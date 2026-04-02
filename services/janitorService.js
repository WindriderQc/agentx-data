/**
 * janitorService.js — path validation, cleanup policies, and constants
 *
 * Foundation module for the disk janitor toolkit. Provides:
 * - Allowlist-based path validation (replaces old blocklist approach)
 * - Cleanup policy definitions
 * - Shared constants for scan/hash limits
 */
const path = require('path');

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

module.exports = {
  validatePath,
  ALLOWED_ROOTS,
  POLICIES,
  MAX_SCAN_FILES,
  MAX_HASH_SIZE
};
