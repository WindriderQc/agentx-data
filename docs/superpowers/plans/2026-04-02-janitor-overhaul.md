# Janitor Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all critical and important issues in the janitor toolkit (C3, C5, C6, I8, I13, I16) — extract business logic into service/controller, harden path validation with an allowlist, fix the token leak, add confirmation to `/execute`, and fix per-file error handling.

**Architecture:** Extract inline business logic from `routes/janitor.routes.js` into `services/janitorService.js` (directory analysis, path validation, policies) and `controllers/janitorController.js` (HTTP handling). Route file becomes thin delegation only. Path validation switches from a blocklist to an allowlist. The confirmation token leak (C3) is fixed in both the service return and route response. The `/execute` endpoint gets a confirmation token and per-file error handling.

**Tech Stack:** Node.js, Express, MongoDB, Jest, Supertest

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `services/janitorService.js` | Path validation (allowlist), directory analysis, policies, cleanup execution |
| Create | `controllers/janitorController.js` | HTTP handlers — validate input, call service, format response |
| Rewrite | `routes/janitor.routes.js` | Thin routing only — delegate to controller |
| Update | `services/dedupScanner.js` | Remove token leak from `executeApprovedDeletions`, add path allowlist validation |
| Create | `tests/unit/janitorService.test.js` | Unit tests for service functions |
| Update | `tests/unit/dedupScanner.test.js` | Update token leak test expectations |
| Update | `tests/unit/dedupRoutes.test.js` | Update route response expectations (no `expected_token`) |

---

### Task 1: Create `services/janitorService.js` — path validation + policies

**Files:**
- Create: `services/janitorService.js`
- Create: `tests/unit/janitorService.test.js`

- [ ] **Step 1: Write failing tests for path validation**

```js
// tests/unit/janitorService.test.js
const { validatePath, ALLOWED_ROOTS, POLICIES } = require('../../services/janitorService');

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

describe('POLICIES', () => {
  test('exports expected policy objects', () => {
    expect(POLICIES.delete_duplicates).toBeDefined();
    expect(POLICIES.delete_duplicates.enabled).toBe(true);
    expect(POLICIES.remove_temp_files).toBeDefined();
    expect(POLICIES.remove_large_files).toBeDefined();
    expect(POLICIES.remove_large_files.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/yb/codes/agentx-platform/data && npx jest tests/unit/janitorService.test.js --no-coverage 2>&1 | tail -5`
Expected: FAIL — cannot find module `../../services/janitorService`

- [ ] **Step 3: Implement `services/janitorService.js` — path validation + policies**

```js
// services/janitorService.js
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const { log } = require('../utils/logger');

/**
 * Allowed root paths — only directories under these roots can be scanned or cleaned.
 * Add entries here to expand the janitor's reach.
 */
const ALLOWED_ROOTS = ['/mnt/datalake/'];

const POLICIES = {
  delete_duplicates: { id: 'delete_duplicates', name: 'Delete Duplicate Files', description: 'Keep oldest copy, delete newer duplicates', enabled: true },
  remove_temp_files: { id: 'remove_temp_files', name: 'Remove Temp Files', description: 'Delete temp files older than 7 days', enabled: true, age_days: 7 },
  remove_large_files: { id: 'remove_large_files', name: 'Flag Large Files', description: 'Files > 1GB for manual review', enabled: false, size_threshold_gb: 1 }
};

const MAX_SCAN_FILES = 2000;
const MAX_HASH_SIZE = 100 * 1024 * 1024; // 100 MB

/**
 * Validate a path against the allowlist.
 * Resolves traversal (../), then checks it falls under an allowed root.
 */
function validatePath(p) {
  if (!p || typeof p !== 'string') return false;
  const resolved = path.resolve(p);
  return ALLOWED_ROOTS.some(root => resolved === root.replace(/\/$/, '') || resolved.startsWith(root));
}

module.exports = { validatePath, ALLOWED_ROOTS, POLICIES, MAX_SCAN_FILES, MAX_HASH_SIZE };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/yb/codes/agentx-platform/data && npx jest tests/unit/janitorService.test.js --no-coverage 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/janitorService.js tests/unit/janitorService.test.js
git commit -m "feat(janitor): add janitorService with allowlist path validation and policies (C5, C6)"
```

---

### Task 2: Add `analyzeDirectory` to the service

