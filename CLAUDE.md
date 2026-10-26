# Sift

Local sample-discovery workbench for Windows. It indexes audio on the user's drives, estimates tempo and key, and assembles four-layer, tempo- and key-matched song starters that can be exported or dragged into a DAW (FL Studio is the target). Inspired by Aria Labs' Upcycle; never copy its code, assets or copy text.

The active roadmap is [SIFT_PLAN.md](SIFT_PLAN.md). Its workstreams have strict file ownership; stay inside yours.

## Layout

- `server.mjs`: local HTTP API, loopback only (`127.0.0.1` / `::1`, port 4317), host and origin checked.
- `lib/`: catalogue (`library.mjs`, `sample-index.mjs`), metadata priority and conflicts (`metadata.mjs`), analysis queue and Essentia worker (`analysis*.mjs`), FFmpeg/Rubber Band rendering and cache (`media.mjs`), stem handoff (`handoff.mjs`).
- `public/`: vanilla ES-module front end, no build step. `harmony.js`, `timing.js` and `workspace.js` are shared with the server.
- `desktop/`: Electron shell. Packaged builds spawn `server.mjs` with `ELECTRON_RUN_AS_NODE` and store data in `%APPDATA%\Sift`.
- `tests/`: `node --test`. `scripts/test-playback.cjs` drives Chromium playback through hidden Electron.

## Working on it

- Node 22+. `npm ci --ignore-scripts`, then `npm test`. FFmpeg and FFprobe with the `rubberband` filter must be on PATH (on Debian/Ubuntu: `apt-get install -y ffmpeg`), or four DSP/server tests fail.
- `npm start` runs the server; open http://127.0.0.1:4317.
- Keep dependencies minimal. No native Node modules (use built-ins such as `node:sqlite`). No front-end bundler or framework.
- The prototype was written in dense one-line style. New and touched code should be readable: one statement per line, named helpers, short comments only where the reason isn't obvious.
- Never commit `data/`, `sounds/`, `test-output/`, logs, or anything containing local sample paths.
- Windows x64 is the only release target. Unsigned builds are acceptable.
- Licence is AGPL-3.0-only (Essentia.js). Record every bundled third-party binary's licence and source in `THIRD_PARTY.md` and `UPSTREAM-SOURCES.json`.

## Git

- `origin` is github.com/DQ-Labs/sift. `gitlab` is the old home; don't push there.
- Work on a branch and open a pull request against `main`. CI must pass.
