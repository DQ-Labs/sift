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

// Downloads url to destination and checks it against a pinned SHA-256. An
// existing file with the right hash is reused. A missing pin fails loudly and
// prints the hash, so pinning a new version is a deliberate edit, unless
// allowUnpinned is set; then the hash is returned for the caller to record.
export async function downloadVerified({ url, sha256, destination, timeoutMs = 600000, allowUnpinned = false }) {
  if (!/^https:\/\//.test(url)) throw new Error(`Refusing a non-HTTPS download: ${url}`);
  const expected = (sha256 || '').toLowerCase();
  if (expected && !/^[0-9a-f]{64}$/.test(expected)) throw new Error(`Invalid pinned SHA-256 for ${url}.`);

  if (expected && (await fileExists(destination)) && (await sha256File(destination)) === expected) {
    return { file: destination, sha256: expected };
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.partial`;
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));

  const actual = await sha256File(partial);
  if (!expected && allowUnpinned) {
    console.warn(`No SHA-256 is pinned for ${url}; it hashes to ${actual}. Pin it in UPSTREAM-SOURCES.json.`);
  } else if (!expected) {
    await rm(partial, { force: true });
    throw new Error(`No SHA-256 is pinned for ${url}. The downloaded file hashes to ${actual}; verify it and pin it in UPSTREAM-SOURCES.json.`);
  }
  if (expected && actual !== expected) {
    await rm(partial, { force: true });
    throw new Error(`Checksum mismatch for ${url}: expected ${expected}, got ${actual}.`);
  }
  await rename(partial, destination);
  return { file: destination, sha256: actual };
}
