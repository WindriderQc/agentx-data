/**
 * Unit tests for services/janitorService.js — path validation + policies
 */
const { validatePath, ALLOWED_ROOTS, POLICIES, MAX_SCAN_FILES, MAX_HASH_SIZE } = require('../../services/janitorService');

// ── validatePath ────────────────────────────────────────────────

describe('validatePath', () => {
  test('allows paths under /mnt/datalake/', () => {
    expect(validatePath('/mnt/datalake/photos/pic.jpg')).toBe(true);
    expect(validatePath('/mnt/datalake/')).toBe(true);
  });

  test('rejects paths outside allowed roots', () => {
    expect(validatePath('/etc/passwd')).toBe(false);
    expect(validatePath('/home/user/.ssh/id_rsa')).toBe(false);
    expect(validatePath('/usr/bin/node')).toBe(false);
    expect(validatePath('/var/log/syslog')).toBe(false);
    expect(validatePath('/')).toBe(false);
  });

  test('rejects null, undefined, non-string', () => {
    expect(validatePath(null)).toBe(false);
    expect(validatePath(undefined)).toBe(false);
    expect(validatePath(42)).toBe(false);
    expect(validatePath('')).toBe(false);
  });

  test('rejects traversal attempts', () => {
    expect(validatePath('/mnt/datalake/../../etc/passwd')).toBe(false);
  });

  test('rejects paths with only prefix match but not under root', () => {
    expect(validatePath('/mnt/datalake-evil/data')).toBe(false);
  });
});

// ── POLICIES ────────────────────────────────────────────────────

describe('POLICIES', () => {
  test('exports expected policy objects', () => {
    expect(POLICIES.delete_duplicates).toBeDefined();
    expect(POLICIES.delete_duplicates.enabled).toBe(true);
    expect(POLICIES.remove_temp_files).toBeDefined();
    expect(POLICIES.remove_temp_files.age_days).toBe(7);
    expect(POLICIES.remove_large_files).toBeDefined();
    expect(POLICIES.remove_large_files.enabled).toBe(false);
    expect(POLICIES.remove_large_files.size_threshold_gb).toBe(1);
  });
});

// ── Constants ──────────────────────────────────────────────────

describe('Constants', () => {
  test('MAX_SCAN_FILES is 2000', () => {
    expect(MAX_SCAN_FILES).toBe(2000);
  });

  test('MAX_HASH_SIZE is 100 MB (104857600)', () => {
    expect(MAX_HASH_SIZE).toBe(104857600);
  });
});

// ── buildSuggestions ─────────────────────────────────────────

const { buildSuggestions, generateCleanupToken, executeCleanup, analyzeDirectory } = require('../../services/janitorService');
const fsMod = require('fs/promises');
const fsSync = require('fs');

describe('buildSuggestions', () => {
  test('suggests deleting newer duplicates, keeping oldest', () => {
    const fileMap = new Map();
    fileMap.set('hash1', [
      { path: '/mnt/datalake/old.txt', size: 100, mtime: new Date('2024-01-01') },
      { path: '/mnt/datalake/new.txt', size: 100, mtime: new Date('2025-06-01') }
    ]);
    const analysis = { duplicate_groups: [{ hash: 'hash1', count: 2, wasted: 100 }], _fileMap: fileMap };
    const suggestions = buildSuggestions(analysis, ['delete_duplicates']);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].policy).toBe('delete_duplicates');
    expect(suggestions[0].files).toEqual(['/mnt/datalake/new.txt']);
    expect(suggestions[0].space_saved).toBe(100);
  });

  test('suggests removing old temp files', () => {
    const fileMap = new Map();
    const oldDate = new Date(Date.now() - 30 * 86400000);
    fileMap.set('hash2', [
      { path: '/mnt/datalake/tmp/old.log', size: 500, mtime: oldDate }
    ]);
    const analysis = { duplicate_groups: [], _fileMap: fileMap };
    const suggestions = buildSuggestions(analysis, ['remove_temp_files']);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].policy).toBe('remove_temp_files');
  });

  test('returns empty when no policies match', () => {
    const analysis = { duplicate_groups: [], _fileMap: new Map() };
    const suggestions = buildSuggestions(analysis, []);
    expect(suggestions).toHaveLength(0);
  });
});

// ── generateCleanupToken ────────────────────────────────────

describe('generateCleanupToken', () => {
  test('produces consistent 16-char hex token', () => {
    const files = ['/mnt/datalake/a.txt', '/mnt/datalake/b.txt'];
    const t1 = generateCleanupToken(files);
    const t2 = generateCleanupToken(files);
    expect(t1).toBe(t2);
    expect(t1).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(t1)).toBe(true);
  });

  test('order-independent (sorted internally)', () => {
    const t1 = generateCleanupToken(['/z.txt', '/a.txt']);
    const t2 = generateCleanupToken(['/a.txt', '/z.txt']);
    expect(t1).toBe(t2);
  });
});