**Files:**
- Modify: `services/janitorService.js`
- Modify: `tests/unit/janitorService.test.js`

- [ ] **Step 1: Write failing tests for `analyzeDirectory`**

Append to `tests/unit/janitorService.test.js`:

```js
const { analyzeDirectory } = require('../../services/janitorService');
const fsMod = require('fs/promises');
const fsSync = require('fs');

describe('analyzeDirectory', () => {
  test('returns analysis with duplicate groups', async () => {
    // Mock readdir to return 3 files, two with same content
    const origReaddir = fsMod.readdir;
    const origStat = fsMod.stat;
    const origCreateReadStream = fsSync.createReadStream;

    const entries = [
      { name: 'a.txt', isDirectory: () => false, isFile: () => true },
      { name: 'b.txt', isDirectory: () => false, isFile: () => true },
      { name: 'c.txt', isDirectory: () => false, isFile: () => true }
    ];

    fsMod.readdir = jest.fn().mockResolvedValue(entries);
    fsMod.stat = jest.fn().mockResolvedValue({ size: 100, mtime: new Date('2025-01-01') });

    // All three return the same hash content
    const { PassThrough } = require('stream');
    fsSync.createReadStream = jest.fn(() => {
      const s = new PassThrough();
      process.nextTick(() => { s.push('same-content'); s.push(null); });
      return s;
    });

    const result = await analyzeDirectory('/mnt/datalake/test');

    expect(result.total_files).toBe(3);
    expect(result.scanned_files).toBe(3);
    expect(result.duplicates_count).toBe(1); // one group of 3
    expect(result.duplicate_groups[0].count).toBe(3);
    expect(result.duplicate_groups[0].wasted).toBe(200); // 100 * (3-1)

    fsMod.readdir = origReaddir;
    fsMod.stat = origStat;
    fsSync.createReadStream = origCreateReadStream;
  });

  test('skips files larger than MAX_HASH_SIZE for hashing', async () => {
    const origReaddir = fsMod.readdir;
    const origStat = fsMod.stat;

    fsMod.readdir = jest.fn().mockResolvedValue([
      { name: 'big.bin', isDirectory: () => false, isFile: () => true }
    ]);
    fsMod.stat = jest.fn().mockResolvedValue({ size: 200 * 1024 * 1024, mtime: new Date() });

    const result = await analyzeDirectory('/mnt/datalake/test');

    expect(result.total_files).toBe(1);
    expect(result.scanned_files).toBe(0); // skipped for hashing

    fsMod.readdir = origReaddir;
    fsMod.stat = origStat;
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/yb/codes/agentx-platform/data && npx jest tests/unit/janitorService.test.js --no-coverage 2>&1 | tail -5`
Expected: FAIL — `analyzeDirectory` is not a function

- [ ] **Step 3: Implement `analyzeDirectory` in the service**

Add to `services/janitorService.js` before `module.exports`:

```js
/**
 * Analyze a directory: hash files, find duplicates.
 * Returns analysis object (without the internal fileMap).
 */
async function analyzeDirectory(dirPath) {
  const fileMap = new Map();
  let totalFiles = 0, totalSize = 0, scannedFiles = 0;

  async function scan(dir) {
    if (totalFiles >= MAX_SCAN_FILES) return;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (totalFiles >= MAX_SCAN_FILES) break;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) { await scan(fullPath); continue; }
      if (!entry.isFile()) continue;

      let stats;
      try { stats = await fs.stat(fullPath); }
      catch { continue; }

      totalFiles++;
      totalSize += stats.size;
      if (stats.size > MAX_HASH_SIZE) continue;

      try {
        const hash = await new Promise((resolve, reject) => {
          const h = crypto.createHash('sha256');
          const stream = fsSync.createReadStream(fullPath);
          stream.on('error', reject);
          stream.on('data', chunk => h.update(chunk));
          stream.on('end', () => resolve(h.digest('hex')));
        });
        if (!fileMap.has(hash)) fileMap.set(hash, []);
        fileMap.get(hash).push({ path: fullPath, size: stats.size, mtime: stats.mtime });
        scannedFiles++;
      } catch { /* skip unreadable files */ }
    }
  }

  await scan(dirPath);

  const duplicates = [];
  for (const [hash, files] of fileMap.entries()) {
    if (files.length > 1) {
      duplicates.push({
        hash, count: files.length,
        files: files.map(f => f.path),
        size: files[0].size,
        wasted: files[0].size * (files.length - 1)
      });
    }
  }

  return {
    path: dirPath,
    total_files: totalFiles,
    scanned_files: scannedFiles,
    total_size: totalSize,
    duplicates_count: duplicates.length,
    wasted_space: duplicates.reduce((s, d) => s + d.wasted, 0),
    duplicate_groups: duplicates.slice(0, 50),
    _fileMap: fileMap  // internal — stripped by controller before response
  };
}
```

