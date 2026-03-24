const { GeneralError } = require('../utils/errors');

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  if (err.name === 'CastError') {
    return res.status(400).json({ status: 'error', message: 'Invalid ID format.' });
  }

  if (err instanceof GeneralError) {
    const json = { status: 'error', message: err.message };
    if (err.errors) json.errors = err.errors;
    return res.status(err.getCode()).json(json);
  }

  const shortMsg = err?.message
    ? `Internal server error: ${String(err.message).split('\n')[0].slice(0, 200)}`
    : 'An internal server error occurred.';

  console.error(err?.stack || String(err));
  return res.status(500).json({ status: 'error', message: shortMsg });
}

module.exports = errorHandler;
