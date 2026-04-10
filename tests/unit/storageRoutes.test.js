/**
 * Route tests for storage scanner endpoints.
 */
const request = require('supertest');
const express = require('express');

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  log: jest.fn()
}));

jest.mock('../../services/janitorService', () => ({
  resolveAllowedPath: jest.fn()
}));

jest.mock('../../services/scanner', () => ({
  Scanner: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    run: jest.fn().mockResolvedValue(),
    stop: jest.fn()
  }))
}));

jest.mock('../../utils/fetch-utils', () => ({
  fetchWithTimeoutAndRetry: jest.fn().mockResolvedValue({ ok: true })
}));

jest.mock('../../utils/file-operations', () => ({
  formatFileSize: jest.fn(n => `${n} B`)
}));

const storageRoutes = require('../../routes/storage.routes');
const { resolveAllowedPath } = require('../../services/janitorService');
const errorHandler = require('../../middleware/errorHandler');

function buildApp(overrides = {}) {
  const app = express();
  app.use(express.json());

  const makeCol = (name) => ({
    find: jest.fn(() => ({
      sort: jest.fn(() => ({
        skip: jest.fn(() => ({
          limit: jest.fn(() => ({
            toArray: jest.fn().mockResolvedValue(overrides.scans || [])
          }))
        }))
      }))
    })),
    findOne: jest.fn().mockResolvedValue(overrides.scanDoc || null),
    countDocuments: jest.fn().mockResolvedValue(overrides.count || 0),
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 }),
    updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
    bulkWrite: jest.fn().mockResolvedValue({ upsertedCount: 2, modifiedCount: 1 }),
    aggregate: jest.fn(() => ({
      toArray: jest.fn().mockResolvedValue(overrides.aggregate || [])
    }))
  });

  const collections = {};
  app.locals.db = {
    collection: jest.fn((name) => {
      if (!collections[name]) collections[name] = makeCol(name);
      return collections[name];
    }),
    _collections: collections,
    _makeCol: makeCol
  };

  app.use('/api/v1/storage', storageRoutes);
  app.use(errorHandler);
  return app;
}

