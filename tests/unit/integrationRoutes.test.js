/**
 * Route tests for integration webhook endpoints.
 */
const request = require('supertest');
const express = require('express');

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  log: jest.fn()
}));

const integrationRoutes = require('../../routes/integrations.routes');
const errorHandler = require('../../middleware/errorHandler');

function buildApp(overrides = {}) {
  const app = express();
  app.use(express.json());

  const toArrayFn = jest.fn().mockResolvedValue(overrides.docs || []);
  const col = {
    find: jest.fn(() => ({
      sort: jest.fn(() => ({
        limit: jest.fn(() => ({ toArray: toArrayFn }))
      }))
    })),
    insertOne: jest.fn().mockResolvedValue({ insertedId: 'int1' })
  };

  app.locals.db = { collection: jest.fn(() => col), _col: col };
  app.use('/api/v1/integrations', integrationRoutes);
  app.use(errorHandler);
  return app;
}

describe('Integration Routes', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('POST /api/v1/integrations/events/n8n', () => {
    test('logs n8n event', async () => {
      const app = buildApp();
      const res = await request(app)
        .post('/api/v1/integrations/events/n8n')
        .send({ workflow: 'test', data: { foo: 'bar' } })
        .expect(200);
      expect(res.body.ok).toBe(true);
      expect(app.locals.db._col.insertOne).toHaveBeenCalled();
    });

    test('normalizes string data field', async () => {
      const app = buildApp();
      const res = await request(app)
        .post('/api/v1/integrations/events/n8n')
        .send({ data: '{"key":"val"}' })
        .expect(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe('GET /api/v1/integrations/events/n8n', () => {
    test('returns n8n events', async () => {
      const docs = [{ src: 'n8n', body: { test: true } }];
      const res = await request(buildApp({ docs }))
        .get('/api/v1/integrations/events/n8n')
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
    });

    test('respects limit param', async () => {
      await request(buildApp())
        .get('/api/v1/integrations/events/n8n?limit=10')
        .expect(200);
    });
  });

  describe('POST /api/v1/integrations/webhooks/clickup', () => {
    test('logs ClickUp webhook', async () => {
      const res = await request(buildApp())
        .post('/api/v1/integrations/webhooks/clickup')
        .send({ event: 'taskCreated', task_id: '123' })
        .expect(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe('POST /api/v1/integrations/webhooks/:source', () => {
    test('logs generic webhook', async () => {
      const res = await request(buildApp())
        .post('/api/v1/integrations/webhooks/github')
        .send({ action: 'push', repo: 'test' })
        .expect(200);
      expect(res.body.ok).toBe(true);
    });
  });
});
