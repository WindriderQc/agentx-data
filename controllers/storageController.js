const { Scanner } = require('../services/scanner');
const { ObjectId } = require('mongodb');
const { resolveAllowedPath } = require('../services/janitorService');
const { log } = require('../utils/logger');
const { fetchWithTimeoutAndRetry } = require('../utils/fetch-utils');

// Track running scans so they can be stopped
const runningScans = new Map();

// Helper to resolve n8n Webhook URL
function resolveN8nUrl() {
  return process.env.N8N_WEBHOOK_URL ||
    (process.env.N8N_WEBHOOK_BASE_URL && process.env.N8N_WEBHOOK_GENERIC
      ? `${process.env.N8N_WEBHOOK_BASE_URL}/${process.env.N8N_WEBHOOK_GENERIC}` : null);
}

// Cleanup stale "running" scans on server restart
async function cleanupStaleScans(db) {
  try {
    const result = await db.collection('nas_scans').updateMany(
      { status: 'running' },
      { $set: { status: 'stopped', finished_at: new Date() } }
    );
    if (result.modifiedCount > 0) {
      log(`[Storage] Cleaned up ${result.modifiedCount} stale running scan(s)`);
    }
  } catch (error) {
    log(`[Storage] Error cleaning up stale scans: ${error.message}`, 'error');
  }
}

const scan = async (req, res) => {
  try {
    const { roots, extensions, exclude_extensions, batch_size, compute_hashes, hash_max_size } = req.body;
    const db = req.app.locals.db;
    const scan_id = new ObjectId().toHexString();
    const requestedRoots = Array.isArray(roots) ? roots : [];

    if (requestedRoots.length === 0) {
      return res.status(400).json({ status: 'error', message: 'roots must be a non-empty array' });
    }

    const safeRoots = [];
    for (const root of requestedRoots) {
      const safePath = await resolveAllowedPath(root, { mustExist: true, type: 'directory' });
      if (!safePath.ok) {
        return res.status(safePath.reason === 'Blocked by safety policy' ? 403 : 400)
          .json({ status: 'error', message: `Invalid scan root "${root}": ${safePath.reason}` });
      }
      safeRoots.push(safePath.realPath);
    }

    const scanner = new Scanner(db);
    runningScans.set(scan_id, scanner);
    scanner.on('done', () => runningScans.delete(scan_id));

    scanner.run({
      roots: safeRoots,
      includeExt: extensions,
      excludeExt: exclude_extensions,
      batchSize: batch_size || 1000,
      scanId: scan_id,
      computeHashes: compute_hashes === true,
      hashMaxSize: hash_max_size || 100 * 1024 * 1024
    }).catch(err => {
      log(`[Storage] Scan ${scan_id} failed: ${err.message}`, 'error');
      runningScans.delete(scan_id);
    });

    res.json({
      status: 'success',
      message: 'Scan started successfully',
      data: { scan_id, roots: safeRoots, extensions, exclude_extensions, batch_size: batch_size || 1000 }
    });
  } catch (error) {
    log(`[Storage] Error starting scan: ${error.message}`, 'error');
    res.status(500).json({ status: 'error', message: 'Failed to start scan', error: error.message });
  }
};

const getStatus = async (req, res) => {
  try {
    const { scan_id } = req.params;
    if (!scan_id) return res.status(400).json({ status: 'error', message: 'Missing scan_id' });

    const db = req.app.locals.db;
    const scanDoc = await db.collection('nas_scans').findOne({ _id: scan_id });
    if (!scanDoc) return res.status(404).json({ status: 'error', message: `Scan not found: ${scan_id}` });

    res.json({
      status: 'success',
      data: {
        _id: scanDoc._id,
        status: scanDoc.status,
        live: runningScans.has(scan_id),
        counts: scanDoc.counts,
        config: scanDoc.config || { roots: scanDoc.roots || [], extensions: [], batch_size: null },
        started_at: scanDoc.started_at,
        finished_at: scanDoc.finished_at,
        last_error: scanDoc.last_error
      }
    });
  } catch (error) {
    log(`[Storage] Failed to get scan status: ${error.message}`, 'error');
    res.status(500).json({ status: 'error', message: 'Failed to retrieve scan status', error: error.message });
  }
};

