# Sift fix-and-improve plan

Written 2026-10-25, when the project moved from GitLab (`JF2B/sift`) to GitHub (`DQ-Labs/sift`).

## Decisions

- **Windows x64 only.** The target is the studio PC running FL Studio. No macOS work.
- **Audience: the owner and their studio.** Unsigned builds are fine. Priority is a smooth daily workflow, not public onboarding.
- **Keep the stack**: Electron + local Node server + vanilla ES modules, no build step, Essentia.js analysis, FFmpeg/Rubber Band rendering. No Tauri rewrite.
- **GitHub is the home.** GitHub Actions replaces GitLab CI. GitLab stays as a read-only remote named `gitlab` until the owner deletes it.
- **Quality bar: NeoDLP-DQ.** Versioned releases from CI, real installer, auto-updater, About/version UI, centralized app identity, issue templates, README with screenshots, confirmation on destructive actions.
- Inspiration is Aria Labs' Upcycle (https://arialabs.io/upcycle). Never copy its code, assets, or copy text.

## Where the prototype stands

Works today: folder indexing, Essentia BPM/key estimation, metadata conflict review, four-layer workbench with lock/mute/solo/reroll, Rubber Band tempo/key matching with a render cache, four-bar cycle playback and WAV export, saved gems and sets, ZIP/WAV stem handoff, native stem drag from the Electron window, NSIS + portable builds. 51 tests; they pass on Linux with FFmpeg installed.

Problems, by severity:

1. **FFmpeg is not bundled.** The packaged app refuses to start until the user installs FFmpeg with Rubber Band through winget. This is the single biggest friction point.
2. **The catalogue doesn't scale.** Every sample lives in one in-memory array, saved as `data/library.json` on each change, and `GET /api/library` ships the entire array to the browser. Search, filtering and combination-finding all run client-side over that array. Upcycle's pitch is "anywhere on your drives"; that means 50k–500k files.
3. **Code is hard to change.** `public/app.js` is a 60 KB monolith and `server.mjs` packs every route into one function. Both use dense one-line statements. Every later feature costs more because of this.
4. **Rerolls are slow.** One Rubber Band render runs at a time; a reroll waits for render + decode before it is heard. Upcycle sells "lightning fast" rerolls.
5. **Analysis is serial.** One Essentia worker for the whole library.
6. **Shipping layer is GitLab-bound and incomplete.** CI and release scripts target GitLab. No auto-update. Version is inconsistent: `package.json` says `0.3.0-alpha.6`, the sidebar says `SIFT / 0.2 EARLY BUILD`, the latest tag is `v0.3.0-alpha.4`. `appId` is the generic `com.sift.workbench`. No app icon beyond the favicon.
7. **Browser-first UX.** The browser launcher is still presented as primary, and the "Send to FL Studio" flow tells users to open the desktop window. For a studio user the desktop app should be the product and the browser a dev convenience.
8. **Upcycle gaps**: no variety (safe ↔ chaos) control, no "fresh batch" distinct from per-layer reroll, exports are not saved as sets automatically, no diagnostics report, `.caf` not scanned, no first-beat alignment beyond leading-silence trimming.

## Workstreams

Each workstream runs in its own cloud session, on its own branch, and ends in a pull request against `main`. **File ownership is strict** so the three Wave 1 branches merge cleanly. If a workstream needs a change in a file it doesn't own, it writes the need into its PR description instead of making the edit.

### Wave 1 (parallel)

#### W1 · Ship: GitHub CI, bundled FFmpeg, updater, app identity

Owns: `.github/`, `.gitlab-ci.yml` (delete), `scripts/`, `desktop/`, `package.json`, `package-lock.json`, `build/` (new, icons), `docs/`, `README.md`, `THIRD_PARTY.md`, `UPSTREAM-SOURCES.json`, `LICENSE`, launch `.cmd`/`.ps1` files. Does not touch `public/`, `lib/` or `server.mjs`.

