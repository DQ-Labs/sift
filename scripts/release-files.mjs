export const CHECKSUM_FILE = 'SHA256SUMS.txt';

export function assertReleaseVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid release version: ${version}`);
}

export function isPrereleaseVersion(version) {
  assertReleaseVersion(version);
  return version.includes('-');
}

// Files attached to a GitHub release, apart from SHA256SUMS.txt itself.
// latest.yml and the installer's .blockmap are read by electron-updater.
export function releaseAssetNames(version) {
  assertReleaseVersion(version);
  return [
    `Sift-${version}-Setup-x64.exe`,
    `Sift-${version}-Setup-x64.exe.blockmap`,
    `Sift-${version}-Portable-x64.exe`,
    `Sift-${version}-Source.tar.gz`,
    'latest.yml',
    'STUDIO-SETUP.md',
  ].sort();
}
