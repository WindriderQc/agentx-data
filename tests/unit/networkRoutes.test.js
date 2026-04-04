const request = require('supertest');
const express = require('express');

jest.mock('../../services/networkScanner', () => ({
  scanNetwork: jest.fn(),
  enrichDevice: jest.fn()
}));

const networkScanner = require('../../services/networkScanner');
const networkRoutes = require('../../routes/network.routes');

function buildDb(overrides = {}) {
  const collection = {
    bulkWrite: jest.fn().mockResolvedValue({}),
    find: jest.fn(() => ({
      sort: jest.fn(() => ({
        toArray: jest.fn().mockResolvedValue([])
      }))
    })),
    findOne: jest.fn(),
    updateOne: jest.fn().mockResolvedValue({}),
    ...overrides
  };

  return {
    collection: jest.fn(() => collection),
    _collection: collection
  };
}

function buildApp(db) {
  const app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use('/api/v1/network', networkRoutes);
  app.use((err, req, res, _next) => {
    res.status(500).json({ status: 'error', message: err.message });
  });
  return app;
}

function createMissingDependencyError() {
  const error = new Error('nmap is not installed on the host. Install nmap to use network scanning.');
  error.code = 'DEPENDENCY_MISSING';
  error.dependency = 'nmap';
  return error;
}

describe('POST /api/v1/network/scan', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns 400 for an invalid scan target', async () => {
    const res = await request(buildApp(buildDb()))
      .post('/api/v1/network/scan')
      .send({ target: '--top-ports 10' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Invalid target format/);
    expect(networkScanner.scanNetwork).not.toHaveBeenCalled();
  });

  test('returns scan totals when discovery succeeds', async () => {
    const db = buildDb();
    networkScanner.scanNetwork.mockResolvedValue([
      { ip: '192.168.2.10', mac: 'AA:BB:CC:DD:EE:FF', hostname: 'printer', vendor: 'HP' }
    ]);

    const res = await request(buildApp(db))
      .post('/api/v1/network/scan')
      .send({ target: '192.168.2.0/24' });

    expect(res.status).toBe(200);
    expect(res.body.data.discovered).toBe(1);
    expect(res.body.data.updated).toBe(1);
    expect(db._collection.bulkWrite).toHaveBeenCalledTimes(1);
  });

  test('returns 503 when nmap is missing', async () => {
    networkScanner.scanNetwork.mockRejectedValue(createMissingDependencyError());

    const res = await request(buildApp(buildDb()))
      .post('/api/v1/network/scan')
      .send({ target: '192.168.2.0/24' });

    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/Scan unavailable/);
    expect(res.body.message).toMatch(/nmap is not installed/);
  });
});

describe('POST /api/v1/network/devices/:id/enrich', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns 503 when nmap is missing', async () => {
    const db = buildDb({
      findOne: jest.fn().mockResolvedValue({
        _id: 'device-1',
        mac: 'AA:BB:CC:DD:EE:FF',
        ip: '192.168.2.10',
        status: 'online'
      })
    });
    networkScanner.enrichDevice.mockRejectedValue(createMissingDependencyError());

    const res = await request(buildApp(db))
      .post('/api/v1/network/devices/AA:BB:CC:DD:EE:FF/enrich');

    expect(res.status).toBe(503);
    expect(res.body.message).toMatch(/Enrichment unavailable/);
    expect(res.body.message).toMatch(/nmap is not installed/);
  });
});
