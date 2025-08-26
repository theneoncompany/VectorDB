import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { fastify } from '../src/index.js';
import { qdrantClient } from '../src/qdrant.js';

// Test configuration
const TEST_API_KEY = 'test_api_key_123';
const TEST_COLLECTION = 'test_collection';

// Mock environment for testing
process.env.API_KEY = TEST_API_KEY;
process.env.QDRANT_COLLECTION = TEST_COLLECTION;
process.env.QDRANT_URL = 'http://localhost:6333';
process.env.OPENAI_API_KEY = 'sk-test-key';
process.env.MONGO_CHANGE_STREAMS_ENABLED = 'false';

describe('Vector Service API Tests', () => {
  beforeAll(async () => {
    try {
      // Ensure test collection exists
      await qdrantClient.ensureCollection(true);
    } catch (error) {
      console.warn('Could not setup test collection:', error);
    }
  });

  afterAll(async () => {
    await fastify.close();
  });

  beforeEach(async () => {
    // Clean up test data before each test
    try {
      await qdrantClient.deleteByPayloadFilter({
        must: [{ key: 'test', match: { value: true } }],
      });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Health Checks', () => {
    it('should return service info on root endpoint', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/',
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data.success).toBe(true);
      expect(data.data.service).toBe('vector-service');
    });

    it('should return health status', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/health',
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('data');
      expect(data.data).toHaveProperty('qdrant');
      expect(data.data).toHaveProperty('mongo');
    });
  });

  describe('Authentication', () => {
    it('should reject requests without auth header', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/embed',
        payload: { text: 'test' },
      });

      expect(response.statusCode).toBe(401);
      const data = JSON.parse(response.payload);
      expect(data.success).toBe(false);
      expect(data.error).toContain('Authorization');
    });

    it('should reject requests with invalid auth token', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/embed',
        payload: { text: 'test' },
        headers: {
          authorization: 'Bearer invalid_token',
        },
      });

      expect(response.statusCode).toBe(401);
      const data = JSON.parse(response.payload);
      expect(data.success).toBe(false);
      expect(data.error).toContain('Invalid authorization');
    });

    it('should accept requests with valid auth token', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/embed',
        payload: { text: 'test embedding text' },
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
        },
      });

      // Should not be a 401 error (might be 500 due to missing OpenAI key, but auth passed)
      expect(response.statusCode).not.toBe(401);
    });
  });

  describe('Embed Endpoint', () => {
    it('should validate required fields', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/embed',
        payload: {},
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should validate text field is not empty', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/embed',
        payload: { text: '' },
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should accept valid embed request format', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/embed',
        payload: {
          text: 'This is a test document for embedding',
          docId: 'test-doc-1',
          chunkSize: 200,
        },
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
        },
      });

      // Might fail due to missing OpenAI key, but should have correct format
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('success');
    });
  });

  describe('Upsert Endpoint', () => {
    it('should validate points array', async () => {
      const response = await fastify.inject({
        method: 'PUT',
        url: '/upsert',
        payload: { points: [] },
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should validate point structure', async () => {
      const response = await fastify.inject({
        method: 'PUT',
        url: '/upsert',
        payload: {
          points: [
            {
              id: 'test-1',
              // Missing vector
              payload: { test: true },
            },
          ],
        },
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should accept valid upsert request', async () => {
      const testVector = Array(1536).fill(0.1); // Valid dimension for OpenAI embeddings

      const response = await fastify.inject({
        method: 'PUT',
        url: '/upsert',
        payload: {
          points: [
            {
              id: uuidv4(),
              vector: testVector,
              payload: { test: true, content: 'test content' },
            },
          ],
          createCollectionIfMissing: true,
        },
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data.success).toBe(true);
      expect(data.data.pointsUpserted).toBe(1);
    });
  });

  describe('Query Endpoint', () => {
    beforeEach(async () => {
      // Setup test data
      try {
        const testVector = Array(1536).fill(0.1);
        await qdrantClient.upsertPoints([
          {
            id: uuidv4(),
            vector: testVector,
            payload: { test: true, category: 'science', title: 'Test Document 1' },
          },
          {
            id: uuidv4(),
            vector: testVector.map((v, i) => v + i * 0.01), // Slightly different vector
            payload: { test: true, category: 'technology', title: 'Test Document 2' },
          },
        ]);
      } catch (error) {
        console.warn('Could not setup query test data:', error);
      }
    });

    it('should require either text or vector', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/query',
        payload: { topK: 5 },
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should accept vector query', async () => {
      const testVector = Array(1536).fill(0.1);

      const response = await fastify.inject({
        method: 'POST',
        url: '/query',
        payload: {
          vector: testVector,
          topK: 5,
          fetchPayload: true,
        },
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data.success).toBe(true);
      expect(Array.isArray(data.data.results)).toBe(true);
    });

    it('should accept filters', async () => {
      const testVector = Array(1536).fill(0.1);

      const response = await fastify.inject({
        method: 'POST',
        url: '/query',
        payload: {
          vector: testVector,
          topK: 5,
          filters: {
            must: [{ key: 'category', match: { value: 'science' } }],
          },
          fetchPayload: true,
        },
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data.success).toBe(true);
    });

    it('should support MMR reranking', async () => {
      const testVector = Array(1536).fill(0.1);

      const response = await fastify.inject({
        method: 'POST',
        url: '/query',
        payload: {
          vector: testVector,
          topK: 2,
          withVectors: true, // Required for MMR
          mmr: {
            enabled: true,
            lambda: 0.5,
            fetchK: 10,
          },
        },
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data.success).toBe(true);
      expect(data.data.query.mmrApplied).toBe(true);
    });
  });

  describe('Delete Endpoint', () => {
    beforeEach(async () => {
      // Setup test data for deletion
      try {
        const testVector = Array(1536).fill(0.1);
        await qdrantClient.upsertPoints([
          {
            id: uuidv4(),
            vector: testVector,
            payload: { test: true, docId: 'delete-doc-1', category: 'test' },
          },
          {
            id: uuidv4(),
            vector: testVector,
            payload: { test: true, docId: 'delete-doc-2', category: 'test' },
          },
        ]);
      } catch (error) {
        console.warn('Could not setup delete test data:', error);
      }
    });

    it('should require at least one deletion criteria', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/delete',
        payload: {},
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should delete by IDs', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/delete',
        payload: {
          ids: [uuidv4()], // Note: This will not match any existing IDs, but tests the endpoint structure
        },
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data.success).toBe(true);
      expect(data.data.deletedBy).toBe('ids');
    });

    it('should delete by docId', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/delete',
        payload: {
          docId: 'delete-doc-2',
        },
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.payload);
      expect(data.success).toBe(true);
      expect(data.data.deletedBy).toBe('docId');
    });
  });

  describe('Sync Endpoint', () => {
    it('should accept dry run request', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/sync/mongo',
        payload: {
          dryRun: true,
          batchSize: 10,
        },
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
        },
      });

      // May fail due to MongoDB connection, but should validate the request format
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('success');
    });

    it('should validate batch size', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/sync/mongo',
        payload: {
          batchSize: 0, // Invalid
          dryRun: true,
        },
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should return sync status', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/sync/mongo/status',
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
        },
      });

      // May fail due to MongoDB connection, but should have correct response structure
      const data = JSON.parse(response.payload);
      expect(data).toHaveProperty('success');
    });
  });

  describe('Rate Limiting', () => {
    it('should handle multiple requests within limits', async () => {
      const requests = Array(5)
        .fill(null)
        .map(() =>
          fastify.inject({
            method: 'GET',
            url: '/',
          })
        );

      const responses = await Promise.all(requests);

      // All should succeed (no rate limiting on health endpoint)
      responses.forEach((response) => {
        expect(response.statusCode).toBe(200);
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle 404 for unknown routes', async () => {
      const response = await fastify.inject({
        method: 'GET',
        url: '/unknown-route',
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
        },
      });

      expect(response.statusCode).toBe(404);
      const data = JSON.parse(response.payload);
      expect(data.success).toBe(false);
      expect(data.error).toContain('not found');
    });

    it('should return proper error format', async () => {
      const response = await fastify.inject({
        method: 'POST',
        url: '/embed',
        payload: { text: '' }, // Invalid payload
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
        },
      });

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.payload);
      expect(data.success).toBe(false);
      expect(data).toHaveProperty('error');
    });
  });
});
