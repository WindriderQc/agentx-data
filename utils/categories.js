/**
 * Static category → extension map. Used by the file browser to surface
 * groups of files (e.g. documents for RAG ingestion) without re-scanning.
 */
const CATEGORIES = Object.freeze({
  document: Object.freeze(['pdf', 'docx', 'doc', 'txt', 'md', 'odt', 'rtf', 'epub', 'xlsx', 'csv', 'pptx']),
  media:    Object.freeze(['mp4', 'mkv', 'avi', 'mov', 'mp3', 'flac', 'wav', 'jpg', 'jpeg', 'png', 'gif', 'webp']),
  archive:  Object.freeze(['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'bz2', 'xz']),
  code:     Object.freeze(['js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'sh', 'rb']),
  config:   Object.freeze(['json', 'yaml', 'yml', 'toml', 'xml', 'ini', 'env'])
});

function categoryToExts(name) {
  if (!name || typeof name !== 'string') return null;
  return CATEGORIES[name] || null;
}

module.exports = { CATEGORIES, categoryToExts };
