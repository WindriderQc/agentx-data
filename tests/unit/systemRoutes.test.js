/**
 * Route tests for system resource endpoints.
 */
const request = require('supertest');
const express = require('express');

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  log: jest.fn()
}));

jest.mock('pidusage', () =>
  jest.fn().mockResolvedValue({ cpu: 12.5, memory: 104857600, elapsed: 3600000, pid: 1234 })
);

const systemRoutes = require('../../routes/system.routes');
const errorHandler = require('../../middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/system', systemRoutes);
  app.use(errorHandler);
  return app;
}

describe('System Routes', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('GET /api/v1/system/resources', () => {
    test('returns process and system stats', async () => {
      const res = await request(buildApp())
        .get('/api/v1/system/resources')
        .expect(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data.process).toBeDefined();
      expect(res.body.data.process.cpu).toBe(12.5);
      expect(res.body.data.process.memory).toBe(104857600);
      expect(res.body.data.process.pid).toBe(1234);
      expect(res.body.data.system).toBeDefined();
      expect(res.body.data.system.total_mem).toBeGreaterThan(0);
      expect(res.body.data.system.cpus).toBeGreaterThan(0);
      expect(res.body.data.system.load_avg).toHaveLength(3);
      expect(res.body.data.system.platform).toBeTruthy();
      expect(res.body.data.timestamp).toBeTruthy();
    });

    test('returns 500 when pidusage fails', async () => {
      const pidusage = require('pidusage');
      pidusage.mockRejectedValueOnce(new Error('Process not found'));
      const res = await request(buildApp())
        .get('/api/v1/system/resources')
        .expect(500);
      expect(res.body.status).toBe('error');
      expect(res.body.message).toMatch(/Failed to fetch/);
    });
  });
});
