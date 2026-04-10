/**
 * Database Browser — inspect any MongoDB collection via API.
 * Admin/debug utility for all AgentX services.
 */

const { logger } = require('../utils/logger');
const { BadRequest } = require('../utils/errors');

// Collections visible via the database browser API
const ALLOWED_COLLECTIONS = new Set([
  'nas_files', 'nas_scans', 'nas_directories', 'nas_pending_deletions',
  'appevents', 'network_devices',
  'isses', 'quakes', 'pressures', 'weatherLocations',
  'integration_events', 'dedup_reports'
]);

function assertAllowedCollection(name) {
  if (!ALLOWED_COLLECTIONS.has(name)) {
    throw new BadRequest(`Collection "${name}" is not accessible via the browser API`);
  }
}

/**
 * Recursively strip MongoDB operators (keys starting with $) from a query object.
 */
function stripMongoOperators(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripMongoOperators);

  const cleaned = {};
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$')) {
      logger.warn(`Stripped MongoDB operator "${key}" from database browser query`);
      continue;
    }
    cleaned[key] = stripMongoOperators(obj[key]);
  }
  return cleaned;
}

exports.listCollections = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const collections = await db.listCollections().toArray();

    const stats = await Promise.all(
      collections.map(async (coll) => {
        try {
          const count = await db.collection(coll.name).countDocuments();
          let collStats;
          try { collStats = await db.command({ collStats: coll.name }); }
          catch { collStats = {}; }
          return {
            name: coll.name,
            count,
            size: collStats.size || 0,
            storageSize: collStats.storageSize || 0
          };
        } catch (e) {
          return { name: coll.name, count: 0, size: 0, error: e.message };
        }
      })
    );

    stats.sort((a, b) => b.count - a.count);

    res.json({
      status: 'success',
      data: {
        database: db.databaseName,
        collections: stats,
        totalCollections: stats.length
      }
    });
  } catch (error) { next(error); }
};

exports.queryCollection = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { name } = req.params;
    assertAllowedCollection(name);

    let { page = 1, limit = 50, sort = 'desc', q } = req.query;
    const parsedPage = Math.max(1, parseInt(page) || 1);
    limit = Math.min(500, Math.max(1, parseInt(limit) || 50));
    const skip = (parsedPage - 1) * limit;
    const sortDir = sort === 'asc' ? 1 : -1;

    // Optional JSON filter via ?q={"field":"value"}
    let filter = {};
    if (q) {
      try { filter = stripMongoOperators(JSON.parse(q)); }
      catch { return next(new BadRequest('Invalid JSON in q parameter')); }
    }

    const collection = db.collection(name);
    const [total, documents] = await Promise.all([
      collection.countDocuments(filter),
      collection.find(filter).sort({ _id: sortDir }).skip(skip).limit(limit).toArray()
    ]);

    res.json({
      status: 'success',
      data: documents,
      pagination: { total, page: parsedPage, limit, pages: Math.ceil(total / limit) }
    });
  } catch (error) { next(error); }
};

exports.getDocument = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { name, id } = req.params;
    assertAllowedCollection(name);
    const { ObjectId } = require('mongodb');

    let filter;
    try { filter = { _id: new ObjectId(id) }; }
    catch { filter = { _id: id }; }

    const doc = await db.collection(name).findOne(filter);
    if (!doc) return res.status(404).json({ status: 'error', message: 'Document not found' });

    res.json({ status: 'success', data: doc });
  } catch (error) { next(error); }
};

exports.getCollectionStats = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { name } = req.params;
    assertAllowedCollection(name);

    const [count, collStats] = await Promise.all([
      db.collection(name).countDocuments(),
      db.command({ collStats: name }).catch(() => ({}))
    ]);

    // Sample a document to show schema shape
    const sample = await db.collection(name).findOne({});
    const fields = sample ? Object.keys(sample) : [];

    res.json({
      status: 'success',
      data: {
        name,
        count,
        size: collStats.size || 0,
        storageSize: collStats.storageSize || 0,
        avgObjSize: collStats.avgObjSize || 0,
        indexes: collStats.nindexes || 0,
        fields
      }
    });
  } catch (error) { next(error); }
};
