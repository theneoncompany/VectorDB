import axios, { AxiosInstance } from 'axios';
import { config } from './config.js';
import { logger } from './logger.js';

export interface QdrantPoint {
  id: string;
  vector: number[];
  payload?: Record<string, any>;
}

export interface QdrantSearchResult {
  id: string;
  score: number;
  payload?: Record<string, any>;
  vector?: number[];
}

export interface QdrantFilter {
  must?: Array<{
    key: string;
    match?: { value: string | number | boolean };
    range?: { gte?: number; lte?: number; gt?: number; lt?: number };
  }>;
  should?: Array<{
    key: string;
    match?: { value: string | number | boolean };
    range?: { gte?: number; lte?: number; gt?: number; lt?: number };
  }>;
  must_not?: Array<{
    key: string;
    match?: { value: string | number | boolean };
    range?: { gte?: number; lte?: number; gt?: number; lt?: number };
  }>;
}

export class QdrantClient {
  private client: AxiosInstance;
  private collectionName: string;

  constructor() {
    this.client = axios.create({
      baseURL: config.QDRANT_URL,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
    this.collectionName = config.QDRANT_COLLECTION;

    // Add request/response logging
    this.client.interceptors.request.use((request) => {
      logger.debug({ url: request.url, method: request.method }, 'Qdrant request');
      return request;
    });

    this.client.interceptors.response.use(
      (response) => {
        logger.debug(
          { status: response.status, url: response.config.url },
          'Qdrant response'
        );
        return response;
      },
      (error) => {
        logger.error(
          {
            status: error.response?.status,
            data: error.response?.data,
            url: error.config?.url,
          },
          'Qdrant error'
        );
        return Promise.reject(error);
      }
    );
  }

  async ensureCollection(createIfMissing = true): Promise<boolean> {
    try {
      // Check if collection exists
      const response = await this.client.get(`/collections/${this.collectionName}`);
      if (response.status === 200) {
        logger.info({ collection: this.collectionName }, 'Collection exists');
        return true;
      }
    } catch (error: any) {
      if (error.response?.status === 404 && createIfMissing) {
        logger.info({ collection: this.collectionName }, 'Creating collection');
        
        try {
          await this.client.put(`/collections/${this.collectionName}`, {
            vectors: {
              size: config.QDRANT_VECTOR_SIZE,
              distance: config.QDRANT_DISTANCE,
            },
            hnsw_config: {
              m: 16,
              ef_construct: 256,
            },
            optimizers_config: {
              default_segment_number: 2,
            },
          });
          
          logger.info({ collection: this.collectionName }, 'Collection created successfully');
          return true;
        } catch (createError: any) {
          logger.error(
            { error: createError.response?.data || createError.message },
            'Failed to create collection'
          );
          return false;
        }
      } else {
        logger.error(
          { error: error.response?.data || error.message },
          'Failed to check collection'
        );
        return false;
      }
    }
    return false;
  }

  async upsertPoints(points: QdrantPoint[]): Promise<void> {
    if (points.length === 0) {
      return;
    }

    try {
      await this.client.put(`/collections/${this.collectionName}/points`, {
        points: points.map((point) => ({
          id: point.id,
          vector: point.vector,
          payload: point.payload || {},
        })),
      });

      logger.info({ count: points.length }, 'Points upserted successfully');
    } catch (error: any) {
      logger.error(
        { 
          error: error.response?.data || error.message,
          pointCount: points.length 
        },
        'Failed to upsert points'
      );
      throw new Error(`Failed to upsert points: ${error.response?.data?.status?.error || error.message}`);
    }
  }

  async search(
    vector: number[],
    topK: number = 10,
    filter?: QdrantFilter,
    withPayload = true,
    withVector = false,
    scoreThreshold?: number,
    efSearch?: number
  ): Promise<QdrantSearchResult[]> {
    try {
      const searchParams: any = {
        vector,
        limit: topK,
        with_payload: withPayload,
        with_vector: withVector,
      };

      if (filter) {
        searchParams.filter = filter;
      }

      if (scoreThreshold !== undefined) {
        searchParams.score_threshold = scoreThreshold;
      }

      if (efSearch !== undefined) {
        searchParams.params = { ef: efSearch };
      }

      const response = await this.client.post(
        `/collections/${this.collectionName}/points/search`,
        searchParams
      );

      const results = response.data.result || [];
      
      logger.debug({ resultCount: results.length, topK }, 'Search completed');
      
      return results.map((result: any) => ({
        id: result.id,
        score: result.score,
        payload: result.payload,
        vector: result.vector,
      }));
    } catch (error: any) {
      logger.error(
        { error: error.response?.data || error.message },
        'Search failed'
      );
      throw new Error(`Search failed: ${error.response?.data?.status?.error || error.message}`);
    }
  }

  async deletePoints(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    try {
      await this.client.post(`/collections/${this.collectionName}/points/delete`, {
        points: ids,
      });

      logger.info({ deletedIds: ids }, 'Points deleted successfully');
    } catch (error: any) {
      logger.error(
        { error: error.response?.data || error.message, ids },
        'Failed to delete points'
      );
      throw new Error(`Failed to delete points: ${error.response?.data?.status?.error || error.message}`);
    }
  }

  async deleteByPayloadFilter(filter: QdrantFilter): Promise<void> {
    try {
      await this.client.post(`/collections/${this.collectionName}/points/delete`, {
        filter,
      });

      logger.info({ filter }, 'Points deleted by filter');
    } catch (error: any) {
      logger.error(
        { error: error.response?.data || error.message, filter },
        'Failed to delete points by filter'
      );
      throw new Error(`Failed to delete by filter: ${error.response?.data?.status?.error || error.message}`);
    }
  }

  async deleteByDocId(docId: string): Promise<void> {
    const filter: QdrantFilter = {
      must: [
        {
          key: 'docId',
          match: { value: docId },
        },
      ],
    };

    await this.deleteByPayloadFilter(filter);
  }

  async getCollectionInfo() {
    try {
      const response = await this.client.get(`/collections/${this.collectionName}`);
      return response.data;
    } catch (error: any) {
      logger.error(
        { error: error.response?.data || error.message },
        'Failed to get collection info'
      );
      throw new Error(`Failed to get collection info: ${error.response?.data?.status?.error || error.message}`);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.client.get('/');
      return response.status === 200;
    } catch {
      return false;
    }
  }
}

export const qdrantClient = new QdrantClient();
