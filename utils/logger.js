/**
 * Data service logger — delegates to shared factory.
 * Factory: ./createLogger.js (standardized across all AgentX services)
 * Preserves legacy { log, logger } export shape for backward compat.
 */
const path = require('path');
const { createLogger } = require('./createLogger');

const logger = createLogger(path.join(__dirname, '../logs'));

const log = (message, level = 'info') => {
  logger.log(level, message);
};

module.exports = { log, logger };
