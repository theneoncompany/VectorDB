import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { MongoClient, Db, Collection } from 'mongodb';
import { qdrantClient } from '../qdrant.js';
import { embeddingProvider } from '../embeddings/openai.js';
import { textChunker } from '../chunk/textChunker.js';
import { config, features } from '../config.js';
import { logger } from '../logger.js';

const syncRequestSchema = z.object({
  batchSize: z.number().min(1).max(10000).default(1000),
  reEmbedIfMissing: z.boolean().default(true),
  onlyMissingEmbeddings: z.boolean().default(false),
  textField: z.string().default('text'), // Field containing the text content
  metadataFields: z.array(z.string()).default([]), // Additional fields to include as metadata
  chunkSize: z.number().min(50).max(2000).default(400),
  overlap: z.number().min(0).max(50).default(15),
  dryRun: z.boolean().default(false), // Preview what would be synced
});

const syncResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      documentsProcessed: z.number(),
      chunksCreated: z.number(),
      pointsUpserted: z.number(),
      documentsSkipped: z.number(),
      errors: z.array(
        z.object({
          docId: z.string(),
          error: z.string(),
        })
      ),
      dryRun: z.boolean(),
      preview: z
        .array(
          z.object({
            docId: z.string(),
            chunks: z.number(),
            hasEmbedding: z.boolean(),
            textLength: z.number(),
          })
        )
        .optional(),
    })
    .optional(),
  processingTimeMs: z.number().optional(),
  error: z.string().optional(),
});

type SyncRequest = z.infer<typeof syncRequestSchema>;
type SyncResponse = z.infer<typeof syncResponseSchema>;

interface MongoDocument {
  _id: any;
  [key: string]: any;
}

