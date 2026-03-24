const appEmitter = require('../utils/eventEmitter');

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
    console.error(`[events] Failed to log: "${message}"`, error);
  }
}

// --- REST endpoints ---

exports.getEvents = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const limit = parseInt(req.query.limit) || 50;
    const type = req.query.type;

    const filter = type ? { type } : {};
    const events = await db.collection('appevents')
      .find(filter).sort({ timestamp: -1 }).limit(limit).toArray();

    res.json({ status: 'success', data: { events, count: events.length } });
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
      console.error('[events] SSE write error:', e);
    }
  };

  appEmitter.on('newEvent', sendEvent);

  const heartbeat = setInterval(() => { res.write(': heartbeat\n\n'); }, 15000);

  req.on('close', () => {
    appEmitter.removeListener('newEvent', sendEvent);
    clearInterval(heartbeat);
    res.end();
  });
};

exports.logEvent = logEvent;
