const { appendFileSync, renameSync, statSync } = require('node:fs');

const MAX_LOG_BYTES = 5 * 1024 * 1024;

// Keeps a log from growing without limit: once it passes maxBytes it becomes
// `<name>.1` (replacing the previous one) and a new file starts.
function rotateLog(file, maxBytes = MAX_LOG_BYTES) {
  try {
    if (statSync(file).size <= maxBytes) return false;
    renameSync(file, `${file}.1`);
    return true;
  } catch {
    // Missing or in use: leave it alone.
    return false;
  }
}

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

module.exports = { createLogger, rotateLog, MAX_LOG_BYTES };