export async function syncMongoRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Body: SyncRequest;
    Reply: SyncResponse;
  }>(
    '/sync/mongo',
    {
      schema: {
        body: zodToJsonSchema(syncRequestSchema),
        response: {
          200: zodToJsonSchema(syncResponseSchema),
        },
      },
    },
    async (request: FastifyRequest<{ Body: SyncRequest }>, reply: FastifyReply) => {
      const startTime = Date.now();
      let mongoClient: MongoClient | null = null;

      try {
        const {
          batchSize,
          reEmbedIfMissing,
          onlyMissingEmbeddings,
          textField,
          metadataFields,
          chunkSize,
          overlap,
          dryRun,
        } = request.body;

        // Safety check: prevent writes in read-only mode
        if (features.mongoReadOnly && !dryRun) {
          reply.code(403);
          return {
            success: false,
            error:
              'MongoDB is in read-only mode. Use dryRun=true to preview without making changes.',
          };
        }

        logger.info(
          {
            batchSize,
            reEmbedIfMissing,
            onlyMissingEmbeddings,
            textField,
            metadataFields,
            dryRun,
          },
          'Starting MongoDB sync'
        );

        // Connect to MongoDB
        mongoClient = new MongoClient(config.MONGO_URI);
        await mongoClient.connect();

        const db: Db = mongoClient.db(config.MONGO_DB);
        const collection: Collection<MongoDocument> = db.collection(config.MONGO_COLLECTION);

        // Ensure Qdrant collection exists (unless dry run)
        if (!dryRun) {
          const collectionExists = await qdrantClient.ensureCollection(true);
          if (!collectionExists) {
            throw new Error('Failed to create Qdrant collection');
          }
        }

        // Build query for documents to sync
        const query: any = {};
        if (onlyMissingEmbeddings) {
          query.embedding = { $exists: false };
        }

        // Get total count for progress tracking
        const totalDocs = await collection.countDocuments(query);
        logger.info({ totalDocs, query }, 'Found documents to sync');

        const stats = {
          documentsProcessed: 0,
          chunksCreated: 0,
          pointsUpserted: 0,
          documentsSkipped: 0,
          errors: [] as Array<{ docId: string; error: string }>,
          preview: [] as Array<{
            docId: string;
            chunks: number;
            hasEmbedding: boolean;
            textLength: number;
          }>,
        };

        // Process documents in batches
        const cursor = collection.find(query).batchSize(batchSize);

        let batch: MongoDocument[] = [];

        for await (const doc of cursor) {
          batch.push(doc);

          if (batch.length >= batchSize) {
            await processBatch(batch, stats, {
              textField,
              metadataFields,
              chunkSize,
              overlap,
              reEmbedIfMissing,
              dryRun,
            });
            batch = [];

            logger.debug(
              {
                processed: stats.documentsProcessed,
                total: totalDocs,
                progress: `${Math.round((stats.documentsProcessed / totalDocs) * 100)}%`,
              },
              'Sync progress'
            );
          }
        }

        // Process remaining documents
        if (batch.length > 0) {
          await processBatch(batch, stats, {
            textField,
            metadataFields,
            chunkSize,
            overlap,
            reEmbedIfMissing,
            dryRun,
          });
        }

        await mongoClient.close();
        mongoClient = null;

        const processingTime = Date.now() - startTime;

        logger.info(
          {
            ...stats,
            processingTimeMs: processingTime,
            dryRun,
          },
          'MongoDB sync completed'
        );

        return {
          success: true,
          data: {
            ...stats,
            dryRun,
          },
          processingTimeMs: processingTime,
        };
      } catch (error: any) {
        logger.error({ error: error.message }, 'MongoDB sync failed');

        if (mongoClient) {
          try {
            await mongoClient.close();
          } catch (closeError) {
            logger.error({ error: closeError }, 'Failed to close MongoDB connection');
          }
        }

        reply.code(500);
        return {
          success: false,
          error: error.message || 'Internal server error',
        };
      }
    }
  );

  async function processBatch(
    docs: MongoDocument[],
    stats: any,
    options: {
      textField: string;
      metadataFields: string[];
      chunkSize: number;
      overlap: number;
      reEmbedIfMissing: boolean;
      dryRun: boolean;
    }
  ) {
    const { textField, metadataFields, chunkSize, overlap, reEmbedIfMissing, dryRun } = options;

    for (const doc of docs) {
      try {
        const docId = doc._id.toString();
        const text = doc[textField];

        if (!text || typeof text !== 'string') {
          logger.warn({ docId, textField }, 'Document missing text field');
          stats.documentsSkipped++;
          continue;
        }

        const hasEmbedding = !!doc.embedding;

        // Skip if has embedding and we don't want to re-embed
        if (hasEmbedding && !reEmbedIfMissing) {
          stats.documentsSkipped++;
          continue;
        }

        // Chunk the text
        const chunks = textChunker.chunkForEmbedding(text, docId, {
          chunkSize,
          overlap,
        });

        if (dryRun) {
          stats.preview.push({
            docId,
            chunks: chunks.length,
            hasEmbedding,
            textLength: text.length,
          });
          stats.documentsProcessed++;
          stats.chunksCreated += chunks.length;
          continue;
        }

        // Generate embeddings for chunks
        const chunkTexts = chunks.map((chunk) => chunk.text);
        const embeddings = await embeddingProvider.embedBatch(chunkTexts);

        // Prepare metadata
        const baseMetadata: any = {
          docId,
          source: 'mongo',
          syncedAt: new Date().toISOString(),
        };

        // Add requested metadata fields
        for (const field of metadataFields) {
          if (doc[field] !== undefined) {
            baseMetadata[field] = doc[field];
          }
        }

        // Create Qdrant points
        const points = chunks.map((chunk, index) => ({
          id: chunk.id,
          vector: embeddings[index] || [],
          payload: {
            ...baseMetadata,
            chunkIndex: chunk.chunkIndex,
            startIndex: chunk.startIndex,
            endIndex: chunk.endIndex,
            text: chunk.text,
            tokens: chunk.tokens,
          },
        }));

        // Upsert to Qdrant
        await qdrantClient.upsertPoints(points);

        stats.documentsProcessed++;
        stats.chunksCreated += chunks.length;
        stats.pointsUpserted += points.length;
      } catch (error: any) {
        const docId = doc._id?.toString() || 'unknown';
        logger.error({ docId, error: error.message }, 'Failed to process document');
        stats.errors.push({
          docId,
          error: error.message,
        });
      }
    }
  }

  // Get sync status/progress endpoint
  fastify.get('/sync/mongo/status', async () => {
    try {
      // This could be enhanced to track ongoing sync operations
      const mongoClient = new MongoClient(config.MONGO_URI);
      await mongoClient.connect();

      const db = mongoClient.db(config.MONGO_DB);
      const collection = db.collection(config.MONGO_COLLECTION);

      const totalDocs = await collection.countDocuments();
      const docsWithEmbeddings = await collection.countDocuments({ embedding: { $exists: true } });
      const docsWithoutEmbeddings = totalDocs - docsWithEmbeddings;

      await mongoClient.close();

      const qdrantHealthy = await qdrantClient.healthCheck();
      const collectionInfo = qdrantHealthy ? await qdrantClient.getCollectionInfo() : null;

      return {
        success: true,
        data: {
          mongo: {
            connected: true,
            totalDocuments: totalDocs,
            documentsWithEmbeddings: docsWithEmbeddings,
            documentsWithoutEmbeddings: docsWithoutEmbeddings,
          },
          qdrant: {
            healthy: qdrantHealthy,
            collection: collectionInfo?.result || null,
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
}