Update `module.exports` to include `analyzeDirectory`:

```js
module.exports = { validatePath, ALLOWED_ROOTS, POLICIES, MAX_SCAN_FILES, MAX_HASH_SIZE, analyzeDirectory };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/yb/codes/agentx-platform/data && npx jest tests/unit/janitorService.test.js --no-coverage 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/janitorService.js tests/unit/janitorService.test.js
git commit -m "feat(janitor): add analyzeDirectory to janitorService (I13)"
```

---

### Task 3: Add `buildSuggestions` and `executeCleanup` to the service

**Files:**
- Modify: `services/janitorService.js`
- Modify: `tests/unit/janitorService.test.js`

- [ ] **Step 1: Write failing tests for `buildSuggestions`**

Append to `tests/unit/janitorService.test.js`:

```js
const { buildSuggestions } = require('../../services/janitorService');

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
    const oldDate = new Date(Date.now() - 30 * 86400000); // 30 days ago
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
```

- [ ] **Step 2: Write failing tests for `executeCleanup`**

Append to `tests/unit/janitorService.test.js`:

```js
const { executeCleanup, generateCleanupToken } = require('../../services/janitorService');

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

describe('executeCleanup', () => {
  test('dry run reports would_delete without unlinking', async () => {
    const origStat = fsMod.stat;
    fsMod.stat = jest.fn().mockResolvedValue({ size: 1024 });

    const files = ['/mnt/datalake/photos/dup.jpg'];
    const token = generateCleanupToken(files);
    const result = await executeCleanup(files, token, true);

    expect(result.ok).toBe(true);
    expect(result.dry_run).toBe(true);
    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0].action).toBe('would_delete');
    expect(result.space_freed).toBe(1024);

    fsMod.stat = origStat;
  });

  test('rejects invalid confirmation token', async () => {
    const result = await executeCleanup(['/mnt/datalake/a.txt'], 'bad-token', true);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid confirmation token/);
    // Must NOT contain expected_token (C3 fix)
    expect(result.expected_token).toBeUndefined();
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
    fsMod.stat = jest.fn()
      .mockResolvedValueOnce({ size: 100 })
      .mockRejectedValueOnce(new Error('ENOENT'));
    fsMod.unlink = jest.fn().mockResolvedValue(undefined);

    const files = ['/mnt/datalake/good.txt', '/mnt/datalake/gone.txt'];
    const token = generateCleanupToken(files);
    const result = await executeCleanup(files, token, false);

    expect(result.ok).toBe(true);
    expect(result.deleted).toHaveLength(1);
    expect(result.failed).toHaveLength(1);

    fsMod.stat = origStat;
    fsMod.unlink = origUnlink;
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /home/yb/codes/agentx-platform/data && npx jest tests/unit/janitorService.test.js --no-coverage 2>&1 | tail -5`
Expected: FAIL — `buildSuggestions`/`executeCleanup`/`generateCleanupToken` not exported

- [ ] **Step 4: Implement `buildSuggestions`, `generateCleanupToken`, and `executeCleanup`**

Add to `services/janitorService.js` before `module.exports`:

