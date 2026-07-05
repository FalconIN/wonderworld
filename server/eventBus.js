const { EventEmitter } = require('events');

// Single in-process pub/sub bus. Safe because PM2 runs this app in fork mode
// with a single instance (ecosystem.config.js) — one process handles every
// SSE connection, so there's no cross-process delivery problem to solve.
module.exports = new EventEmitter();
