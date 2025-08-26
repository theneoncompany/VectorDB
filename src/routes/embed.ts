import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { embeddingProvider } from '../embeddings/openai.js';
import { textChunker } from '../chunk/textChunker.js';
import { logger } from '../logger.js';

const embedRequestSchema = z.object({
  text: z.string().min(1, 'Text cannot be empty'),
  docId: z.string().optional(),
  chunkSize: z.number().min(50).max(2000).optional().default(400),
  overlap: z.number().min(0).max(50).optional().default(15),
  preserveSentences: z.boolean().optional().default(true),
});

const embedResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    chunks: z.array(
      z.object({
        id: z.string(),
        text: z.string(),
        startIndex: z.number(),
        endIndex: z.number(),
        chunkIndex: z.number(),
        tokens: z.number().optional(),
        docId: z.string().optional(),
        embedding: z.array(z.number()),
      })
    ),
    totalChunks: z.number(),
    totalTokens: z.number(),
    embeddingDimensions: z.number(),
  }),
  processingTimeMs: z.number(),
});

type EmbedRequest = z.infer<typeof embedRequestSchema>;
type EmbedResponse = z.infer<typeof embedResponseSchema>;

export async function embedRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Body: EmbedRequest;
    Reply: EmbedResponse;
  }>(
    '/embed',
    {
      schema: {
        body: zodToJsonSchema(embedRequestSchema),
        response: {
          200: zodToJsonSchema(embedResponseSchema),
        },
      },
    },
    async (request: FastifyRequest<{ Body: EmbedRequest }>, reply: FastifyReply) => {
      const startTime = Date.now();

      try {
        const { text, docId, chunkSize, overlap, preserveSentences } = request.body;

        // Validate text length
        const validation = textChunker.validate(text, embeddingProvider.getMaxInputLength());
        if (!validation.valid) {
          reply.code(400);
          return reply.send({
            success: false,
            error: validation.reason,
          });
        }

        logger.info(
          {
            textLength: text.length,
            docId,
            chunkSize,
            overlap,
          },
          'Processing embed request'
        );

        // Chunk the text
        const chunks = textChunker.chunkForEmbedding(text, docId, {
          chunkSize,
          overlap,
          preserveSentences,
        });

        // Generate embeddings for all chunks
        const chunkTexts = chunks.map((chunk) => chunk.text);
        const embeddings = await embeddingProvider.embedBatch(chunkTexts);

        // Combine chunks with their embeddings
        const chunksWithEmbeddings = chunks.map((chunk, index) => ({
          ...chunk,
          embedding: embeddings[index] || [],
        }));

        const totalTokens = chunks.reduce((sum, chunk) => sum + (chunk.tokens || 0), 0);
        const processingTime = Date.now() - startTime;

        logger.info(
          {
            chunksCount: chunks.length,
            totalTokens,
            processingTimeMs: processingTime,
            docId,
          },
          'Embed request completed'
        );

        return {
          success: true,
          data: {
            chunks: chunksWithEmbeddings,
            totalChunks: chunks.length,
            totalTokens,
            embeddingDimensions: embeddingProvider.getDimensions(),
          },
          processingTimeMs: processingTime,
        };
      } catch (error: any) {
        logger.error({ error: error.message }, 'Embed request failed');

        reply.code(500);
        return reply.send({
          success: false,
          error: error.message || 'Internal server error',
        });
      }
    }
  );
}