```js
/**
 * Build cleanup suggestions from an analysis result.
 * @param {Object} analysis - result from analyzeDirectory (must include _fileMap)
 * @param {string[]} activePolicies - policy IDs to apply
 * @returns {Object[]} suggestions
 */
function buildSuggestions(analysis, activePolicies) {
  const suggestions = [];

  if (activePolicies.includes('delete_duplicates')) {
    for (const group of analysis.duplicate_groups) {
      const files = Array.from(analysis._fileMap.get(group.hash) || [])
        .sort((a, b) => new Date(a.mtime) - new Date(b.mtime));
      const toDelete = files.slice(1);
      if (toDelete.length > 0) {
        suggestions.push({
          policy: 'delete_duplicates', action: 'delete',
          files: toDelete.map(f => f.path),
          reason: `Duplicate of ${files[0].path}`,
          space_saved: group.wasted
        });
      }
    }
  }

  if (activePolicies.includes('remove_temp_files')) {
    const cutoff = new Date(Date.now() - (POLICIES.remove_temp_files.age_days || 7) * 86400000);
    for (const [, files] of analysis._fileMap) {
      for (const file of files) {
        if ((file.path.includes('/temp/') || file.path.includes('/tmp/')) && new Date(file.mtime) < cutoff) {
          suggestions.push({
            policy: 'remove_temp_files', action: 'delete',
            files: [file.path], reason: 'Old temp file',
            space_saved: file.size
          });
        }
      }
    }
  }

  return suggestions;
}

/**
 * Generate a confirmation token for a set of file paths.
 * Token = SHA256(sorted paths joined with newline), truncated to 16 hex chars.
 */
function generateCleanupToken(filePaths) {
  const sorted = [...filePaths].sort();
  return crypto.createHash('sha256').update(sorted.join('\n')).digest('hex').slice(0, 16);
}

/**
 * Execute approved file deletions with per-file error handling (I16 fix).
 * Validates each path against the allowlist (C5 fix).
 * Never leaks the expected token on failure (C3 fix pattern).
 */
async function executeCleanup(filePaths, token, dryRun = true) {
  const expectedToken = generateCleanupToken(filePaths);
  if (token !== expectedToken) {
    return { ok: false, error: 'Invalid confirmation token' };
  }

  const results = {
    ok: true, dry_run: dryRun,
    total_files: filePaths.length,
    deleted: [], failed: [], space_freed: 0
  };

  for (const fp of filePaths) {
    if (!fp || typeof fp !== 'string') {
      results.failed.push({ file: fp, reason: 'Invalid path' });
      continue;
    }
    if (!path.isAbsolute(fp) || !validatePath(fp)) {
      results.failed.push({ file: fp, reason: 'Blocked by safety policy' });
      continue;
    }

    try {
      const stats = await fs.stat(fp);
      if (dryRun) {
        results.deleted.push({ path: fp, size: stats.size, action: 'would_delete' });
      } else {
        await fs.unlink(fp);
        results.deleted.push({ path: fp, size: stats.size, action: 'deleted' });
      }
      results.space_freed += stats.size;
    } catch (err) {
      results.failed.push({ file: fp, reason: err.message });
    }
  }

  return results;
}
```

Update `module.exports`:

```js
module.exports = {
  validatePath, ALLOWED_ROOTS, POLICIES, MAX_SCAN_FILES, MAX_HASH_SIZE,
  analyzeDirectory, buildSuggestions, generateCleanupToken, executeCleanup
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /home/yb/codes/agentx-platform/data && npx jest tests/unit/janitorService.test.js --no-coverage 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add services/janitorService.js tests/unit/janitorService.test.js
git commit -m "feat(janitor): add buildSuggestions, executeCleanup with token + allowlist (C3, C5, I8, I16)"
```

---

### Task 4: Create `controllers/janitorController.js`

**Files:**
- Create: `controllers/janitorController.js`

- [ ] **Step 1: Create the controller — thin HTTP handlers delegating to the service**

