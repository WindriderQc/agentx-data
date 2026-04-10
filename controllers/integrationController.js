/**
 * Integration Controller — webhook event handling for n8n, ClickUp, etc.
 */

function normalizeData(data) {
  if (typeof data === 'object' && data !== null) return data;
  if (typeof data === 'string') {
    try { return JSON.parse(data); } catch { return { raw: data }; }
  }
  return { value: data };
}

exports.createN8nEvent = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const body = { ...req.body };
    if (body.data !== undefined) body.data = normalizeData(body.data);

    const doc = { src: 'n8n', at: new Date(), body };
    await db.collection('integration_events').insertOne(doc);
    res.json({ ok: true, id: doc._id });
  } catch (err) { next(err); }
};

exports.getN8nEvents = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const limit = parseInt(req.query.limit) || 100;
    const events = await db.collection('integration_events').find({ src: 'n8n' }).sort({ at: -1 }).limit(limit).toArray();
    res.json({ status: 'success', data: events });
  } catch (err) { next(err); }
};

exports.createClickUpEvent = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    await db.collection('integration_events').insertOne({ src: 'clickup', at: new Date(), body: req.body });
    res.json({ ok: true });
  } catch (err) { next(err); }
};

exports.createWebhookEvent = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    // Sanitize source: alphanumeric + hyphens/underscores only, max 64 chars
    const rawSource = req.params.source || 'unknown';
    const source = rawSource.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'unknown';
    const body = { ...req.body };
    if (body.data !== undefined) body.data = normalizeData(body.data);
    await db.collection('integration_events').insertOne({ src: source, at: new Date(), body });
    res.json({ ok: true });
  } catch (err) { next(err); }
};
