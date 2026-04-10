/**
 * Route tests for event feed endpoints.
 */
const request = require('supertest');
const express = require('express');

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  log: jest.fn()
}));

jest.mock('../../utils/eventEmitter', () => ({
  emit: jest.fn(),
  on: jest.fn(),
  removeListener: jest.fn()
}));

const eventRoutes = require('../../routes/events.routes');
const errorHandler = require('../../middleware/errorHandler');

function buildApp(overrides = {}) {
  const app = express();
  app.use(express.json());

  const toArrayFn = jest.fn().mockResolvedValue(overrides.docs || []);
  const limitFn = jest.fn(() => ({ toArray: toArrayFn }));
  const skipFn = jest.fn(() => ({ limit: limitFn }));
  const sortFn = jest.fn(() => ({ skip: skipFn, limit: limitFn }));
  const col = {
    find: jest.fn(() => ({
      sort: sortFn
    })),
    countDocuments: jest.fn().mockResolvedValue(overrides.count || 0),
    insertOne: jest.fn().mockResolvedValue({ insertedId: 'ev1' })
  };

  app.locals.db = { collection: jest.fn(() => col), _col: col };
  app.use('/api/v1/events', eventRoutes);
  app.use(errorHandler);
  return app;
}

describe('Event Routes', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('GET /api/v1/events', () => {
    test('returns events with pagination', async () => {
      const docs = [{ message: 'test', type: 'info', timestamp: new Date() }];
      const app = buildApp({ docs, count: 1 });
      // Override countDocuments so the pagination total works
      app.locals.db._col.countDocuments = jest.fn().mockResolvedValue(1);
      const res = await request(app)
        .get('/api/v1/events')
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.events).toHaveLength(1);
      expect(res.body.data.pagination).toBeDefined();
      expect(res.body.data.pagination.total).toBe(1);
    });

    test('accepts type filter', async () => {
      const app = buildApp();
      await request(app).get('/api/v1/events?type=error').expect(200);
      expect(app.locals.db._col.find).toHaveBeenCalledWith({ type: 'error' });
    });

    test('accepts limit param', async () => {
      await request(buildApp())
        .get('/api/v1/events?limit=10')
        .expect(200);
    });
  });

  describe('POST /api/v1/events', () => {
    test('creates event', async () => {
      const res = await request(buildApp())
        .post('/api/v1/events')
        .send({ message: 'Something happened', type: 'warn' })
        .expect(201);
      expect(res.body.status).toBe('success');
    });

    test('returns 400 without message', async () => {
      const res = await request(buildApp())
        .post('/api/v1/events')
        .send({ type: 'info' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/message/i);
    });

    test('defaults type to info', async () => {
      const res = await request(buildApp())
        .post('/api/v1/events')
        .send({ message: 'Default type test' })
        .expect(201);
      expect(res.body.status).toBe('success');
    });
  });

  describe('GET /api/v1/events/stream (SSE)', () => {
    test('sets SSE headers', (done) => {
      const app = buildApp();
      const server = app.listen(0, () => {
        const port = server.address().port;
        const http = require('http');
        const req = http.get(`http://127.0.0.1:${port}/api/v1/events/stream`, (res) => {
          expect(res.headers['content-type']).toMatch(/text\/event-stream/);
          expect(res.headers['cache-control']).toMatch(/no-cache/);
          req.destroy();
          server.close(done);
        });
      });
    }, 10000);
  });
});
