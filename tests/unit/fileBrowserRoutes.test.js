/**
 * Route tests for file browser endpoints.
 */
const request = require('supertest');
const express = require('express');

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  log: jest.fn()
}));

jest.mock('../../utils/file-operations', () => ({
  formatFileSize: jest.fn(n => `${n} B`)
}));

jest.mock('../../utils/fileHelpers', () => ({
  formatFilePath: jest.fn(f => f.path || `${f.dirname}/${f.filename}`)
}));

jest.mock('../../services/janitorService', () => ({
  resolveAllowedPath: jest.fn()
}));

jest.mock('../../services/scanner', () => ({
  Scanner: jest.fn()
}));

const storageRoutes = require('../../routes/storage.routes');
const errorHandler = require('../../middleware/errorHandler');

function buildApp(overrides = {}) {
  const app = express();
  app.use(express.json());

  const toArrayResult = jest.fn().mockResolvedValue(overrides.docs || []);
  const limitFn = jest.fn(() => ({ toArray: toArrayResult }));
  const skipFn = jest.fn(() => ({ limit: limitFn }));
  const sortFn = jest.fn(() => ({ skip: skipFn, limit: limitFn }));

  const makeCol = () => ({
    find: jest.fn(() => ({
      sort: sortFn,
      limit: limitFn,
      toArray: toArrayResult
    })),
    findOne: jest.fn().mockResolvedValue(overrides.doc || null),
    countDocuments: jest.fn().mockResolvedValue(overrides.count || 0),
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 }),
    findOneAndUpdate: jest.fn().mockResolvedValue(overrides.doc || { _id: 'f1', path: '/test.txt' }),
    insertOne: jest.fn().mockResolvedValue({ insertedId: 'new1' }),
    insertMany: jest.fn().mockResolvedValue({ insertedCount: 1, insertedIds: { 0: 'new1' } }),
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    aggregate: jest.fn(() => ({
      toArray: jest.fn().mockResolvedValue(overrides.aggregate || [{}])
    }))
  });

  const collections = {};
  app.locals.db = {
    collection: jest.fn((name) => {
      if (!collections[name]) collections[name] = makeCol();
      return collections[name];
    })
  };

  app.use('/api/v1/storage', storageRoutes);
  app.use(errorHandler);
  return app;
}

