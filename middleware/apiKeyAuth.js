/**
 * API Key authentication middleware.
 * When DATA_API_KEY is set, all requests (except /health) must provide it
 * via the x-api-key header or ?api_key query parameter.
 */
const { log } = require('../utils/logger');

const API_KEY = process.env.DATA_API_KEY;

function apiKeyAuth(req, res, next) {
  if (!API_KEY) return next();                       // auth disabled
  if (req.path === '/health' || req.path === '/') return next();  // always open

  const provided = req.headers['x-api-key'] || req.query.api_key;
  if (!provided) {
    return res.status(401).json({ status: 'error', message: 'Missing API key' });
  }

  if (provided !== API_KEY) {
    log(`[auth] Invalid API key from ${req.ip}`, 'warn');
    return res.status(403).json({ status: 'error', message: 'Invalid API key' });
  }

  next();
}

module.exports = apiKeyAuth;
