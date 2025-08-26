import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { googleSheetsSync, SheetConfig, SyncStats } from '../sync/googleSheets.js';
import { logger } from '../logger.js';
import { config } from '../config.js';

// Request/Response schemas
const syncRequestSchema = z.object({
  spreadsheetId: z.string().min(1, 'Spreadsheet ID is required'),
  sheetName: z.string().min(1, 'Sheet name is required'),
  keyColumn: z.string().min(1, 'Key column is required'),
  textColumns: z.array(z.string()).min(1, 'At least one text column is required'),
  metadataColumns: z.array(z.string()).default([]),
});

const syncResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      stats: z.object({
        totalRows: z.number(),
        processedRows: z.number(),
        newChunks: z.number(),
        updatedChunks: z.number(),
        errors: z.number(),
        processingTimeMs: z.number(),
      }),
      sheetInfo: z.object({
        spreadsheetId: z.string(),
        sheetName: z.string(),
        syncedAt: z.string(),
      }),
    })
    .optional(),
  error: z.string().optional(),
});

const sheetsListResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      sheets: z.array(z.string()),
      spreadsheetId: z.string(),
    })
    .optional(),
  error: z.string().optional(),
});

const testConnectionResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      connected: z.boolean(),
      spreadsheetTitle: z.string().optional(),
    })
    .optional(),
  error: z.string().optional(),
});

type SyncRequest = z.infer<typeof syncRequestSchema>;
type SyncResponse = z.infer<typeof syncResponseSchema>;
type SheetsListResponse = z.infer<typeof sheetsListResponseSchema>;
type TestConnectionResponse = z.infer<typeof testConnectionResponseSchema>;

