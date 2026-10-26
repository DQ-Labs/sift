// Verifies that FFmpeg (with the rubberband filter) and FFprobe run. Uses
// SIFT_FFMPEG / SIFT_FFPROBE when set, otherwise PATH.
import { spawnSync } from 'node:child_process';

const checks = [
  { name: 'FFmpeg', command: process.env.SIFT_FFMPEG || 'ffmpeg', args: ['-hide_banner', '-h', 'filter=rubberband'], expected: /^Filter rubberband/m },
  { name: 'FFprobe', command: process.env.SIFT_FFPROBE || 'ffprobe', args: ['-version'], expected: /^ffprobe version/m },
];

for (const { name, command, args, expected } of checks) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status !== 0 || !expected.test(output)) {
    throw new Error(`${name} check failed: executable=${command}; status=${result.status}; error=${result.error?.message || 'none'}; output=${output.slice(0, 8000)}`);
  }
  const version = spawnSync(command, ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  console.log(`${name} verified: ${(version.stdout || '').split(/\r?\n/)[0]}`);
}
