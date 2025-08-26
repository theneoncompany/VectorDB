# 🚀 Railway Deployment Guide

## Prerequisites

- Railway account (free tier available)
- GitHub repository with your code
- Your environment variables ready

## Step 1: Prepare Your Repository

Make sure your repository has these files:

- `package.json` with build and start scripts
- `Dockerfile` (already created)
- Environment variables documented

```bash
# Verify your package.json has the right scripts
cat package.json | grep -A 5 '"scripts"'
```

Expected scripts:

```json
{
  "scripts": {
    "build": "tsup",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts"
  }
}
```

## Step 2: Deploy to Railway

### Option A: Deploy from GitHub (Recommended)

1. **Connect Repository**:
   - Go to [Railway](https://railway.app)
   - Click "Deploy Now" → "Deploy from GitHub repo"
   - Select your repository

2. **Railway will auto-detect**:
   - Node.js project
   - Uses your Dockerfile
   - Sets up build pipeline

### Option B: Deploy with Railway CLI

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login to Railway
railway login

# Initialize project
railway init

# Deploy
railway up
```

## Step 3: Add Qdrant Service

Railway doesn't have Qdrant as a built-in service, so we'll use their Docker support:

1. **Add New Service**:
   - In your Railway project dashboard
   - Click "New Service" → "Empty Service"
   - Name it "qdrant"

2. **Configure Qdrant**:
   - Go to the qdrant service
   - In "Settings" → "Source", set:
     - **Deploy Method**: Docker Image
     - **Image**: `qdrant/qdrant:latest`
   - In "Settings" → "Networking":
     - **Port**: `6333`

3. **Configure Storage** (Important!):
   - Go to "Variables" tab
   - Add volume mount:
     - **Path**: `/qdrant/storage`
     - This ensures data persistence

## Step 4: Configure Environment Variables

In your main application service, go to "Variables" and add:

```bash
# Server Configuration
PORT=8080
NODE_ENV=production

# Frontend Control (set to 'true' to enable frontend in production)
ENABLE_FRONTEND=false

# API Security - GENERATE A STRONG KEY!
API_KEY=your-secure-api-key-here

# Qdrant Configuration (Railway internal URL)
QDRANT_URL=http://qdrant.railway.internal:6333
QDRANT_COLLECTION=my_docs
QDRANT_VECTOR_SIZE=1536
QDRANT_DISTANCE=Cosine

# MongoDB Configuration
MONGO_URI=mongodb+srv://theneoncompany-db-user:AW0J60n5HlbOgKmF@theneoncompany.qblpufd.mongodb.net
MONGO_DB=TheNeonCompany
MONGO_COLLECTION=documents
MONGO_CHANGE_STREAMS_ENABLED=false
MONGO_READ_ONLY=true

# Embeddings Configuration
EMBEDDINGS_PROVIDER=openai
OPENAI_API_KEY=your-openai-api-key-here

# Google Sheets Integration
GCP_SERVICE_ACCOUNT_JSON=your-base64-encoded-service-account-json
SHEET_ID=1f5BQFiLvtRa1qyzDk3diWRTG_xf5ZIitYx8Ore5IPFQ
GOOGLE_SHEETS_SYNC_ENABLED=true
GOOGLE_SHEETS_SYNC_INTERVAL_MINUTES=60

# Logging
LOG_LEVEL=info

# Rate Limiting
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW_MS=60000

# CORS Configuration
CORS_ORIGIN=*
```

## 🎛️ **Environment Control**

The application automatically detects the environment:

- **Development** (`NODE_ENV != 'production'`): Frontend UI enabled by default
- **Production** (`NODE_ENV = 'production'`): Frontend UI disabled by default

**Frontend Control Options:**

- Set `ENABLE_FRONTEND=true` to force-enable the frontend UI in production
- Set `ENABLE_FRONTEND=false` to disable frontend UI (API-only mode)
- Leave unset for automatic environment detection

## Step 5: Configure Networking

1. **Get Your Domain**:
   - Railway automatically provides a domain like `your-app-name.up.railway.app`
   - You can find it in "Settings" → "Domains"

2. **Custom Domain (Optional)**:
   - Add your custom domain in "Settings" → "Domains"
   - Update DNS records as shown

## Step 6: Deploy and Test

1. **Trigger Deployment**:
   - Push to your connected GitHub branch
   - Or use `railway up` if using CLI

2. **Check Deployment**:
   - View logs in Railway dashboard
   - Monitor build progress

3. **Test Your Deployment**:

```bash
# Replace with your Railway domain
RAILWAY_DOMAIN="your-app-name.up.railway.app"

# Test health endpoint
curl https://$RAILWAY_DOMAIN/health

# Test sync (with your API key)
curl -X POST https://$RAILWAY_DOMAIN/sync/sheets/default \
  -H "Authorization: Bearer wjiduihy8gf2ty9hbh2e8vr2yf9evfueb2y9bf9ih9cvmbsbdnc9efhi"

# Test search
curl -X POST https://$RAILWAY_DOMAIN/query \
  -H "Authorization: Bearer wjiduihy8gf2ty9hbh2e8vr2yf9evfueb2y9bf9ih9cvmbsbdnc9efhi" \
  -H "Content-Type: application/json" \
  -d '{"text": "neon kleuren", "topK": 3}'
```

## Step 7: Configure Auto-Deployment

Railway automatically redeploys when you push to your connected branch. To configure:

1. **Branch Settings**:
   - Go to "Settings" → "Source"
   - Set your deployment branch (usually `main` or `production`)

2. **Build Settings** (if needed):
   - Railway auto-detects, but you can override in "Settings" → "Build"
   - Build Command: `npm run build`
   - Start Command: `npm start`

## Step 8: Monitor and Scale

1. **View Metrics**:
   - Railway dashboard shows CPU, memory, and network usage
   - Set up alerts for high usage

2. **Scaling**:
   - Railway automatically handles scaling
   - Upgrade plan for higher limits if needed

3. **Logs**:
   - View real-time logs in Railway dashboard
   - Use `railway logs` CLI command

## 🎯 Railway Benefits

✅ **Easy Setup**: One-click deployment from GitHub  
✅ **Auto-Scaling**: Handles traffic spikes automatically  
✅ **Zero Config**: Detects your app type and builds accordingly  
✅ **Built-in SSL**: HTTPS enabled by default  
✅ **Environment Management**: Easy variable management  
✅ **Monitoring**: Built-in metrics and logging

## 💰 Pricing Considerations

- **Free Tier**: $5 credit monthly (enough for development)
- **Pro Plan**: $20/month for production apps
- **Usage-Based**: Pay for what you use (CPU, memory, network)

## 🔧 Troubleshooting

### Build Fails

```bash
# Check your package.json scripts
npm run build  # Should work locally

# Check Railway build logs
railway logs --deployment
```

### Service Can't Connect to Qdrant

```bash
# Verify internal URL in environment variables
QDRANT_URL=http://qdrant.railway.internal:6333

# Check if Qdrant service is running
# In Railway dashboard → qdrant service → Deployments
```

### Memory Issues

```bash
# Railway free tier has memory limits
# Monitor usage in dashboard
# Consider upgrading plan or optimizing code
```

## 🚀 Your Setup

With Railway, you get:

1. **Easy Access**: `https://your-app.up.railway.app/app`
2. **Auto-Deploy**: Push to GitHub → automatic deployment
3. **Monitoring**: Built-in metrics and alerts
4. **Scaling**: Automatic based on traffic
5. **SSL**: HTTPS enabled by default

Railway makes deployment much simpler than managing your own servers! 🎉
