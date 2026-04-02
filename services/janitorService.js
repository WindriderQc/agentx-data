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

// ── Directory analysis ─────────────────────────────────────────
/**
 * Analyze a directory: hash files, find duplicates.
 * Returns analysis object (with internal _fileMap for downstream use).
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
    _fileMap: fileMap
  };
}

module.exports = {
  validatePath,
  ALLOWED_ROOTS,
  POLICIES,
  MAX_SCAN_FILES,
  MAX_HASH_SIZE,
  analyzeDirectory
};
