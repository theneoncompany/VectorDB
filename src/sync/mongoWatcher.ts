import { MongoClient, Db, Collection, ChangeStream, ChangeStreamDocument } from 'mongodb';
import { qdrantClient } from '../qdrant.js';
import { embeddingProvider } from '../embeddings/openai.js';
import { textChunker } from '../chunk/textChunker.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

interface MongoDocument {
  _id: any;
  [key: string]: any;
}

export class MongoChangeStreamsWatcher {
  private client: MongoClient | null = null;
  private changeStream: ChangeStream | null = null;
  private isRunning = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 5000; // 5 seconds

  constructor(
    private options: {
      textField?: string;
      metadataFields?: string[];
      chunkSize?: number;
      overlap?: number;
    } = {}
  ) {
    this.options = {
      textField: 'text',
      metadataFields: [],
      chunkSize: 400,
      overlap: 15,
      ...options,
    };
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Change streams watcher is already running');
      return;
    }

    if (!config.MONGO_CHANGE_STREAMS_ENABLED) {
      logger.info('MongoDB change streams are disabled');
      return;
    }

    try {
      await this.connect();
      await this.setupChangeStream();
      this.isRunning = true;
      this.reconnectAttempts = 0;
      
      logger.info('MongoDB change streams watcher started successfully');
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to start change streams watcher');
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    try {
      if (this.changeStream) {
        await this.changeStream.close();
        this.changeStream = null;
      }

      if (this.client) {
        await this.client.close();
        this.client = null;
      }

      logger.info('MongoDB change streams watcher stopped');
    } catch (error: any) {
      logger.error({ error: error.message }, 'Error stopping change streams watcher');
    }
  }

  private async connect(): Promise<void> {
    this.client = new MongoClient(config.MONGO_URI, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 10000,
      heartbeatFrequencyMS: 10000,
    });

    await this.client.connect();
    logger.debug('Connected to MongoDB for change streams');
  }

  private async setupChangeStream(): Promise<void> {
    if (!this.client) {
      throw new Error('MongoDB client not connected');
    }

    const db: Db = this.client.db(config.MONGO_DB);
    const collection: Collection<MongoDocument> = db.collection(config.MONGO_COLLECTION);

    // Watch for insert, update, and delete operations
    this.changeStream = collection.watch(
      [
        {
          $match: {
            operationType: { $in: ['insert', 'update', 'delete'] },
          },
        },
      ],
      {
        fullDocument: 'updateLookup', // Get full document for updates
        maxAwaitTimeMS: 30000, // Wait up to 30 seconds for changes
      }
    );

    // Handle change stream events
    this.changeStream.on('change', this.handleChangeEvent.bind(this));
    this.changeStream.on('error', this.handleError.bind(this));
    this.changeStream.on('close', this.handleClose.bind(this));

    logger.debug('Change stream established');
  }

  private async handleChangeEvent(change: ChangeStreamDocument<MongoDocument>): Promise<void> {
    try {
      const { operationType, documentKey, fullDocument } = change;
      const docId = documentKey._id.toString();

      logger.debug({ operationType, docId }, 'Processing change event');

      switch (operationType) {
        case 'insert':
        case 'update':
          if (fullDocument) {
            await this.processDocumentUpsert(fullDocument);
          } else {
            logger.warn({ docId, operationType }, 'No full document available for upsert');
          }
          break;

        case 'delete':
          await this.processDocumentDelete(docId);
          break;

        default:
          logger.debug({ operationType }, 'Ignoring operation type');
      }
    } catch (error: any) {
      logger.error(
        { 
          error: error.message,
          changeEvent: change,
        },
        'Error processing change event'
      );
    }
  }

  private async processDocumentUpsert(doc: MongoDocument): Promise<void> {
    const docId = doc._id.toString();
    const text = doc[this.options.textField!];

    if (!text || typeof text !== 'string') {
      logger.debug({ docId, textField: this.options.textField }, 'Document missing or invalid text field');
      // Delete any existing vectors for this document
      await this.processDocumentDelete(docId);
      return;
    }

    try {
      // First, delete any existing vectors for this document
      await qdrantClient.deleteByDocId(docId);

      // Chunk the text
      const chunks = textChunker.chunkForEmbedding(text, docId, {
        chunkSize: this.options.chunkSize,
        overlap: this.options.overlap,
      });

      if (chunks.length === 0) {
        logger.debug({ docId }, 'No chunks created for document');
        return;
      }

      // Generate embeddings
      const chunkTexts = chunks.map(chunk => chunk.text);
      const embeddings = await embeddingProvider.embedBatch(chunkTexts);

      // Prepare metadata
      const baseMetadata: any = {
        docId,
        source: 'mongo',
        updatedAt: new Date().toISOString(),
      };

      // Add requested metadata fields
      for (const field of this.options.metadataFields || []) {
        if (doc[field] !== undefined) {
          baseMetadata[field] = doc[field];
        }
      }

      // Create Qdrant points
      const points = chunks.map((chunk, index) => ({
        id: chunk.id,
        vector: embeddings[index],
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

      logger.info(
        { 
          docId,
          chunks: chunks.length,
          points: points.length,
        },
        'Document vectors updated via change stream'
      );

    } catch (error: any) {
      logger.error(
        { 
          docId,
          error: error.message,
        },
        'Failed to process document upsert'
      );
    }
  }

  private async processDocumentDelete(docId: string): Promise<void> {
    try {
      await qdrantClient.deleteByDocId(docId);
      
      logger.info({ docId }, 'Document vectors deleted via change stream');
    } catch (error: any) {
      logger.error(
        { 
          docId,
          error: error.message,
        },
        'Failed to process document delete'
      );
    }
  }

  private async handleError(error: any): Promise<void> {
    logger.error({ error: error.message }, 'Change stream error');
    
    if (this.isRunning && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      
      logger.warn(
        { 
          attempt: this.reconnectAttempts,
          maxAttempts: this.maxReconnectAttempts,
          delayMs: this.reconnectDelay,
        },
        'Attempting to reconnect change stream'
      );

      // Wait before reconnecting
      await new Promise(resolve => setTimeout(resolve, this.reconnectDelay));
      
      try {
        await this.stop();
        await this.start();
      } catch (reconnectError: any) {
        logger.error(
          { error: reconnectError.message },
          'Failed to reconnect change stream'
        );
      }
    } else {
      logger.error('Max reconnection attempts reached, stopping change stream watcher');
      this.isRunning = false;
    }
  }

  private handleClose(): void {
    logger.info('Change stream closed');
    
    if (this.isRunning) {
      // Unexpected close, try to reconnect
      logger.warn('Change stream closed unexpectedly, attempting to reconnect');
      this.handleError(new Error('Change stream closed unexpectedly'));
    }
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      connected: !!this.client,
      hasChangeStream: !!this.changeStream,
      options: this.options,
    };
  }

  // Health check method
  async healthCheck(): Promise<boolean> {
    try {
      if (!this.client) return false;
      
      // Simple ping to check connection
      await this.client.db('admin').command({ ping: 1 });
      return true;
    } catch {
      return false;
    }
  }
}

// Export singleton instance
export const mongoWatcher = new MongoChangeStreamsWatcher({
  textField: 'text', // Can be configured via env vars if needed
  metadataFields: ['title', 'category', 'source', 'tags'], // Common metadata fields
});
