import { google } from 'googleapis';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { qdrantClient } from '../qdrant.js';
import { TextChunker } from '../chunk/textChunker.js';
import { embeddingProvider } from '../embeddings/openai.js';
import { v4 as uuidv4 } from 'uuid';

export interface SheetConfig {
  spreadsheetId: string;
  sheetName: string;
  keyColumn: string; // Column to use as unique identifier
  textColumns: string[]; // Columns to combine for text content
  metadataColumns: string[]; // Additional columns to store as metadata
}

export interface SyncStats {
  totalRows: number;
  processedRows: number;
  newChunks: number;
  updatedChunks: number;
  errors: number;
  processingTimeMs: number;
}

export class GoogleSheetsSync {
  private auth: any;
  private sheets: any;
  private textChunker: TextChunker;

  constructor() {
    this.textChunker = new TextChunker();
    this.initializeAuth();
  }

  private async initializeAuth() {
    try {
      if (!config.GCP_SERVICE_ACCOUNT_JSON) {
        throw new Error('GCP_SERVICE_ACCOUNT_JSON environment variable is required');
      }

      // Decode base64 service account JSON
      const serviceAccountJson = Buffer.from(config.GCP_SERVICE_ACCOUNT_JSON, 'base64').toString(
        'utf8'
      );
      const credentials = JSON.parse(serviceAccountJson);

      // Initialize Google Sheets API with service account credentials
      this.auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
      });

