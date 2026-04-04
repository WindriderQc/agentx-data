/**
 * janitorService.js — path validation, cleanup policies, and constants
 *
 * Foundation module for the disk janitor toolkit. Provides:
 * - Allowlist-based path validation (replaces old blocklist approach)
 * - Cleanup policy definitions
 * - Shared constants for scan/hash limits
 */
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const crypto = require('crypto');

// ── Allowed roots ───────────────────────────────────────────────
// Only directories under these roots can be scanned or cleaned.
// Override via JANITOR_ALLOWED_ROOTS env var (comma-separated).
const ALLOWED_ROOTS = process.env.JANITOR_ALLOWED_ROOTS
  ? process.env.JANITOR_ALLOWED_ROOTS.split(',').map(r => r.trim().replace(/\/?$/, '/'))
  : ['/mnt/datalake/'];
Object.freeze(ALLOWED_ROOTS);

// ── Cleanup policies ────────────────────────────────────────────
const POLICIES = Object.freeze({
  delete_duplicates: Object.freeze({
    id: 'delete_duplicates',
    name: 'Delete Duplicate Files',
    description: 'Keep oldest copy, delete newer duplicates',
    enabled: true
  }),
  remove_temp_files: Object.freeze({
    id: 'remove_temp_files',
    name: 'Remove Temp Files',
    description: 'Delete temp files older than 7 days',
    enabled: true,
    age_days: 7
  }),
  remove_large_files: Object.freeze({
    id: 'remove_large_files',
    name: 'Flag Large Files',
    description: 'Files > 1GB for manual review',
    enabled: false,
    size_threshold_gb: 1
  })
});

// ── Limits ──────────────────────────────────────────────────────
const MAX_SCAN_FILES = 2000;
const MAX_HASH_SIZE = 100 * 1024 * 1024; // 100 MB

// ── Path validation ─────────────────────────────────────────────
/**
 * Validate a path against the allowlist.
 * Resolves traversal (../), then checks it falls under an allowed root.
 * NOTE: validates lexically only — symlinks are not dereferenced.
 * Callers that open or delete files should verify realpath at operation time.
 *
 * @param {*} p - Path to validate
 * @returns {boolean} true if the resolved path is under an allowed root
 */
function validatePath(p) {
  if (!p || typeof p !== 'string') return false;
  const resolved = path.resolve(p);
  return ALLOWED_ROOTS.some(
    root => resolved === root.replace(/\/$/, '') || resolved.startsWith(root)
  );
}

/**
 * Resolve a path through the filesystem and verify the real target remains
 * under an allowed root. For missing paths, callers can require existence.
 *
 * @param {*} p - Path to resolve
 * @param {Object} [options]
 * @param {boolean} [options.mustExist=false] - require the path to exist
 * @param {'file'|'directory'} [options.type] - expected target type when it exists
 * @returns {Promise<{ok: boolean, path?: string, realPath?: string, reason?: string}>}
 */
async function resolveAllowedPath(p, options = {}) {
  const { mustExist = false, type } = options;
  if (!p || typeof p !== 'string') {
    return { ok: false, reason: 'Invalid path' };
  }

  const inputPath = path.resolve(p);
  let realPath = inputPath;

  try {
    realPath = await fs.realpath(inputPath);
  } catch (err) {
    if (mustExist) {
      return {
        ok: false,
        reason: err?.code === 'ENOENT' ? 'Path not found' : `Unable to resolve path: ${err.message}`
      };
    }
  }

  if (!validatePath(realPath)) {
    return { ok: false, reason: 'Blocked by safety policy' };
  }

  if (mustExist && type) {
    try {
      const stats = await fs.stat(realPath);
      if (type === 'directory' && !stats.isDirectory()) {
        return { ok: false, reason: 'Path must be a directory' };
      }
      if (type === 'file' && !stats.isFile()) {
        return { ok: false, reason: 'Path must be a file' };
      }
    } catch (err) {
      return {
        ok: false,
        reason: err?.code === 'ENOENT' ? 'Path not found' : `Unable to stat path: ${err.message}`
      };
    }
  }

  return { ok: true, path: inputPath, realPath };
}

// ── Directory analysis ─────────────────────────────────────────
/**
 * Analyze a directory: hash files, find duplicates.
 * Returns analysis object (with internal _fileMap for downstream use).
 */
