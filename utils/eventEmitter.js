const EventEmitter = require('events');

// Shared event bus for app-wide pub/sub (SSE feeds, event logging, etc.)
module.exports = new (class AppEmitter extends EventEmitter {})();