```js
// controllers/janitorController.js
const janitorService = require('../services/janitorService');
const dedupScanner = require('../services/dedupScanner');
const { log } = require('../utils/logger');

/** POST /analyze */
async function analyze(req, res, next) {
  const { path: scanPath } = req.body;
  if (!scanPath) return res.status(400).json({ status: 'error', message: 'path required' });
  if (!janitorService.validatePath(scanPath)) {
    return res.status(403).json({ status: 'error', message: 'Path blocked by safety policy' });
  }
  try {
    const result = await janitorService.analyzeDirectory(scanPath);
    delete result._fileMap;
    res.json({ status: 'success', data: result });
  } catch (err) { next(err); }
}

/** POST /suggest */
async function suggest(req, res, next) {
  const { path: scanPath, policies } = req.body;
  if (!scanPath) return res.status(400).json({ status: 'error', message: 'path required' });
  if (!janitorService.validatePath(scanPath)) {
    return res.status(403).json({ status: 'error', message: 'Path blocked by safety policy' });
  }
  try {
    const analysis = await janitorService.analyzeDirectory(scanPath);
    const active = policies || Object.keys(janitorService.POLICIES).filter(k => janitorService.POLICIES[k].enabled);
    const suggestions = janitorService.buildSuggestions(analysis, active);
    const totalSaved = suggestions.reduce((s, x) => s + (x.space_saved || 0), 0);

    // Generate a confirmation token for the suggested files
    const allFiles = suggestions.flatMap(s => s.files);
    const confirmationToken = allFiles.length > 0 ? janitorService.generateCleanupToken(allFiles) : null;

    res.json({
      status: 'success',
      data: {
        suggestions_count: suggestions.length,
        total_space_saved: totalSaved,
        suggestions: suggestions.slice(0, 100),
        policies_applied: active,
        confirmation_token: confirmationToken
      }
    });
  } catch (err) { next(err); }
}

/** POST /execute */
async function execute(req, res, next) {
  const { files, confirmation_token, dry_run } = req.body;
  if (!files || !Array.isArray(files)) {
    return res.status(400).json({ status: 'error', message: 'files array required' });
  }
  if (!confirmation_token) {
    return res.status(400).json({ status: 'error', message: 'confirmation_token required' });
  }

  const isDryRun = dry_run !== false;
  try {
    const result = await janitorService.executeCleanup(files, confirmation_token, isDryRun);
    if (!result.ok) {
      return res.status(403).json({ status: 'error', message: result.error });
    }
    const verb = isDryRun ? 'Dry run — no files deleted.' : 'Files permanently deleted.';
    log(`Janitor execute: ${isDryRun ? 'Would delete' : 'Deleted'} ${result.deleted.length} files, freed ${result.space_freed} bytes`);
    res.json({ status: 'success', data: { ...result, warning: verb } });
  } catch (err) { next(err); }
}

/** GET /policies */
function listPolicies(req, res) {
  res.json({ status: 'success', data: { policies: Object.values(janitorService.POLICIES) } });
}

/** POST /dedup-scan */
async function dedupScan(req, res, next) {
  const db = req.app.locals.db;
  if (!db) return res.status(503).json({ status: 'error', message: 'Database not ready' });

  const { root_path, extensions, max_depth } = req.body;
  const rootPath = root_path || '/mnt/datalake/';

  if (!janitorService.validatePath(rootPath)) {
    return res.status(403).json({ status: 'error', message: 'Path blocked by safety policy' });
  }

  try {
    const report = await dedupScanner.buildDedupReport(db, {
      rootPath,
      extensions: extensions || [],
      maxDepth: max_depth || null
    });
    const reportId = await dedupScanner.saveReport(db, report);
    log(`Dedup scan complete: ${report.summary.total_duplicate_groups} groups, ${report.summary.total_wasted_space_formatted} wasted`);
    res.json({
      status: 'success',
      message: 'Dedup scan complete',
      data: { report_id: reportId, summary: report.summary }
    });
  } catch (err) {
    log(`Dedup scan failed: ${err.message}`, 'error');
    next(err);
  }
}

/** GET /dedup-report */
async function dedupReport(req, res, next) {
  const db = req.app.locals.db;
  if (!db) return res.status(503).json({ status: 'error', message: 'Database not ready' });

  try {
    const report = await dedupScanner.getReport(db, req.query.report_id || null);
    if (!report) return res.status(404).json({ status: 'error', message: 'No dedup report found' });
    res.json({ status: 'success', data: report });
  } catch (err) { next(err); }
}

/** POST /dedup-approve */
async function dedupApprove(req, res, next) {
  const db = req.app.locals.db;
  if (!db) return res.status(503).json({ status: 'error', message: 'Database not ready' });

  const { report_id, files, confirmation_token, dry_run } = req.body;
  if (!report_id) return res.status(400).json({ status: 'error', message: 'report_id required' });
  if (!files || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ status: 'error', message: 'files array required' });
  }
  if (!confirmation_token) return res.status(400).json({ status: 'error', message: 'confirmation_token required' });

  const isDryRun = dry_run !== false;
  try {
    const result = await dedupScanner.executeApprovedDeletions(db, files, confirmation_token, report_id, isDryRun);
    if (!result.ok) {
      // C3 fix: never leak expected_token in the response
      return res.status(403).json({ status: 'error', message: result.error });
    }
    const verb = isDryRun ? 'Would delete' : 'Deleted';
    log(`Dedup approve: ${verb} ${result.deleted.length} files, freed ${result.space_freed_formatted}`);
    res.json({
      status: 'success',
      message: isDryRun ? 'Dry run — no files deleted.' : 'Approved files deleted.',
      data: result
    });
  } catch (err) { next(err); }
}

module.exports = { analyze, suggest, execute, listPolicies, dedupScan, dedupReport, dedupApprove };
```

