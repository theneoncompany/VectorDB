import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { config, features } from './config.js';
import { logger } from './logger.js';
import { embedRoutes } from './routes/embed.js';
import { upsertRoutes } from './routes/upsert.js';
import { queryRoutes } from './routes/query.js';
import { deleteRoutes } from './routes/delete.js';
import { syncMongoRoutes } from './routes/syncMongo.js';
import { uploadRoutes } from './routes/upload.js';
import { syncSheetsRoutes } from './routes/syncSheets.js';
import { mongoWatcher } from './sync/mongoWatcher.js';
import { qdrantClient } from './qdrant.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fastify = Fastify({
  logger: true, // Use Fastify's built-in Pino logger
  requestIdLogLabel: 'reqId',
  requestIdHeader: 'x-request-id',
  genReqId: () => `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
});

// Register plugins
async function registerPlugins() {
  // Security headers
  await fastify.register(helmet, {
    contentSecurityPolicy: false, // Disable CSP for API
  });

  // CORS
  await fastify.register(cors, {
    origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(','),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id'],
    credentials: true,
  });

  // Multipart support for file uploads
  await fastify.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024, // 50MB max file size
    },
  });

  // Static file serving (only in development or when explicitly enabled)
  const isDevelopment = process.env.NODE_ENV !== 'production';
  const enableFrontend = process.env.ENABLE_FRONTEND === 'true' || isDevelopment;

  if (enableFrontend) {
    // Static file serving for assets
    await fastify.register(staticFiles, {
      root: path.join(__dirname, '..', 'public'),
      prefix: '/static/',
    });

    // Static file serving for the app directory (for sendFile to work)
    await fastify.register(staticFiles, {
      root: path.join(__dirname, '..', 'public'),
      prefix: '/app-assets/',
      decorateReply: false,
    });
  }

  // Rate limiting
  await fastify.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    errorResponseBuilder: (request, context) => ({
      success: false,
      error: 'Rate limit exceeded',
      retryAfter: context.after,
    }),
  });
}

// Request logging middleware
async function registerRequestLogging(): Promise<void> {
  // Add start time as early as possible
  await fastify.addHook('onRequest', async (request, reply) => {
    (request as any).startTime = Date.now();
  });

  await fastify.addHook('preHandler', async (request, reply) => {
    // Enhanced request logging
    const logData: any = {
      method: request.method,
      url: request.url,
      headers: {
        'content-type': request.headers['content-type'],
        'user-agent': request.headers['user-agent'],
        authorization: request.headers.authorization ? 'Bearer ***' : undefined,
      },
      ip: request.ip,
      reqId: request.id,
    };

    // Log request body for POST/PUT requests (but mask sensitive data)
    if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
      try {
        const body = request.body;
        if (body) {
          // Create a safe copy of the body for logging
          const safeBody = JSON.parse(JSON.stringify(body));

          // Mask sensitive fields
          if (safeBody.apiKey) safeBody.apiKey = '***';
          if (safeBody.password) safeBody.password = '***';
          if (safeBody.token) safeBody.token = '***';

          // Truncate long text fields
          if (safeBody.text && safeBody.text.length > 200) {
            safeBody.text = safeBody.text.substring(0, 200) + '... (truncated)';
          }

          logData.body = safeBody;
        }
      } catch (error) {
        logData.body = '[Failed to parse body]';
      }
    }

    // Log query parameters
    if (Object.keys(request.query as object).length > 0) {
      logData.query = request.query;
    }

    logger.info(logData, 'Incoming request');

    // Log raw request details for debugging
    logger.debug(
      {
        method: request.method,
        url: request.url,
        rawBody: request.body,
        contentType: request.headers['content-type'],
        bodyType: typeof request.body,
        bodyLength: request.headers['content-length'],
      },
      'Raw request details'
    );
  });

  // Response logging
  await fastify.addHook('onSend', async (request, reply, payload) => {
    const responseTime = Date.now() - (request as any).startTime;

    const logData: any = {
      method: request.method,
      url: request.url,
      statusCode: reply.statusCode,
      responseTime: `${responseTime}ms`,
      reqId: request.id,
    };

    // Add error details for 4xx and 5xx responses
    if (reply.statusCode >= 400) {
      try {
        const errorPayload = typeof payload === 'string' ? JSON.parse(payload) : payload;
        logData.error = errorPayload;
      } catch {
        logData.errorPayload = payload?.toString().substring(0, 200);
      }

      logger.warn(logData, 'Request failed');
    } else {
      logger.info(logData, 'Request completed');
    }
  });
}

// Authentication middleware
async function registerAuth(): Promise<void> {
  await fastify.addHook('preHandler', async (request, reply) => {
    // Skip auth for health check endpoints, static files, and frontend
    const skipAuthPaths = ['/health', '/app', '/static/', '/favicon.ico'];
    const url = request.routeOptions.url || request.url;

    if (skipAuthPaths.some((path) => url === path || url.startsWith(path))) {
      return;
    }

    const authHeader = request.headers.authorization;

    if (!authHeader) {
      reply.code(401);
      return reply.send({
        success: false,
        error: 'Missing Authorization header',
      });
    }

    const [type, token] = authHeader.split(' ');

    if (type !== 'Bearer' || token !== config.API_KEY) {
      reply.code(401);
      return reply.send({
        success: false,
        error: 'Invalid authorization token',
      });
    }

    // Add user context (could be enhanced for multi-user scenarios)
    request.user = { apiKey: token };
  });
}

// Register routes
async function registerRoutes() {
  // Check environment for frontend serving
  const isDevelopment = process.env.NODE_ENV !== 'production';
  const enableFrontend = process.env.ENABLE_FRONTEND === 'true' || isDevelopment;

  // API info endpoint
  fastify.get('/api', async () => ({
    success: true,
    data: {
      service: 'vector-service',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    },
  }));

  // Frontend application (only in development or when explicitly enabled)
  if (enableFrontend) {
    fastify.get('/app', async (request, reply) => {
      return reply.sendFile('index.html');
    });

    // Redirect root to app
    fastify.get('/', async (request, reply) => {
      return reply.redirect('/app');
    });
  } else {
    // Production mode - return API info at root
    fastify.get('/', async () => ({
      success: true,
      message: 'Vector Knowledge Base API',
      version: '1.0.0',
      environment: 'production',
      endpoints: {
        health: '/health',
        embed: '/embed',
        upsert: '/upsert',
        query: '/query',
        delete: '/delete',
        sync: '/sync/*',
      },
      documentation: 'Use API endpoints for integration. Frontend UI disabled in production.',
      timestamp: new Date().toISOString(),
    }));
  }

  fastify.get('/health', async () => {
    try {
      const qdrantHealthy = await qdrantClient.healthCheck();

      // For MongoDB, if change streams are disabled (read-only mode),
      // we only need to verify the connection works, not the watcher
      let mongoHealthy = false;
      if (config.MONGO_CHANGE_STREAMS_ENABLED) {
        mongoHealthy = await mongoWatcher.healthCheck();
      } else {
        // In read-only mode, test MongoDB connection directly
        try {
          const { MongoClient } = await import('mongodb');
          const testClient = new MongoClient(config.MONGO_URI);
          await testClient.connect();
          await testClient.db('admin').command({ ping: 1 });
          await testClient.close();
          mongoHealthy = true;
        } catch {
          mongoHealthy = false;
        }
      }

      const health = {
        success: qdrantHealthy && mongoHealthy,
        data: {
          qdrant: {
            healthy: qdrantHealthy,
            url: config.QDRANT_URL,
            collection: config.QDRANT_COLLECTION,
          },
          mongo: {
            healthy: mongoHealthy,
            changeStreamsEnabled: config.MONGO_CHANGE_STREAMS_ENABLED,
            watcherRunning: mongoWatcher.getStatus().isRunning,
          },
          embeddings: {
            provider: config.EMBEDDINGS_PROVIDER,
            dimensions: 1536, // OpenAI text-embedding-3-small
          },
          features: {
            pgvector: config.PGVECTOR_ENABLED,
            mongoChangeStreams: config.MONGO_CHANGE_STREAMS_ENABLED,
          },
        },
        timestamp: new Date().toISOString(),
      };

      return health;
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  });

  // API routes
  await fastify.register(embedRoutes);
  await fastify.register(upsertRoutes);
  await fastify.register(queryRoutes);
  await fastify.register(deleteRoutes);
  await fastify.register(syncMongoRoutes);
  await fastify.register(uploadRoutes);
  await fastify.register(syncSheetsRoutes);
}

// Error handling
async function registerErrorHandlers() {
  fastify.setErrorHandler(async (error, request, reply) => {
    logger.error(
      {
        error: error.message,
        stack: error.stack,
        reqId: request.id,
        url: request.url,
        method: request.method,
      },
      'Unhandled error'
    );

    const statusCode = error.statusCode || 500;

    reply.code(statusCode);
    return {
      success: false,
      error: statusCode === 500 ? 'Internal server error' : error.message,
      reqId: request.id,
    };
  });

  fastify.setNotFoundHandler(async (request, reply) => {
    reply.code(404);
    return {
      success: false,
      error: 'Route not found',
      path: request.url,
    };
  });
}

// Graceful shutdown
async function setupGracefulShutdown() {
  const signals = ['SIGINT', 'SIGTERM'];

  signals.forEach((signal) => {
    process.on(signal, async () => {
      logger.info({ signal }, 'Received shutdown signal');

      try {
        // Stop mongo watcher
        await mongoWatcher.stop();

        // Close Fastify server
        await fastify.close();

        logger.info('Graceful shutdown completed');
        process.exit(0);
      } catch (error: any) {
        logger.error({ error: error.message }, 'Error during shutdown');
        process.exit(1);
      }
    });
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.fatal({ reason, promise }, 'Unhandled promise rejection');
    process.exit(1);
  });
}

// Main startup function
async function start() {
  try {
    logger.info('Starting Vector Service...');

    // Register everything
    await registerPlugins();
    await registerRequestLogging();
    await registerAuth();
    await registerRoutes();
    await registerErrorHandlers();

    // Setup graceful shutdown
    setupGracefulShutdown();

    // Start the server
    await fastify.listen({
      port: config.PORT,
      host: config.HOST,
    });

    logger.info(
      {
        port: config.PORT,
        host: config.HOST,
        qdrantUrl: config.QDRANT_URL,
        mongoUri: config.MONGO_URI.replace(/\/\/.*@/, '//***:***@'), // Hide credentials in logs
        env: process.env.NODE_ENV || 'development',
      },
      'Vector Service started successfully'
    );

    // Start MongoDB change streams watcher (only if not in read-only mode)
    if (config.MONGO_CHANGE_STREAMS_ENABLED && !features.mongoReadOnly) {
      try {
        await mongoWatcher.start();
        logger.info('MongoDB change streams watcher started');
      } catch (error: any) {
        logger.warn({ error: error.message }, 'Failed to start MongoDB change streams watcher');
      }
    } else if (features.mongoReadOnly) {
      logger.info('MongoDB is in read-only mode - change streams watcher disabled');
    }

    // Verify Qdrant connection
    try {
      const qdrantHealthy = await qdrantClient.healthCheck();
      if (qdrantHealthy) {
        logger.info('Qdrant connection verified');
      } else {
        logger.warn('Qdrant health check failed');
      }
    } catch (error: any) {
      logger.warn({ error: error.message }, 'Qdrant connection verification failed');
    }
  } catch (error: any) {
    logger.fatal({ error: error.message }, 'Failed to start Vector Service');
    process.exit(1);
  }
}

// Type augmentation for request user context
declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      apiKey: string;
    };
  }
}

// Start the application
if (
  (process.argv[1] && process.argv[1].endsWith('index.ts')) ||
  (process.argv[1] && process.argv[1].endsWith('index.js'))
) {
  start().catch((error) => {
    console.error('Failed to start application:', error);
    process.exit(1);
  });
}

export { fastify, start };