const stopScan = async (req, res) => {
  try {
    const { scan_id } = req.params;
    if (!scan_id) return res.status(400).json({ status: 'error', message: 'Missing scan_id' });

    const scanner = runningScans.get(scan_id);
    if (!scanner) return res.status(404).json({ status: 'error', message: 'Scan not running or already completed' });

    scanner.stop();
    res.json({ status: 'success', message: 'Stop request sent', data: { scan_id } });
  } catch (error) {
    log(`[Storage] Failed to stop scan: ${error.message}`, 'error');
    res.status(500).json({ status: 'error', message: 'Failed to stop scan', error: error.message });
  }
};

const listScans = async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const db = req.app.locals.db;
    const parsedPage = Math.max(1, parseInt(page));
    const parsedLimit = Math.max(1, Math.min(100, parseInt(limit)));
    const skip = (parsedPage - 1) * parsedLimit;

    const col = db.collection('nas_scans');
    const [total, scans] = await Promise.all([
      col.countDocuments(),
      col.find({}).sort({ started_at: -1 }).skip(skip).limit(parsedLimit).toArray()
    ]);

    const scansWithLive = scans.map(scan => {
      const isLive = runningScans.has(scan._id);
      let status = scan.status;
      if (status === 'running' && !isLive) status = 'stopped';

      return {
        ...scan, status, live: isLive,
        duration: scan.finished_at && scan.started_at
          ? Math.round((new Date(scan.finished_at) - new Date(scan.started_at)) / 1000) : null
      };
    });

    res.json({
      status: 'success',
      data: {
        scans: scansWithLive,
        pagination: { total, page: parsedPage, limit: parsedLimit, pages: Math.ceil(total / parsedLimit) }
      }
    });
  } catch (error) {
    log(`[Storage] Failed to list scans: ${error.message}`, 'error');
    res.status(500).json({ status: 'error', message: 'Failed to retrieve scans list', error: error.message });
  }
};

const insertBatch = async (req, res) => {
  try {
    const { scan_id } = req.params;
    const { files, meta } = req.body;

    if (!scan_id) return res.status(400).json({ status: 'error', message: 'Missing scan_id' });
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ status: 'error', message: 'files must be a non-empty array' });
    }

    const db = req.app.locals.db;
    const scanDoc = await db.collection('nas_scans').findOne({ _id: scan_id });
    if (!scanDoc) return res.status(404).json({ status: 'error', message: `Scan not found: ${scan_id}` });

    const filesCollection = db.collection('nas_files');
    const now = new Date();

    for (const [index, file] of files.entries()) {
      if (!file || typeof file.path !== 'string' || file.path.trim() === '') {
        return res.status(400).json({ status: 'error', message: `files[${index}].path must be a non-empty string` });
      }
    }

    const bulkOps = files.map(file => {
      const normalizedPath = file.path.replace(/\/+$/, '').trim();
      const pathParts = normalizedPath?.split('/') || [];
      const filename = pathParts.pop() || '';
      const dirname = pathParts.join('/') || '';
      const dotIdx = filename.lastIndexOf('.');
      const extension = dotIdx >= 0 ? filename.slice(dotIdx + 1).toLowerCase() : '';

      return {
        updateOne: {
          filter: { path: normalizedPath },
          update: {
            $set: {
              path: normalizedPath, dirname, filename, ext: extension, extension,
              size: file.size || 0,
              modified: file.mtime ? new Date(file.mtime * 1000) : file.modified ? new Date(file.modified) : now,
              scan_id, updated_at: now
            },
            $setOnInsert: { created_at: now }
          },
          upsert: true
        }
      };
    });

    const result = await filesCollection.bulkWrite(bulkOps, { ordered: false });

    await db.collection('nas_scans').updateOne(
      { _id: scan_id },
      {
        $inc: {
          'counts.files_processed': files.length,
          'counts.inserted': result.upsertedCount || 0,
          'counts.updated': result.modifiedCount || 0
        },
        $set: { last_batch_at: now }
      }
    );

    res.json({
      status: 'success',
      message: `Processed ${files.length} files`,
      data: {
        scan_id,
        batch: { received: files.length, inserted: result.upsertedCount || 0, updated: result.modifiedCount || 0 },
        meta: meta || {}
      }
    });
  } catch (error) {
    log(`[Storage] Failed to insert batch: ${error.message}`, 'error');
    res.status(500).json({ status: 'error', message: 'Failed to insert file batch', error: error.message });
  }
};

