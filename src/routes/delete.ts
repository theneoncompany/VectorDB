import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { qdrantClient } from '../qdrant.js';
import { logger } from '../logger.js';

const deleteRequestSchema = z
  .object({
    ids: z.array(z.string()).optional(),
    docId: z.string().optional(),
    filter: z
      .object({
        must: z
          .array(
            z.object({
              key: z.string(),
              match: z
                .object({
                  value: z.union([z.string(), z.number(), z.boolean()]),
                })
                .optional(),
              range: z
                .object({
                  gte: z.number().optional(),
                  lte: z.number().optional(),
                  gt: z.number().optional(),
                  lt: z.number().optional(),
                })
                .optional(),
            })
          )
          .optional(),
        should: z
          .array(
            z.object({
              key: z.string(),
              match: z
                .object({
                  value: z.union([z.string(), z.number(), z.boolean()]),
                })
                .optional(),
              range: z
                .object({
                  gte: z.number().optional(),
                  lte: z.number().optional(),
                  gt: z.number().optional(),
                  lt: z.number().optional(),
                })
                .optional(),
            })
          )
          .optional(),
        must_not: z
          .array(
            z.object({
              key: z.string(),
              match: z
                .object({
                  value: z.union([z.string(), z.number(), z.boolean()]),
                })
                .optional(),
              range: z
                .object({
                  gte: z.number().optional(),
                  lte: z.number().optional(),
                  gt: z.number().optional(),
                  lt: z.number().optional(),
                })
                .optional(),
            })
          )
          .optional(),
      })
      .optional(),
  })
  .refine((data) => data.ids || data.docId || data.filter, {
    message: 'Either ids, docId, or filter must be provided',
  });

const deleteResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    deletedBy: z.enum(['ids', 'docId', 'filter']),
    deletedCount: z.string(), // Qdrant doesn't return actual count, so we use description
  }),
  processingTimeMs: z.number(),
});

type DeleteRequest = z.infer<typeof deleteRequestSchema>;
type DeleteResponse = z.infer<typeof deleteResponseSchema>;

export async function deleteRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Body: DeleteRequest;
    Reply: DeleteResponse;
  }>(
    '/delete',
    {
      schema: {
        body: zodToJsonSchema(deleteRequestSchema),
        response: {
          200: zodToJsonSchema(deleteResponseSchema),
        },
      },
    },
    async (request: FastifyRequest<{ Body: DeleteRequest }>, reply: FastifyReply) => {
      const startTime = Date.now();

      try {
        const { ids, docId, filter } = request.body;

        logger.info(
          {
            hasIds: !!ids,
            idsCount: ids?.length,
            docId,
            hasFilter: !!filter,
          },
          'Processing delete request'
        );

        let deletedBy: 'ids' | 'docId' | 'filter';
        let deletedCount: string;

        if (ids && ids.length > 0) {
          // Delete by specific IDs
          await qdrantClient.deletePoints(ids);
          deletedBy = 'ids';
          deletedCount = `${ids.length} point(s) by ID`;

          logger.info({ deletedIds: ids }, 'Deleted points by IDs');
        } else if (docId) {
          // Delete by document ID (using payload filter)
          await qdrantClient.deleteByDocId(docId);
          deletedBy = 'docId';
          deletedCount = `All points with docId: ${docId}`;

          logger.info({ docId }, 'Deleted points by docId');
        } else if (filter) {
          // Delete by custom filter
          await qdrantClient.deleteByPayloadFilter(filter as any);
          deletedBy = 'filter';
          deletedCount = 'Points matching filter criteria';

          logger.info({ filter }, 'Deleted points by filter');
        } else {
          reply.code(400);
          return reply.send({
            success: false,
            error: 'Either ids, docId, or filter must be provided',
          });
        }

        const processingTime = Date.now() - startTime;

        logger.info(
          {
            deletedBy,
            deletedCount,
            processingTimeMs: processingTime,
          },
          'Delete request completed'
        );

        return {
          success: true,
          data: {
            deletedBy,
            deletedCount,
          },
          processingTimeMs: processingTime,
        };
      } catch (error: any) {
        logger.error({ error: error.message }, 'Delete request failed');

        reply.code(500);
        return reply.send({
          success: false,
          error: error.message || 'Internal server error',
        });
      }
    }
  );

  // Health check endpoint for the delete service
  fastify.get('/delete/health', async () => {
    try {
      const isHealthy = await qdrantClient.healthCheck();
      return {
        success: true,
        data: {
          qdrantHealthy: isHealthy,
          timestamp: new Date().toISOString(),
        },
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
      };
    }
  });
}
