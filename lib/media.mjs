import { spawn } from 'node:child_process';
import { stat, mkdir, readdir, unlink, rename, utimes } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { parseKey, renderPlan } from '../public/harmony.js';

export function runMedia(command, args, { maxBytes = 16 * 1024 * 1024, timeout = 60000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let length = 0;
    let stderr = '';
    let failure;
    const stop = error => {
      failure = error;
      child.kill();
    };
    const abort = () => stop(new Error('Audio processing cancelled.'));
    const timer = setTimeout(() => stop(new Error('Audio processing timed out.')), timeout);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', chunk => {
      length += chunk.length;
      if (length > maxBytes) stop(new Error('Audio exceeds the processing limit.'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on('error', error => {
      failure = new Error(error.code === 'ENOENT' ? `${command} is unavailable. Install FFmpeg with Rubber Band support and restart Sift.` : error.message);
    });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure || code) reject(failure || new Error(`Audio processing failed: ${stderr.trim().slice(-500)}`));
      else resolve(Buffer.concat(chunks));
    });
  });
}

export const ffmpeg = process.env.SIFT_FFMPEG || 'ffmpeg';
export const ffprobe = process.env.SIFT_FFPROBE || 'ffprobe';

export async function probeAudio(filename, signal) {
  const raw = await runMedia(ffprobe, [
    '-v', 'error', '-protocol_whitelist', 'file,pipe', '-select_streams', 'a:0',
    '-show_entries', 'stream=sample_rate,channels,bits_per_raw_sample,bits_per_sample,duration:format=duration',
    '-of', 'json', filename
  ], { maxBytes: 65536, timeout: 20000, signal });
  const info = JSON.parse(raw);
  const stream = info.streams?.[0];
  if (!stream) throw new Error('No audio stream found.');
  const duration = Number(stream.duration || info.format?.duration);
  return {
    duration: Number.isFinite(duration) ? duration : null,
    rate: +stream.sample_rate || null,
    channels: +stream.channels || null,
    bits: +stream.bits_per_raw_sample || +stream.bits_per_sample || null
  };
}

export async function analysisAudio(filename, signal) {
  const metadata = await probeAudio(filename, signal);
  const pcm = await runMedia(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-protocol_whitelist', 'file,pipe',
    '-i', filename, '-map', '0:a:0', '-t', '60', '-vn', '-ac', '1', '-ar', '44100', '-f', 'f32le', 'pipe:1'
  ], { maxBytes: 44100 * 60 * 4 + 4096, signal });
  const audio = new Float32Array(pcm.length / 4);
  for (let i = 0; i < audio.length; i++) audio[i] = pcm.readFloatLE(i * 4);
  return { audio, metadata };
}

// ---- Rubber Band options per layer type --------------------------------------
// Based on Rubber Band's own "crispness" presets: drums keep sharp, unsmeared
// hits; vocals keep their formants when transposed; pads and textures favour
// smooth, phase-coherent sustain over attack definition.

//
// Only drums process channels together, for a phase-stable stereo image.
// Every other type processes them apart: with channels=together, smooth
// transients collapse a stereo pair onto one channel's pitch (FFmpeg 6.1's
// librubberband), and mixed transients leak one channel into the other
// (FFmpeg 8.1.2's, the build Sift bundles). tests/dsp.test.mjs checks both.
const typeOptions = {
  // Crispness 6 ("may be good for drums") with the percussive onset detector.
  Drums: { transients: 'crisp', detector: 'percussive', phase: 'independent', window: 'short', channels: 'together' },
  // Transposing a voice without moving its formants avoids the chipmunk effect.
  Vocal: { transients: 'mixed', formant: 'preserved', pitchq: 'quality', channels: 'apart' },
  // Crispness 2: no transient handling, no phase lamination.
  Melodic: { transients: 'smooth', phase: 'independent', pitchq: 'quality', channels: 'apart' },
  // Crispness 0: as above with a long window, for the smoothest sustain.
  Texture: { transients: 'smooth', phase: 'independent', window: 'long', pitchq: 'quality', channels: 'apart' },
  Bass: { transients: 'mixed', pitchq: 'quality', channels: 'apart' }
};
const fallbackOptions = { transients: 'mixed', channels: 'apart' };

// Rubber Band filter options for a layer type, in a fixed order so the
// string is stable for the render cache key.
export function rubberbandOptions(type) {
  const options = typeOptions[type] || fallbackOptions;
  return Object.keys(options).sort().map(name => `${name}=${options[name]}`).join(':');
}

