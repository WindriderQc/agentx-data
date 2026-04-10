const request = require('supertest');
const express = require('express');

jest.mock('../../services/janitorProfiles', () => ({
  list: jest.fn(),
  get: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  remove: jest.fn()
}));
jest.mock('../../services/janitorRunner', () => ({
  runProfile: jest.fn(),
  listRunsForProfile: jest.fn(),
  getRun: jest.fn(),
  approveAction: jest.fn(),
  rejectAction: jest.fn()
}));
jest.mock('../../services/janitorScheduler', () => ({
  reload: jest.fn(async () => {})
}));

const janitorProfiles = require('../../services/janitorProfiles');
const janitorRunner = require('../../services/janitorRunner');
const janitorScheduler = require('../../services/janitorScheduler');
const routes = require('../../routes/janitor-profiles.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.locals.db = {};
  app.use('/api/v1/janitor/profiles', routes);
  app.use((err, req, res, _next) => res.status(500).json({ status: 'error', message: err.message }));
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('GET /', () => {
  test('returns list of profiles', async () => {
    janitorProfiles.list.mockResolvedValue([{ _id: 'a', name: 'A' }]);
    const res = await request(buildApp()).get('/api/v1/janitor/profiles');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.profiles).toHaveLength(1);
  });
});

describe('POST /', () => {
  test('creates a profile and triggers scheduler reload', async () => {
    janitorProfiles.create.mockResolvedValue({ ok: true, profile: { _id: 'new', name: 'X' } });
    const res = await request(buildApp()).post('/api/v1/janitor/profiles').send({ name: 'X' });
    expect(res.status).toBe(201);
    expect(janitorScheduler.reload).toHaveBeenCalledWith(expect.any(Object), 'new');
  });

  test('returns 400 on validation failure', async () => {
    janitorProfiles.create.mockResolvedValue({ ok: false, errors: ['name required'] });
    const res = await request(buildApp()).post('/api/v1/janitor/profiles').send({});
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(['name required']);
  });

  test('returns 409 on conflict', async () => {
    janitorProfiles.create.mockResolvedValue({ ok: false, conflict: true, errors: ['name "X" already exists'] });
    const res = await request(buildApp()).post('/api/v1/janitor/profiles').send({ name: 'X' });
    expect(res.status).toBe(409);
  });
});

describe('GET /:id', () => {
  test('returns the profile', async () => {
    janitorProfiles.get.mockResolvedValue({ _id: 'a', name: 'A' });
    const res = await request(buildApp()).get('/api/v1/janitor/profiles/a');
    expect(res.status).toBe(200);
    expect(res.body.data.profile.name).toBe('A');
  });

  test('returns 404 when missing', async () => {
    janitorProfiles.get.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/v1/janitor/profiles/nope');
    expect(res.status).toBe(404);
  });
});

describe('PUT /:id', () => {
  test('updates and reloads scheduler', async () => {
    janitorProfiles.update.mockResolvedValue({ ok: true, profile: { _id: 'a', name: 'A2' } });
    const res = await request(buildApp()).put('/api/v1/janitor/profiles/a').send({ name: 'A2' });
    expect(res.status).toBe(200);
    expect(janitorScheduler.reload).toHaveBeenCalledWith(expect.any(Object), 'a');
  });

  test('returns 404 when notFound', async () => {
    janitorProfiles.update.mockResolvedValue({ ok: false, notFound: true, errors: ['profile not found'] });
    const res = await request(buildApp()).put('/api/v1/janitor/profiles/x').send({});
    expect(res.status).toBe(404);
  });

  test('returns 400 on badRequest (invalid id)', async () => {
    janitorProfiles.update.mockResolvedValue({ ok: false, badRequest: true, errors: ['invalid id'] });
    const res = await request(buildApp()).put('/api/v1/janitor/profiles/bad-id').send({});
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(['invalid id']);
  });
});

describe('DELETE /:id', () => {
  test('deletes and reloads scheduler', async () => {
    janitorProfiles.remove.mockResolvedValue({ ok: true });
    const res = await request(buildApp()).delete('/api/v1/janitor/profiles/a');
    expect(res.status).toBe(200);
    expect(janitorScheduler.reload).toHaveBeenCalledWith(expect.any(Object), 'a');
  });

  test('returns 404 when missing', async () => {
    janitorProfiles.remove.mockResolvedValue({ ok: false, notFound: true });
    const res = await request(buildApp()).delete('/api/v1/janitor/profiles/x');
    expect(res.status).toBe(404);
  });

  test('returns 400 on badRequest (invalid id)', async () => {
    janitorProfiles.remove.mockResolvedValue({ ok: false, badRequest: true, errors: ['invalid id'] });
    const res = await request(buildApp()).delete('/api/v1/janitor/profiles/bad-id');
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(['invalid id']);
  });
});