describe('Storage Scanner Routes', () => {
  beforeEach(() => jest.clearAllMocks());

  // ── POST /scan ──

  describe('POST /api/v1/storage/scan', () => {
    test('returns 400 when roots is missing', async () => {
      const res = await request(buildApp())
        .post('/api/v1/storage/scan')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/roots/i);
    });

    test('returns 400 when roots is empty array', async () => {
      const res = await request(buildApp())
        .post('/api/v1/storage/scan')
        .send({ roots: [] });
      expect(res.status).toBe(400);
    });

    test('returns 403 for blocked path', async () => {
      resolveAllowedPath.mockResolvedValue({ ok: false, reason: 'Blocked by safety policy' });
      const res = await request(buildApp())
        .post('/api/v1/storage/scan')
        .send({ roots: ['/etc/passwd'] });
      expect(res.status).toBe(403);
    });

    test('returns 400 for non-existent path', async () => {
      resolveAllowedPath.mockResolvedValue({ ok: false, reason: 'Path does not exist' });
      const res = await request(buildApp())
        .post('/api/v1/storage/scan')
        .send({ roots: ['/nonexistent'] });
      expect(res.status).toBe(400);
    });

    test('starts scan for valid root', async () => {
      resolveAllowedPath.mockResolvedValue({ ok: true, realPath: '/mnt/datalake/media' });
      const res = await request(buildApp())
        .post('/api/v1/storage/scan')
        .send({ roots: ['/mnt/datalake/media'] });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.scan_id).toBeTruthy();
      expect(res.body.data.roots).toEqual(['/mnt/datalake/media']);
    });
  });

  // ── GET /scans ──

  describe('GET /api/v1/storage/scans', () => {
    test('returns scan list with pagination', async () => {
      const scans = [{ _id: 'scan1', status: 'complete', started_at: new Date(), finished_at: new Date() }];
      const res = await request(buildApp({ scans, count: 1 }))
        .get('/api/v1/storage/scans')
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.scans).toHaveLength(1);
      expect(res.body.data.pagination).toBeDefined();
      expect(res.body.data.pagination.page).toBe(1);
    });

    test('respects limit and skip params', async () => {
      const app = buildApp();
      await request(app).get('/api/v1/storage/scans?limit=5&skip=10').expect(200);
      expect(app.locals.db.collection).toHaveBeenCalledWith('nas_scans');
    });
  });

  // ── GET /status/:scan_id ──

  describe('GET /api/v1/storage/status/:scan_id', () => {
    test('returns 404 for unknown scan', async () => {
      const res = await request(buildApp({ scanDoc: null }))
        .get('/api/v1/storage/status/unknown123')
        .expect(404);
      expect(res.body.message).toMatch(/not found/i);
    });

    test('returns scan status', async () => {
      const scanDoc = { _id: 'abc', status: 'running', counts: { files_processed: 50 }, started_at: new Date() };
      const res = await request(buildApp({ scanDoc }))
        .get('/api/v1/storage/status/abc')
        .expect(200);
      expect(res.body.data.status).toBe('running');
      expect(res.body.data.counts.files_processed).toBe(50);
    });
  });

  // ── POST /stop/:scan_id ──

  describe('POST /api/v1/storage/stop/:scan_id', () => {
    test('returns 404 when scan is not running', async () => {
      const res = await request(buildApp())
        .post('/api/v1/storage/stop/nonexistent')
        .expect(404);
      expect(res.body.message).toMatch(/not running/i);
    });
  });

  // ── GET /summary ──

  describe('GET /api/v1/storage/summary', () => {
    test('returns storage summary', async () => {
      const app = buildApp({
        aggregate: [{ totalFiles: 100, totalSize: 1048576, hashedFiles: 50 }]
      });
      const res = await request(app)
        .get('/api/v1/storage/summary')
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveProperty('totalFiles');
      expect(res.body.data).toHaveProperty('duplicates');
    });
  });

  // ── GET /directory-count ──

  describe('GET /api/v1/storage/directory-count', () => {
    test('returns count', async () => {
      const res = await request(buildApp({ count: 42 }))
        .get('/api/v1/storage/directory-count')
        .expect(200);
      expect(res.body.data.count).toBe(42);
    });
  });

  // ── POST /scan/:scan_id/batch ──

  describe('POST /api/v1/storage/scan/:scan_id/batch', () => {
    test('returns 400 when files is missing', async () => {
      const res = await request(buildApp({ scanDoc: { _id: 'x' } }))
        .post('/api/v1/storage/scan/x/batch')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/files/i);
    });

    test('returns 404 for unknown scan', async () => {
      const res = await request(buildApp({ scanDoc: null }))
        .post('/api/v1/storage/scan/unknown/batch')
        .send({ files: [{ path: '/test/file.txt', size: 100 }] });
      expect(res.status).toBe(404);
    });

    test('inserts batch for valid scan', async () => {
      const res = await request(buildApp({ scanDoc: { _id: 'scan1' } }))
        .post('/api/v1/storage/scan/scan1/batch')
        .send({ files: [{ path: '/test/file1.txt', size: 100 }, { path: '/test/file2.txt', size: 200 }] });
      expect(res.status).toBe(200);
      expect(res.body.data.batch.received).toBe(2);
    });

    test('rejects file with empty path', async () => {
      const res = await request(buildApp({ scanDoc: { _id: 'scan1' } }))
        .post('/api/v1/storage/scan/scan1/batch')
        .send({ files: [{ path: '', size: 100 }] });
      expect(res.status).toBe(400);
    });
  });

  // ── PATCH /scan/:scan_id ──

  describe('PATCH /api/v1/storage/scan/:scan_id', () => {
    test('updates scan status', async () => {
      const res = await request(buildApp())
        .patch('/api/v1/storage/scan/scan1')
        .send({ status: 'completed', stats: { total: 100 } });
      expect(res.status).toBe(200);
      expect(res.body.data.scan_id).toBe('scan1');
    });

    test('returns 404 for unknown scan', async () => {
      const app = buildApp();
      // Override updateOne to return matchedCount: 0
      const col = app.locals.db.collection('nas_scans');
      col.updateOne = jest.fn().mockResolvedValue({ matchedCount: 0 });
      const res = await request(app)
        .patch('/api/v1/storage/scan/unknown')
        .send({ status: 'completed' });
      expect(res.status).toBe(404);
    });
  });
});
