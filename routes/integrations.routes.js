/**
 * Integrations — webhook sink for n8n, ClickUp, etc.
 */
const router = require('express').Router();

function normalizeData(data) {
  if (typeof data === 'object' && data !== null) return data;
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch { return { raw: data }; }
  }
  return { value: data };
}

// n8n event inbox
router.post('/events/n8n', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const body = { ...req.body };
    if (body.data !== undefined) body.data = normalizeData(body.data);

    const doc = { src: 'n8n', at: new Date(), body };
    await db.collection('integration_events').insertOne(doc);
    res.json({ ok: true, id: doc._id });
  } catch (err) { next(err); }
});

// Retrieve n8n events
router.get('/events/n8n', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const limit = parseInt(req.query.limit) || 100;
    const events = await db.collection('integration_events').find({ src: 'n8n' }).sort({ at: -1 }).limit(limit).toArray();
    res.json({ status: 'success', data: events });
  } catch (err) { next(err); }
});

// ClickUp webhook sink
router.post('/webhooks/clickup', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    await db.collection('integration_events').insertOne({ src: 'clickup', at: new Date(), body: req.body });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Generic webhook sink (any source)
router.post('/webhooks/:source', async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const body = { ...req.body };
    if (body.data !== undefined) body.data = normalizeData(body.data);
    await db.collection('integration_events').insertOne({ src: req.params.source, at: new Date(), body });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
