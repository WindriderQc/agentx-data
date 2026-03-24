const winston = require('winston');

const level = process.env.LOG_LEVEL || 'info';
const silent = process.env.NODE_ENV === 'test';

const logger = winston.createLogger({
  level,
  format: winston.format.json(),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
      silent
    })
  ]
});

const log = (message, level = 'info') => {
  logger.log(level, message);
};

module.exports = { log, logger };
