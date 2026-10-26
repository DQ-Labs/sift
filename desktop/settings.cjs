const { readFileSync, writeFileSync, renameSync } = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  checkForUpdates: true,
  skippedVersion: null,
});

// Small JSON settings file for desktop-only preferences, kept beside the
// catalogue in the data folder. A missing or damaged file falls back to defaults.
class DesktopSettings {
  constructor(dataDirectory) {
    this.file = path.join(dataDirectory, 'desktop-settings.json');
    this.values = { ...DEFAULTS };
    try {
      const stored = JSON.parse(readFileSync(this.file, 'utf8'));
      if (typeof stored.checkForUpdates === 'boolean') this.values.checkForUpdates = stored.checkForUpdates;
      if (typeof stored.skippedVersion === 'string') this.values.skippedVersion = stored.skippedVersion;
    } catch {
      // Defaults apply.
    }
  }

  get(name) {
    return this.values[name];
  }

  set(name, value) {
    this.values[name] = value;
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.values, null, 2) + '\n');
    renameSync(temporary, this.file);
  }
}

module.exports = { DesktopSettings, DEFAULTS };
