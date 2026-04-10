/**
 * Rate limiting middleware.
 * General: 100 requests/min per IP.
 * Heavy ops (scan, nmap, dedup, analyze): 10 requests/min per IP.
 */
const rateLimit = require('express-rate-limit');

const general = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many requests — try again later' }
});

const heavy = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 'error', message: 'Too many heavy operations — try again later' }
});

module.exports = { general, heavy };
