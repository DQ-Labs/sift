import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

export const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.wav': 'audio/wav',
  '.wave': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.caf': 'audio/x-caf'
};

const contentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'";
const maxJsonBytes = 2_000_000;

export function httpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function sendJson(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

export async function readJson(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw httpError('JSON required', 415);
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > maxJsonBytes) throw httpError('Request too large', 413);
  }
  return JSON.parse(raw || '{}');
}

export async function readBytes(req, maxBytes, tooLarge = 'Request too large') {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw httpError(tooLarge, 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// The server answers only on loopback names for its own port, and only to
// pages it served itself.
export function checkLocalRequest(req, res, port) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  if (!hosts.includes(req.headers.host)) {
    sendJson(res, { error: 'Local access only' }, 403);
    return false;
  }
  if (req.headers.origin && !hosts.map(host => `http://${host}`).includes(req.headers.origin)) {
    sendJson(res, { error: 'Origin denied' }, 403);
    return false;
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', contentSecurityPolicy);
  return true;
}

// Parses a single `bytes=` range. Returns null for an unsatisfiable range.
function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  let start;
  let end = size - 1;
  if (!match[1]) start = Math.max(0, size - Number(match[2]));
  else {
    start = Number(match[1]);
    if (match[2]) end = Math.min(end, Number(match[2]));
  }
  if (start > end || start >= size) return null;
  return { start, end };
}

export async function streamFile(req, res, filename, extraHeaders = {}) {
  const info = await stat(filename);
  let start = 0;
  let end = info.size - 1;
  let status = 200;
  if (req.headers.range) {
    const range = byteRange(req.headers.range, info.size);
    if (!range) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
      return res.end();
    }
    ({ start, end } = range);
    status = 206;
  }
  const headers = {
    'Content-Type': mimeTypes[path.extname(filename).toLowerCase()] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Content-Length': Math.max(0, end - start + 1),
    'Cache-Control': 'no-cache'
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  res.writeHead(status, { ...headers, ...extraHeaders });
  if (req.method === 'HEAD') return res.end();
  const stream = createReadStream(filename, { start, end });
  stream.on('error', () => res.destroy());
  req.on('close', () => stream.destroy());
  stream.pipe(res);
}

export function sendBytes(res, bytes, headers) {
  res.writeHead(200, { 'Content-Length': bytes.length, 'Cache-Control': 'no-store', ...headers });
  res.end(bytes);
}
