import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { qdrantClient, QdrantPoint } from '../qdrant.js';
import { logger } from '../logger.js';

const pointSchema = z.object({
  id: z.string().uuid('Point ID must be a valid UUID for Qdrant compatibility'),
  vector: z.array(z.number()).min(1, 'Vector cannot be empty'),
  payload: z.record(z.any()).optional().default({}),
});

const upsertRequestSchema = z.object({
  points: z.array(pointSchema).min(1, 'Must provide at least one point'),
  createCollectionIfMissing: z.boolean().optional().default(true),
  batchSize: z.number().min(1).max(5000).optional().default(1000),
});

const upsertResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    pointsUpserted: z.number(),
    collectionExists: z.boolean(),
    collectionCreated: z.boolean(),
  }),
  processingTimeMs: z.number(),
});

type UpsertRequest = z.infer<typeof upsertRequestSchema>;
type UpsertResponse = z.infer<typeof upsertResponseSchema>;

export async function upsertRoutes(fastify: FastifyInstance) {
  fastify.put<{
    Body: UpsertRequest;
    Reply: UpsertResponse;
  }>(
    '/upsert',
    {
      schema: {
        body: zodToJsonSchema(upsertRequestSchema),
        response: {
          200: zodToJsonSchema(upsertResponseSchema),
        },
      },
    },
    async (request: FastifyRequest<{ Body: UpsertRequest }>, reply: FastifyReply) => {
      const startTime = Date.now();

      try {
        const { points, createCollectionIfMissing, batchSize } = request.body;

        logger.info(
          {
            pointsCount: points.length,
            createCollectionIfMissing,
            batchSize,
          },
          'Processing upsert request'
        );

        // Validate vector dimensions
        const expectedDim = points[0]?.vector.length;
        if (expectedDim) {
          const invalidPoints = points.filter((p) => p.vector.length !== expectedDim);
          if (invalidPoints.length > 0) {
            reply.code(400);
            return reply.send({
              success: false,
              error: `Inconsistent vector dimensions. Expected ${expectedDim}, but found points with different dimensions.`,
            });
          }
        }

        // Ensure collection exists
        let collectionExists = await qdrantClient.ensureCollection(false);
        let collectionCreated = false;

        if (!collectionExists && createCollectionIfMissing) {
          collectionExists = await qdrantClient.ensureCollection(true);
          collectionCreated = collectionExists;
        }

        if (!collectionExists) {
          reply.code(400);
          return reply.send({
            success: false,
            error: 'Collection does not exist and createCollectionIfMissing is false',
          });
        }

        // Process points in batches
        let totalUpserted = 0;

        for (let i = 0; i < points.length; i += batchSize) {
          const batch = points.slice(i, i + batchSize);
          const qdrantPoints: QdrantPoint[] = batch.map((point) => ({
            id: point.id,
            vector: point.vector,
            payload: point.payload || {},
          }));

          await qdrantClient.upsertPoints(qdrantPoints);
          totalUpserted += batch.length;

          logger.debug(
            {
              batchStart: i,
              batchSize: batch.length,
              totalProcessed: totalUpserted,
              totalPoints: points.length,
            },
            'Upserted batch'
          );
        }

        const processingTime = Date.now() - startTime;

        logger.info(
          {
            pointsUpserted: totalUpserted,
            collectionCreated,
            processingTimeMs: processingTime,
          },
          'Upsert request completed'
        );

        return {
          success: true,
          data: {
            pointsUpserted: totalUpserted,
            collectionExists,
            collectionCreated,
          },
          processingTimeMs: processingTime,
        };
      } catch (error: any) {
        logger.error({ error: error.message }, 'Upsert request failed');

        reply.code(500);
        return reply.send({
          success: false,
          error: error.message || 'Internal server error',
        });
      }
    }
  );
}