      this.sheets = google.sheets({ version: 'v4', auth: this.auth });
      logger.info('Google Sheets API initialized successfully with decoded credentials');
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to initialize Google Sheets API');
      throw error;
    }
  }

  /**
   * Sync data from Google Sheets to Qdrant vector database
   */
  async syncSheet(sheetConfig: SheetConfig): Promise<SyncStats> {
    const startTime = Date.now();
    const stats: SyncStats = {
      totalRows: 0,
      processedRows: 0,
      newChunks: 0,
      updatedChunks: 0,
      errors: 0,
      processingTimeMs: 0,
    };

    try {
      logger.info(
        {
          spreadsheetId: sheetConfig.spreadsheetId,
          sheetName: sheetConfig.sheetName,
        },
        'Starting Google Sheets sync'
      );

      // Get sheet data
      const sheetData = await this.getSheetData(sheetConfig);
      stats.totalRows = sheetData.length;

      // Process each row
      for (const row of sheetData) {
        try {
          const chunkStats = await this.processRow(row, sheetConfig);
          stats.processedRows++;
          stats.newChunks += chunkStats.newChunks;
          stats.updatedChunks += chunkStats.updatedChunks;

          // Add small delay to avoid rate limits
          await new Promise((resolve) => setTimeout(resolve, 100));
        } catch (error: any) {
          stats.errors++;
          logger.error(
            {
              error: error.message,
              row: row[sheetConfig.keyColumn],
            },
            'Failed to process sheet row'
          );
        }
      }

      stats.processingTimeMs = Date.now() - startTime;

      logger.info(
        {
          ...stats,
          sheetName: sheetConfig.sheetName,
        },
        'Google Sheets sync completed'
      );

      return stats;
    } catch (error: any) {
      stats.processingTimeMs = Date.now() - startTime;
      logger.error({ error: error.message }, 'Google Sheets sync failed');
      throw error;
    }
  }

  /**
   * Get data from Google Sheets
   */
  private async getSheetData(sheetConfig: SheetConfig): Promise<any[]> {
    try {
      const response = await this.sheets.spreadsheets.values.get({
        spreadsheetId: sheetConfig.spreadsheetId,
        range: `${sheetConfig.sheetName}!A:Z`, // Get all columns
      });

      const rows = response.data.values;
      if (!rows || rows.length === 0) {
        logger.warn('No data found in sheet');
        return [];
      }

      // Convert rows to objects using first row as headers
      const headers = rows[0];
      const dataRows = rows.slice(1);

      return dataRows.map((row: any[]) => {
        const obj: any = {};
        headers.forEach((header: string, index: number) => {
          obj[header] = row[index] || '';
        });
        return obj;
      });
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to get sheet data');
      throw error;
    }
  }

  /**
   * Process a single row from the sheet
   */
  private async processRow(
    row: any,
    sheetConfig: SheetConfig
  ): Promise<{ newChunks: number; updatedChunks: number }> {
    // Create unique document ID from key column
    const docId = `sheet_${sheetConfig.sheetName}_${row[sheetConfig.keyColumn]}`;

    // Combine text columns to create content
    const textContent = sheetConfig.textColumns
      .map((col) => `${col}: ${row[col] || ''}`)
      .filter((text) => text.trim().length > 0)
      .join('\n');

    if (!textContent.trim()) {
      logger.warn({ docId }, 'No text content found for row');
      return { newChunks: 0, updatedChunks: 0 };
    }

    // Create metadata from specified columns
    const metadata: any = {
      source: 'google_sheets',
      spreadsheetId: sheetConfig.spreadsheetId,
      sheetName: sheetConfig.sheetName,
      syncedAt: new Date().toISOString(),
      rowKey: row[sheetConfig.keyColumn],
    };

    // Add metadata columns
    sheetConfig.metadataColumns.forEach((col) => {
      if (row[col]) {
        metadata[col] = row[col];
      }
    });

    // Delete existing points for this document (if any)
    try {
      await qdrantClient.deleteByDocId(docId);
      logger.debug({ docId }, 'Deleted existing points for document');
    } catch (error: any) {
      // It's okay if no points exist to delete
      logger.debug(
        { docId, error: error.message },
        'No existing points to delete (this is normal)'
      );
    }

    // Chunk the text content
    const chunks = this.textChunker.chunkForEmbedding(textContent, docId, {
      chunkSize: 400,
      overlap: 0.15,
      preserveSentences: true,
    });

    // Track chunk statistics
    let processedChunks = 0;

    // Generate embeddings and store chunks
    for (const chunk of chunks) {
      try {
        // Generate embedding
        const embedding = await embeddingProvider.embed(chunk.text);

        // Create point for Qdrant
        const point = {
          id: chunk.id,
          vector: embedding,
          payload: {
            ...metadata,
            text: chunk.text,
            chunkIndex: chunk.index,
            startIndex: chunk.startIndex,
            endIndex: chunk.endIndex,
          },
        };

        // Store in Qdrant
        await qdrantClient.upsertPoints([point]);
        processedChunks++;

        logger.debug(
          {
            docId,
            chunkId: chunk.id,
            chunkIndex: chunk.index,
          },
          'Stored chunk in vector database'
        );
      } catch (error: any) {
        logger.error(
          {
            error: error.message,
            docId,
            chunkIndex: chunk.index,
          },
          'Failed to process chunk'
        );
        throw error;
      }
    }

    logger.debug(
      {
        docId,
        chunksCreated: processedChunks,
        totalChunks: chunks.length,
      },
      'Document processing completed'
    );

    // Since we delete existing documents and create new ones, all chunks are "new"
    return { newChunks: processedChunks, updatedChunks: 0 };
  }

  /**
   * Test connection to Google Sheets
   */
  async testConnection(spreadsheetId: string): Promise<boolean> {
    try {
      const response = await this.sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'properties.title',
      });

      logger.info(
        {
          title: response.data.properties.title,
          spreadsheetId,
        },
        'Google Sheets connection test successful'
      );

      return true;
    } catch (error: any) {
      logger.error(
        {
          error: error.message,
          spreadsheetId,
        },
        'Google Sheets connection test failed'
      );
      return false;
    }
  }

  /**
   * Get list of sheets in a spreadsheet
   */
  async getSheetNames(spreadsheetId: string): Promise<string[]> {
    try {
      const response = await this.sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets.properties.title',
      });

      return response.data.sheets.map((sheet: any) => sheet.properties.title);
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to get sheet names');
      throw error;
    }
  }

  /**
   * Health check for Google Sheets service
   */
  async healthCheck(): Promise<boolean> {
    try {
      if (!this.auth || !this.sheets) {
        return false;
      }

      // Test with a simple request
      await this.auth.getAccessToken();
      return true;
    } catch {
      return false;
    }
  }
}

// Export singleton instance
export const googleSheetsSync = new GoogleSheetsSync();
