/**
 * Unit tests for services/dedupScanner.js
 */
const {
  buildDedupReport,
  saveReport,
  getReport,
  generateConfirmationToken,
  executeApprovedDeletions,
  isProtectedPath
} = require('../../services/dedupScanner');

// ── helpers ──────────────────────────────────────────────────

/** Build a minimal mock MongoDB collection with an aggregate pipeline */
function mockCollection(docs = []) {
  return {
    aggregate: jest.fn().mockReturnValue({
      toArray: jest.fn().mockResolvedValue(docs)
    }),
    insertOne: jest.fn().mockResolvedValue({ insertedId: 'report-123' }),
    findOne: jest.fn().mockImplementation((filter, opts) => {
      if (opts && opts.sort) return Promise.resolve(docs[0] || null);
      return Promise.resolve(docs.find(d => String(d._id) === String(filter._id)) || null);
    }),
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 })
  };
}

function mockDb(collectionMap = {}) {
  return {
    collection: jest.fn((name) => collectionMap[name] || mockCollection())
  };
}

// ── isProtectedPath ──────────────────────────────────────────

describe('isProtectedPath', () => {
  test('blocks paths containing /keys/', () => {
    expect(isProtectedPath('/mnt/datalake/keys/secret.pem')).toBe(true);
    expect(isProtectedPath('/home/user/keys/id_rsa')).toBe(true);
  });

  test('allows normal paths', () => {
    expect(isProtectedPath('/mnt/datalake/photos/pic.jpg')).toBe(false);
    expect(isProtectedPath('/mnt/datalake/backups/data.tar')).toBe(false);
  });

  test('blocks null/undefined/non-string', () => {
    expect(isProtectedPath(null)).toBe(true);
    expect(isProtectedPath(undefined)).toBe(true);
    expect(isProtectedPath(42)).toBe(true);
  });
});

// ── generateConfirmationToken ────────────────────────────────

describe('generateConfirmationToken', () => {
  test('produces consistent 16-char hex token for the same inputs', () => {
    const files = ['/a/b.txt', '/c/d.txt'];
    const token1 = generateConfirmationToken(files, 'r1');
    const token2 = generateConfirmationToken(files, 'r1');
    expect(token1).toBe(token2);
    expect(token1).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(token1)).toBe(true);
  });

  test('order of files does not matter (sorted internally)', () => {
    const t1 = generateConfirmationToken(['/z.txt', '/a.txt'], 'r1');
    const t2 = generateConfirmationToken(['/a.txt', '/z.txt'], 'r1');
    expect(t1).toBe(t2);
  });

  test('different report IDs produce different tokens', () => {
    const files = ['/a.txt'];
    const t1 = generateConfirmationToken(files, 'r1');
    const t2 = generateConfirmationToken(files, 'r2');
    expect(t1).not.toBe(t2);
  });
});

// ── buildDedupReport ─────────────────────────────────────────

describe('buildDedupReport', () => {
  test('builds a report from aggregated duplicate groups', async () => {
    const aggResult = [
      {
        _id: 'abc123',
        count: 3,
        size: 1024,
        files: [
          { path: '/mnt/datalake/a/file.txt', dirname: '/mnt/datalake/a', filename: 'file.txt', size: 1024, mtime: 1700000000 },
          { path: '/mnt/datalake/b/file.txt', dirname: '/mnt/datalake/b', filename: 'file.txt', size: 1024, mtime: 1700000100 },
          { path: '/mnt/datalake/c/file.txt', dirname: '/mnt/datalake/c', filename: 'file.txt', size: 1024, mtime: 1700000200 }
        ]
      },
      {
        _id: 'def456',
        count: 2,
        size: 512,
        files: [
          { path: '/mnt/datalake/x/data.bin', dirname: '/mnt/datalake/x', filename: 'data.bin', size: 512, mtime: 1700000000 },
          { path: '/mnt/datalake/y/data.bin', dirname: '/mnt/datalake/y', filename: 'data.bin', size: 512, mtime: 1700000100 }
        ]
      }
    ];

    const nasFiles = mockCollection(aggResult);
    const db = mockDb({ nas_files: nasFiles });

    const report = await buildDedupReport(db);

    expect(report.status).toBe('complete');
    expect(report.summary.total_duplicate_groups).toBe(2);
    expect(report.summary.total_duplicate_files).toBe(5);
    // wasted = 1024*(3-1) + 512*(2-1) = 2048 + 512 = 2560
    expect(report.summary.total_wasted_space).toBe(2560);
    expect(report.summary.top_10_largest).toHaveLength(2);
    expect(report.groups).toHaveLength(2);
    expect(report.groups[0].hash).toBe('abc123');
    expect(report.groups[0].recommended_action).toBe('review_and_delete_duplicates');
  });

  test('returns empty report when no duplicates exist', async () => {
    const nasFiles = mockCollection([]);
    const db = mockDb({ nas_files: nasFiles });

    const report = await buildDedupReport(db);

    expect(report.summary.total_duplicate_groups).toBe(0);
    expect(report.summary.total_wasted_space).toBe(0);
    expect(report.groups).toHaveLength(0);
  });

  test('passes rootPath and extensions to the match stage', async () => {
    const nasFiles = mockCollection([]);
    const db = mockDb({ nas_files: nasFiles });

    await buildDedupReport(db, {
      rootPath: '/mnt/datalake/',
      extensions: ['jpg', 'png']
    });

    const matchArg = nasFiles.aggregate.mock.calls[0][0][0].$match;
    expect(matchArg.ext).toEqual({ $in: ['jpg', 'png'] });
    expect(matchArg.$and).toBeDefined();
    expect(matchArg.$and[0].path.$regex).toMatch(/datalake/);
  });
});

