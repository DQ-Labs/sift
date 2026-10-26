const { appendFileSync } = require('node:fs');

// Appends desktop-process messages to desktop.log in the data folder. Also used
// as electron-updater's logger, which calls info/warn/error/debug.
function createLogger(file) {
  const write = (level, parts) => {
    const text = parts.map(part => (part instanceof Error ? part.stack || part.message : String(part))).join(' ');
    try {
      appendFileSync(file, `${new Date().toISOString()} ${level} ${text}\n`);
    } catch {
      // Logging must never break the app.
    }
  };
  return {
    file,
    info: (...parts) => write('INFO', parts),
    warn: (...parts) => write('WARN', parts),
    error: (...parts) => write('ERROR', parts),
    debug: () => {},
  };
}

module.exports = { createLogger };
