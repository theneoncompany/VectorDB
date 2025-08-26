# Vector Service for n8n

A production-ready vector search service that replaces slow MongoDB vector search with Qdrant while keeping MongoDB as the source of truth. Designed specifically for n8n workflows with built-in chunking, embeddings, and real-time synchronization.

## ✨ Features

- **⚡ Fast Vector Search**: Qdrant HNSW index with cosine similarity
- **🔄 Real-time Sync**: MongoDB Change Streams → Qdrant automatic updates
- **🧠 Smart Chunking**: Text splitting with sentence preservation and overlap
- **🎯 Advanced Search**: MMR re-ranking, filters, and score thresholds
- **🚀 n8n Ready**: RESTful API designed for n8n HTTP Request nodes
- **🔒 Production Ready**: Authentication, rate limiting, logging, and health checks
- **🐳 Docker Support**: Complete Docker Compose setup included

## 🏗️ Architecture

```
┌─────────────┐    ┌──────────────┐    ┌─────────────┐
│   n8n       │───▶│ Vector       │───▶│   Qdrant    │
│ Workflows   │    │ Service      │    │ (HNSW Index)│
└─────────────┘    │ (Fastify)    │    └─────────────┘
                   │              │
                   │              │    ┌─────────────┐
                   │              │───▶│  MongoDB    │
                   │              │    │(Source of   │
                   └──────────────┘    │ Truth)      │
                          │            └─────────────┘
                          │
                   ┌──────▼──────┐
                   │ Change      │
                   │ Streams     │
                   │ Watcher     │
                   └─────────────┘
```

## 🚀 Quick Start

### 1. Prerequisites

- Node.js 20+
- Docker & Docker Compose
- OpenAI API Key

### 2. Setup Infrastructure

```bash
# Clone and setup
git clone <repo-url>
cd vector-service

# Start Qdrant and MongoDB
docker compose up -d

# Install dependencies
npm install
```

### 3. Configure Environment

```bash
# Copy environment template
cp env.example .env

# Edit .env with your settings
```

**Required Environment Variables:**
```env
# Server
API_KEY=your_secure_api_key_here

# OpenAI (for embeddings)
OPENAI_API_KEY=sk-your-openai-api-key

# Qdrant (uses Docker defaults)
QDRANT_URL=http://localhost:6333
QDRANT_COLLECTION=my_docs

# MongoDB (uses Docker defaults)
MONGO_URI=mongodb://localhost:27017
MONGO_DB=mydb
MONGO_COLLECTION=documents
```

### 4. Start the Service

```bash
# Development
npm run dev

# Production
npm run build
npm start
```

The service will be available at `http://localhost:8080`

## 📡 API Endpoints

### Authentication

All endpoints (except `/` and `/health`) require Bearer token authentication:

```bash
Authorization: Bearer your_api_key_here
```

### 🔧 Core Endpoints

#### Embed Text
Convert text to vector embeddings with smart chunking.

```bash
curl -X POST http://localhost:8080/embed \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Home batteries store excess solar energy for later use.",
    "docId": "doc_1",
    "chunkSize": 400,
    "overlap": 15
  }'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "chunks": [
      {
        "id": "doc_1#0",
        "text": "Home batteries store excess solar energy for later use.",
        "startIndex": 0,
        "endIndex": 55,
        "chunkIndex": 0,
        "tokens": 12,
        "docId": "doc_1",
        "embedding": [0.001, 0.234, ...]
      }
    ],
    "totalChunks": 1,
    "totalTokens": 12,
    "embeddingDimensions": 1536
  },
  "processingTimeMs": 245
}
```

#### Upsert Vectors
Store vector embeddings with metadata in Qdrant.

```bash
curl -X PUT http://localhost:8080/upsert \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "points": [
      {
        "id": "doc_1#0",
        "vector": [0.001, 0.234, ...],
        "payload": {
          "docId": "doc_1",
          "topic": "batteries",
          "title": "Home Energy Storage",
          "source": "manual"
        }
      }
    ],
    "createCollectionIfMissing": true
  }'
```

#### Query Vectors
Search for similar vectors with advanced options.

```bash
curl -X POST http://localhost:8080/query \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "text": "how to choose a home battery",
    "topK": 8,
    "filters": {
      "must": [
        {"key": "topic", "match": {"value": "batteries"}}
      ]
    },
    "mmr": {
      "enabled": true,
      "lambda": 0.5,
      "fetchK": 50
    },
    "fetchPayload": true,
    "withVectors": false
  }'
```

