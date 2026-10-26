# Sift

[![CI](https://github.com/DQ-Labs/sift/actions/workflows/ci.yml/badge.svg)](https://github.com/DQ-Labs/sift/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/DQ-Labs/sift?include_prereleases&label=release)](https://github.com/DQ-Labs/sift/releases)

Sift is a sample-discovery workbench for Windows. It indexes the audio already on your drives, estimates each sample's tempo and key, and builds four-layer song starters that are tempo- and key-matched. Audition them, lock the layers you like, reroll the rest, then export a mix or drag the stems straight into FL Studio.

Everything runs locally. Sift never uploads, copies or modifies your samples, and it needs no account or internet connection (apart from checking for updates, which you can turn off).

## Install

1. Open the [latest release](https://github.com/DQ-Labs/sift/releases).
2. Download **`Sift-<version>-Setup-x64.exe`** and run it. It installs for your user only; no administrator rights are needed.
3. Start Sift from the Start menu and add your sample folders.

FFmpeg (with Rubber Band, used for tempo and key matching) and Node.js are included. Builds are not code-signed, so Windows SmartScreen may show *Windows protected your PC* the first time: choose **More info → Run anyway**. Each release lists SHA-256 checksums in `SHA256SUMS.txt`.

Prefer not to install? **`Sift-<version>-Portable-x64.exe`** runs from anywhere and uses the same data folder. It tells you when a new version is out but does not update itself.

Setting Sift up on a studio PC, including the audio and FL Studio checks, is covered in [Studio setup](docs/STUDIO-SETUP.md).

### Updates

The installed app checks GitHub Releases a few seconds after it starts. When a newer version exists it shows the release notes and asks before downloading; after the download it asks before restarting. You can choose **Skip this version**, check by hand with **Help → Check for updates…**, or turn off the launch check by unticking **Help → Check for updates on launch**. Setting the environment variable `SIFT_DISABLE_UPDATE_CHECK=1` also disables it.

Updates replace the program only. Your library, gems, sets, exports and settings stay in `%APPDATA%\Sift`.

## Using Sift

- **Add folder** to index a sample folder or a whole drive. Sift scans in the background and analyses tempo and key with Essentia.js.
- **Find a combination** fills the four layers with samples that suit each other. Lock, mute, solo or **Reroll** individual layers; set the session tempo and key, and every layer is stretched and transposed to match.
- **Export mix** writes a four-bar WAV. **Send to DAW → Prepare WAV stems** writes one WAV per layer that you can drag from Sift into FL Studio's Playlist.
- Diamonds save **gems**; **Save set** stores the whole workbench.

The [user guide](docs/GUIDE.md) describes every control, how metadata and timing work, and the current limits.

The **Help** menu shows **About** (Sift, Electron, Node.js and FFmpeg versions, licence and data folder), **Open data folder**, **View logs** and the update controls.

## Screenshots

_Screenshots of the workbench, library and stem handoff will be added here._

## Where things are stored

| What | Where |
| --- | --- |
| Library, gems, sets, settings | `%APPDATA%\Sift` (**Help → Open data folder**) |
| Prepared stems | `%APPDATA%\Sift\exports` |
| Logs | `sift.log`, `sift-error.log` and `desktop.log` in the data folder (**Help → View logs**) |
| Program files (installer) | `%LOCALAPPDATA%\Programs\Sift` |

Set `SIFT_DATA_DIR` before starting Sift to use a different data folder. The catalogue contains absolute paths to your samples; don't share it publicly.

## Development

You need Windows or Linux, Node.js 22+, and FFmpeg/FFprobe with the `rubberband` filter on `PATH` (Debian/Ubuntu: `apt-get install -y ffmpeg`). There is no build step.

```sh
npm ci --ignore-scripts
npm test                 # node --test; four DSP/server tests need FFmpeg
npm run desktop          # Electron window (run `node node_modules/electron/install.js` once first)
npm start                # local server only, then open http://127.0.0.1:4317
```

On Windows, **Start Sift Desktop.cmd** opens the desktop window from a checkout, and **Start Sift.cmd** starts a hidden server and opens your browser. Browser mode is a development convenience: it serves the same app, but native stem dragging needs the desktop window. The hidden server writes `sift.log`/`sift-error.log` in the checkout and runs until stopped; use `npm start` for a server you can stop with Ctrl+C. The server listens only on `127.0.0.1` and `::1`.

From a development checkout the desktop window prefers `build/ffmpeg` (fetched with `npm run fetch:ffmpeg` on Windows), then `SIFT_FFMPEG`/`SIFT_FFPROBE`, then WinGet's links, then `PATH`.

Building the Windows installer and portable EXE (Windows only):

```powershell
npm ci --ignore-scripts
node node_modules/electron/install.js
npm run dist:win         # fetches the pinned FFmpeg, then builds into dist/
npm run test:packaged    # full packaged checks on desktop Windows
```

`npm run icon` regenerates `build/icon.ico` from `public/favicon.svg`.

| Path | Contents |
| --- | --- |
| `server.mjs`, `lib/` | Local HTTP API, catalogue, analysis queue, FFmpeg/Rubber Band rendering, stem handoff |
| `public/` | Front end (vanilla ES modules) |
| `desktop/` | Electron shell: window, Help menu, updater, FFmpeg discovery |
| `scripts/` | Packaging, release and test helpers |
| `tests/` | `node --test` suites |
| `.github/workflows/` | CI (Linux tests, Windows build) and tagged releases |

Every pull request runs the Linux test suite and builds and smoke-tests the Windows package; see [Releasing](docs/RELEASING.md) for how versions are published. The roadmap is [SIFT_PLAN.md](SIFT_PLAN.md).

Keep `data/`, `sounds/`, `test-output/`, logs and credentials out of commits; they can contain local paths and personal audio.

## Contributing and support

Found a bug or have an idea? [Open an issue](https://github.com/DQ-Labs/sift/issues/new/choose). For a bug, **Help → About → Copy details** gives the versions to include.

## Licence

Sift is published by DQ Labs under the [GNU AGPL v3.0 only](LICENSE). The installer bundles FFmpeg (GPLv3), Essentia.js (AGPL-3.0), Electron (MIT) and other components under their own licences; see [THIRD_PARTY.md](THIRD_PARTY.md) and [UPSTREAM-SOURCES.json](UPSTREAM-SOURCES.json). Each release's source archive contains Sift's source and the Essentia.js and FFmpeg sources.

Sift was inspired by Aria Labs' Upcycle. It is built from scratch and uses none of Upcycle's code, assets or text.