- [ ] **Step 2: Commit**

```bash
git add controllers/janitorController.js
git commit -m "feat(janitor): add janitorController — thin HTTP handlers (I13, C3, C6)"
```

---

### Task 5: Rewrite `routes/janitor.routes.js` as thin delegation

**Files:**
- Rewrite: `routes/janitor.routes.js`

- [ ] **Step 1: Replace `routes/janitor.routes.js` with thin routing**

```js
// routes/janitor.routes.js
const router = require('express').Router();
const janitorController = require('../controllers/janitorController');

router.post('/analyze',     janitorController.analyze);
router.post('/suggest',     janitorController.suggest);
router.post('/execute',     janitorController.execute);
router.get('/policies',     janitorController.listPolicies);
router.post('/dedup-scan',  janitorController.dedupScan);
router.get('/dedup-report', janitorController.dedupReport);
router.post('/dedup-approve', janitorController.dedupApprove);

module.exports = router;
```

- [ ] **Step 2: Run existing route tests to verify they still pass**

Run: `cd /home/yb/codes/agentx-platform/data && npx jest tests/unit/dedupRoutes.test.js --no-coverage 2>&1 | tail -10`
Expected: PASS (route paths and behavior unchanged)

- [ ] **Step 3: Commit**

```bash
git add routes/janitor.routes.js
git commit -m "refactor(janitor): slim routes to thin delegation (I13)"
```

---

### Task 6: Fix token leak in `dedupScanner.js` (C3)

**Files:**
- Modify: `services/dedupScanner.js:164-168`
- Modify: `tests/unit/dedupScanner.test.js`

- [ ] **Step 1: Update the failing-token test to assert NO `expected_token` in result**

In `tests/unit/dedupScanner.test.js`, update the test at line 179-184:

Replace:
```js
  test('rejects invalid confirmation token', async () => {
    const db = mockDb();
    const result = await executeApprovedDeletions(db, ['/a.txt'], 'bad-token', 'r1', true);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid confirmation token/);
  });
```

With:
```js
  test('rejects invalid confirmation token without leaking expected token', async () => {
    const db = mockDb();
    const result = await executeApprovedDeletions(db, ['/a.txt'], 'bad-token', 'r1', true);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Invalid confirmation token/);
    expect(result.expected_token).toBeUndefined();
  });
```

- [ ] **Step 2: Run the test to verify it fails (the current code still leaks the token)**

Run: `cd /home/yb/codes/agentx-platform/data && npx jest tests/unit/dedupScanner.test.js -t "rejects invalid" --no-coverage 2>&1 | tail -10`
Expected: FAIL — `expected_token` is defined

- [ ] **Step 3: Fix `services/dedupScanner.js` — remove `expected_token` from the return**

In `services/dedupScanner.js`, replace lines 165-168:

```js
  const expectedToken = generateConfirmationToken(filePaths, reportId);
  if (token !== expectedToken) {
    return { ok: false, error: 'Invalid confirmation token', expected_token: expectedToken };
  }
```

With:

```js
  const expectedToken = generateConfirmationToken(filePaths, reportId);
  if (token !== expectedToken) {
    return { ok: false, error: 'Invalid confirmation token' };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/yb/codes/agentx-platform/data && npx jest tests/unit/dedupScanner.test.js --no-coverage 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 5: Update `tests/unit/dedupRoutes.test.js` — remove `expected_token` from mock and assert it's absent**

In `tests/unit/dedupRoutes.test.js`, replace the 403 token test (lines 180-192):

```js
  test('returns 403 on invalid token without leaking expected token', async () => {
    dedupScanner.executeApprovedDeletions.mockResolvedValue({
      ok: false, error: 'Invalid confirmation token'
    });

    const app = buildApp(mockDb);
    const res = await request(app).post('/api/v1/janitor/dedup-approve').send({
      report_id: 'r1', files: ['/a.txt'], confirmation_token: 'wrong'
    });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/Invalid/);
    expect(res.body.expected_token).toBeUndefined();
  });
