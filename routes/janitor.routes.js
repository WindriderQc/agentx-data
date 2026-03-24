/**
 * Janitor — live disk analysis + cleanup with safety checks.
 * Scans real directories (not just DB), hashes files, finds dupes.
 */
const router = require('express').Router();
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');
const { log } = require('../utils/logger');

const POLICIES = {
  delete_duplicates: { id: 'delete_duplicates', name: 'Delete Duplicate Files', description: 'Keep oldest copy, delete newer duplicates', enabled: true },
  remove_temp_files: { id: 'remove_temp_files', name: 'Remove Temp Files', description: 'Delete temp files older than 7 days', enabled: true, age_days: 7 },
  remove_large_files: { id: 'remove_large_files', name: 'Flag Large Files', description: 'Files > 1GB for manual review', enabled: false, size_threshold_gb: 1 }
};

const BLOCKLIST = ['/', '/home', '/usr', '/bin', '/etc', '/var', '/sys', '/proc'];

async function analyzeDirectory(dirPath) {
  const fileMap = new Map();
  let totalFiles = 0, totalSize = 0, scannedFiles = 0;
  const MAX_FILES = 2000;

  async function scan(dir) {
    if (totalFiles >= MAX_FILES) return;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (totalFiles >= MAX_FILES) break;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) { await scan(fullPath); continue; }
        if (!entry.isFile()) continue;

        const stats = await fs.stat(fullPath);
        totalFiles++; totalSize += stats.size;
        if (stats.size > 100 * 1024 * 1024) continue; // skip >100MB for hashing

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
        } catch { /* skip unreadable */ }
      }
    } catch { /* skip inaccessible dirs */ }
  }

  await scan(dirPath);

  const duplicates = [];
  for (const [hash, files] of fileMap.entries()) {
    if (files.length > 1) {
      duplicates.push({ hash, count: files.length, files: files.map(f => f.path), size: files[0].size, wasted: files[0].size * (files.length - 1) });
    }
  }

  return {
    path: dirPath, total_files: totalFiles, scanned_files: scannedFiles, total_size: totalSize,
    duplicates_count: duplicates.length, wasted_space: duplicates.reduce((s, d) => s + d.wasted, 0),
    duplicate_groups: duplicates.slice(0, 50), fileMap
  };
}

router.post('/analyze', async (req, res) => {
  const { path: scanPath } = req.body;
  if (!scanPath) return res.status(400).json({ status: 'error', message: 'path required' });
  try {
    const result = await analyzeDirectory(scanPath);
    delete result.fileMap; // don't leak internal map
    res.json({ status: 'success', data: result });
  } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

router.post('/suggest', async (req, res) => {
  const { path: scanPath, policies } = req.body;
  if (!scanPath) return res.status(400).json({ status: 'error', message: 'path required' });
  try {
    const analysis = await analyzeDirectory(scanPath);
    const active = policies || Object.keys(POLICIES).filter(k => POLICIES[k].enabled);
    const suggestions = [];

    if (active.includes('delete_duplicates')) {
      for (const group of analysis.duplicate_groups) {
        const files = Array.from(analysis.fileMap.get(group.hash)).sort((a, b) => new Date(a.mtime) - new Date(b.mtime));
        const toDelete = files.slice(1);
        if (toDelete.length > 0) {
          suggestions.push({ policy: 'delete_duplicates', action: 'delete', files: toDelete.map(f => f.path), reason: `Duplicate of ${files[0].path}`, space_saved: group.wasted });
        }
      }
    }

    if (active.includes('remove_temp_files')) {
      const cutoff = new Date(Date.now() - (POLICIES.remove_temp_files.age_days || 7) * 86400000);
      for (const [, files] of analysis.fileMap) {
        for (const file of files) {
          if ((file.path.includes('/temp/') || file.path.includes('/tmp/')) && new Date(file.mtime) < cutoff) {
            suggestions.push({ policy: 'remove_temp_files', action: 'delete', files: [file.path], reason: 'Old temp file', space_saved: file.size });
          }
        }
      }
    }

    const totalSaved = suggestions.reduce((s, x) => s + (x.space_saved || 0), 0);
    res.json({ status: 'success', data: { suggestions_count: suggestions.length, total_space_saved: totalSaved, suggestions: suggestions.slice(0, 100), policies_applied: active } });
  } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

router.post('/execute', async (req, res) => {
  const { files, dry_run } = req.body;
  if (!files || !Array.isArray(files)) return res.status(400).json({ status: 'error', message: 'files array required' });

  const isDryRun = dry_run !== false;
  const results = { dry_run: isDryRun, total_files: files.length, deleted: [], failed: [], space_freed: 0 };

  for (const filePath of files) {
    if (!filePath || typeof filePath !== 'string') { results.failed.push({ file: filePath, reason: 'Invalid path' }); continue; }
    if (BLOCKLIST.includes(filePath) || !path.isAbsolute(filePath)) { results.failed.push({ file: filePath, reason: 'Blocked by safety policy' }); continue; }
    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats) { results.failed.push({ file: filePath, reason: 'Not found' }); continue; }
    if (!isDryRun) await fs.unlink(filePath);
    results.deleted.push(filePath);
    results.space_freed += stats.size;
  }

  res.json({ status: 'success', data: { ...results, warning: isDryRun ? 'Dry run — no files deleted.' : 'Files permanently deleted.' } });
});

router.get('/policies', (req, res) => {
  res.json({ status: 'success', data: { policies: Object.values(POLICIES) } });
});

module.exports = router;