export function rubberbandFilter({ rate, semitones, type }) {
  return `rubberband=tempo=${rate.toFixed(8)}:pitch=${(2 ** (semitones / 12)).toFixed(10)}:${rubberbandOptions(type)}`;
}

// ---- Render pool --------------------------------------------------------------

export const renderPriorities = ['now', 'prefetch'];
const maxRenderWorkers = 8;

// min(3, max(2, cores - 1)) by default; SIFT_RENDER_WORKERS overrides it.
export function renderWorkerCount({ env = process.env, cores = availableParallelism() } = {}) {
  const override = Number(env.SIFT_RENDER_WORKERS);
  if (env.SIFT_RENDER_WORKERS && Number.isInteger(override) && override >= 1) return Math.min(override, maxRenderWorkers);
  return Math.min(3, Math.max(2, cores - 1));
}

const queueFull = () => new Error('The stretch queue is full. Wait for the current sounds to finish.');

// Runs keyed jobs `size` at a time. 'now' jobs (a layer someone is waiting
// to hear) start before any 'prefetch' job, and one worker is kept free of
// prefetches so an audible layer never waits behind them. Identical keys
// share one job; a queued prefetch moves up when a 'now' request for the
// same key arrives.
export class RenderPool {
  constructor(size = renderWorkerCount(), { limit = 16 } = {}) {
    this.size = Math.max(1, size);
    this.prefetchLanes = Math.max(1, this.size - 1);
    this.limit = limit;
    this.jobs = new Map();
    this.queues = { now: [], prefetch: [] };
    this.running = { now: 0, prefetch: 0 };
  }

  get active() {
    return this.running.now + this.running.prefetch;
  }

  run(key, priority, task) {
    if (!renderPriorities.includes(priority)) throw new Error('Render priority must be now or prefetch.');
    const existing = this.jobs.get(key);
    if (existing) {
      if (priority === 'now' && existing.priority === 'prefetch' && existing.state === 'queued') this.promote(existing);
      return existing.promise;
    }
    if (this.jobs.size >= this.limit && !(priority === 'now' && this.dropPrefetch())) throw queueFull();
    const job = { key, priority, task, state: 'queued' };
    job.promise = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    this.jobs.set(key, job);
    this.queues[priority].push(job);
    this.pump();
    return job.promise;
  }

  promote(job) {
    this.queues.prefetch = this.queues.prefetch.filter(queued => queued !== job);
    job.priority = 'now';
    this.queues.now.push(job);
    this.pump();
  }

  // Makes room for an audible layer by dropping the oldest queued prefetch.
  dropPrefetch() {
    const job = this.queues.prefetch.shift();
    if (!job) return false;
    this.jobs.delete(job.key);
    job.reject(new Error('Background render dropped to make room for an audible layer.'));
    return true;
  }

  next() {
    if (this.active >= this.size) return null;
    if (this.queues.now.length) return this.queues.now.shift();
    if (this.queues.prefetch.length && this.running.prefetch < this.prefetchLanes) return this.queues.prefetch.shift();
    return null;
  }

  pump() {
    for (let job = this.next(); job; job = this.next()) void this.start(job);
  }

  async start(job) {
    // The lane is counted by the priority the job started with.
    const lane = job.priority;
    job.state = 'running';
    this.running[lane]++;
    try {
      job.resolve(await job.task());
    } catch (error) {
      job.reject(error);
    } finally {
      this.running[lane]--;
      this.jobs.delete(job.key);
      this.pump();
    }
  }

  status() {
    return {
      workers: this.size,
      running: this.active,
      queued: { now: this.queues.now.length, prefetch: this.queues.prefetch.length }
    };
  }
}