```

- [ ] **Step 6: Run all janitor tests**

Run: `cd /home/yb/codes/agentx-platform/data && npx jest tests/unit/ --no-coverage 2>&1 | tail -15`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add services/dedupScanner.js tests/unit/dedupScanner.test.js tests/unit/dedupRoutes.test.js
git commit -m "fix(janitor): remove confirmation token leak from error responses (C3)"
```

---

### Task 7: Add path validation to dedup pipeline in `dedupScanner.js` (C5/C6 alignment)

**Files:**
- Modify: `services/dedupScanner.js`
- Modify: `tests/unit/dedupScanner.test.js`

- [ ] **Step 1: Write failing test — `executeApprovedDeletions` rejects paths outside allowlist**

Append to `tests/unit/dedupScanner.test.js`, inside the `executeApprovedDeletions` describe block:

```js
  test('rejects paths outside allowed roots', async () => {
    const files = ['/etc/shadow'];
    const token = generateConfirmationToken(files, 'r1');
    const db = mockDb();

    const result = await executeApprovedDeletions(db, files, token, 'r1', true);
    expect(result.ok).toBe(true);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toMatch(/safety policy/i);
    expect(result.deleted).toHaveLength(0);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/yb/codes/agentx-platform/data && npx jest tests/unit/dedupScanner.test.js -t "rejects paths outside" --no-coverage 2>&1 | tail -10`
Expected: FAIL — currently the dedup scanner only checks for `/keys/`

- [ ] **Step 3: Add allowlist check to `executeApprovedDeletions` in `services/dedupScanner.js`**

At the top of `services/dedupScanner.js`, add the import:

```js
const { validatePath } = require('./janitorService');
```

In `executeApprovedDeletions`, inside the loop over `filePaths`, add a validatePath check after the isProtectedPath check (after line 182):

```js
    if (!validatePath(fp)) {
      results.failed.push({ path: fp, reason: 'Blocked by safety policy' });
      continue;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/yb/codes/agentx-platform/data && npx jest tests/unit/dedupScanner.test.js --no-coverage 2>&1 | tail -10`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add services/dedupScanner.js tests/unit/dedupScanner.test.js
git commit -m "fix(janitor): add allowlist path validation to dedup deletions (C5)"
```

---

### Task 8: Add controller + route tests for the new janitor flow

**Files:**
- Update: `tests/unit/dedupRoutes.test.js` → rename conceptually to cover all janitor routes
- Or create: `tests/unit/janitorRoutes.test.js`

- [ ] **Step 1: Create `tests/unit/janitorRoutes.test.js` — tests for the non-dedup janitor endpoints**

```js
// tests/unit/janitorRoutes.test.js
const request = require('supertest');
const express = require('express');

jest.mock('../../services/janitorService', () => {
  const actual = jest.requireActual('../../services/janitorService');
  return {
    ...actual,
    analyzeDirectory: jest.fn(),
    buildSuggestions: jest.fn(),
    executeCleanup: jest.fn(),
    generateCleanupToken: jest.fn()
  };
});

const janitorService = require('../../services/janitorService');
const janitorRoutes = require('../../routes/janitor.routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/janitor', janitorRoutes);
  return app;
}

describe('POST /api/v1/janitor/analyze', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns 400 when path is missing', async () => {
    const res = await request(buildApp()).post('/api/v1/janitor/analyze').send({});
    expect(res.status).toBe(400);
  });

  test('returns 403 for blocked path', async () => {
    const res = await request(buildApp()).post('/api/v1/janitor/analyze').send({ path: '/etc' });
    expect(res.status).toBe(403);
  });

  test('returns analysis data for allowed path', async () => {
    janitorService.analyzeDirectory.mockResolvedValue({
      path: '/mnt/datalake/test', total_files: 10, scanned_files: 8,
      total_size: 5000, duplicates_count: 2, wasted_space: 1000,
      duplicate_groups: [], _fileMap: new Map()
    });

    const res = await request(buildApp()).post('/api/v1/janitor/analyze').send({ path: '/mnt/datalake/test' });
    expect(res.status).toBe(200);
    expect(res.body.data.total_files).toBe(10);
    expect(res.body.data._fileMap).toBeUndefined(); // internal map stripped
  });
});

