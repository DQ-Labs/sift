# Third-party components

Sift is licensed under AGPL-3.0-only. The Windows installer and portable EXE bundle the components below; each keeps its own licence. Exact versions and source locations are pinned in [UPSTREAM-SOURCES.json](UPSTREAM-SOURCES.json) and `package-lock.json`.

## FFmpeg 8.1.2 (bundled, Windows builds)

- Project: https://ffmpeg.org/ . Filter documentation: https://ffmpeg.org/ffmpeg-filters.html#rubberband .
- Build: `8.1.2-essentials_build-www.gyan.dev`, a static 64-bit build by Gyan Doshi (https://www.gyan.dev/ffmpeg/builds/), downloaded from https://github.com/GyanD/codexffmpeg/releases/download/8.1.2/ffmpeg-8.1.2-essentials_build.zip and verified against SHA-256 `db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec` by `scripts/fetch-ffmpeg.mjs` during the CI build.
- Licence: GPL version 3. The build enables GPL and version-3 components, among them Rubber Band (librubberband v1.8.1), x264 and x265. The full licence text ships as `resources\ffmpeg\LICENSE.txt`.
- Shipped files: `ffmpeg.exe`, `ffprobe.exe`, `LICENSE.txt`, and the build's `README.txt`, which lists the configuration and every enabled external library with its version, plus `SOURCE.txt` pointing back here.
- Source: FFmpeg revision https://github.com/FFmpeg/FFmpeg/commit/38b88335f9 (release 8.1.2). Each Sift release's source archive includes the FFmpeg release tarball https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz . The external libraries' sources are available from their upstream projects at the versions `README.txt` names.
- Limitation: the builder does not publish the scripts used to produce this binary, so this is not a verified reproducible build. The SHA-256 of the FFmpeg source tarball is recorded in the source archive's `upstream/README.txt`; pinning it in `UPSTREAM-SOURCES.json` is pending (see the TODO in `scripts/source-archive.mjs`).
- Sift runs FFmpeg and FFprobe as separate processes; it does not link them.
- Rubber Band: https://breakfastquay.com/rubberband/ (GPL-2.0-or-later, used here under GPLv3 as part of the FFmpeg build).

Development checkouts and the Linux CI job use the system's FFmpeg instead (Debian's build includes Rubber Band).

## Essentia.js 0.1.3

- Project: https://github.com/MTG/essentia.js
- Authors: Music Technology Group, Universitat Pompeu Fabra; see `node_modules/essentia.js/AUTHORS.md`.
- Installed from npm, version pinned by `package-lock.json`.
- Licence: AGPL-3.0. Full licence: `node_modules/essentia.js/LICENSE`.
- Used for RhythmExtractor2013 and KeyExtractor in a local Node worker. Its `node-wav` 0.0.2 dependency is installed by npm; Sift itself decodes with FFmpeg.
- Algorithm references: https://essentia.upf.edu/reference/std_RhythmExtractor2013.html and https://essentia.upf.edu/reference/std_KeyExtractor.html.
- Release source archives include the wrapper source at npm gitHead `f46c91c08bdf263d5f3d575ab8fb0f9b81695acf`, with its Dockerfile, Makefile and build scripts. The bundled WASM reports Essentia `2.1-beta6-dev`; upstream's Dockerfile does not pin the C++ checkout. This provenance limitation is recorded in `UPSTREAM-SOURCES.json` rather than claiming a verified bit-for-bit rebuild.

## Electron 44.9.2

- Project: https://www.electronjs.org/ . Pinned npm development dependency; electron-builder packages its official runtime.
- Licence: MIT; see `node_modules/electron/LICENSE`. The runtime includes Chromium and Node.js; their notices ship as `LICENSE.electron.txt` and `LICENSES.chromium.html` beside `Sift.exe`.
- Used for the desktop window, the Help menu and native file dragging. Drag API documentation: https://www.electronjs.org/docs/latest/tutorial/native-file-drag-drop .

## electron-updater 6.8.11

- Project: https://github.com/electron-userland/electron-builder/tree/master/packages/electron-updater . Licence: MIT.
- Runtime dependency used by the installed build to update from GitHub Releases. Its dependencies ship in `resources\app\node_modules` with their licence files: builder-util-runtime, fs-extra, graceful-fs, jsonfile, universalify, js-yaml, lazy-val, lodash.escaperegexp, lodash.isequal, tiny-typed-emitter, debug and ms (MIT); semver (ISC); sax (BlueOak-1.0.0); argparse (Python-2.0).

## Build tooling (not shipped)

- electron-builder 26.15.3: MIT, https://github.com/electron-userland/electron-builder . Builds the NSIS installer and portable EXE.
- GitHub Actions (`actions/checkout`, `actions/setup-node`, `actions/cache`, `actions/upload-artifact`, `actions/download-artifact`): MIT.
- The app icon `build/icon.ico` is generated from Sift's own `public/favicon.svg` by `scripts/make-icon.cjs`.

Sift does not ship third-party sample packs. Preserve these notices and review the AGPL/GPL source and distribution requirements before distributing or hosting a modified version. No commercial relicensing is implied.
