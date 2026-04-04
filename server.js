require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { MongoClient } = require('mongodb');
const { log } = require('./utils/logger');
const { ensureIndexes } = require('./utils/indexes');
const errorHandler = require('./middleware/errorHandler');
const storageController = require('./controllers/storageController');
const liveData = require('./services/liveData');
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

// API routes
app.use('/api/v1/storage', require('./routes/storage.routes'));
app.use('/api/v1/system', require('./routes/system.routes'));
app.use('/api/v1/network', require('./routes/network.routes'));
app.use('/api/v1/events', require('./routes/events.routes'));
app.use('/api/v1/livedata', require('./routes/livedata.routes'));
app.use('/api/v1/databases', require('./routes/databases.routes'));
app.use('/api/v1/exports', require('./routes/exports.routes'));
app.use('/api/v1/janitor', require('./routes/janitor.routes'));
app.use('/api/v1/integrations', require('./routes/integrations.routes'));

// Error handler
app.use(errorHandler);

// Database + server startup
let client;
let server;

async function start() {
  log(`Starting agentx-data v${pjson.version} (${process.env.NODE_ENV || 'development'})`);

  client = new MongoClient(MONGODB_URI);
  await client.connect();
  log(`Connected to MongoDB at ${MONGODB_URI}`);

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
  await liveData.close();
  if (server) await new Promise(r => server.close(r));
  if (client) await client.close();
  log('agentx-data shut down.');
}

process.on('SIGINT', async () => { await shutdown(); process.exit(0); });
process.on('SIGTERM', async () => { await shutdown(); process.exit(0); });

if (require.main === module) {
  start().catch(err => {
    log(`Failed to start: ${err.message}`, 'error');
    process.exit(1);
  });
}

module.exports = { app, start, shutdown };
