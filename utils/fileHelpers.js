const path = require('path');

function formatFilePath(file) {
  if (file.path) return file.path;
  if (!file.dirname) return file.filename || '';
  return path.join(file.dirname, file.filename || '');
}

module.exports = { formatFilePath };