describe('POST /:id/run', () => {
  test('triggers a run and returns the run id', async () => {
    janitorRunner.runProfile.mockResolvedValue({ ok: true, run_id: 'r1' });
    const res = await request(buildApp()).post('/api/v1/janitor/profiles/a/run');
    expect(res.status).toBe(202);
    expect(res.body.data.run_id).toBe('r1');
  });

  test('returns 409 when already running', async () => {
    janitorRunner.runProfile.mockResolvedValue({ ok: false, alreadyRunning: true });
    const res = await request(buildApp()).post('/api/v1/janitor/profiles/a/run');
    expect(res.status).toBe(409);
  });

  test('returns 404 when profile missing', async () => {
    janitorRunner.runProfile.mockResolvedValue({ ok: false, notFound: true });
    const res = await request(buildApp()).post('/api/v1/janitor/profiles/x/run');
    expect(res.status).toBe(404);
  });

  test('returns 500 on generic runner failure', async () => {
    janitorRunner.runProfile.mockResolvedValue({ ok: false, error: 'scan failed' });
    const res = await request(buildApp()).post('/api/v1/janitor/profiles/a/run');
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('scan failed');
  });
});

describe('GET /:id/runs', () => {
  test('returns paginated runs', async () => {
    janitorRunner.listRunsForProfile.mockResolvedValue({ runs: [{ _id: 'r1' }], total: 1, page: 1, limit: 20 });
    const res = await request(buildApp()).get('/api/v1/janitor/profiles/a/runs');
    expect(res.status).toBe(200);
    expect(res.body.data.runs).toHaveLength(1);
    expect(res.body.data.pagination.total).toBe(1);
  });
});

describe('GET /runs/:run_id', () => {
  test('returns run detail', async () => {
    janitorRunner.getRun.mockResolvedValue({ _id: 'r1', proposed_actions: [] });
    const res = await request(buildApp()).get('/api/v1/janitor/profiles/runs/r1');
    expect(res.status).toBe(200);
    expect(res.body.data.run._id).toBe('r1');
  });

  test('returns 404 when missing', async () => {
    janitorRunner.getRun.mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/v1/janitor/profiles/runs/nope');
    expect(res.status).toBe(404);
  });
});

describe('POST /runs/:run_id/actions/:idx/approve', () => {
  test('approves and returns the action', async () => {
    janitorRunner.approveAction.mockResolvedValue({
      ok: true,
      action: { policy: 'delete_duplicates', status: 'executed' },
      result: { deleted: [{}], failed: [], space_freed: 100 }
    });
    const res = await request(buildApp()).post('/api/v1/janitor/profiles/runs/r1/actions/0/approve');
    expect(res.status).toBe(200);
    expect(res.body.data.action.status).toBe('executed');
  });

  test('returns 409 when action is not pending', async () => {
    janitorRunner.approveAction.mockResolvedValue({ ok: false, error: 'action is executed' });
    const res = await request(buildApp()).post('/api/v1/janitor/profiles/runs/r1/actions/0/approve');
    expect(res.status).toBe(409);
  });

  test('returns 404 when run/action missing', async () => {
    janitorRunner.approveAction.mockResolvedValue({ ok: false, notFound: true });
    const res = await request(buildApp()).post('/api/v1/janitor/profiles/runs/r1/actions/9/approve');
    expect(res.status).toBe(404);
  });
});

describe('POST /runs/:run_id/actions/:idx/reject', () => {
  test('rejects and returns the action', async () => {
    janitorRunner.rejectAction.mockResolvedValue({ ok: true, action: { status: 'rejected' } });
    const res = await request(buildApp()).post('/api/v1/janitor/profiles/runs/r1/actions/0/reject');
    expect(res.status).toBe(200);
    expect(res.body.data.action.status).toBe('rejected');
  });

  test('returns 404 when run/action missing', async () => {
    janitorRunner.rejectAction.mockResolvedValue({ ok: false, notFound: true });
    const res = await request(buildApp()).post('/api/v1/janitor/profiles/runs/r1/actions/0/reject');
    expect(res.status).toBe(404);
  });

  test('returns 409 when action is not pending', async () => {
    janitorRunner.rejectAction.mockResolvedValue({ ok: false, error: 'action is rejected' });
    const res = await request(buildApp()).post('/api/v1/janitor/profiles/runs/r1/actions/0/reject');
    expect(res.status).toBe(409);
  });
});
