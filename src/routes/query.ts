import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { qdrantClient, QdrantFilter } from '../qdrant.js';
import { embeddingProvider } from '../embeddings/openai.js';
import { applyMMR, applyDiversityReranking, MMROptions } from '../utils/mmr.js';
import { validateFilter } from '../utils/filters.js';
import { logger } from '../logger.js';

const filterConditionSchema = z.object({
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
});

const filterSchema = z.object({
  must: z.array(filterConditionSchema).optional(),
  should: z.array(filterConditionSchema).optional(),
  must_not: z.array(filterConditionSchema).optional(),
});

const mmrOptionsSchema = z.object({
  enabled: z.boolean().default(false),
  lambda: z.number().min(0).max(1).default(0.5),
  fetchK: z.number().min(1).max(1000).default(50),
});

const queryRequestSchema = z
  .object({
    text: z.string().optional(),
    vector: z.array(z.number()).optional(),
    topK: z.number().min(1).max(1000).default(10),
    filters: filterSchema.optional(),
    fetchPayload: z.boolean().default(true),
    withVectors: z.boolean().default(false),
    scoreThreshold: z.number().min(0).max(1).optional(),
    efSearch: z.number().min(1).max(1000).optional(),
    mmr: mmrOptionsSchema.default({}),
    diversityReranking: z
      .object({
        enabled: z.boolean().default(false),
        weight: z.number().min(0).max(1).default(0.3),
      })
      .default({}),
  })
  .refine((data) => data.text || data.vector, {
    message: 'Either text or vector must be provided',
  });

const queryResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    results: z.array(
      z.object({
        id: z.string(),
        score: z.number(),
        payload: z.record(z.any()).optional(),
        vector: z.array(z.number()).optional(),
        originalScore: z.number().optional(),
        mmrScore: z.number().optional(),
        mmrRank: z.number().optional(),
      })
    ),
    query: z.object({
      text: z.string().optional(),
      embedding: z.array(z.number()).optional(),
      topK: z.number(),
      actualK: z.number(),
      filters: filterSchema.optional(),
      mmrApplied: z.boolean(),
      diversityApplied: z.boolean(),
    }),
  }),
  processingTimeMs: z.number(),
});

type QueryRequest = z.infer<typeof queryRequestSchema>;
type QueryResponse = z.infer<typeof queryResponseSchema>;

export async function queryRoutes(fastify: FastifyInstance) {
  fastify.post<{
    Body: QueryRequest;
    Reply: QueryResponse;
  }>(
    '/query',
    {
      schema: {
        body: zodToJsonSchema(queryRequestSchema),
        response: {
          200: zodToJsonSchema(queryResponseSchema),
        },
      },
    },
    async (request: FastifyRequest<{ Body: QueryRequest }>, reply: FastifyReply) => {
      const startTime = Date.now();

      try {
        const {
          text,
          vector,
          topK,
          filters,
          fetchPayload,
          withVectors,
          scoreThreshold,
          efSearch,
          mmr,
          diversityReranking,
        } = request.body;

        logger.info(
          {
            hasText: !!text,
            hasVector: !!vector,
            topK,
            hasFilters: !!filters,
            mmrEnabled: mmr.enabled,
            diversityEnabled: diversityReranking.enabled,
          },
          'Processing query request'
        );

        // Validate filters if provided
        if (filters) {
          const filterValidation = validateFilter(filters);
          if (!filterValidation.valid) {
            reply.code(400);
            return {
              success: false,
              error: `Invalid filters: ${filterValidation.errors.join(', ')}`,
            };
          }
        }

        // Get or generate query vector
        let queryVector: number[];
        if (vector) {
          queryVector = vector;
        } else if (text) {
          queryVector = await embeddingProvider.embed(text);
        } else {
          reply.code(400);
          return {
            success: false,
            error: 'Either text or vector must be provided',
          };
        }

        // Determine fetch limit for MMR/diversity re-ranking
        const needsReranking = mmr.enabled || diversityReranking.enabled;
        const fetchLimit = needsReranking ? Math.max(topK, mmr.fetchK || 50) : topK;
        const needsVectors = withVectors || needsReranking;

        // Perform search
        const searchResults = await qdrantClient.search(
          queryVector,
          fetchLimit,
          filters as QdrantFilter,
          fetchPayload,
          needsVectors,
          scoreThreshold,
          efSearch
        );

        logger.debug(
          {
            searchResults: searchResults.length,
            fetchLimit,
            needsReranking,
          },
          'Search completed'
        );

        // Apply re-ranking if requested
        let finalResults = searchResults;
        let mmrApplied = false;
        let diversityApplied = false;

        if (mmr.enabled && searchResults.length > 0) {
          const mmrResults = applyMMR(searchResults, queryVector, mmr as MMROptions, topK);
          finalResults = mmrResults;
          mmrApplied = true;
          logger.debug({ mmrResults: mmrResults.length }, 'MMR re-ranking applied');
        } else if (diversityReranking.enabled && searchResults.length > 0) {
          const diversityResults = applyDiversityReranking(
            searchResults,
            diversityReranking.weight,
            topK
          );
          finalResults = diversityResults;
          diversityApplied = true;
          logger.debug(
            { diversityResults: diversityResults.length },
            'Diversity re-ranking applied'
          );
        } else {
          // Just take top K without re-ranking
          finalResults = searchResults.slice(0, topK);
        }

        // Remove vectors from response if not requested
        if (!withVectors) {
          finalResults = finalResults.map((result) => {
            const { vector: _, ...resultWithoutVector } = result;
            return resultWithoutVector;
          });
        }

        const processingTime = Date.now() - startTime;

        logger.info(
          {
            resultsCount: finalResults.length,
            mmrApplied,
            diversityApplied,
            processingTimeMs: processingTime,
          },
          'Query request completed'
        );

        return {
          success: true,
          data: {
            results: finalResults,
            query: {
              text,
              embedding: withVectors ? queryVector : undefined,
              topK,
              actualK: finalResults.length,
              filters,
              mmrApplied,
              diversityApplied,
            },
          },
          processingTimeMs: processingTime,
        };
      } catch (error: any) {
        logger.error({ error: error.message }, 'Query request failed');

        reply.code(500);
        return {
          success: false,
          error: error.message || 'Internal server error',
        };
      }
    }
  );
}
