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
