// node:sqlite ships with Node 22.13+ and Electron's Node without a flag, but it
// still prints a one-time ExperimentalWarning. Launchers and tests treat any
// startup stderr as a failure, so that single warning is filtered while the
// module loads. Every other warning still reaches stderr.
function loadSqlite() {
  const emitWarning = process.emitWarning;
  process.emitWarning = function filteredWarning(warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
    const message = typeof warning === 'string' ? warning : warning?.message;
    if (type === 'ExperimentalWarning' && /sqlite/i.test(message || '')) return;
    return emitWarning.call(this, warning, ...rest);
  };
  try {
    return process.getBuiltinModule('node:sqlite');
  } finally {
    process.emitWarning = emitWarning;
  }
}

export const { DatabaseSync } = loadSqlite();

// SQLite's primary result codes for a damaged or foreign file.
const damagedCodes = new Set([11, 26]);

export function isDamagedDatabaseError(error) {
  return Number.isInteger(error?.errcode) && damagedCodes.has(error.errcode & 0xff);
}