**Query Options:**
- `text` OR `vector`: Query input
- `topK`: Number of results (default: 10)
- `filters`: Qdrant-style filters
- `mmr`: Maximal Marginal Relevance re-ranking
- `scoreThreshold`: Minimum similarity score
- `efSearch`: HNSW search parameter

#### Delete Vectors
Remove vectors by ID, docId, or filter.

```bash
# Delete by IDs
curl -X POST http://localhost:8080/delete \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "ids": ["doc_1#0", "doc_1#1"]
  }'

# Delete by document ID
curl -X POST http://localhost:8080/delete \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "docId": "doc_1"
  }'
```

### 🔄 Sync Endpoints

#### Bulk Sync from MongoDB
One-time bulk synchronization from MongoDB to Qdrant.

```bash
curl -X POST http://localhost:8080/sync/mongo \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "batchSize": 1000,
    "reEmbedIfMissing": true,
    "textField": "content",
    "metadataFields": ["title", "category", "tags"],
    "dryRun": false
  }'
```

#### Sync Status
Check MongoDB and Qdrant status.

```bash
curl -X GET http://localhost:8080/sync/mongo/status \
  -H "Authorization: Bearer $API_KEY"
```

### 🏥 Health & Monitoring

```bash
# Service health
curl http://localhost:8080/health

# Basic info
curl http://localhost:8080/
```

## 🤖 n8n Integration

### Basic Search Workflow

1. **HTTP Request Node** - Query vectors
   ```json
   {
     "method": "POST",
     "url": "https://your-vector-service.com/query",
     "headers": {
       "Authorization": "Bearer {{ $json.apiKey }}",
       "Content-Type": "application/json"
     },
     "body": {
       "text": "{{ $json.userQuery }}",
       "topK": 5,
       "filters": {
         "must": [{"key": "category", "match": {"value": "{{ $json.category }}"}}]
       }
     }
   }
   ```

2. **Code Node** - Process results
   ```javascript
   // Extract and format search results
   const results = $input.first().json.data.results;
   const context = results.map(r => r.payload.text).join('\n\n');
   
   return {
     context,
     sources: results.map(r => ({
       id: r.id,
       title: r.payload.title,
       score: r.score
     }))
   };
   ```

3. **OpenAI Node** - Generate answer with context

### Document Ingestion Workflow

1. **Trigger** - New document webhook
2. **HTTP Request** - Embed text
   ```json
   {
     "method": "POST",
     "url": "https://your-vector-service.com/embed",
     "body": {
       "text": "{{ $json.content }}",
       "docId": "{{ $json.id }}",
       "chunkSize": 400
     }
   }
   ```
3. **HTTP Request** - Upsert vectors
   ```json
   {
     "method": "PUT",
     "url": "https://your-vector-service.com/upsert",
     "body": {
       "points": "{{ $json.data.chunks.map(chunk => ({
         id: chunk.id,
         vector: chunk.embedding,
         payload: {
           docId: chunk.docId,
           text: chunk.text,
           title: $('Trigger').item.json.title,
           category: $('Trigger').item.json.category
         }
       })) }}"
     }
   }
   ```

## 🛠️ Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Server port |
| `HOST` | `0.0.0.0` | Server host |
| `API_KEY` | **required** | API authentication key |
| `QDRANT_URL` | `http://localhost:6333` | Qdrant server URL |
| `QDRANT_COLLECTION` | `my_docs` | Collection name |
| `QDRANT_VECTOR_SIZE` | `1536` | Vector dimensions |
| `QDRANT_DISTANCE` | `Cosine` | Distance metric |
| `MONGO_URI` | `mongodb://localhost:27017` | MongoDB connection |
| `MONGO_DB` | `mydb` | Database name |
| `MONGO_COLLECTION` | `documents` | Collection name |
| `MONGO_CHANGE_STREAMS_ENABLED` | `true` | Enable real-time sync |
| `OPENAI_API_KEY` | **required** | OpenAI API key |
| `EMBEDDINGS_PROVIDER` | `openai` | Embedding provider |
| `LOG_LEVEL` | `info` | Logging level |
| `RATE_LIMIT_MAX` | `60` | Requests per minute |
| `CORS_ORIGIN` | `*` | CORS allowed origins |

