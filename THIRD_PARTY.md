# Audio dependencies

## Essentia.js 0.1.3

- Project: https://github.com/MTG/essentia.js
- Authors: Music Technology Group, Universitat Pompeu Fabra; see `node_modules/essentia.js/AUTHORS.md`.
- Installed from npm, version pinned by `package-lock.json`.
- License: AGPL-3.0. Full license: `node_modules/essentia.js/LICENSE`.
- Used for RhythmExtractor2013 and KeyExtractor in a local Node worker. Its `node-wav` 0.0.2 dependency is installed by npm; Sift itself decodes with FFmpeg.
- Algorithm references: https://essentia.upf.edu/reference/std_RhythmExtractor2013.html and https://essentia.upf.edu/reference/std_KeyExtractor.html.
- Release source archives include the wrapper source at npm gitHead `f46c91c08bdf263d5f3d575ab8fb0f9b81695acf`, with its Dockerfile, Makefile and build scripts. The bundled WASM reports Essentia `2.1-beta6-dev`; upstream's Dockerfile does not pin the C++ checkout. This provenance limitation is recorded in `UPSTREAM-SOURCES.json` rather than claiming a verified bit-for-bit rebuild.

## FFmpeg / Rubber Band

- FFmpeg: https://ffmpeg.org/ . Filter documentation: https://ffmpeg.org/ffmpeg-filters.html#rubberband .
- Rubber Band: https://breakfastquay.com/rubberband/ .
- Sift invokes the installed FFmpeg/FFprobe executables and does not redistribute their binaries.
- This machine's FFmpeg build reports GPL/version-3 support and librubberband enabled. Preserve the applicable licenses and corresponding source for the exact build if redistributing it.

Sift runs locally and does not bundle installed FFmpeg binaries or third-party sample packs. Preserve notices and review the applicable AGPL/GPL source and distribution requirements before distributing or hosting a combined version. No commercial relicensing is implied.

## Electron 44.9.2 (optional desktop launcher)

- Project: https://www.electronjs.org/ . Pinned npm development dependency.
- License: MIT; see `node_modules/electron/LICENSE`. Its official runtime includes Chromium and Node.js plus their third-party notices in `node_modules/electron/dist/`.
- Used only for the isolated desktop window and native file dragging. The local browser app and server remain usable without it.
- Drag API documentation: https://www.electronjs.org/docs/latest/tutorial/native-file-drag-drop .

## Release tooling

- electron-builder 26.15.3: MIT, https://github.com/electron-userland/electron-builder . Build-time dependency; not included as an application runtime dependency.
- Windows builds preserve Electron's LICENSE and LICENSES.chromium.html and the installed production dependencies' license files. FFmpeg used by CI tests is not copied into release binaries.
