import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function sha256File(file) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

async function fileExists(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

// A response worth asking for again: the server was busy or briefly broken.
const retryableStatus = status => status === 408 || status === 429 || status >= 500;

async function fetchToFile(url, file, timeoutMs) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok || !response.body) {
    const error = new Error(`Download failed (${response.status}): ${url}`);
    error.retryable = retryableStatus(response.status);
    throw error;
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
}

// Mirrors drop connections now and then. A dropped connection or a busy
// server is tried again, waiting twice as long each time; a refusal such as
// 404 is not, and neither is a file that arrives whole with the wrong hash.
async function fetchWithRetries({ url, partial, timeoutMs, attempts, retryDelayMs }) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchToFile(url, partial, timeoutMs);
    } catch (error) {
      await rm(partial, { force: true });
      const retryable = error.retryable ?? true;
      if (!retryable || attempt >= attempts) throw error;
      const wait = retryDelayMs * 2 ** (attempt - 1);
      console.warn(`Download attempt ${attempt} of ${attempts} failed (${error.cause?.code || error.message}); retrying in ${wait / 1000} s: ${url}`);
      await new Promise(resolve => setTimeout(resolve, wait));
    }
  }
}

// Downloads url to destination and checks it against a pinned SHA-256. An
// existing file with the right hash is reused. A missing pin fails loudly and
// prints the hash, so pinning a new version is a deliberate edit.
export async function downloadVerified({ url, sha256, destination, timeoutMs = 600000, attempts = 4, retryDelayMs = 2000 }) {
  if (!/^https:\/\//.test(url)) throw new Error(`Refusing a non-HTTPS download: ${url}`);
  const expected = (sha256 || '').toLowerCase();
  if (expected && !/^[0-9a-f]{64}$/.test(expected)) throw new Error(`Invalid pinned SHA-256 for ${url}.`);

  if (expected && (await fileExists(destination)) && (await sha256File(destination)) === expected) {
    return { file: destination, sha256: expected };
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.partial`;
  await fetchWithRetries({ url, partial, timeoutMs, attempts, retryDelayMs });

  const actual = await sha256File(partial);
  if (!expected) {
    await rm(partial, { force: true });
    throw new Error(`No SHA-256 is pinned for ${url}. The downloaded file hashes to ${actual}; verify it and pin it in UPSTREAM-SOURCES.json.`);
  }
  if (actual !== expected) {
    await rm(partial, { force: true });
    throw new Error(`Checksum mismatch for ${url}: expected ${expected}, got ${actual}.`);
  }
  await rename(partial, destination);
  return { file: destination, sha256: actual };
}