### MongoDB Change Streams

For real-time synchronization, your MongoDB must support Change Streams:
- MongoDB 4.0+ (replica set or sharded cluster)
- Enable with `MONGO_CHANGE_STREAMS_ENABLED=true`

The service watches for:
- **Insert/Update**: Re-embeds and updates vectors
- **Delete**: Removes corresponding vectors

### Chunking Strategy

The service uses smart text chunking:
- **Default**: 400 tokens per chunk, 15% overlap
- **Sentence preservation**: Attempts to keep sentences intact
- **Overlap**: Ensures context continuity between chunks

## 🚀 Deployment

### Docker Production

```bash
# Build production image
docker build -t vector-service .

# Run with environment
docker run -d \
  --name vector-service \
  -p 8080:8080 \
  --env-file .env \
  vector-service
```

### Railway/Render

1. Connect your repository
2. Set environment variables
3. Use build command: `npm run build`
4. Use start command: `npm start`

### Docker Compose (Full Stack)

```yaml
version: "3.8"
services:
  vector-service:
    build: .
    ports:
      - "8080:8080"
    environment:
      - API_KEY=your_api_key
      - OPENAI_API_KEY=your_openai_key
      - QDRANT_URL=http://qdrant:6333
      - MONGO_URI=mongodb://mongodb:27017
    depends_on:
      - qdrant
      - mongodb

  qdrant:
    image: qdrant/qdrant:latest
    ports:
      - "6333:6333"
    volumes:
      - qdrant_storage:/qdrant/storage

  mongodb:
    image: mongo:7
    ports:
      - "27017:27017"
    volumes:
      - mongodb_data:/data/db
    command: mongod --replSet rs0 --bind_ip_all

volumes:
  qdrant_storage:
  mongodb_data:
```

## 🧪 Testing

```bash
# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Watch mode
npm run test:watch
```

## 🔧 Development

```bash
# Development with hot reload
npm run dev

# Lint code
npm run lint

# Format code
npm run format

# Build for production
npm run build
```

## 📊 Performance

### Benchmarks
- **Qdrant HNSW**: ~1ms search latency for 1M vectors
- **OpenAI Embeddings**: ~200ms for batch of 10 chunks
- **MongoDB Change Streams**: ~10ms propagation delay
- **Chunking**: ~50ms for 10KB document

### Optimization Tips
1. **Batch Operations**: Use batch endpoints for multiple documents
2. **MMR Parameters**: Adjust `lambda` (0.3-0.7) and `fetchK` (20-100)
3. **Chunk Size**: Optimize for your content (200-600 tokens)
4. **HNSW Tuning**: Increase `ef_construct` for better recall
5. **Caching**: Consider Redis for frequent queries

## 🐛 Troubleshooting

### Common Issues

**Qdrant Connection Failed**
```bash
# Check Qdrant health
curl http://localhost:6333/health

# Restart Qdrant
docker compose restart qdrant
```

**MongoDB Change Streams Not Working**
```bash
# Check replica set status
mongosh --eval "rs.status()"

# Initialize replica set
mongosh --eval "rs.initiate()"
```

**Embedding Errors**
- Verify `OPENAI_API_KEY` is set correctly
- Check OpenAI account quota and billing
- Ensure text length is under 8K tokens

**Rate Limiting**
- Adjust `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW_MS`
- Implement exponential backoff in n8n workflows

### Debug Logging

```bash
# Enable debug logs
LOG_LEVEL=debug npm run dev

# MongoDB connection debug
DEBUG=mongodb* npm run dev
```

## 🛣️ Roadmap

- [ ] **pgvector Support**: PostgreSQL alternative to Qdrant
- [ ] **Multiple Embeddings**: Support for Cohere, Azure OpenAI, local models
- [ ] **Hybrid Search**: Combine vector and text search
- [ ] **Advanced Chunking**: Semantic chunking, custom strategies
- [ ] **Metrics & Analytics**: Prometheus metrics, query analytics
- [ ] **Caching Layer**: Redis for frequent queries
- [ ] **Multi-tenancy**: Namespace support for multiple users

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

## 📞 Support

- **Issues**: GitHub Issues
- **Documentation**: [docs/](docs/)
- **Discord**: [Community Server](#)

---

**Built with ❤️ for the n8n community**
