# Builds and releases

Sift is built and published by GitHub Actions in [DQ-Labs/sift](https://github.com/DQ-Labs/sift). Nothing is deployed to a studio machine automatically; installed copies pick up a release through the updater.

## Continuous integration

[`ci.yml`](../.github/workflows/ci.yml) runs on every pull request and every push to `main`:

| Job | What it does |
| --- | --- |
| Linux tests | In `node:22-bookworm`: installs Debian's FFmpeg (with Rubber Band), `npm ci --ignore-scripts`, checks FFmpeg, runs the full `npm test` suite including analysis, tempo/key processing and handoffs. |
| Source archive | Builds `Sift-<version>-Source.tar.gz`: the committed tree plus the Essentia.js wrapper source and the FFmpeg source tarball. |
| Windows build | On `windows-2025`: unit tests, fetches the pinned FFmpeg, builds the NSIS installer and portable EXE (`npm run dist:win`), and runs `npm run test:packaged -- --headless`: package layout and identity, the bundled FFmpeg and its `rubberband` filter, `app-update.yml`/`latest.yml`, and the packaged backend (HTTP/UI assets, demo audio, writable catalogue, persistence across restart, clean shutdown). |

The installer, portable EXE, `latest.yml` and source archive are attached to each run as artifacts for 14 days, so any pull request can be installed for testing.

CI does not open a visible Electron window, play audio, test native drag-and-drop or import into a DAW. Run the local checks below on desktop Windows before tagging a release.

## Publish a version

1. Set the version in `package.json` and update the lockfile:

   ```sh
   npm version 0.4.0-alpha.2 --no-git-tag-version --ignore-scripts
   ```

2. Merge that change to `main` through a pull request with green CI.
3. Tag the merge commit with the matching version and push the tag:

   ```sh
   git tag v0.4.0-alpha.2
   git push origin v0.4.0-alpha.2
   ```

[`release.yml`](../.github/workflows/release.yml) then:

1. checks that the tag equals `v` + the `package.json` version;
2. runs the whole CI workflow on the tag;
3. writes `SHA256SUMS.txt` and publishes a GitHub Release named *Sift &lt;version&gt;* with:
   - `Sift-<version>-Setup-x64.exe` and its `.blockmap`
   - `Sift-<version>-Portable-x64.exe`
   - `Sift-<version>-Source.tar.gz`
   - `latest.yml` (read by the updater)
   - `STUDIO-SETUP.md`
   - `SHA256SUMS.txt`

Versions with a hyphen (`-alpha.N`, `-beta.N`, `-rc.N`) are published as pre-releases. Release notes are a short standard header followed by GitHub's generated list of merged pull requests; edit the release afterwards to add highlights. The updater shows the start of these notes.

The workflow uses the built-in `GITHUB_TOKEN` with `contents: write` for the publish job only. No personal access token is needed.

If a tag's run fails, fix the problem on `main`, delete the tag (`git push origin :refs/tags/v<version>`) and the draft release if one was left, and tag again, or bump the version.

## How updates reach users

electron-builder writes `resources/app-update.yml` (pointing at this repository) into the app, and `latest.yml` (version, file name, SHA-512) next to the installer. The installed app's updater reads the newest release from GitHub, downloads `latest.yml` from it, and when the version is newer, offers the installer. Someone running a pre-release is offered newer pre-releases and stable releases; someone on a stable release is only offered stable releases. The portable build reads the GitHub releases API and links to the release page.

A release missing `latest.yml` or the Setup EXE breaks updates for everyone, so always publish through the workflow.

## Bundled FFmpeg

`UPSTREAM-SOURCES.json` pins the Windows FFmpeg build (URL and SHA-256) under `ffmpeg.windows`, and the FFmpeg source tarball under `ffmpeg.source`. `npm run fetch:ffmpeg` downloads and verifies the archive and places `ffmpeg.exe`, `ffprobe.exe` and the build's licence in `build/ffmpeg` (ignored by git); `dist:win` runs it first, and electron-builder copies the folder to `resources/ffmpeg`.

To move to a newer FFmpeg:

1. Pick a release from [GyanD/codexffmpeg](https://github.com/GyanD/codexffmpeg/releases) and download its `essentials_build.zip`.
2. Confirm its `README.txt` lists `librubberband`, and record the SHA-256 (`Get-FileHash -Algorithm SHA256` or `sha256sum`).
3. Update `ffmpeg.version`, `ffmpeg.build`, `ffmpeg.windows` and `ffmpeg.source` in `UPSTREAM-SOURCES.json`, and the FFmpeg section of `THIRD_PARTY.md`. Leaving a `sha256` empty makes the download fail and print the file's hash (the source tarball only warns).
4. Open a pull request; the Windows job verifies the filter.

## Local Windows verification

With Node.js 22+ on desktop Windows:

```powershell
npm ci --ignore-scripts
node node_modules/electron/install.js
npm run fetch:ffmpeg
$env:SIFT_FFMPEG = "$PWD\build\ffmpeg\ffmpeg.exe"; $env:SIFT_FFPROBE = "$PWD\build\ffmpeg\ffprobe.exe"
npm test
npm run test:playback
npm run dist:win
npm run test:packaged
```

`test:packaged` without `--headless` also runs the full server test suite against the packaged runtime and bundled FFmpeg, and launches the installed-layout and portable EXEs in smoke-test mode to check the renderer, preload, bundled FFmpeg and backend shutdown. Then install the Setup EXE and work through [Studio setup](STUDIO-SETUP.md).

To test an update end to end, install the previous release, publish a newer pre-release, and start the old copy: it should offer the update, install it after the restart prompt, and keep the library.

Signing is not configured; builds are unsigned.

## VST3

The Electron standalone application cannot be exported as a VST3 binary. A real plugin needs a native host-facing processor/controller, host transport and sample rate/block-size handling, persistent plugin state and a real-time audio path. Steinberg's VST3 SDK or another suitable plugin framework can support that work. The release workflow publishes only the standalone Windows app.