- GitHub Actions: `ci.yml` (Linux: `apt-get install ffmpeg`, `npm ci --ignore-scripts`, `npm test`; Windows: unit tests, `dist:win`, packaged backend smoke test) on PRs and pushes to `main`. `release.yml` on `v*` tags builds and publishes a GitHub Release with the installer, portable EXE, source archive, `SHA256SUMS.txt` and `latest.yml`. Port or replace `scripts/publish-release.mjs` and `scripts/ci-windows.ps1`. Delete `.gitlab-ci.yml`.
- Bundle a pinned Windows FFmpeg/FFprobe build that includes the `rubberband` filter (download in CI with a pinned URL and SHA-256, place under `extraResources`). `desktop/main.cjs` prefers the bundled binaries, then `SIFT_FFMPEG`/`SIFT_FFPROBE`, then WinGet links, then PATH. The "install FFmpeg first" dialog becomes a last-resort error. Record FFmpeg's GPL licence and exact source in `THIRD_PARTY.md` and `UPSTREAM-SOURCES.json`.
- Auto-update with `electron-updater` from GitHub Releases for the NSIS build (check on launch, prompt with release notes, setting to disable). The portable build shows "update available" with a link instead.
- App identity in one place: `appId` `com.dqlabs.sift`, product name, publisher "DQ Labs", repository URL, all from `package.json`. Set `package.json` version to `0.4.0-alpha.1`. Real app icon (`build/icon.ico`, generated from `public/favicon.svg`).
- Desktop becomes primary: README and docs lead with the installer; `Start Sift.cmd` stays as a dev convenience. A desktop **Help** menu with About (version, Electron/Node/FFmpeg versions, licence, data folder), Open data folder, View logs, Check for updates.
- `.github/ISSUE_TEMPLATE/` (bug, feature), PR template, README rewrite with screenshots placeholder section, `docs/RELEASING.md` for the GitHub flow.

#### W2 · Catalogue: SQLite, query API, server split, faster analysis

Owns: `server.mjs`, `lib/`, `tests/` except the front-end tests listed under W3. Does not touch `public/` (it may import from `public/harmony.js`, `public/workspace.js`, `public/timing.js` as it does today, but never edit them).