// ── executeCleanup ──────────────────────────────────────────

describe('executeCleanup', () => {
  test('dry run reports would_delete without unlinking', async () => {
    const origStat = fsMod.stat;
    const origRealpath = fsMod.realpath;
    fsMod.stat = jest.fn().mockResolvedValue({ size: 1024, isFile: () => true });
    fsMod.realpath = jest.fn().mockImplementation(async (value) => value);
    const files = ['/mnt/datalake/photos/dup.jpg'];
    const token = generateCleanupToken(files);
    const result = await executeCleanup(files, token, true);
    expect(result.ok).toBe(true);
    expect(result.dry_run).toBe(true);
    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0].action).toBe('would_delete');
    expect(result.space_freed).toBe(1024);
    fsMod.stat = origStat;
    fsMod.realpath = origRealpath;
  });

  test('rejects invalid confirmation token', async () => {
    const result = await executeCleanup(['/mnt/datalake/a.txt'], 'bad-token', true);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid confirmation token/);
    expect(result.expected_token).toBeUndefined(); // C3 fix
  });

  test('rejects paths outside allowlist', async () => {
    const files = ['/etc/passwd'];
    const token = generateCleanupToken(files);
    const result = await executeCleanup(files, token, true);
    expect(result.ok).toBe(true);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toMatch(/safety policy/i);
  });

  test('handles per-file errors without aborting batch', async () => {
    const origStat = fsMod.stat;
    const origUnlink = fsMod.unlink;
    const origRealpath = fsMod.realpath;
    fsMod.stat = jest.fn()
      .mockResolvedValueOnce({ size: 100, isFile: () => true })
      .mockRejectedValueOnce(new Error('ENOENT'));
    fsMod.unlink = jest.fn().mockResolvedValue(undefined);
    fsMod.realpath = jest.fn().mockImplementation(async (value) => value);
    const files = ['/mnt/datalake/good.txt', '/mnt/datalake/gone.txt'];
    const token = generateCleanupToken(files);
    const result = await executeCleanup(files, token, false);
    expect(result.ok).toBe(true);
    expect(result.deleted).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    fsMod.stat = origStat;
    fsMod.unlink = origUnlink;
    fsMod.realpath = origRealpath;
  });
});

// ── analyzeDirectory ──────────────────────────────────────────

describe('analyzeDirectory', () => {
  test('returns analysis with duplicate groups', async () => {
    const origReaddir = fsMod.readdir;
    const origRealpath = fsMod.realpath;
    const origStat = fsMod.stat;
    const origCreateReadStream = fsSync.createReadStream;

    const entries = [
      { name: 'a.txt', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
      { name: 'b.txt', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
      { name: 'c.txt', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }
    ];

    fsMod.readdir = jest.fn().mockResolvedValue(entries);
    fsMod.realpath = jest.fn().mockImplementation(async (value) => value);
    fsMod.stat = jest.fn().mockResolvedValue({ size: 100, mtime: new Date('2025-01-01') });

    const { PassThrough } = require('stream');
    fsSync.createReadStream = jest.fn(() => {
      const s = new PassThrough();
      process.nextTick(() => { s.push('same-content'); s.push(null); });
      return s;
    });

    const result = await analyzeDirectory('/mnt/datalake/test');

    expect(result.total_files).toBe(3);
    expect(result.scanned_files).toBe(3);
    expect(result.duplicates_count).toBe(1);
    expect(result.duplicate_groups[0].count).toBe(3);
    expect(result.duplicate_groups[0].wasted).toBe(200);

    fsMod.readdir = origReaddir;
    fsMod.realpath = origRealpath;
    fsMod.stat = origStat;
    fsSync.createReadStream = origCreateReadStream;
  });

  test('skips files larger than MAX_HASH_SIZE for hashing', async () => {
    const origReaddir = fsMod.readdir;
    const origRealpath = fsMod.realpath;
    const origStat = fsMod.stat;

    fsMod.readdir = jest.fn().mockResolvedValue([
      { name: 'big.bin', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false }
    ]);
    fsMod.realpath = jest.fn().mockImplementation(async (value) => value);
    fsMod.stat = jest.fn().mockResolvedValue({ size: 200 * 1024 * 1024, mtime: new Date() });

    const result = await analyzeDirectory('/mnt/datalake/test');

    expect(result.total_files).toBe(1);
    expect(result.scanned_files).toBe(0);

    fsMod.readdir = origReaddir;
    fsMod.realpath = origRealpath;
    fsMod.stat = origStat;
  });
});
