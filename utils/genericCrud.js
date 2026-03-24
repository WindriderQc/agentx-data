/**
 * Generic CRUD factory — generates full REST handlers for any collection.
 * Usage: const fooCtrl = genericCrud('foos'); router.route('/foos').get(fooCtrl.getAll).post(fooCtrl.create);
 */
const { ObjectId } = require('mongodb');

module.exports = function genericCrud(collectionName) {
  return {
    getAll: async (req, res, next) => {
      try {
        const db = req.app.locals.db;
        let { skip = 0, limit = 50, sort = 'desc' } = req.query;
        skip = Math.max(0, parseInt(skip) || 0);
        limit = Math.min(500, Math.max(1, parseInt(limit) || 50));

        const query = { ...req.query };
        delete query.skip; delete query.limit; delete query.sort;

        const [total, docs] = await Promise.all([
          db.collection(collectionName).countDocuments(query),
          db.collection(collectionName).find(query).sort({ _id: sort === 'asc' ? 1 : -1 }).skip(skip).limit(limit).toArray()
        ]);

        res.json({ status: 'success', data: docs, meta: { total, skip, limit, sort, has_more: total - (skip + limit) > 0 } });
      } catch (error) { next(error); }
    },

    getById: async (req, res, next) => {
      try {
        const db = req.app.locals.db;
        const { id } = req.params;
        let filter;
        try { filter = { _id: new ObjectId(id) }; } catch { filter = { _id: id }; }

        const doc = await db.collection(collectionName).findOne(filter);
        if (!doc) return res.status(404).json({ status: 'error', message: 'Not found' });
        res.json({ status: 'success', data: doc });
      } catch (error) { next(error); }
    },

    create: async (req, res, next) => {
      try {
        const db = req.app.locals.db;
        const result = await db.collection(collectionName).insertOne(req.body);
        res.status(201).json({ status: 'success', data: { ...req.body, _id: result.insertedId } });
      } catch (error) { next(error); }
    },

    update: async (req, res, next) => {
      try {
        const db = req.app.locals.db;
        const { id } = req.params;
        let filter;
        try { filter = { _id: new ObjectId(id) }; } catch { filter = { _id: id }; }

        const result = await db.collection(collectionName).updateOne(filter, { $set: req.body });
        if (result.matchedCount === 0) return res.status(404).json({ status: 'error', message: 'Not found' });
        res.json({ status: 'success', message: 'Updated' });
      } catch (error) { next(error); }
    },

    delete: async (req, res, next) => {
      try {
        const db = req.app.locals.db;
        const { id } = req.params;
        let filter;
        try { filter = { _id: new ObjectId(id) }; } catch { filter = { _id: id }; }

        const result = await db.collection(collectionName).deleteOne(filter);
        if (result.deletedCount === 0) return res.status(404).json({ status: 'error', message: 'Not found' });
        res.json({ status: 'success', message: 'Deleted' });
      } catch (error) { next(error); }
    }
  };
};
