const request = require('supertest');
const express = require('express');

jest.mock('../../utils/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
  log: jest.fn()
}));

const databasesController = require('../../controllers/databasesController');
const errorHandler = require('../../middleware/errorHandler');
const { logger } = require('../../utils/logger');

function buildCollection(overrides = {}) {
  return {
    countDocuments: jest.fn().mockResolvedValue(0),
    find: jest.fn(() => ({
      sort: jest.fn(() => ({
        skip: jest.fn(() => ({
          limit: jest.fn(() => ({
            toArray: jest.fn().mockResolvedValue([])
          }))
        }))
      }))
    })),
    ...overrides
  };
}

function buildApp(collection) {
  const app = express();
  app.use(express.json());
  const col = buildCollection(collection);
  app.locals.db = {
    collection: jest.fn(() => col),
    _col: col,
    databaseName: 'agentx',
    listCollections: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue([{ name: 'appevents' }]) })),
    command: jest.fn().mockResolvedValue({ size: 1024, storageSize: 2048 })
  };
  app.get('/collections/:name', databasesController.queryCollection);
  app.get('/collections', databasesController.listCollections);
  app.get('/collections/:name/stats', databasesController.getCollectionStats);
  app.get('/collections/:name/:id', databasesController.getDocument);
  app.use(errorHandler);
  return app;
}

describe('queryCollection — NoSQL injection sanitization', () => {
  beforeEach(() => jest.clearAllMocks());

  it('passes a normal query through unchanged', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/collections/appevents?q={"name":"test"}')
      .expect(200);

    expect(res.body.status).toBe('success');
    const col = app.locals.db._col;
    expect(col.countDocuments).toHaveBeenCalledWith({ name: 'test' });
  });

  it('strips $gt operator from query', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/collections/appevents?q={"age":{"$gt":5}}')
      .expect(200);

    expect(res.body.status).toBe('success');
    const col = app.locals.db._col;
    // $gt stripped, inner object becomes empty
    expect(col.countDocuments).toHaveBeenCalledWith({ age: {} });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('$gt'));
  });

  it('strips $where operator from query', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/collections/appevents?q={"$where":"1==1"}')
      .expect(200);

    expect(res.body.status).toBe('success');
    const col = app.locals.db._col;
    // $where stripped entirely
    expect(col.countDocuments).toHaveBeenCalledWith({});
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('$where'));
  });

  it('returns 400 for malformed JSON', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/collections/appevents?q=invalid_json')
      .expect(400);

    expect(res.body.status).toBe('error');
    expect(res.body.errors).toMatch(/Invalid JSON/i);
  });

  it('strips nested MongoDB operators', async () => {
    const app = buildApp();
    await request(app)
      .get('/collections/appevents?q={"a":{"b":{"$regex":".*"}}}')
      .expect(200);

    const col = app.locals.db._col;
    expect(col.countDocuments).toHaveBeenCalledWith({ a: { b: {} } });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('$regex'));
  });
});

describe('Collection allowlist', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects disallowed collection in queryCollection', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/collections/livedataconfigs')
      .expect(400);
    expect(res.body.errors).toMatch(/not accessible/i);
  });

  it('rejects disallowed collection in getCollectionStats', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/collections/system.users/stats')
      .expect(400);
    expect(res.body.errors).toMatch(/not accessible/i);
  });

  it('rejects disallowed collection in getDocument', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/collections/livedataconfigs/abc123')
      .expect(400);
    expect(res.body.errors).toMatch(/not accessible/i);
  });

  it('allows whitelisted collection names', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/collections/appevents')
      .expect(200);
    expect(res.body.status).toBe('success');
  });
});

describe('listCollections', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns collection list with stats', async () => {
    const app = buildApp();
    const res = await request(app)
      .get('/collections')
      .expect(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.database).toBe('agentx');
    expect(res.body.data.collections).toBeDefined();
    expect(res.body.data.totalCollections).toBeGreaterThanOrEqual(0);
  });
});

describe('getDocument', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns 404 when document not found', async () => {
    const app = buildApp({ findOne: jest.fn().mockResolvedValue(null) });
    const res = await request(app)
      .get('/collections/appevents/507f1f77bcf86cd799439011')
      .expect(404);
    expect(res.body.message).toMatch(/not found/i);
  });

  it('returns document when found', async () => {
    const doc = { _id: '507f1f77bcf86cd799439011', message: 'test' };
    const app = buildApp({ findOne: jest.fn().mockResolvedValue(doc) });
    const res = await request(app)
      .get('/collections/appevents/507f1f77bcf86cd799439011')
      .expect(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.message).toBe('test');
  });
});

describe('getCollectionStats', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns stats for allowed collection', async () => {
    const app = buildApp({ findOne: jest.fn().mockResolvedValue({ _id: 1, name: 'test' }) });
    const res = await request(app)
      .get('/collections/appevents/stats')
      .expect(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.name).toBe('appevents');
    expect(res.body.data.fields).toBeDefined();
  });
});