async function analyzeDirectory(dirPath) {
  const fileMap = new Map();
  let totalFiles = 0, totalSize = 0, scannedFiles = 0;
  const visitedDirs = new Set();

  async function scan(dir) {
    if (totalFiles >= MAX_SCAN_FILES) return;
    let realDir;
    try { realDir = await fs.realpath(dir); }
    catch { return; }
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);

    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; }

    for (const entry of entries) {
      if (totalFiles >= MAX_SCAN_FILES) break;
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
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
    _fileMap: fileMap
  };
}

// ── Build suggestions from analysis ────────────────────────────
/**
 * Generate cleanup suggestions from an analysis result.
 *
 * @param {Object} analysis - Result from analyzeDirectory (must include _fileMap, duplicate_groups)
 * @param {string[]} activePolicies - Array of active policy IDs
 * @returns {Array<{policy, action, files, reason, space_saved}>}
 */
function buildSuggestions(analysis, activePolicies) {
  const suggestions = [];

  if (activePolicies.includes('delete_duplicates')) {
    for (const group of analysis.duplicate_groups) {
      const files = Array.from(analysis._fileMap.get(group.hash))
        .sort((a, b) => new Date(a.mtime) - new Date(b.mtime));
      const toDelete = files.slice(1);
      if (toDelete.length > 0) {
        suggestions.push({
          policy: 'delete_duplicates',
          action: 'delete',
          files: toDelete.map(f => f.path),
          reason: `Duplicate of ${files[0].path}`,
          space_saved: group.wasted
        });
      }
    }
  }

  if (activePolicies.includes('remove_temp_files')) {
    const ageDays = POLICIES.remove_temp_files.age_days || 7;
    const cutoff = new Date(Date.now() - ageDays * 86400000);
    for (const [, files] of analysis._fileMap) {
      for (const file of files) {
        if ((file.path.includes('/temp/') || file.path.includes('/tmp/')) && new Date(file.mtime) < cutoff) {
          suggestions.push({
            policy: 'remove_temp_files',
            action: 'delete',
            files: [file.path],
            reason: 'Old temp file',
            space_saved: file.size
          });
        }
      }
    }
  }

  return suggestions;
}

// ── Cleanup token generation ──────────────────────────────────
/**
 * Generate a confirmation token for a set of file paths.
 * Token = SHA256 of sorted paths joined with newline, truncated to 16 hex chars.
 *
 * @param {string[]} filePaths
 * @returns {string} 16-char hex token
 */
function generateCleanupToken(filePaths) {
  const sorted = [...filePaths].sort();
  return crypto.createHash('sha256')
    .update(sorted.join('\n'))
    .digest('hex')
    .slice(0, 16);
}

// ── Execute cleanup ───────────────────────────────────────────
/**
 * Execute file cleanup with token validation and per-file error handling.
 * SECURITY: Never returns expected_token on mismatch (C3 fix).
 *
 * @param {string[]} filePaths - Files to delete
 * @param {string} token - Confirmation token from generateCleanupToken
 * @param {boolean} dryRun - If true, report only without deleting
 * @returns {Promise<Object>} Result with ok, dry_run, total_files, deleted, failed, space_freed
 */
async function executeCleanup(filePaths, token, dryRun) {
  const expectedToken = generateCleanupToken(filePaths);
  if (token !== expectedToken) {
    return { ok: false, error: 'Invalid confirmation token' };
  }

  const results = { ok: true, dry_run: dryRun, total_files: filePaths.length, deleted: [], failed: [], space_freed: 0 };

  for (const filePath of filePaths) {
    if (!validatePath(filePath)) {
      results.failed.push({ file: filePath, reason: 'Blocked by safety policy' });
      continue;
    }

    try {
      const stats = await fs.stat(filePath);
      if (dryRun) {
        results.deleted.push({ file: filePath, action: 'would_delete', size: stats.size });
      } else {
        await fs.unlink(filePath);
        results.deleted.push({ file: filePath, action: 'deleted', size: stats.size });
      }
      results.space_freed += stats.size;
    } catch (err) {
      results.failed.push({ file: filePath, reason: err.message });
    }
  }

  return results;
}

module.exports = {
  validatePath,
  resolveAllowedPath,
  ALLOWED_ROOTS,
  POLICIES,
  MAX_SCAN_FILES,
  MAX_HASH_SIZE,
  analyzeDirectory,
  buildSuggestions,
  generateCleanupToken,
  executeCleanup
};
