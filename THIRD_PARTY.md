# Audio dependencies

## Essentia.js 0.1.3

- Project: https://github.com/MTG/essentia.js
- Authors: Music Technology Group, Universitat Pompeu Fabra; see `node_modules/essentia.js/AUTHORS.md`.
- Installed from npm, version pinned by `package-lock.json`.
- License: AGPL-3.0. Full license: `node_modules/essentia.js/LICENSE`.
- Used for RhythmExtractor2013 and KeyExtractor in a local Node worker. Its `node-wav` 0.0.2 dependency is installed by npm; Sift itself decodes with FFmpeg.
- Algorithm references: https://essentia.upf.edu/reference/std_RhythmExtractor2013.html and https://essentia.upf.edu/reference/std_KeyExtractor.html.

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
