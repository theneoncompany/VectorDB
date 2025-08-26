import OpenAI from 'openai';
import { EmbeddingProvider } from './provider.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI;
  private model = 'text-embedding-3-small';
  private dimensions = 1536;
  private maxInputLength = 8191; // tokens

  constructor() {
    if (!config.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is required for OpenAI embedding provider');
    }

    this.client = new OpenAI({
      apiKey: config.OPENAI_API_KEY,
    });

    logger.info({ model: this.model, dimensions: this.dimensions }, 'OpenAI embedding provider initialized');
  }

  async embed(text: string): Promise<number[]> {
    try {
      const response = await this.client.embeddings.create({
        model: this.model,
        input: text,
        dimensions: this.dimensions,
      });

      const embedding = response.data[0]?.embedding;
      if (!embedding) {
        throw new Error('No embedding returned from OpenAI');
      }

      logger.debug({ textLength: text.length, embeddingLength: embedding.length }, 'Generated embedding');
      
      return embedding;
    } catch (error: any) {
      logger.error(
        { 
          error: error.message,
          textLength: text.length,
          model: this.model 
        },
        'Failed to generate embedding'
      );
      throw new Error(`OpenAI embedding failed: ${error.message}`);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    try {
      // OpenAI API supports batch requests up to 2048 inputs
      const batchSize = 100; // Conservative batch size
      const results: number[][] = [];

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        
        const response = await this.client.embeddings.create({
          model: this.model,
          input: batch,
          dimensions: this.dimensions,
        });

        const batchEmbeddings = response.data.map((item) => item.embedding);
        results.push(...batchEmbeddings);

        logger.debug(
          { 
            batchStart: i,
            batchSize: batch.length,
            totalProcessed: i + batch.length,
            totalTexts: texts.length 
          },
          'Processed embedding batch'
        );

        // Rate limiting: small delay between batches
        if (i + batchSize < texts.length) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      logger.info({ totalTexts: texts.length, totalEmbeddings: results.length }, 'Batch embedding completed');
      
      return results;
    } catch (error: any) {
      logger.error(
        { 
          error: error.message,
          textCount: texts.length,
          model: this.model 
        },
        'Failed to generate batch embeddings'
      );
      throw new Error(`OpenAI batch embedding failed: ${error.message}`);
    }
  }

  getDimensions(): number {
    return this.dimensions;
  }

  getMaxInputLength(): number {
    return this.maxInputLength;
  }

  getProviderName(): string {
    return 'openai';
  }
}

// Factory function to create the embedding provider based on config
export function createEmbeddingProvider(): EmbeddingProvider {
  switch (config.EMBEDDINGS_PROVIDER) {
    case 'openai':
      return new OpenAIEmbeddingProvider();
    default:
      throw new Error(`Unsupported embedding provider: ${config.EMBEDDINGS_PROVIDER}`);
  }
}

export const embeddingProvider = createEmbeddingProvider();
