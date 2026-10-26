import { format } from 'node:util';
import os from 'node:os';

// Keeps the most recent console output in memory for diagnostics reports.
export class LogBuffer {
  constructor(limit = 500) {
    this.limit = limit;
    this.lines = [];
    this.errors = [];
  }

  add(level, text) {
    const entry = { at: new Date().toISOString(), level, text };
    this.lines.push(entry);
    if (this.lines.length > this.limit) this.lines.splice(0, this.lines.length - this.limit);
    if (level === 'error' || level === 'warn') {
      this.errors.push(entry);
      if (this.errors.length > 50) this.errors.shift();
    }
  }

  // Mirrors console output into the buffer while still printing it.
  capture(target = console) {
    for (const level of ['log', 'info', 'warn', 'error']) {
      const original = target[level].bind(target);
      target[level] = (...args) => {
        this.add(level, format(...args));
        original(...args);
      };
    }
    return this;
  }
}

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Drive-letter and UNC paths, plus POSIX paths under the usual user roots.
// Paths may contain spaces, so each runs to the next quote, colon or line end.
const pathTail = `[^"'<>|*?:\\r\\n]*`;
const windowsPath = new RegExp(`(?:(?<![A-Za-z0-9])[A-Za-z]:[\\\\/]|\\\\\\\\[^\\\\\\s"'<>|]+\\\\)${pathTail}`, 'g');
const posixPath = new RegExp(`(?<![\\w.:/])/(?:home|Users|root|mnt|media|Volumes|tmp|var|opt|srv|data|run)(?:/${pathTail})?`, 'g');

// Replaces full paths with labels. Known folders keep their names so a report
// shows which source an error came from, never the files inside it.
export function makeRedactor({ folders = [], dataDirectory, appDirectory, home = os.homedir() } = {}) {
  const known = [];
  // Labels must not look like paths themselves (a drive root is named `D:\`).
  for (const folder of folders) known.push([folder.path, `<folder:${folder.name.replace(/[\\/:]+/g, ' ').trim() || 'root'}>`]);
  if (dataDirectory) known.push([dataDirectory, '<data>']);
  if (appDirectory) known.push([appDirectory, '<app>']);
  if (home) known.push([home, '<home>']);
  known.sort((a, b) => b[0].length - a[0].length);
  const patterns = known
    .filter(([value]) => value && value.length > 1)
    .map(([value, label]) => [new RegExp(`${escapeRegExp(value)}${pathTail}`, 'gi'), label]);
  return value => {
    let result = String(value ?? '');
    for (const [pattern, label] of patterns) result = result.replace(pattern, label);
    return result.replace(windowsPath, '<path>').replace(posixPath, '<path>');
  };
}
