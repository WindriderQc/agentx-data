/**
 * Database Browser — inspect any MongoDB collection via API.
 * Admin/debug utility for all AgentX services.
 */

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

    let { skip = 0, limit = 50, sort = 'desc', q } = req.query;
    skip = Math.max(0, parseInt(skip) || 0);
    limit = Math.min(500, Math.max(1, parseInt(limit) || 50));
    const sortDir = sort === 'asc' ? 1 : -1;

    // Optional JSON filter via ?q={"field":"value"}
    let filter = {};
    if (q) {
      try { filter = JSON.parse(q); } catch { /* ignore bad JSON */ }
    }

    const collection = db.collection(name);
    const [total, documents] = await Promise.all([
      collection.countDocuments(filter),
      collection.find(filter).sort({ _id: sortDir }).skip(skip).limit(limit).toArray()
    ]);

    res.json({
      status: 'success',
      data: documents,
      meta: { collection: name, total, skip, limit, sort, has_more: total - (skip + limit) > 0 }
    });
  } catch (error) { next(error); }
};

exports.getDocument = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const { name, id } = req.params;
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