// ── saveReport / getReport ──────────────────────────────────

describe('saveReport', () => {
  test('inserts into dedup_reports and returns ID', async () => {
    const col = mockCollection();
    const db = mockDb({ dedup_reports: col });

    const id = await saveReport(db, { summary: {}, groups: [] });
    expect(id).toBe('report-123');
    expect(col.insertOne).toHaveBeenCalledTimes(1);
  });
});

describe('getReport', () => {
  test('returns latest report when no ID given', async () => {
    const doc = { _id: 'latest', summary: { total_duplicate_groups: 5 } };
    const col = mockCollection([doc]);
    const db = mockDb({ dedup_reports: col });

    const result = await getReport(db, null);
    expect(col.findOne).toHaveBeenCalledWith({}, { sort: { created_at: -1 } });
    expect(result).toEqual(doc);
  });
});

// ── executeApprovedDeletions ────────────────────────────────

describe('executeApprovedDeletions', () => {
  test('rejects invalid confirmation token', async () => {
    const db = mockDb();
    const result = await executeApprovedDeletions(db, ['/a.txt'], 'bad-token', 'r1', true);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid confirmation token/);
  });

  test('skips protected paths even with valid token', async () => {
    const files = ['/mnt/datalake/keys/secret.pem'];
    const token = generateConfirmationToken(files, 'r1');
    const db = mockDb();

    const result = await executeApprovedDeletions(db, files, token, 'r1', true);
    expect(result.ok).toBe(true);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toMatch(/Protected/);
    expect(result.deleted).toHaveLength(0);
  });

  test('dry run reports would_delete without actually deleting', async () => {
    // Mock fs.stat to return a size
    const fsMock = require('fs/promises');
    const origStat = fsMock.stat;
    fsMock.stat = jest.fn().mockResolvedValue({ size: 4096 });

    const files = ['/mnt/datalake/photos/dup1.jpg'];
    const token = generateConfirmationToken(files, 'r1');
    const db = mockDb();

    const result = await executeApprovedDeletions(db, files, token, 'r1', true);
    expect(result.ok).toBe(true);
    expect(result.dry_run).toBe(true);
    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0].action).toBe('would_delete');
    expect(result.space_freed).toBe(4096);

    fsMock.stat = origStat;
  });

  test('real delete removes file and updates nas_files', async () => {
    const fsMock = require('fs/promises');
    const origStat = fsMock.stat;
    const origUnlink = fsMock.unlink;
    fsMock.stat = jest.fn().mockResolvedValue({ size: 2048 });
    fsMock.unlink = jest.fn().mockResolvedValue(undefined);

    const nasFiles = mockCollection();
    const db = mockDb({ nas_files: nasFiles });

    const files = ['/mnt/datalake/backups/dup.tar'];
    const token = generateConfirmationToken(files, 'r1');

    const result = await executeApprovedDeletions(db, files, token, 'r1', false);
    expect(result.ok).toBe(true);
    expect(result.dry_run).toBe(false);
    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0].action).toBe('deleted');
    expect(fsMock.unlink).toHaveBeenCalledWith('/mnt/datalake/backups/dup.tar');
    expect(nasFiles.deleteOne).toHaveBeenCalledWith({ path: '/mnt/datalake/backups/dup.tar' });

    fsMock.stat = origStat;
    fsMock.unlink = origUnlink;
  });
});
