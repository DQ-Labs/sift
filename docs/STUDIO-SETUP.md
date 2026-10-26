# Sift on a studio PC

Sift for Windows x64 is a standalone desktop app. Node.js, Electron and FFmpeg with Rubber Band are included, so there is nothing else to install. It is not a VST3 plugin and does not provide an ASIO driver.

## Install

1. Download `Sift-<version>-Setup-x64.exe` from [GitHub Releases](https://github.com/DQ-Labs/sift/releases). Optionally check it against `SHA256SUMS.txt`:

   ```powershell
   Get-FileHash -Algorithm SHA256 .\Sift-<version>-Setup-x64.exe
   ```

2. Run it. The installer is per user (no administrator rights) and lets you choose the folder; the default is `%LOCALAPPDATA%\Programs\Sift`. Builds are unsigned, so SmartScreen may ask you to confirm: **More info → Run anyway**.
3. Start Sift and add the studio machine's sample folders. Original audio is never copied or changed.

The `Sift-<version>-Portable-x64.exe` alternative needs no installation. It extracts its runtime on each launch, shares the same data folder, and only notifies you about updates.

### Upgrading from 0.3.x test builds

Earlier builds used a different app ID, so Windows lists them as a separate program. Uninstall **Sift 0.3.x** from *Settings → Apps* before installing 0.4 or later. Uninstalling does not touch `%APPDATA%\Sift`, so your library, gems, sets and exports carry over. A WinGet FFmpeg you installed for 0.3 is no longer needed; Sift only falls back to it if its bundled copy fails.

## Data and logs

Your catalogue, desktop settings, exports and desktop profile live in `%APPDATA%\Sift` (**Help → Open data folder**). To keep them elsewhere, set `SIFT_DATA_DIR` before starting Sift. Logs are `sift.log`, `sift-error.log` and `desktop.log` in the same folder (**Help → View logs**).

**Help → About** shows the Sift, Electron, Node.js and FFmpeg versions, where FFmpeg was found, and the data folder. **Copy details** puts all of it on the clipboard for a bug report.

## FFmpeg

Sift uses the FFmpeg and FFprobe bundled in its `resources\ffmpeg` folder. If they are missing or fail to run, it falls back to `SIFT_FFMPEG`/`SIFT_FFPROBE` (full paths to executables), then WinGet's links, then `PATH`. Only if none of them works, or none provides the `rubberband` filter, does Sift stop with an error explaining how to install FFmpeg (`winget install --id Gyan.FFmpeg.Essentials --exact`).

## Updates

The installed app checks GitHub Releases shortly after launch, shows the release notes and asks before downloading and again before restarting. Untick **Help → Check for updates on launch** to stop the automatic check, or set `SIFT_DISABLE_UPDATE_CHECK=1`. **Help → Check for updates…** always works. Updates keep your data.

## Test with the studio audio hardware

Use a local session on the studio PC and select your audio interface as the Windows playback device before opening Sift. Electron/Web Audio uses the Windows audio device; it does not offer a dedicated ASIO driver selector. RDP audio redirection is not a useful check of the actual studio output path.

- Audition samples and check stereo playback through the interface.
- Run analysis on a small source and inspect BPM/key results.
- Find a four-layer combination; test tempo, key, timing offsets and repeat modes.
- Export the mix and prepare a handoff. Drag the stems into FL Studio's Playlist and align starts.
- Check that imported audio retains the rendered speed and matches the mix balance.
- Save a gem and set, close Sift, reopen it and verify persistence.
- Open **Help → About** and confirm FFmpeg is reported as *bundled with Sift*.

Prepared handoffs stay in `%APPDATA%\Sift\exports`; collect them into the DAW project before moving machines, and don't delete them while a DAW project references them. Closing Sift stops the local server it started, after saving the catalogue.

Stop any other Sift instance (for example a development server on port 4317) before launching a different build or catalogue.
