const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function validateFilename(filename) {
  if (!filename || typeof filename !== 'string') return false;
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) return false;
  if (/[\x00-\x1f\x80-\x9f]/.test(filename)) return false;
  return true;
}

async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
    return true;
  } catch (error) {
    console.error(`Failed to create directory ${dirPath}:`, error);
    return false;
  }
}

function exists(filePath) {
  try { return fsSync.existsSync(filePath); }
  catch { return false; }
}

async function listFilesWithMeta(dirPath, options = {}) {
  try {
    if (!fsSync.existsSync(dirPath)) return [];
    const files = await fs.readdir(dirPath);
    const fileStats = await Promise.all(
      files.map(async filename => {
        const filePath = path.join(dirPath, filename);
        const stats = await fs.stat(filePath);
        return {
          filename, path: filePath,
          size: stats.size, created: stats.birthtime, modified: stats.mtime,
          isDirectory: stats.isDirectory(), isFile: stats.isFile()
        };
      })
    );

    let filtered = fileStats;
    if (options.filesOnly) filtered = filtered.filter(f => f.isFile);
    if (options.dirsOnly) filtered = filtered.filter(f => f.isDirectory);
    if (options.sortBy) {
      const field = options.sortBy;
      const order = options.sortOrder === 'desc' ? -1 : 1;
      filtered.sort((a, b) => (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0) * order);
    }
    return filtered;
  } catch (error) {
    console.error(`Failed to list files in ${dirPath}:`, error);
    return [];
  }
}

module.exports = { formatFileSize, validateFilename, ensureDir, exists, listFilesWithMeta };