describe('POST /api/v1/janitor/execute', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns 400 when confirmation_token is missing', async () => {
    const res = await request(buildApp()).post('/api/v1/janitor/execute').send({ files: ['/mnt/datalake/a.txt'] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/confirmation_token/);
  });

  test('returns 400 when files is missing', async () => {
    const res = await request(buildApp()).post('/api/v1/janitor/execute').send({ confirmation_token: 'tok' });
    expect(res.status).toBe(400);
  });

  test('returns 403 on invalid token', async () => {
    janitorService.executeCleanup.mockResolvedValue({ ok: false, error: 'Invalid confirmation token' });
    const res = await request(buildApp()).post('/api/v1/janitor/execute').send({
      files: ['/mnt/datalake/a.txt'], confirmation_token: 'wrong'
    });
    expect(res.status).toBe(403);
    expect(res.body.expected_token).toBeUndefined();
  });

  test('executes cleanup with valid token', async () => {
    janitorService.executeCleanup.mockResolvedValue({
      ok: true, dry_run: true, total_files: 1,
      deleted: [{ path: '/mnt/datalake/a.txt', size: 100, action: 'would_delete' }],
      failed: [], space_freed: 100
    });
    const res = await request(buildApp()).post('/api/v1/janitor/execute').send({
      files: ['/mnt/datalake/a.txt'], confirmation_token: 'tok'
    });
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toHaveLength(1);
  });
});

describe('GET /api/v1/janitor/policies', () => {
  test('returns policy list', async () => {
    const res = await request(buildApp()).get('/api/v1/janitor/policies');
    expect(res.status).toBe(200);
    expect(res.body.data.policies.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `cd /home/yb/codes/agentx-platform/data && npx jest tests/unit/janitorRoutes.test.js --no-coverage 2>&1 | tail -15`
Expected: PASS

- [ ] **Step 3: Run all tests to confirm nothing is broken**

Run: `cd /home/yb/codes/agentx-platform/data && npx jest --no-coverage 2>&1 | tail -15`
Expected: All test suites PASS

- [ ] **Step 4: Commit**

```bash
git add tests/unit/janitorRoutes.test.js
git commit -m "test(janitor): add route tests for analyze, execute, policies endpoints"
```

---

### Task 9: Update CLAUDE.md directory structure

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the directory tree in `CLAUDE.md` to reflect new files**

Add `janitorService.js` and `dedupScanner.js` under `services/`, and `janitorController.js` under `controllers/`. Add the `tests/` directory.

The services section should read:
```
├── services/
│   ├── scanner.js              # File scanner (EventEmitter, SHA256)
│   ├── janitorService.js       # Disk janitor: analysis, suggestions, cleanup
│   ├── dedupScanner.js         # Dedup report pipeline (NAS-wide)
│   ├── networkScanner.js       # nmap wrapper
│   ├── liveData.js             # Background fetcher orchestrator
│   └── mqttClient.js           # MQTT pub/sub (optional)
```

The controllers section should include:
```
├── controllers/
│   ├── storageController.js
│   ├── fileBrowserController.js
│   ├── janitorController.js    # Disk janitor + dedup HTTP handlers
│   ├── networkController.js
│   ├── liveDataController.js
│   ├── eventController.js
│   ├── databasesController.js
│   ├── exportController.js
│   └── systemController.js
```

Add tests:
```
├── tests/
│   └── unit/
│       ├── janitorService.test.js
│       ├── janitorRoutes.test.js
│       ├── dedupScanner.test.js
│       └── dedupRoutes.test.js
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update directory structure with janitor service/controller and tests (N12)"
```

---

## Summary of Issues Addressed

| ID | Severity | Fix | Task |
|----|----------|-----|------|
| C3 | Critical | Remove `expected_token` from error responses | 6 |
| C5 | Critical | Switch to path allowlist, apply to dedup pipeline | 1, 7 |
| C6 | Critical | Validate `root_path` on dedup-scan | 4 (controller) |
| I8 | Important | Add `confirmation_token` requirement to `/execute` | 3, 4 |
| I13 | Important | Extract to service + controller | 1–5 |
| I16 | Important | Per-file error handling in `executeCleanup` | 3 |
| N1 | Nitpick | Silent catches now only in service (documented) | 2 |
| N2 | Nitpick | Magic numbers → named constants | 1 |
| N12 | Nitpick | CLAUDE.md directory tree updated | 9 |
| I12 | Important | Standardize on `next(error)` in controller | 4 |
