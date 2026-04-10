/**
 * Route tests for live data endpoints.
 */
const request = require('supertest');
const express = require('express');

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  log: jest.fn()
}));

jest.mock('../../services/liveData', () => ({
  getState: jest.fn(() => ({ iss: true, quakes: false })),
  reloadConfig: jest.fn().mockResolvedValue()
}));

const livedataRoutes = require('../../routes/livedata.routes');
const errorHandler = require('../../middleware/errorHandler');

function buildApp(overrides = {}) {
  const app = express();
  app.use(express.json());

  const toArrayFn = jest.fn().mockResolvedValue(overrides.docs || []);
  const col = {
    find: jest.fn(() => ({
      sort: jest.fn(() => ({
        limit: jest.fn(() => ({ toArray: toArrayFn }))
      })),
      toArray: toArrayFn
    })),
    updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 })
  };

  app.locals.db = { collection: jest.fn(() => col), _col: col };
  app.use('/api/v1/livedata', livedataRoutes);
  app.use(errorHandler);
  return app;
}

describe('Live Data Routes', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('GET /api/v1/livedata/state', () => {
    test('returns current service states', async () => {
      const res = await request(buildApp())
        .get('/api/v1/livedata/state')
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toEqual({ iss: true, quakes: false });
    });
  });

  describe('GET /api/v1/livedata/config', () => {
    test('returns config from DB', async () => {
      const docs = [
        { service: 'iss', enabled: true },
        { service: 'quakes', enabled: false }
      ];
      const res = await request(buildApp({ docs }))
        .get('/api/v1/livedata/config')
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.iss).toBe(true);
      expect(res.body.data.quakes).toBe(false);
    });
  });

  describe('POST /api/v1/livedata/config', () => {
    test('toggles valid service', async () => {
      const res = await request(buildApp())
        .post('/api/v1/livedata/config')
        .send({ service: 'iss', enabled: true })
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.message).toMatch(/iss/);
    });

    test('returns 400 for invalid service', async () => {
      const res = await request(buildApp())
        .post('/api/v1/livedata/config')
        .send({ service: 'invalid_service', enabled: true });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/Invalid service/);
    });
  });

  describe('GET /api/v1/livedata/iss', () => {
    test('returns ISS positions', async () => {
      const docs = [{ latitude: 51.5, longitude: -0.1, timeStamp: new Date() }];
      const res = await request(buildApp({ docs }))
        .get('/api/v1/livedata/iss')
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
      expect(res.body.count).toBe(1);
    });
  });

  describe('GET /api/v1/livedata/quakes', () => {
    test('returns earthquake data', async () => {
      const docs = [{ magnitude: 5.2, location: 'Pacific' }];
      const res = await request(buildApp({ docs }))
        .get('/api/v1/livedata/quakes')
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
    });
  });
});
