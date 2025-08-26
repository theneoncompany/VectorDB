import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const configSchema = z.object({
  // Server
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default('0.0.0.0'),
  API_KEY: z.string().min(1, 'API_KEY is required'),

  // Qdrant
  QDRANT_URL: z.string().url().default('http://localhost:6333'),
  QDRANT_COLLECTION: z.string().default('my_docs'),
  QDRANT_VECTOR_SIZE: z.coerce.number().default(1536),
  QDRANT_DISTANCE: z.enum(['Cosine', 'Dot', 'Euclid']).default('Cosine'),

  // MongoDB
  MONGO_URI: z.string().default('mongodb://localhost:27017'),
  MONGO_DB: z.string().default('mydb'),
  MONGO_COLLECTION: z.string().default('documents'),
  MONGO_CHANGE_STREAMS_ENABLED: z
    .string()
    .transform((val) => val === 'true')
    .default('true'),
  MONGO_READ_ONLY: z
    .string()
    .transform((val) => val === 'true')
    .default('false'),

  // Embeddings
  EMBEDDINGS_PROVIDER: z.enum(['openai']).default('openai'),
  OPENAI_API_KEY: z.string().optional(),

  // Optional: pgvector
  PGVECTOR_ENABLED: z
    .string()
    .transform((val) => val === 'true')
    .default('false'),
  DATABASE_URL: z.string().optional(),

  // Logging
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Rate Limiting
  RATE_LIMIT_MAX: z.coerce.number().default(60),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),

  // CORS
  CORS_ORIGIN: z.string().default('*'),

  // Google Sheets Integration
  GCP_SERVICE_ACCOUNT_JSON: z.string().optional(),
  SHEET_ID: z.string().optional(),
  GOOGLE_SHEETS_SYNC_ENABLED: z
    .string()
    .transform((val) => val === 'true')
    .default('false'),
  GOOGLE_SHEETS_SYNC_INTERVAL_MINUTES: z.coerce.number().default(60),
});

export type Config = z.infer<typeof configSchema>;

function validateConfig(): Config {
  const result = configSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Invalid configuration:');
    result.error.issues.forEach((issue) => {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    });
    process.exit(1);
  }

  // Additional validation
  if (result.data.EMBEDDINGS_PROVIDER === 'openai' && !result.data.OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY is required when EMBEDDINGS_PROVIDER=openai');
    process.exit(1);
  }

  if (result.data.PGVECTOR_ENABLED && !result.data.DATABASE_URL) {
    console.error('❌ DATABASE_URL is required when PGVECTOR_ENABLED=true');
    process.exit(1);
  }

  return result.data;
}

export const config = validateConfig();

// Feature flags
export const features = {
  pgvector: config.PGVECTOR_ENABLED,
  mongoChangeStreams: config.MONGO_CHANGE_STREAMS_ENABLED,
  mongoReadOnly: config.MONGO_READ_ONLY,
} as const;