- Move the catalogue to SQLite using built-in `node:sqlite` (no native modules; must work under Electron's Node via `ELECTRON_RUN_AS_NODE`). One-time migration from `library.json`, which is kept as `library.pre-sqlite.json`. Preserve the current corrupt-file recovery guarantees and the case-only alias rules in `lib/sample-index.mjs`.
- Split `server.mjs` into a small router plus `lib/routes/*.mjs`. Rewrite dense one-liners into readable code as files are touched. Replace the hard-coded static `files` table with a route that serves any `.html/.js/.css/.svg` file directly inside `public/` (no subpaths, no traversal), so W3's new modules load without further server edits.
- Implement the **API contract** below, keeping every existing endpoint working, so W3 can build against it in parallel.
- Analysis worker pool (default `min(4, cores - 1)`, `SIFT_ANALYSIS_WORKERS` override). Never re-analyze an unchanged file (same path/size/mtime) after restart or on a reconnected external drive.
- Scanning: add `.caf`; allow a drive root (`D:\`) as a source and skip system folders (`Windows`, `Program Files*`, `ProgramData`, `$Recycle.Bin`, `System Volume Information`, `AppData`, `node_modules`, `.git`); reject zero-byte and unreadable files as invalid instead of queueing them forever.
- Diagnostics: `GET /api/diagnostics` returns a ZIP with versions, capabilities, FFmpeg check output, catalogue counts, analysis status, the last 500 log lines, recent errors. No sample paths beyond folder names, no audio.
- `GET /api/capabilities` adds `version` (read from `package.json`) and `ffmpeg: { found, rubberband, version }`.
- Tests: migration, query filters/sort/paging, a 50,000-sample synthetic catalogue (query under 100 ms, startup under 3 s), worker pool, drive-root skips, diagnostics contents.

#### W3 · Front end: modular app.js, catalogue client, Upcycle-style controls

Owns: `public/` and its tests (`tests/harmony.test.mjs`, `tests/timing.test.mjs`, `tests/library-activity.test.mjs`, new front-end tests), `scripts/test-playback.cjs`. Does not touch `server.mjs` or `lib/`.

- Split `public/app.js` into ES modules: `api.js`, `state.js`, `player.js` (preview + transport), `workbench.js`, `collection.js`, `details.js`, `handoff.js`, `shortcuts.js`, plus the existing helpers. No bundler. **Exception to ownership:** W3 may add its new filenames to the static `files` table in `server.mjs` and change nothing else there; W2 replaces that table with a directory route, and integration keeps W2's version.
- `public/catalog-client.js`: talks to the new query API (contract below) and falls back to the current `GET /api/library` behaviour when the new endpoints return 404, so it works before and after W2 merges.
- Collection list renders a page at a time from the server; nothing holds the full sample array.
- Variety control (Safe ↔ Wild) that widens or narrows the weighted candidate pool in `chooseCombination`; persist it in the workspace. Keep `chooseCombination(tracks, samples, settings, index, random)` callable with its current arguments (the server will import it).
- "New batch" (replace all unlocked layers) distinct from per-layer reroll; prefetch the next candidate's render for each unlocked layer so a reroll is heard immediately when the render is cached.
- Rename "Send to FL Studio" to "Send to DAW" (keep the FL Studio notes inside the panel). Every export or stem handoff also saves an automatic set named after its timestamp ("anything you export is saved").
- Version label reads `version` from `/api/capabilities` (fallback: hide it). Help/About dialog in the web UI mirrors the desktop one. "Save diagnostics report" button downloads `/api/diagnostics`.
- Confirmation dialogs on destructive actions (clean up library, clean up exports, overwrite a set).

### Wave 2 (after Wave 1 merges)

#### W4 · Sound: render speed and musical alignment

Owns: `lib/media.mjs`, `lib/analysis-worker.mjs`, `public/timing.js`, the DSP tests.

- Concurrent render pool (2–3 FFmpeg processes) with priority for the layer the user is waiting on.
- Per-type Rubber Band options: transient-friendly for drums, formant-preserving for vocals, smoother for pads/textures.
- Store Essentia's beat positions during analysis and offer **Snap to first beat** as the default start for loops, replacing leading-silence-only alignment.
- Detect loopable files (duration near a whole number of bars at the detected BPM) and prefer them in combinations.

### Wave 3 (local, on the studio PC)

Integration and acceptance, done in a local session on Windows because it needs real hardware: merge order W2 → W3 → W1 (W1 last because it touches only packaging), apply the server static-route change W3 asked for, install the CI build, run the `docs/STUDIO-SETUP.md` hardware checks with FL Studio, tag `v0.4.0`.

## API contract (W2 implements, W3 consumes)

All JSON. Existing endpoints keep their current behaviour.

- `GET /api/library?lite=1` → `{ folders, favorites, sets, workspace, recovery, scan, analysis, counts: { total, real, demo, conflicts, byRoot: { [root]: n } } }`. No `samples` array.
- `GET /api/samples?source=<root|demo|>&view=all|gems&q=&type=&bpm=slow|mid|fast|unknown&conflicts=1&sort=name|bpm|duration&page=0&pageSize=50` → `{ total, page, pageSize, items: [sample] }`. Filter semantics match `filteredSamples()` in today's `public/app.js`.
- `GET /api/samples/:id` → `sample` (404 if unknown).
- `POST /api/samples/batch` `{ ids: [...] }` (max 500) → `{ items: [sample] }`. Used to hydrate workbench layers, gems and sets.
- `POST /api/combination` `{ source, tracks, tempo, sync, key, variety, index }` → `{ tracks }`. Runs `chooseCombination` from `public/harmony.js` server-side over the source's playable samples, passing `variety` through in `settings`. `index` (optional) rerolls a single layer.
- `GET /api/diagnostics` → `application/zip` download.
- `GET /api/capabilities` adds `version` and `ffmpeg: { found, rubberband, version }`.

## Rules for every workstream

- Read `CLAUDE.md` first.
- Linux cloud sessions: `apt-get install -y ffmpeg` (Debian's build includes Rubber Band), `npm ci --ignore-scripts`, `npm test`. All tests must pass before opening the PR.
- Windows-only behaviour (Explorer, folder picker, Electron packaging) can't be exercised in the cloud; cover it with unit tests and say in the PR what still needs a check on Windows.
- Small commits with clear messages. The PR description lists: what changed, test results, anything left for the studio check, and any cross-ownership requests.

## Budget

About $57 of cloud credit, expiring 2026-11-05 02:59 EST. Wave 1 is three sessions, Wave 2 is one. Wave 3 runs locally and costs no cloud credit.