const updateScan = async (req, res) => {
  try {
    const { scan_id } = req.params;
    const { status, stats, completedAt } = req.body;
    if (!scan_id) return res.status(400).json({ status: 'error', message: 'Missing scan_id' });

    const db = req.app.locals.db;
    const updateFields = {};

    if (status) updateFields.status = status === 'completed' ? 'complete' : status;
    if (status === 'complete' || status === 'completed' || completedAt) {
      updateFields.finished_at = completedAt ? new Date(completedAt) : new Date();
    }
    if (stats) {
      const allowedStats = ['files_processed', 'inserted', 'updated', 'errors', 'skipped', 'directories'];
      Object.entries(stats).forEach(([key, value]) => {
        if (allowedStats.includes(key)) updateFields[`counts.${key}`] = value;
      });
    }

    const result = await db.collection('nas_scans').updateOne({ _id: scan_id }, { $set: updateFields });
    if (result.matchedCount === 0) return res.status(404).json({ status: 'error', message: `Scan not found: ${scan_id}` });

    // Trigger n8n webhook if scan completed
    const n8nUrl = resolveN8nUrl();
    if (status === 'completed' && n8nUrl) {
      fetchWithTimeoutAndRetry(n8nUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'scan_complete', scan_id, stats: stats || {} }),
        timeout: 5000, retries: 1, name: 'n8n-webhook'
      }).catch(err => log(`[Storage] Failed to trigger n8n webhook: ${err.message}`, 'warn'));
    }

    res.json({ status: 'success', message: 'Scan updated', data: { scan_id, updated: updateFields } });
  } catch (error) {
    log(`[Storage] Failed to update scan: ${error.message}`, 'error');
    res.status(500).json({ status: 'error', message: 'Failed to update scan', error: error.message });
  }
};

const getDirectoryCount = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const count = await db.collection('nas_directories').countDocuments();
    res.json({ status: 'success', data: { count } });
  } catch (error) {
    next(error);
  }
};

const getSummary = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const files = db.collection('nas_files');
    const scans = db.collection('nas_scans');

    const [fileStats, lastScan, duplicateCount] = await Promise.all([
      files.aggregate([{
        $group: {
          _id: null,
          totalFiles: { $sum: 1 },
          totalSize: { $sum: '$size' },
          hashedFiles: { $sum: { $cond: [{ $ifNull: ['$sha256', false] }, 1, 0] } }
        }
      }]).toArray(),
      scans.findOne({}, { sort: { started_at: -1 } }),
      files.aggregate([
        { $match: { sha256: { $exists: true, $ne: null } } },
        { $group: { _id: '$sha256', count: { $sum: 1 }, size: { $first: '$size' } } },
        { $match: { count: { $gt: 1 } } },
        { $group: { _id: null, groups: { $sum: 1 }, wasted: { $sum: { $multiply: ['$size', { $subtract: ['$count', 1] }] } } } }
      ]).toArray()
    ]);

    const { formatFileSize } = require('../utils/file-operations');
    const stats = fileStats[0] || { totalFiles: 0, totalSize: 0, hashedFiles: 0 };
    const dupes = duplicateCount[0] || { groups: 0, wasted: 0 };

    res.json({
      status: 'success',
      data: {
        totalFiles: stats.totalFiles,
        totalSize: stats.totalSize,
        totalSizeFormatted: formatFileSize(stats.totalSize),
        hashedFiles: stats.hashedFiles,
        lastScan: lastScan ? {
          id: lastScan._id, status: lastScan.status,
          started_at: lastScan.started_at, finished_at: lastScan.finished_at,
          counts: lastScan.counts
        } : null,
        duplicates: {
          groups: dupes.groups,
          potentialSavings: dupes.wasted,
          potentialSavingsFormatted: formatFileSize(dupes.wasted)
        }
      }
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  scan, getStatus, stopScan, listScans,
  getDirectoryCount, insertBatch, updateScan,
  cleanupStaleScans, getSummary
};