// Rejects when signal aborts, without cancelling work other callers share.
function waitFor(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('Audio processing cancelled.'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('Audio processing cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// ---- Render cache -------------------------------------------------------------

// Marks a cached file as just used. False when it does not exist.
async function touch(filename) {
  try {
    await stat(filename);
    await utimes(filename, new Date(), new Date());
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return false;
  }
}

// Formats Chromium cannot decode; they are auditioned through a WAV copy.
export const browserUnplayable = new Set(['.caf', '.aif', '.aiff', '.aifc']);
export const needsBrowserCopy = filename => browserUnplayable.has(path.extname(filename).toLowerCase());

const maxSourceBytes = 100 * 1024 * 1024;
const maxCacheBytes = 512 * 1024 * 1024;
const maxCopySeconds = 10 * 60;
const cachedName = /^[a-f0-9]{64}\.wav$/;

// Tempo/key renders and browser-playable copies, cached on disk by content.
export class StretchCache {
  constructor(directory, { pool = new RenderPool() } = {}) {
    this.directory = directory;
    this.pool = pool;
    this.pruning = null;
    this.pruneAgain = false;
  }

  // Returns the cached file for cacheKey, rendering it with produce(output)
  // through the pool when it is missing.
  async cached(cacheKey, priority, produce, signal) {
    const output = path.join(this.directory, `${cacheKey}.wav`);
    await mkdir(this.directory, { recursive: true });
    if (await touch(output)) return output;
    const job = this.pool.run(cacheKey, priority, async () => {
      // An identical job may have finished between the check above and now.
      if (await touch(output)) return output;
      const temporary = `${output}.tmp`;
      try {
        await produce(temporary);
        await rename(temporary, output);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
      void this.prune(output);
      return output;
    });
    return waitFor(job, signal);
  }

  async render(sample, tempo, { signal, sync = true, key = null, priority = 'now' } = {}) {
    if (!Number.isFinite(tempo) || tempo < 40 || tempo > 240) throw new Error('Session tempo must be 40–240 BPM.');
    if (typeof sync !== 'boolean' || (key !== null && !parseKey(key))) throw new Error('Choose valid tempo sync and session key settings.');
    if (!renderPriorities.includes(priority)) throw new Error('Render priority must be now or prefetch.');
    const { rate, semitones } = renderPlan(sample, { tempo, sync, key });
    if (!Number.isFinite(rate) || rate < .25 || rate > 4) throw new Error('Supported stretch range is 0.25×–4×.');
    const info = await stat(sample.path);
    if (info.size > maxSourceBytes) throw new Error('Choose a file under 100 MB for tempo/key sync.');
    const filter = rubberbandFilter({ rate, semitones, type: sample.type });
    // The filter string carries the tempo, pitch and per-type options.
    const cacheKey = createHash('sha256').update(JSON.stringify(['rubberband-v3', sample.path, info.size, info.mtimeMs, filter])).digest('hex');
    return this.cached(cacheKey, priority, async temporary => {
      const metadata = await probeAudio(sample.path);
      if (!metadata.duration || metadata.duration > 180 || metadata.duration / rate > 360) {
        throw new Error('Tempo/key sync supports source clips up to 3 minutes and output up to 6 minutes. Use a shorter excerpt.');
      }
      await runMedia(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1', '-protocol_whitelist', 'file,pipe',
        '-i', sample.path, '-map', '0:a:0', '-vn', '-af', filter,
        '-ar', '44100', '-ac', String(Math.min(2, metadata.channels || 2)), '-c:a', 'pcm_f32le', '-f', 'wav', temporary
      ], { maxBytes: 65536, timeout: 120000 });
    }, signal);
  }

  // A float WAV copy of a file the browser cannot decode, at its own rate
  // and channel count, for audition and unprocessed workbench playback.
  async browserCopy(filepath, { signal, priority = 'now' } = {}) {
    const info = await stat(filepath);
    if (info.size > maxSourceBytes) throw new Error('Choose a file under 100 MB to audition this format.');
    const cacheKey = createHash('sha256').update(JSON.stringify(['browser-wav-v1', filepath, info.size, info.mtimeMs])).digest('hex');
    return this.cached(cacheKey, priority, async temporary => {
      const metadata = await probeAudio(filepath);
      if (metadata.duration > maxCopySeconds) throw new Error('This format can be auditioned up to 10 minutes long. Convert longer files to WAV.');
      await runMedia(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-threads', '1', '-protocol_whitelist', 'file,pipe',
        '-i', filepath, '-map', '0:a:0', '-vn', '-c:a', 'pcm_f32le', '-f', 'wav', temporary
      ], { maxBytes: 65536, timeout: 120000 });
    }, signal);
  }

  // Keeps the cache under 512 MB, oldest use first. One prune at a time.
  async prune(keep) {
    if (this.pruning) {
      this.pruneAgain = true;
      return;
    }
    this.pruning = (async () => {
      do {
        this.pruneAgain = false;
        await this.pruneOnce(keep);
      } while (this.pruneAgain);
    })();
    try {
      await this.pruning;
    } catch {
      // Pruning is best effort; the next render tries again.
    } finally {
      this.pruning = null;
    }
  }

  async pruneOnce(keep) {
    const files = [];
    for (const name of (await readdir(this.directory)).filter(entry => cachedName.test(entry))) {
      const filename = path.join(this.directory, name);
      try {
        files.push({ filename, ...await stat(filename) });
      } catch {}
    }
    let bytes = files.reduce((total, file) => total + file.size, 0);
    for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (bytes <= maxCacheBytes) break;
      if (file.filename === keep) continue;
      try {
        await unlink(file.filename);
        bytes -= file.size;
      } catch {}
    }
  }
}
