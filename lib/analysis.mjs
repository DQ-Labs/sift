import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { stat } from 'node:fs/promises';
import { analysisAudio } from './media.mjs';
import { effectiveMetadata } from './metadata.mjs';
export { effectiveMetadata } from './metadata.mjs';

// 2 adds the beat grid (`beats`); older results are analysed again once.
export const ANALYSIS_VERSION = 2;
const workerUrl = new URL('./analysis-worker.mjs', import.meta.url);
const maxWorkers = 16;
// A file that cannot be reached right now (unplugged drive, network share).
const unavailableCodes = new Set(['ENOENT', 'ENOTDIR', 'ENODEV', 'ENXIO', 'EIO']);

// min(4, cores - 1) by default; SIFT_ANALYSIS_WORKERS overrides it.
export function analysisWorkerCount({ env = process.env, cores = availableParallelism() } = {}) {
  const override = Number(env.SIFT_ANALYSIS_WORKERS);
  if (env.SIFT_ANALYSIS_WORKERS && Number.isInteger(override) && override >= 1) return Math.min(override, maxWorkers);
  return Math.max(1, Math.min(4, cores - 1));
}

function startWorker() {
  return new Worker(workerUrl, { execArgv: [] });
}

// Sends one job to a worker. A rejected job carries `healthy`: true when the
// worker reported the error itself and can take another job.
function analyzeOn(worker, audio, type, { timeout = 60000, signal } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result, healthy) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
      if (error) reject(Object.assign(error, { healthy }));
      else resolve(result);
    };
    const onMessage = ({ result, error }) => (error ? finish(new Error(error), null, true) : finish(null, result, true));
    const onError = error => finish(error, null, false);
    const onExit = code => finish(new Error(`Analysis worker exited (${code}).`), null, false);
    const abort = () => finish(new Error('Audio analysis cancelled.'), null, false);
    const timer = setTimeout(() => finish(new Error('Audio analysis timed out.'), null, false), timeout);
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    worker.postMessage({ audio, type }, [audio.buffer]);
  });
}

// One-off analysis in a fresh worker.
export async function computeAnalysis(audio, type = 'Other', options = {}) {
  const worker = startWorker();
  try {
    return await analyzeOn(worker, audio, type, options);
  } finally {
    void worker.terminate();
  }
}

// Keeps up to `size` Essentia workers warm. A worker that times out, is
// cancelled or crashes is terminated and replaced on the next job.
export class AnalysisWorkerPool {
  constructor(size, { idleTimeout = 30000, createWorker = startWorker } = {}) {
    this.size = size;
    this.idleTimeout = idleTimeout;
    this.createWorker = createWorker;
    this.idle = [];
    this.busy = new Set();
    this.waiting = [];
    this.closed = false;
  }

  acquire() {
    const entry = this.idle.pop();
    if (entry) {
      clearTimeout(entry.timer);
      entry.worker.ref();
      this.busy.add(entry.worker);
      return Promise.resolve(entry.worker);
    }
    if (this.busy.size < this.size) {
      const worker = this.createWorker();
      this.busy.add(worker);
      return Promise.resolve(worker);
    }
    return new Promise(resolve => this.waiting.push(resolve));
  }

  release(worker) {
    this.busy.delete(worker);
    if (this.closed) {
      void worker.terminate();
      return;
    }
    const next = this.waiting.shift();
    if (next) {
      this.busy.add(worker);
      next(worker);
      return;
    }
    worker.unref();
    const entry = { worker, timer: null };
    entry.timer = setTimeout(() => {
      this.idle = this.idle.filter(item => item !== entry);
      void worker.terminate();
    }, this.idleTimeout);
    entry.timer.unref();
    this.idle.push(entry);
  }

  retire(worker) {
    this.busy.delete(worker);
    void worker.terminate();
    const next = this.waiting.shift();
    if (next && !this.closed) {
      const replacement = this.createWorker();
      this.busy.add(replacement);
      next(replacement);
    }
  }

