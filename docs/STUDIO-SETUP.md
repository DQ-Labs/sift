# Sift on a studio PC

These Windows x64 test builds are standalone apps. Node.js and Electron are included.
They are not VST3 plugins and do not provide a native ASIO audio driver.

1. Install FFmpeg Essentials, which includes the Rubber Band filter. In a Windows terminal:

   ```powershell
   winget install --id Gyan.FFmpeg.Essentials --exact
   ```

   Reopen your terminal and check `ffmpeg -hide_banner -h filter=rubberband`.
   Sift also detects this package's FFmpeg/FFprobe in WinGet's user links directory.
   An existing installation can be selected using the `SIFT_FFMPEG` and
   `SIFT_FFPROBE` environment variables, with full executable paths.

2. Download either `Sift-<version>-Setup-x64.exe` or `Sift-<version>-Portable-x64.exe`
   from the GitLab release. The installer installs for your user; the portable
   executable extracts its runtime on launch. Both share the same catalogue.

3. Launch Sift and add the studio machine's sample folders. Original audio is not
   copied into Sift. Your data, exports and desktop profile live in `%APPDATA%\Sift`.
   A portable executable does not keep the catalogue beside itself. To choose a
   different location, set `SIFT_DATA_DIR` before starting it.

The builds are unsigned test releases. The release includes SHA-256 checksums;
compare a download using `Get-FileHash -Algorithm SHA256 .\Sift-<version>-Setup-x64.exe`.
No sample packs, personal catalogue or private files are shipped.

## Test with the studio audio hardware

Use a local session on the studio PC and select your audio interface as the Windows
playback device before opening Sift. Electron/Web Audio uses the Windows audio
device; it does not offer a dedicated ASIO driver selector. RDP audio redirection
is not a useful check of the actual studio output path.

- Audition samples and check stereo playback through the interface.
- Run analysis on a small source and inspect BPM/key results.
- Find a four-layer combination; test tempo, key, timing offsets and repeat modes.
- Export the mix and prepare a handoff. Import stems in FL Studio and align starts.
- Check that imported audio retains the rendered speed and matches the mix balance.
- Save a gem and set, close Sift, reopen it and verify persistence.

Prepared handoffs stay in `%APPDATA%\Sift\exports`; collect them into the DAW
project before moving machines. Do not delete them while a DAW project references
them. Closing a packaged Sift window stops the backend that window started, after
flushing the catalogue. A separately started browser server keeps its own lifecycle.

For logs, inspect `%APPDATA%\Sift\sift.log` and `sift-error.log`. Stop an older Sift
instance on port 4317 before launching a different build or catalogue.