export async function syncSheetsRoutes(fastify: FastifyInstance) {
  // Manual sync endpoint
  fastify.post<{
    Body: SyncRequest;
    Reply: SyncResponse;
  }>(
    '/sync/sheets',
    {
      schema: {
        body: zodToJsonSchema(syncRequestSchema),
        response: {
          200: zodToJsonSchema(syncResponseSchema),
        },
      },
    },
    async (request: FastifyRequest<{ Body: SyncRequest }>, reply: FastifyReply) => {
      try {
        const { spreadsheetId, sheetName, keyColumn, textColumns, metadataColumns } = request.body;

        logger.info(
          {
            spreadsheetId,
            sheetName,
            keyColumn,
            textColumns,
            metadataColumns,
          },
          'Starting manual Google Sheets sync'
        );

        const sheetConfig: SheetConfig = {
          spreadsheetId,
          sheetName,
          keyColumn,
          textColumns,
          metadataColumns,
        };

        const stats = await googleSheetsSync.syncSheet(sheetConfig);

        return {
          success: true,
          data: {
            stats,
            sheetInfo: {
              spreadsheetId,
              sheetName,
              syncedAt: new Date().toISOString(),
            },
          },
        };
      } catch (error: any) {
        logger.error({ error: error.message }, 'Manual Google Sheets sync failed');

        reply.code(500);
        return {
          success: false,
          error: error.message || 'Sync failed',
        };
      }
    }
  );

  // Get list of sheets in a spreadsheet
  fastify.get<{
    Querystring: { spreadsheetId: string };
    Reply: SheetsListResponse;
  }>(
    '/sync/sheets/list',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            spreadsheetId: { type: 'string' },
          },
          required: ['spreadsheetId'],
        },
        response: {
          200: zodToJsonSchema(sheetsListResponseSchema),
        },
      },
    },
    async (
      request: FastifyRequest<{ Querystring: { spreadsheetId: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { spreadsheetId } = request.query;

        const sheets = await googleSheetsSync.getSheetNames(spreadsheetId);

        return {
          success: true,
          data: {
            sheets,
            spreadsheetId,
          },
        };
      } catch (error: any) {
        logger.error({ error: error.message }, 'Failed to get sheet list');

        reply.code(500);
        return {
          success: false,
          error: error.message || 'Failed to get sheet list',
        };
      }
    }
  );

  // Test Google Sheets connection
  fastify.post<{
    Body: { spreadsheetId: string };
    Reply: TestConnectionResponse;
  }>(
    '/sync/sheets/test',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            spreadsheetId: { type: 'string' },
          },
          required: ['spreadsheetId'],
        },
        response: {
          200: zodToJsonSchema(testConnectionResponseSchema),
        },
      },
    },
    async (request: FastifyRequest<{ Body: { spreadsheetId: string } }>, reply: FastifyReply) => {
      try {
        const { spreadsheetId } = request.body;

        const connected = await googleSheetsSync.testConnection(spreadsheetId);

        return {
          success: true,
          data: {
            connected,
          },
        };
      } catch (error: any) {
        logger.error({ error: error.message }, 'Google Sheets connection test failed');

        return {
          success: false,
          data: {
            connected: false,
          },
          error: error.message || 'Connection test failed',
        };
      }
    }
  );

  // Get sync status and health
  fastify.get('/sync/sheets/status', async () => {
    try {
      const sheetsHealthy = await googleSheetsSync.healthCheck();

      return {
        success: true,
        data: {
          googleSheets: {
            healthy: sheetsHealthy,
            syncEnabled: config.GOOGLE_SHEETS_SYNC_ENABLED,
            syncInterval: config.GOOGLE_SHEETS_SYNC_INTERVAL_MINUTES,
            defaultSpreadsheetId: config.SHEET_ID,
          },
          lastSync: {
            // This could be enhanced to track last sync time
            timestamp: null,
            status: 'manual',
          },
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
      };
    }
  });

  // Debug endpoint to inspect sheet data structure
  fastify.get<{
    Querystring: { spreadsheetId: string; sheetName: string };
  }>('/sync/sheets/debug', async (request, reply) => {
    try {
      const { spreadsheetId, sheetName } = request.query;

      if (!spreadsheetId || !sheetName) {
        reply.code(400);
        return {
          success: false,
          error: 'spreadsheetId and sheetName are required',
        };
      }

      // Get first few rows to inspect structure
      const sheetData = await googleSheetsSync.getSheetData({
        spreadsheetId,
        sheetName,
        keyColumn: 'dummy', // We're just inspecting
        textColumns: [],
        metadataColumns: [],
      });

      return {
        success: true,
        data: {
          totalRows: sheetData.length,
          firstRow: sheetData[0] || null,
          columnNames: sheetData[0] ? Object.keys(sheetData[0]) : [],
          sampleData: sheetData.slice(0, 3), // First 3 rows
        },
      };
    } catch (error: any) {
      reply.code(500);
      return {
        success: false,
        error: error.message || 'Failed to debug sheet data',
      };
    }
  });

  // Sync with default configuration (for scheduled sync)
  fastify.post('/sync/sheets/default', async (request, reply) => {
    try {
      if (!config.GOOGLE_SHEETS_SYNC_ENABLED) {
        reply.code(400);
        return {
          success: false,
          error: 'Google Sheets sync is not enabled',
        };
      }

      if (!config.SHEET_ID) {
        reply.code(400);
        return {
          success: false,
          error: 'Default spreadsheet ID not configured',
        };
      }

      // Default configuration for The Neon Company knowledge base
      const defaultConfig: SheetConfig = {
        spreadsheetId: config.SHEET_ID,
        sheetName: 'Algemene vragen', // Same as your current CRM
        keyColumn: 'question', // Use the question text as unique identifier
        textColumns: ['question', 'Answer'], // The two columns available
        metadataColumns: [], // No additional metadata columns for now
      };

      const stats = await googleSheetsSync.syncSheet(defaultConfig);

      return {
        success: true,
        data: {
          stats,
          sheetInfo: {
            spreadsheetId: defaultConfig.spreadsheetId,
            sheetName: defaultConfig.sheetName,
            syncedAt: new Date().toISOString(),
          },
        },
      };
    } catch (error: any) {
      logger.error({ error: error.message }, 'Default Google Sheets sync failed');

      reply.code(500);
      return {
        success: false,
        error: error.message || 'Default sync failed',
      };
    }
  });
}
