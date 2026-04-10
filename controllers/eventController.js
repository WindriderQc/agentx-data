const appEmitter = require('../utils/eventEmitter');
const { log } = require('../utils/logger');

const MAX_SSE_CONNECTIONS = 50;
let sseConnectionCount = 0;
const sseConnections = new Set();

/**
 * Log an event to the database and emit for SSE subscribers.
 */
async function logEvent(db, message, type = 'info', opts = {}) {
  try {
    const doc = { message, type, timestamp: new Date() };
    if (opts.stack) doc.stack = opts.stack;
    if (opts.meta) doc.meta = opts.meta;

    await db.collection('appevents').insertOne(doc);
    appEmitter.emit('newEvent', doc);
  } catch (error) {
    log(`[events] Failed to log: "${message}" — ${error.message}`, 'error');
  }
}

// --- REST endpoints ---

exports.getEvents = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { page = 1, limit = 50 } = req.query;
    const type = req.query.type;
    const parsedPage = Math.max(1, parseInt(page));
    const parsedLimit = Math.max(1, Math.min(200, parseInt(limit)));
    const skip = (parsedPage - 1) * parsedLimit;

    const filter = type ? { type } : {};
    const col = db.collection('appevents');
    const [total, events] = await Promise.all([
      col.countDocuments(filter),
      col.find(filter).sort({ timestamp: -1 }).skip(skip).limit(parsedLimit).toArray()
    ]);

    res.json({
      status: 'success',
      data: {
        events,
        pagination: { total, page: parsedPage, limit: parsedLimit, pages: Math.ceil(total / parsedLimit) }
      }
    });
  } catch (error) { next(error); }
};

exports.createEvent = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { message, type, meta } = req.body;
    if (!message) return res.status(400).json({ status: 'error', message: 'message is required' });

    await logEvent(db, message, type || 'info', { meta });
    res.status(201).json({ status: 'success', message: 'Event logged' });
  } catch (error) { next(error); }
};

/**
 * SSE stream — pushes real-time events to connected clients.
 */
exports.streamEvents = (req, res) => {
  if (sseConnectionCount >= MAX_SSE_CONNECTIONS) {
    return res.status(503).json({ status: 'error', message: 'Too many SSE connections' });
  }
  sseConnectionCount++;
  sseConnections.add(res);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const typeFilter = req.query.type;

  const sendEvent = (data) => {
    try {
      if (typeFilter && data.type !== typeFilter) return;
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      log(`[events] SSE write error: ${e.message}`, 'error');
    }
  };

  appEmitter.on('newEvent', sendEvent);

  const heartbeat = setInterval(() => { res.write(': heartbeat\n\n'); }, 15000);

  req.on('close', () => {
    sseConnectionCount--;
    sseConnections.delete(res);
    appEmitter.removeListener('newEvent', sendEvent);
    clearInterval(heartbeat);
    res.end();
  });
};

/**
 * Close all active SSE connections — call during graceful shutdown.
 */
exports.drainSSE = () => {
  for (const res of sseConnections) {
    try { res.end(); } catch { /* already closed */ }
  }
  sseConnections.clear();
  sseConnectionCount = 0;
};


