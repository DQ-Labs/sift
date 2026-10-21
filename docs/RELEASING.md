# Builds and releases

Every branch/MR pipeline runs the full Node test suite on Linux, including analysis,
tempo/key processing and handoffs, then prepares a source archive. GitLab's hosted
Windows x64 runner runs the unit tests and produces an installer and portable EXE.
The packaged backend is tested using the shipped executable and source: HTTP/UI
assets, demo audio, a writable catalogue, persistence across restart and shutdown.

The hosted Windows server lacks desktop multimedia DLLs needed by desktop FFmpeg
builds. It does not run the FFmpeg integration or Electron window/portable-launch
acceptance tests. Run the full local Windows verification below on desktop Windows;
these checks must pass before approving a studio release. CI does not verify audio
interface playback, ASIO, native drag-and-drop or a real DAW import.

Download the `windows_build` job artifacts for an untagged test build. They expire
after 14 days. No deployment to a studio machine happens automatically.

## Publish a version

1. Change the version in `package.json` and update `package-lock.json` using
   `npm install --package-lock-only --ignore-scripts`.
2. Commit, push, then tag that commit with its matching version:

   ```powershell
   git tag v0.3.0-alpha.4
   git push origin v0.3.0-alpha.4
   ```

3. The tag pipeline must pass Linux audio integration tests, Windows unit tests,
   packaging and the headless packaged-backend check. Only then does it upload binaries, source, setup guide and
   SHA256SUMS.txt to GitLab's generic package registry and create the release.

The publish job uses the existing CI_JOB_TOKEN. Do not add a personal access token
to the repository or CI configuration. Stable download links point to the package
registry, so release assets do not disappear with expiring job artifacts.

GitLab's hosted Windows runners are beta and can take several minutes to provision.
Account verification, compute quotas or runner availability may require action in
GitLab. This pipeline does not install or register a runner on your workstation.

## Local Windows verification

With Node.js 22+ and FFmpeg/Rubber Band installed:

```powershell
npm ci
npm test
npm run dist:win
npm run test:packaged
node scripts/source-archive.mjs
npm run release:checksums
```

Run source-archive.mjs from a committed tree: it exports tracked HEAD and includes
the published Essentia.js wrapper source at its npm gitHead revision. See
UPSTREAM-SOURCES.json for dependency provenance and upstream build limitations.

Signing is not configured. No automatic updater is installed. Updates replace the
application, while catalogue data stays in the user's roaming app-data folder.

## VST3

The Electron standalone application cannot be exported as a VST3 binary. A real
plugin needs a native host-facing processor/controller, host transport and sample
rate/block-size handling, persistent plugin state and a real-time audio path.
Steinberg's VST3 SDK or another suitable plugin framework can support that work.
This pipeline intentionally publishes only working standalone Windows apps.