  async run(audio, type, options) {
    const worker = await this.acquire();
    try {
      const result = await analyzeOn(worker, audio, type, options);
      this.release(worker);
      return result;
    } catch (error) {
      if (error.healthy) this.release(worker);
      else this.retire(worker);
      throw error;
    }
  }

  get workerCount() {
    return this.busy.size + this.idle.length;
  }

  close() {
    this.closed = true;
    for (const entry of this.idle) {
      clearTimeout(entry.timer);
      void entry.worker.terminate();
    }
    this.idle = [];
    for (const worker of this.busy) void worker.terminate();
    this.busy.clear();
  }
}

function isUnavailable(error) {
  return unavailableCodes.has(error?.code);
}

// Background tempo/key analysis over a queue of sample IDs.
//
// Storage is injected: `load(id)` returns the current record and
// `commit(id, apply)` applies a change to the current record and saves it.
// Without them the queue reads `samples()` and mutates those objects, then
// calls `persist()` to save, as the JSON catalogue did.
export class AnalysisQueue {
  constructor({
    samples = () => [],
    load,
    commit,
    persist = async () => {},
    paused = false,
    onUpdate = () => {},
    concurrency = analysisWorkerCount(),
    analyze,
    decode = analysisAudio,
    statFile = stat
  } = {}) {
    this.samples = samples;
    this.load = load || (id => this.samples().find(sample => sample.id === id));
    this.commit = commit || ((id, apply) => {
      const sample = this.load(id);
      if (sample) apply(sample);
      return sample;
    });
    this.persist = persist;
    this.onUpdate = onUpdate;
    this.paused = paused;
    this.concurrency = Math.max(1, concurrency);
    this.pool = analyze ? null : new AnalysisWorkerPool(this.concurrency);
    this.analyze = analyze || ((audio, type, options) => this.pool.run(audio, type, options));
    this.decode = decode;
    this.statFile = statFile;
    this.queue = [];
    this.head = 0;
    this.queued = new Set();
    this.active = new Map();
    this.unsaved = new Map();
    this.completed = 0;
    this.failed = 0;
    this.skipped = 0;
    this.revision = 0;
    this.closed = false;
    this.saveError = null;
    this.dirty = 0;
    this.lastSave = 0;
  }

  get pending() {
    return this.queue.length - this.head;
  }

  status() {
    const processed = this.completed + this.failed + this.skipped;
    const jobs = [...this.active.values()];
    const unfinished = jobs.filter(job => !job.finished).length;
    const remaining = this.pending + unfinished;
    return {
      running: this.active.size > 0,
      paused: this.paused,
      pending: this.pending,
      completed: this.completed,
      failed: this.failed,
      skipped: this.skipped,
      processed,
      total: processed + remaining,
      remaining,
      current: jobs[0]?.sample.name || null,
      active: unfinished,
      workers: this.concurrency,
      revision: this.revision,
      saveError: this.saveError
    };
  }

  enqueue(samples, { force = false } = {}) {
    for (const sample of samples) {
      if (!sample || sample.missing || sample.invalid) continue;
      if (this.active.has(sample.id) || this.queued.has(sample.id)) continue;
      const finished = sample.analysis?.version === ANALYSIS_VERSION && ['done', 'error'].includes(sample.analysis.status);
      if (!force && finished) continue;
      this.push(sample.id);
    }
    this.pump();
    return this.status();
  }

  push(id) {
    this.queue.push(id);
    this.queued.add(id);
  }

  take() {
    const id = this.queue[this.head++];
    this.queued.delete(id);
    // Drop the consumed prefix now and then instead of shifting every time.
    if (this.head > 4096 && this.head * 2 > this.queue.length) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
    return id;
  }

  pause() {
    this.paused = true;
    return this.status();
  }

  resume() {
    this.paused = false;
    this.pump();
    return this.status();
  }

  close() {
    this.closed = true;
    for (const job of this.active.values()) job.controller.abort();
    this.pool?.close();
  }