describe('File Browser Routes', () => {
  beforeEach(() => jest.clearAllMocks());

  // ── GET /files/browse ──

  describe('GET /api/v1/storage/files/browse', () => {
    test('returns files with pagination', async () => {
      const docs = [
        { path: '/mnt/nas/photo.jpg', filename: 'photo.jpg', dirname: '/mnt/nas', size: 1024, mtime: Date.now() / 1000 }
      ];
      const app = buildApp({ docs, count: 1 });
      const res = await request(app)
        .get('/api/v1/storage/files/browse')
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.files).toHaveLength(1);
      expect(res.body.data.pagination).toBeDefined();
      expect(res.body.data.pagination.total).toBe(1);
    });

    test('accepts search, ext, dirname filters', async () => {
      const app = buildApp({ docs: [], count: 0 });
      const res = await request(app)
        .get('/api/v1/storage/files/browse?search=test&ext=pdf&dirname=/mnt')
        .expect(200);
      expect(res.body.data.files).toHaveLength(0);
    });

    test('accepts page and limit params', async () => {
      const res = await request(buildApp())
        .get('/api/v1/storage/files/browse?page=2&limit=50')
        .expect(200);
      expect(res.body.data.pagination.page).toBe(2);
      expect(res.body.data.pagination.limit).toBe(50);
    });
  });

  // ── GET /files/tree ──

  describe('GET /api/v1/storage/files/tree', () => {
    test('returns directory tree', async () => {
      const docs = [
        { path: '/mnt/nas', file_count: 10, total_size: 5000, largest_file: 'big.zip' }
      ];
      const app = buildApp({ docs });
      const res = await request(app)
        .get('/api/v1/storage/files/tree')
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.tree).toBeDefined();
    });

    test('respects root query param', async () => {
      const res = await request(buildApp())
        .get('/api/v1/storage/files/tree?root=/mnt/nas/photos')
        .expect(200);
      expect(res.body.data.tree).toBeDefined();
    });
  });

  // ── GET /files/stats ──

  describe('GET /api/v1/storage/files/stats', () => {
    test('returns file stats', async () => {
      const aggregate = [{
        byExtension: [{ _id: 'jpg', count: 50, size: 10240 }],
        bySize: [],
        total: [{ count: 100, totalSize: 50000, avgSize: 500 }]
      }];
      const res = await request(buildApp({ aggregate }))
        .get('/api/v1/storage/files/stats')
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.total).toBeDefined();
      expect(res.body.data.byExtension).toBeDefined();
      expect(res.body.data.sizeCategories).toBeDefined();
    });
  });

  // ── GET /files/duplicates ──

  describe('GET /api/v1/storage/files/duplicates', () => {
    test('returns duplicates (fuzzy when no hashed files)', async () => {
      const app = buildApp({ count: 0, aggregate: [] });
      const res = await request(app)
        .get('/api/v1/storage/files/duplicates')
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.method).toBe('fuzzy');
      expect(res.body.data.duplicates).toBeDefined();
    });

    test('respects limit param', async () => {
      const res = await request(buildApp({ count: 0, aggregate: [] }))
        .get('/api/v1/storage/files/duplicates?limit=5')
        .expect(200);
      expect(res.body.data.duplicates).toBeDefined();
    });

    test('forces hash method with method=hash', async () => {
      const res = await request(buildApp({ count: 100, aggregate: [] }))
        .get('/api/v1/storage/files/duplicates?method=hash')
        .expect(200);
      expect(res.body.data.method).toBe('sha256');
    });
  });

  // ── GET /files/cleanup-recommendations ──

  describe('GET /api/v1/storage/files/cleanup-recommendations', () => {
    test('returns recommendations', async () => {
      const res = await request(buildApp({ docs: [], aggregate: [] }))
        .get('/api/v1/storage/files/cleanup-recommendations')
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.recommendations).toHaveLength(3);
      expect(res.body.data.recommendations.map(r => r.type))
        .toEqual(['large_files', 'old_files', 'duplicates']);
    });
  });

  // ── PATCH /files/:id ──

  describe('PATCH /api/v1/storage/files/:id', () => {
    test('updates file metadata', async () => {
      const res = await request(buildApp({ doc: { _id: 'f1', path: '/test.txt' } }))
        .patch('/api/v1/storage/files/507f1f77bcf86cd799439011')
        .send({ tags: ['backup'] });
      expect(res.status).toBe(200);
    });
  });

  // ═══════════════════════════════════════════════
  // Datalake Janitor endpoints
  // ═══════════════════════════════════════════════

  describe('POST /api/v1/storage/janitor/suggest-deletions', () => {
    test('returns duplicate suggestions', async () => {
      const aggregate = [
        { _id: 'abc123', count: 2, files: [
          { _id: 'f1', path: '/a.txt', dirname: '/mnt', filename: 'a.txt', mtime: 1000, size: 512 },
          { _id: 'f2', path: '/b.txt', dirname: '/mnt', filename: 'b.txt', mtime: 2000, size: 512 }
        ], totalSize: 512 }
      ];
      const res = await request(buildApp({ aggregate }))
        .post('/api/v1/storage/janitor/suggest-deletions')
        .send({})
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.suggestions).toHaveLength(1);
      expect(res.body.data.strategy).toBe('keep_oldest');
      expect(res.body.data.summary.duplicateGroups).toBe(1);
    });

    test('accepts strategy and minSize params', async () => {
      const res = await request(buildApp({ aggregate: [] }))
        .post('/api/v1/storage/janitor/suggest-deletions')
        .send({ strategy: 'keep_newest', minSize: 1024 })
        .expect(200);
      expect(res.body.data.strategy).toBe('keep_newest');
    });
  });

  describe('POST /api/v1/storage/janitor/mark-for-deletion', () => {
    test('marks files for deletion', async () => {
      const app = buildApp();
      const res = await request(app)
        .post('/api/v1/storage/janitor/mark-for-deletion')
        .send({ files: [{ fileId: 'f1', path: '/a.txt', reason: 'duplicate' }] })
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.insertedCount).toBeDefined();
    });

    test('rejects empty files array', async () => {
      const res = await request(buildApp())
        .post('/api/v1/storage/janitor/mark-for-deletion')
        .send({ files: [] })
        .expect(400);
      expect(res.body.message).toMatch(/files array/);
    });

    test('rejects missing files field', async () => {
      const res = await request(buildApp())
        .post('/api/v1/storage/janitor/mark-for-deletion')
        .send({})
        .expect(400);
    });
  });

  describe('GET /api/v1/storage/janitor/pending-deletions', () => {
    test('returns pending deletions', async () => {
      const docs = [{ _id: 'p1', path: '/a.txt', status: 'pending', marked_at: new Date() }];
      const res = await request(buildApp({ docs }))
        .get('/api/v1/storage/janitor/pending-deletions')
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.pending).toHaveLength(1);
      expect(res.body.data.count).toBe(1);
    });

    test('returns empty when no pending deletions', async () => {
      const res = await request(buildApp({ docs: [] }))
        .get('/api/v1/storage/janitor/pending-deletions')
        .expect(200);
      expect(res.body.data.count).toBe(0);
    });
  });

  describe('DELETE /api/v1/storage/janitor/confirm-deletion/:id', () => {
    test('requires explicit confirmation', async () => {
      const res = await request(buildApp())
        .delete('/api/v1/storage/janitor/confirm-deletion/507f1f77bcf86cd799439011')
        .send({})
        .expect(400);
      expect(res.body.message).toMatch(/confirm/i);
    });

    test('returns 404 when record not found', async () => {
      const res = await request(buildApp({ doc: null }))
        .delete('/api/v1/storage/janitor/confirm-deletion/507f1f77bcf86cd799439011')
        .send({ confirm: true })
        .expect(404);
      expect(res.body.message).toMatch(/not found/i);
    });
  });
});
