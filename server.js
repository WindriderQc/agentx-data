require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { MongoClient } = require('mongodb');
const { log } = require('./utils/logger');
const { ensureIndexes } = require('./utils/indexes');
const errorHandler = require('./middleware/errorHandler');
const apiKeyAuth = require('./middleware/apiKeyAuth');
const { general: generalLimiter, heavy: heavyLimiter } = require('./middleware/rateLimiter');
const storageController = require('./controllers/storageController');
const liveData = require('./services/liveData');
const janitorScheduler = require('./services/janitorScheduler');
const eventController = require('./controllers/eventController');
const pjson = require('./package.json');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3083;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://192.168.2.33:27017/agentx';

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

// Health
app.get('/', (req, res) => res.redirect('/health'));
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'agentx-data', version: pjson.version, ts: Date.now() });
});

// API key authentication (when DATA_API_KEY is set)
app.use(apiKeyAuth);

// Rate limiting
app.use('/api/', generalLimiter);
app.use('/api/v1/storage/scan', heavyLimiter);
app.use('/api/v1/network/scan', heavyLimiter);
app.use('/api/v1/janitor/analyze', heavyLimiter);
app.use('/api/v1/janitor/dedup-scan', heavyLimiter);

// API routes
app.use('/api/v1/storage', require('./routes/storage.routes'));
app.use('/api/v1/system', require('./routes/system.routes'));
app.use('/api/v1/network', require('./routes/network.routes'));
app.use('/api/v1/events', require('./routes/events.routes'));
app.use('/api/v1/livedata', require('./routes/livedata.routes'));
app.use('/api/v1/databases', require('./routes/databases.routes'));
app.use('/api/v1/exports', require('./routes/exports.routes'));
app.use('/api/v1/janitor', require('./routes/janitor.routes'));
app.use('/api/v1/janitor/profiles', require('./routes/janitor-profiles.routes'));
app.use('/api/v1/integrations', require('./routes/integrations.routes'));

// Error handler
app.use(errorHandler);

// Database + server startup
let client;
let server;

async function start() {
  log(`Starting agentx-data v${pjson.version} (${process.env.NODE_ENV || 'development'})`);

  client = new MongoClient(MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    heartbeatFrequencyMS: 10000
  });
  await client.connect();
  // Sanitize URI for logging — strip credentials
  const safeUri = MONGODB_URI.replace(/\/\/[^@]*@/, '//<credentials>@');
  log(`Connected to MongoDB at ${safeUri}`);

  // Log topology events for monitoring
  client.on('serverHeartbeatFailed', (ev) => log(`[MongoDB] Heartbeat failed: ${ev.failure?.message}`, 'warn'));
  client.on('topologyOpening', () => log('[MongoDB] Topology opening'));
  client.on('topologyClosed', () => log('[MongoDB] Topology closed'));

  // Parse DB name from URI or default to 'agentx'
  const dbName = new URL(MONGODB_URI).pathname.slice(1) || 'agentx';
  const db = client.db(dbName);
  app.locals.db = db;

  await ensureIndexes(db);

  // Cleanup stale scans from previous session
  await storageController.cleanupStaleScans(db);

  server = app.listen(PORT, async () => {
    log(`agentx-data listening on port ${PORT}`);

    // Initialize live data after server is up (interval-based fetchers)
    if (process.env.NODE_ENV !== 'test') {
      try { await liveData.init(db); }
      catch (e) { log(`[liveData] Init failed: ${e.message}`, 'warn'); }
      try { await janitorScheduler.init(db); }
      catch (e) { log(`[janitorScheduler] Init failed: ${e.message}`, 'warn'); }
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`Port ${PORT} is already in use.`, 'error');
      process.exit(1);
    }
    log(`Server error: ${err.message}`, 'error');
    process.exit(1);
  });
}

async function shutdown() {
  log('Shutting down agentx-data...');
  try { eventController.drainSSE(); } catch (e) { log(`[shutdown] drainSSE error: ${e.message}`, 'warn'); }
  try { await liveData.close(); } catch (e) { log(`[shutdown] liveData.close error: ${e.message}`, 'warn'); }
  try { await janitorScheduler.close(); } catch (e) { log(`[shutdown] janitorScheduler.close error: ${e.message}`, 'warn'); }
  if (server) {
    await new Promise(r => server.close(r));
  }
  if (client) {
    try { await client.close(); } catch (e) { log(`[shutdown] MongoDB close error: ${e.message}`, 'warn'); }
  }
  log('agentx-data shut down.');
}

process.on('SIGINT', async () => {
  const timer = setTimeout(() => { log('Shutdown timed out, forcing exit', 'error'); process.exit(1); }, 10000);
  await shutdown();
  clearTimeout(timer);
  process.exit(0);
});
process.on('SIGTERM', async () => {
  const timer = setTimeout(() => { log('Shutdown timed out, forcing exit', 'error'); process.exit(1); }, 10000);
  await shutdown();
  clearTimeout(timer);
  process.exit(0);
});
process.on('unhandledRejection', (reason) => {
  log(`Unhandled rejection: ${reason?.message || reason}`, 'error');
});

if (require.main === module) {
  start().catch(err => {
    log(`Failed to start: ${err.message}`, 'error');
    process.exit(1);
  });
}

module.exports = { app, start, shutdown };
