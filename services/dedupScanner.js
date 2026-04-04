/**
 * Dedup Scanner — analyzes nas_files for duplicate groups by SHA256 hash,
 * persists reports to dedup_reports, and handles approved deletions safely.
 */
const crypto = require('crypto');
const { log } = require('../utils/logger');
const { formatFileSize } = require('../utils/file-operations');
const { validatePath, resolveAllowedPath } = require('./janitorService');

/** Paths that must never appear in deletion lists */
const PROTECTED_PATTERNS = ['/keys/', '/keys'];

function isProtectedPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return true;
  return PROTECTED_PATTERNS.some(p => filePath.includes(p));
}

/**
 * Build dupe groups from nas_files via MongoDB aggregation.
 * @param {Db} db - MongoDB database handle
 * @param {Object} opts
 * @param {number} [opts.maxDepth] - max directory depth from root (unused filter stored for metadata)
 * @param {string[]} [opts.extensions] - only include these extensions
 * @param {string} [opts.rootPath] - only files under this root path
 * @returns {Promise<Object>} report document ready for persistence
 */
async function buildDedupReport(db, opts = {}) {
  const files = db.collection('nas_files');
  const matchStage = { sha256: { $exists: true, $ne: null } };

  if (opts.rootPath) {
    const escaped = opts.rootPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    matchStage.path = { $regex: `^${escaped}` };
  }
  if (opts.extensions && opts.extensions.length > 0) {
    matchStage.ext = { $in: opts.extensions.map(e => e.toLowerCase().replace(/^\./, '')) };
  }

  // Exclude protected paths
  matchStage.path = matchStage.path || {};
  if (typeof matchStage.path === 'object' && matchStage.path.$regex) {
    // Already has a regex, add exclusion via $and
    delete matchStage.path;
    matchStage.$and = [
      { path: { $regex: `^${opts.rootPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` } },
      { path: { $not: /\/keys\// } }
    ];
  } else {
    matchStage.path = { $not: /\/keys\// };
  }

  const pipeline = [
    { $match: matchStage },
    {
      $group: {
        _id: '$sha256',
        count: { $sum: 1 },
        size: { $first: '$size' },
        files: {
          $push: {
            path: '$path',
            dirname: '$dirname',
            filename: '$filename',
            size: '$size',
            mtime: '$mtime'
          }
        }
      }
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { size: -1 } }
  ];

  const groups = await files.aggregate(pipeline, { allowDiskUse: true }).toArray();

  const dupeGroups = groups.map(g => ({
    hash: g._id,
    count: g.count,
    file_size: g.size,
    wasted_space: g.size * (g.count - 1),
    files: g.files.map(f => ({
      path: f.path,
      dirname: f.dirname,
      filename: f.filename,
      size: f.size,
      mtime: f.mtime
    })),
    recommended_action: g.count > 1 ? 'review_and_delete_duplicates' : 'none'
  }));

  const totalDupes = dupeGroups.length;
  const totalWasted = dupeGroups.reduce((s, g) => s + g.wasted_space, 0);
  const totalFiles = dupeGroups.reduce((s, g) => s + g.count, 0);
  const top10 = dupeGroups.slice(0, 10);

  const report = {
    created_at: new Date(),
    status: 'complete',
    config: {
      root_path: opts.rootPath || '/mnt/datalake/',
      extensions: opts.extensions || [],
      max_depth: opts.maxDepth || null
    },
    summary: {
      total_duplicate_groups: totalDupes,
      total_duplicate_files: totalFiles,
      total_wasted_space: totalWasted,
      total_wasted_space_formatted: formatFileSize(totalWasted),
      top_10_largest: top10.map(g => ({
        hash: g.hash,
        count: g.count,
        file_size: g.file_size,
        file_size_formatted: formatFileSize(g.file_size),
        wasted_space: g.wasted_space,
        wasted_space_formatted: formatFileSize(g.wasted_space),
        sample_path: g.files[0]?.path || 'unknown'
      }))
    },
    groups: dupeGroups
  };

  return report;
}

/**
 * Persist a dedup report to MongoDB.
 */
async function saveReport(db, report) {
  const col = db.collection('dedup_reports');
  const result = await col.insertOne(report);
  return result.insertedId;
}

/**
 * Get the latest dedup report, or a specific one by ID.
 */
async function getReport(db, reportId) {
  const col = db.collection('dedup_reports');
  if (reportId) {
    const { ObjectId } = require('mongodb');
    return col.findOne({ _id: new ObjectId(reportId) });
  }
  return col.findOne({}, { sort: { created_at: -1 } });
}

/**
 * Generate a confirmation token for a set of file paths.
 * Token = SHA256(sorted paths joined with newline + report ID).
 */
function generateConfirmationToken(filePaths, reportId) {
  const sorted = [...filePaths].sort();
  const payload = sorted.join('\n') + '::' + String(reportId);
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * Validate and execute approved deletions.
 * @param {Db} db
 * @param {string[]} filePaths - files to delete
 * @param {string} token - confirmation token
 * @param {string} reportId - report this approval references
 * @param {boolean} dryRun - if true, simulate only
 * @returns {Promise<Object>} results
 */
async function executeApprovedDeletions(db, filePaths, token, reportId, dryRun = true) {
  const expectedToken = generateConfirmationToken(filePaths, reportId);
  if (token !== expectedToken) {
    return { ok: false, error: 'Invalid confirmation token' };
  }

  const fs = require('fs/promises');
  const results = {
    dry_run: dryRun,
    requested: filePaths.length,
    deleted: [],
    skipped: [],
    failed: [],
    space_freed: 0
  };

  for (const fp of filePaths) {
    if (isProtectedPath(fp)) {
      results.skipped.push({ path: fp, reason: 'Protected path (keys/)' });
      continue;
    }
    if (!validatePath(fp)) {
      results.failed.push({ path: fp, reason: 'Blocked by safety policy' });
      continue;
    }

    try {
      const safePath = await resolveAllowedPath(fp, { mustExist: true, type: 'file' });
      if (!safePath.ok) {
        results.failed.push({ path: fp, reason: safePath.reason });
        continue;
      }
      const stat = await fs.stat(fp);
      if (dryRun) {
        results.deleted.push({ path: fp, size: stat.size, action: 'would_delete' });
        results.space_freed += stat.size;
      } else {
        await fs.unlink(fp);
        results.deleted.push({ path: fp, size: stat.size, action: 'deleted' });
        results.space_freed += stat.size;
        // Also remove from nas_files index
        await db.collection('nas_files').deleteOne({ path: fp });
      }
    } catch (err) {
      results.failed.push({ path: fp, error: err.message });
    }
  }

  results.space_freed_formatted = formatFileSize(results.space_freed);
  results.ok = true;
  return results;
}

module.exports = {
  buildDedupReport,
  saveReport,
  getReport,
  generateConfirmationToken,
  executeApprovedDeletions,
  isProtectedPath
};