  // Writes results that could not be saved earlier, then persists. Clears the
  // save error only when everything succeeded.
  async save() {
    try {
      for (const [id, apply] of this.unsaved) {
        await this.commit(id, apply);
        this.unsaved.delete(id);
      }
      await this.persist();
      this.saveError = null;
      this.dirty = 0;
      this.lastSave = Date.now();
    } catch (error) {
      this.saveError = error.message;
      this.paused = true;
      throw error;
    }
  }

  pump() {
    while (!this.closed && !this.paused && this.active.size < this.concurrency && this.pending) {
      const id = this.take();
      const sample = this.load(id);
      if (!sample || sample.missing || sample.invalid) continue;
      const job = { sample, controller: new AbortController(), finished: false };
      this.active.set(id, job);
      void this.run(id, job);
    }
  }

  async analyzeFile(sample, signal) {
    const before = await this.statFile(sample.path);
    const { audio, metadata } = await this.decode(sample.path, signal);
    const result = await this.analyze(audio, sample.type, { signal });
    const after = await this.statFile(sample.path);
    if (after.mtimeMs !== before.mtimeMs || after.size !== before.size) return { status: 'changed' };
    return { status: 'done', result, metadata, after };
  }

  async outcome(sample, signal) {
    try {
      return await this.analyzeFile(sample, signal);
    } catch (error) {
      if (isUnavailable(error)) return { status: 'unavailable' };
      // Decoders report a vanished file in their own words; check directly.
      try {
        await this.statFile(sample.path);
      } catch (statError) {
        if (isUnavailable(statError)) return { status: 'unavailable' };
      }
      return { status: 'error', error };
    }
  }

  // The change to store for an outcome. It refuses (returns false) when the
  // record now describes a different file than the one analyzed.
  resultFor(sample, outcome, onStale) {
    return current => {
      if (current.path !== sample.path || current.size !== sample.size || current.mtime !== sample.mtime) {
        onStale();
        return false;
      }
      const analyzedAt = new Date().toISOString();
      if (outcome.status === 'error') {
        current.analysis = { status: 'error', version: ANALYSIS_VERSION, error: outcome.error.message, analyzedAt };
        // A beat grid from an earlier version of the file no longer applies.
        delete current.beats;
        return true;
      }
      const { result, metadata, after } = outcome;
      // Peaks and beats live on the record itself, stored in their own columns.
      const { peaks, beats, ...measured } = result;
      current.analysis = { ...measured, status: 'done', version: ANALYSIS_VERSION, analyzedAt, mtime: after.mtimeMs, size: after.size };
      Object.assign(current, metadata, { peaks, beats: beats || [], mtime: after.mtimeMs, size: after.size });
      Object.assign(current, effectiveMetadata(current));
      return true;
    };
  }

  async run(id, job) {
    const { sample } = job;
    try {
      const outcome = await this.outcome(sample, job.controller.signal);
      if (this.closed) return;
      if (outcome.status === 'changed') {
        this.push(id);
        return;
      }
      if (outcome.status === 'unavailable') {
        // Left unanalyzed, not failed: it is retried when the drive returns.
        this.skipped++;
        return;
      }
      let stale = false;
      const apply = this.resultFor(sample, outcome, () => { stale = true; });
      try {
        await this.commit(id, apply);
      } catch (error) {
        this.unsaved.set(id, apply);
        this.saveError = error.message;
        this.paused = true;
      }
      if (stale) {
        this.push(id);
        return;
      }
      if (outcome.status === 'error') this.failed++;
      else this.completed++;
    } finally {
      if (!this.closed) {
        job.finished = true;
        this.revision++;
        this.onUpdate();
        this.dirty++;
        const due = this.dirty >= 10 || !this.pending || this.paused || Date.now() - this.lastSave > 5000;
        if (due) {
          try {
            await this.save();
          } catch {}
        }
      }
      this.active.delete(id);
      if (!this.closed) setImmediate(() => this.pump());
    }
  }
}
