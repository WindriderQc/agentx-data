/**
 * File Export — generate optimized reports from indexed NAS files.
 * Supports: full, summary, media, large, stats report types.
 */
const path = require('path');
const { formatFileSize, ensureDir, listFilesWithMeta, validateFilename, exists } = require('../utils/file-operations');
const fs = require('fs/promises');

const EXPORT_DIR = path.join(__dirname, '../exports');

function formatFilePath(file) {
  if (file.path) return file.path;
  if (!file.dirname) return file.filename || '';
  return path.join(file.dirname, file.filename || '');
}

async function generateOptimizedReport(db, reportType) {
  const nasFiles = db.collection('nas_files');
  const nasDirs = db.collection('nas_directories');

  if (reportType === 'full') {
    const files = [];
    const cursor = nasFiles.find({}).sort({ dirname: 1, filename: 1 });
    while (await cursor.hasNext()) {
      const f = await cursor.next();
      files.push({ path: formatFilePath(f), filename: f.filename, dirname: f.dirname, ext: f.ext, size: f.size, sizeFormatted: formatFileSize(f.size), mtime: f.mtime });
    }
    return { reportType: 'full', generatedAt: new Date().toISOString(), totalFiles: files.length, files };
  }

  if (reportType === 'summary') {
    let dirs = await nasDirs.find({}).sort({ total_size: -1 }).toArray();
    if (dirs.length === 0) {
      dirs = (await nasFiles.aggregate([
        { $group: { _id: '$dirname', file_count: { $sum: 1 }, total_size: { $sum: '$size' } } },
        { $sort: { total_size: -1 } }
      ]).toArray()).map(d => ({ path: d._id, file_count: d.file_count, total_size: d.total_size }));
    }
    return {
      reportType: 'summary', generatedAt: new Date().toISOString(),
      totalDirectories: dirs.length,
      totalFiles: dirs.reduce((s, d) => s + (d.file_count || 0), 0),
      totalSize: dirs.reduce((s, d) => s + (d.total_size || 0), 0),
      directories: dirs.map(d => ({ directory: d.path, fileCount: d.file_count, totalSize: d.total_size, totalSizeFormatted: formatFileSize(d.total_size) }))
    };
  }

  if (reportType === 'media') {
    const exts = ['jpg','jpeg','png','gif','bmp','webp','svg','mp4','avi','mkv','mov','wmv','flv','webm','mp3','wav','flac','aac','ogg','m4a'];
    const files = await nasFiles.find({ ext: { $in: exts } }).sort({ size: -1 }).toArray();
    return {
      reportType: 'media', generatedAt: new Date().toISOString(), totalMediaFiles: files.length,
      files: files.map(f => ({ path: formatFilePath(f), filename: f.filename, ext: f.ext, size: f.size, sizeFormatted: formatFileSize(f.size) }))
    };
  }

  if (reportType === 'large') {
    const files = await nasFiles.find({ size: { $gte: 100 * 1024 * 1024 } }).sort({ size: -1 }).toArray();
    return {
      reportType: 'large_files', generatedAt: new Date().toISOString(), totalLargeFiles: files.length,
      files: files.map(f => ({ path: formatFilePath(f), filename: f.filename, ext: f.ext, size: f.size, sizeFormatted: formatFileSize(f.size) }))
    };
  }

  if (reportType === 'stats') {
    const [statsByExt, totalFiles, totalSize] = await Promise.all([
      nasFiles.aggregate([
        { $group: { _id: '$ext', count: { $sum: 1 }, totalSize: { $sum: '$size' }, avgSize: { $avg: '$size' }, maxSize: { $max: '$size' } } },
        { $sort: { totalSize: -1 } }
      ]).toArray(),
      nasFiles.countDocuments(),
      nasFiles.aggregate([{ $group: { _id: null, total: { $sum: '$size' } } }]).toArray()
    ]);
    const ts = totalSize[0]?.total || 0;
    return {
      reportType: 'statistics', generatedAt: new Date().toISOString(),
      overview: { totalFiles, totalSize: ts, totalSizeFormatted: formatFileSize(ts) },
      extensionStats: statsByExt.map(s => ({
        extension: s._id || 'none', fileCount: s.count,
        totalSize: s.totalSize, totalSizeFormatted: formatFileSize(s.totalSize),
        avgSize: Math.round(s.avgSize), maxSize: s.maxSize,
        pct: ts > 0 ? Math.round((s.totalSize / ts) * 10000) / 100 : 0
      }))
    };
  }

  throw new Error(`Unknown report type: ${reportType}. Use: full, summary, media, large, stats`);
}

function convertToCSV(data) {
  const list = data.files || data.directories || data.extensionStats || [];
  if (!Array.isArray(list) || list.length === 0) return 'No data\n';
  const headers = Object.keys(list[0]);
  const rows = list.map(item => headers.map(h => {
    const v = item[h];
    if (Array.isArray(v)) return `"${v.length} items"`;
    if (typeof v === 'object' && v !== null) return `"${JSON.stringify(v).replace(/"/g, '""')}"`;
    return typeof v === 'string' && v.includes(',') ? `"${v.replace(/"/g, '""')}"` : v;
  }).join(','));
  return [headers.join(','), ...rows].join('\n');
}

exports.generateReport = async (req, res, next) => {
  try {
    const db = req.app.locals.db;
    const type = req.body.type || req.query.type || 'full';
    const format = req.body.format || req.query.format || 'json';

    const data = await generateOptimizedReport(db, type);
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}`;
    const filename = `export_${type}_${ts}.${format}`;
    const filePath = path.join(EXPORT_DIR, filename);
    await ensureDir(EXPORT_DIR);

    const content = format === 'csv' ? convertToCSV(data) : JSON.stringify(data, null, 2);
    await fs.writeFile(filePath, content);
    const stats = await fs.stat(filePath);

    res.json({
      status: 'success',
      data: { filename, size: stats.size, sizeFormatted: formatFileSize(stats.size), recordCount: data.totalFiles || data.totalMediaFiles || data.totalLargeFiles || 0, generatedAt: data.generatedAt }
    });
  } catch (error) {
    if (error.message.startsWith('Unknown report type')) return res.status(400).json({ status: 'error', message: error.message });
    next(error);
  }
};

exports.listExports = async (req, res, next) => {
  try {
    await ensureDir(EXPORT_DIR);
    const files = await listFilesWithMeta(EXPORT_DIR, { filesOnly: true, sortBy: 'modified', sortOrder: 'desc' });
    res.json({ status: 'success', data: files });
  } catch (error) { next(error); }
};

exports.deleteExport = async (req, res, next) => {
  try {
    const { filename } = req.params;
    if (!validateFilename(filename)) return res.status(400).json({ status: 'error', message: 'Invalid filename' });
    const filePath = path.join(EXPORT_DIR, filename);
    if (!exists(filePath)) return res.status(404).json({ status: 'error', message: 'File not found' });
    await fs.unlink(filePath);
    res.json({ status: 'success', message: 'Deleted' });
  } catch (error) { next(error); }
};

exports.generateOptimizedReport = generateOptimizedReport;
