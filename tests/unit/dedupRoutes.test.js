/**
 * Route tests for the dedup pipeline endpoints on /api/v1/janitor.
 */
const request = require('supertest');
const express = require('express');

// We need to mock the dedupScanner before requiring the routes
jest.mock('../../services/dedupScanner', () => ({
  buildDedupReport: jest.fn(),
  saveReport: jest.fn(),
  getReport: jest.fn(),
  generateConfirmationToken: jest.fn(),
  executeApprovedDeletions: jest.fn(),
  isProtectedPath: jest.fn()
}));

const dedupScanner = require('../../services/dedupScanner');
const janitorRoutes = require('../../routes/janitor.routes');

function buildApp(db) {
  const app = express();
  app.use(express.json());
  app.locals.db = db;
  app.use('/api/v1/janitor', janitorRoutes);
  return app;
}

const mockDb = { collection: jest.fn() };

// ── POST /dedup-scan ─────────────────────────────────────────

describe('POST /api/v1/janitor/dedup-scan', () => {
  beforeEach(() => jest.clearAllMocks());

  test('triggers scan and returns summary', async () => {
    const summary = { total_duplicate_groups: 3, total_wasted_space: 9000, total_wasted_space_formatted: '8.79 KB' };
    dedupScanner.buildDedupReport.mockResolvedValue({ summary, groups: [] });
    dedupScanner.saveReport.mockResolvedValue('report-abc');

    const app = buildApp(mockDb);
    const res = await request(app).post('/api/v1/janitor/dedup-scan').send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.report_id).toBe('report-abc');
    expect(res.body.data.summary.total_duplicate_groups).toBe(3);
    expect(dedupScanner.buildDedupReport).toHaveBeenCalledWith(mockDb, {
      rootPath: '/mnt/datalake/',
      extensions: [],
      maxDepth: null
    });
  });

  test('accepts custom root_path and extensions', async () => {
    dedupScanner.buildDedupReport.mockResolvedValue({ summary: {}, groups: [] });
    dedupScanner.saveReport.mockResolvedValue('r2');

    const app = buildApp(mockDb);
    await request(app).post('/api/v1/janitor/dedup-scan').send({
      root_path: '/mnt/other/',
      extensions: ['pdf', 'docx'],
      max_depth: 5
    });

    expect(dedupScanner.buildDedupReport).toHaveBeenCalledWith(mockDb, {
      rootPath: '/mnt/other/',
      extensions: ['pdf', 'docx'],
      maxDepth: 5
    });
  });

  test('returns 503 if DB not ready', async () => {
    const app = buildApp(null);
    const res = await request(app).post('/api/v1/janitor/dedup-scan').send({});
    expect(res.status).toBe(503);
  });

  test('returns 500 on scan error', async () => {
    dedupScanner.buildDedupReport.mockRejectedValue(new Error('aggregation failed'));
    const app = buildApp(mockDb);
    const res = await request(app).post('/api/v1/janitor/dedup-scan').send({});
    expect(res.status).toBe(500);
    expect(res.body.message).toMatch(/aggregation failed/);
  });
});

// ── GET /dedup-report ────────────────────────────────────────

describe('GET /api/v1/janitor/dedup-report', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns latest report', async () => {
    const report = { _id: 'r1', summary: { total_duplicate_groups: 2 }, groups: [] };
    dedupScanner.getReport.mockResolvedValue(report);

    const app = buildApp(mockDb);
    const res = await request(app).get('/api/v1/janitor/dedup-report');

    expect(res.status).toBe(200);
    expect(res.body.data._id).toBe('r1');
    expect(dedupScanner.getReport).toHaveBeenCalledWith(mockDb, null);
  });

  test('returns specific report by ID', async () => {
    dedupScanner.getReport.mockResolvedValue({ _id: 'r5' });
    const app = buildApp(mockDb);
    await request(app).get('/api/v1/janitor/dedup-report?report_id=r5');
    expect(dedupScanner.getReport).toHaveBeenCalledWith(mockDb, 'r5');
  });

  test('returns 404 when no report exists', async () => {
    dedupScanner.getReport.mockResolvedValue(null);
    const app = buildApp(mockDb);
    const res = await request(app).get('/api/v1/janitor/dedup-report');
    expect(res.status).toBe(404);
  });

  test('returns 503 if DB not ready', async () => {
    const app = buildApp(null);
    const res = await request(app).get('/api/v1/janitor/dedup-report');
    expect(res.status).toBe(503);
  });
});

// ── POST /dedup-approve ──────────────────────────────────────

describe('POST /api/v1/janitor/dedup-approve', () => {
  beforeEach(() => jest.clearAllMocks());

  test('validates required fields', async () => {
    const app = buildApp(mockDb);

    let res = await request(app).post('/api/v1/janitor/dedup-approve').send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/report_id/);

    res = await request(app).post('/api/v1/janitor/dedup-approve').send({ report_id: 'r1' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/files/);

    res = await request(app).post('/api/v1/janitor/dedup-approve').send({ report_id: 'r1', files: ['/a.txt'] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/confirmation_token/);
  });

  test('defaults to dry_run=true', async () => {
    dedupScanner.executeApprovedDeletions.mockResolvedValue({
      ok: true, dry_run: true, deleted: [], skipped: [], failed: [],
      space_freed: 0, space_freed_formatted: '0 B'
    });

    const app = buildApp(mockDb);
    await request(app).post('/api/v1/janitor/dedup-approve').send({
      report_id: 'r1', files: ['/a.txt'], confirmation_token: 'tok'
    });

    expect(dedupScanner.executeApprovedDeletions).toHaveBeenCalledWith(
      mockDb, ['/a.txt'], 'tok', 'r1', true
    );
  });

  test('passes dry_run=false when explicitly set', async () => {
    dedupScanner.executeApprovedDeletions.mockResolvedValue({
      ok: true, dry_run: false, deleted: [{ path: '/a.txt', size: 100, action: 'deleted' }],
      skipped: [], failed: [], space_freed: 100, space_freed_formatted: '100 B'
    });

    const app = buildApp(mockDb);
    const res = await request(app).post('/api/v1/janitor/dedup-approve').send({
      report_id: 'r1', files: ['/a.txt'], confirmation_token: 'tok', dry_run: false
    });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/deleted/i);
    expect(dedupScanner.executeApprovedDeletions).toHaveBeenCalledWith(
      mockDb, ['/a.txt'], 'tok', 'r1', false
    );
  });

  test('returns 403 on invalid token', async () => {
    dedupScanner.executeApprovedDeletions.mockResolvedValue({
      ok: false, error: 'Invalid confirmation token', expected_token: 'abc123'
    });

    const app = buildApp(mockDb);
    const res = await request(app).post('/api/v1/janitor/dedup-approve').send({
      report_id: 'r1', files: ['/a.txt'], confirmation_token: 'wrong'
    });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Invalid/);
  });

  test('returns 503 if DB not ready', async () => {
    const app = buildApp(null);
    const res = await request(app).post('/api/v1/janitor/dedup-approve').send({
      report_id: 'r1', files: ['/a.txt'], confirmation_token: 'tok'
    });
    expect(res.status).toBe(503);
  });
});
