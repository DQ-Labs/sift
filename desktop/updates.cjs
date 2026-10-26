const { existsSync } = require('node:fs');
const path = require('node:path');

// --- Version helpers ------------------------------------------------------

function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text || '').trim());
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function compareIdentifiers(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// Semantic-version ordering: 0.4.0-alpha.1 < 0.4.0-alpha.2 < 0.4.0-beta.1 < 0.4.0.
function compareVersions(left, right) {
  const a = typeof left === 'string' ? parseVersion(left) : left;
  const b = typeof right === 'string' ? parseVersion(right) : right;
  if (!a || !b) throw new Error(`Cannot compare versions ${left} and ${right}.`);
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return Math.sign(a.core[index] - b.core[index]);
  }
  // A release outranks any prerelease of the same version.
  const aPrerelease = a.prerelease.length > 0;
  const bPrerelease = b.prerelease.length > 0;
  if (!aPrerelease && !bPrerelease) return 0;
  if (!aPrerelease) return 1;
  if (!bPrerelease) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    const order = compareIdentifiers(a.prerelease[index], b.prerelease[index]);
    if (order) return order;
  }
  return 0;
}

// Picks the newest published GitHub release that is newer than the running
// version. Someone on a stable build is only offered stable releases.
function pickNewerRelease(releases, currentVersion) {
  const current = parseVersion(currentVersion);
  if (!current || !Array.isArray(releases)) return null;
  let best = null;
  for (const release of releases) {
    if (!release || release.draft) continue;
    const version = parseVersion(release.tag_name);
    if (!version) continue;
    const prerelease = release.prerelease || version.prerelease.length > 0;
    if (prerelease && !current.prerelease.length) continue;
    if (compareVersions(version, current) <= 0) continue;
    if (best && compareVersions(version, best.parsed) <= 0) continue;
    best = { parsed: version, version: release.tag_name.replace(/^v/, ''), url: release.html_url, notes: release.body || '' };
  }
  if (!best) return null;
  return { version: best.version, url: best.url, notes: best.notes };
}

// --- Release notes --------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// electron-updater hands over release notes as HTML (from the GitHub feed);
// the GitHub API returns Markdown. Dialogs need short plain text.
function releaseNotesText(notes, limit = 1200) {
  let text = Array.isArray(notes) ? notes.map(entry => entry?.note || '').join('\n\n') : String(notes || '');
  text = text
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n• ')
    .replace(/<\/\s*(p|div|h\d|ul|ol)\s*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity, name) => {
      if (name[0] === '#') {
        const code = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        return Number.isFinite(code) ? String.fromCodePoint(code) : entity;
      }
      return ENTITIES[name.toLowerCase()] ?? entity;
    })
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length > limit) text = text.slice(0, limit).replace(/\s+\S*$/, '') + ' …';
  return text;
}

// --- Update mode ----------------------------------------------------------

// installer: the NSIS build, which electron-updater can update in place.
// portable: the single-file build, which can only point at the download page.
// development: an unpackaged checkout; manual checks only.
function updateMode({ packaged, env = process.env, resourcesPath, exists = existsSync }) {
  if (!packaged) return 'development';
  if (env.PORTABLE_EXECUTABLE_FILE) return 'portable';
  if (resourcesPath && exists(path.join(resourcesPath, 'app-update.yml'))) return 'installer';
  return 'portable';
}

function launchCheckEnabled({ mode, settings, env = process.env, smokeTest = false }) {
  if (smokeTest || mode === 'development') return false;
  if (env.SIFT_DISABLE_UPDATE_CHECK === '1') return false;
  return settings.get('checkForUpdates') !== false;
}

// --- Controller -----------------------------------------------------------

class UpdateController {
  constructor({ identity, mode, settings, logger, dialog, shell, getWindow, beforeInstall, fetchImpl = fetch, loadAutoUpdater }) {
    Object.assign(this, { identity, mode, settings, logger, dialog, shell, getWindow, beforeInstall, fetchImpl });
    this.loadAutoUpdater = loadAutoUpdater || (() => require('electron-updater').autoUpdater);
    this.busy = false;
    this.downloadedVersion = null;
  }

  async check({ manual }) {
    if (this.busy) {
      if (manual) await this.message('info', 'Sift is already checking for updates.');
      return;
    }
    this.busy = true;
    try {
      if (this.mode === 'installer') await this.checkInstaller(manual);
      else await this.checkReleases(manual);
    } catch (error) {
      this.logger.error('Update check failed:', error);
      if (manual) await this.message('warning', 'Sift could not check for updates.', error.message);
    } finally {
      this.busy = false;
      this.getWindow()?.setProgressBar(-1);
    }
  }

  autoUpdater() {
    if (this.updater) return this.updater;
    const updater = this.loadAutoUpdater();
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = true;
    updater.logger = this.logger;
    updater.on('download-progress', progress => {
      this.getWindow()?.setProgressBar(Math.max(0, Math.min(1, progress.percent / 100)));
    });
    this.updater = updater;
    return updater;
  }

  async checkInstaller(manual) {
    if (this.downloadedVersion) {
      await this.promptRestart(this.downloadedVersion);
      return;
    }
    const updater = this.autoUpdater();
    const result = await updater.checkForUpdates();
    if (!result?.isUpdateAvailable) {
      if (manual) await this.upToDate();
      return;
    }
    const { version, releaseNotes } = result.updateInfo;
    if (!manual && this.settings.get('skippedVersion') === version) return;

    const choice = await this.ask({
      message: `Sift ${version} is available.`,
      detail: this.describe(releaseNotes, `You have ${this.identity.version}. Sift downloads the installer, then asks before restarting.`),
      buttons: ['Download and install', 'Later', 'Skip this version'],
    });
    if (choice === 2) this.settings.set('skippedVersion', version);
    if (choice !== 0) return;

    await updater.downloadUpdate();
    this.downloadedVersion = version;
    await this.promptRestart(version);
  }

  async promptRestart(version) {
    const choice = await this.ask({
      message: `Sift ${version} is ready to install.`,
      detail: 'Restart now to install it, or it installs the next time you quit Sift. Your library, gems, sets and exports are kept.',
      buttons: ['Restart now', 'When I quit'],
    });
    if (choice !== 0) return;
    // Stop the local server first so the catalogue is flushed before the
    // installer replaces the program files.
    await this.beforeInstall();
    this.autoUpdater().quitAndInstall(false, true);
  }

  async checkReleases(manual) {
    const response = await this.fetchImpl(this.identity.releasesApiUrl, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `${this.identity.productName}/${this.identity.version}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`GitHub answered ${response.status} ${response.statusText || ''}`.trim());
    const release = pickNewerRelease(await response.json(), this.identity.version);
    if (!release) {
      if (manual) await this.upToDate();
      return;
    }
    if (!manual && this.settings.get('skippedVersion') === release.version) return;

    const how = this.mode === 'portable'
      ? 'The portable build does not update itself. Download the new Portable EXE, or switch to the Setup installer for automatic updates.'
      : 'Development checkouts update with git pull.';
    const choice = await this.ask({
      message: `Sift ${release.version} is available.`,
      detail: this.describe(release.notes, `You have ${this.identity.version}. ${how}`),
      buttons: ['Open download page', 'Later', 'Skip this version'],
    });
    if (choice === 2) this.settings.set('skippedVersion', release.version);
    if (choice !== 0) return;
    const releasePage = `${this.identity.releasesUrl}/`;
    await this.shell.openExternal(release.url?.startsWith(releasePage) ? release.url : this.identity.releasesUrl);
  }

  describe(notes, footer) {
    const text = releaseNotesText(notes);
    return text ? `${text}\n\n${footer}` : footer;
  }

  async upToDate() {
    await this.message('info', `Sift ${this.identity.version} is the latest version.`);
  }

  async ask({ message, detail, buttons }) {
    const options = { type: 'info', title: 'Sift updates', message, detail, buttons, defaultId: 0, cancelId: 1, noLink: true };
    const window = this.getWindow();
    const { response } = window ? await this.dialog.showMessageBox(window, options) : await this.dialog.showMessageBox(options);
    return response;
  }

  async message(type, message, detail = '') {
    const options = { type, title: 'Sift updates', message, detail, buttons: ['OK'], noLink: true };
    const window = this.getWindow();
    if (window) await this.dialog.showMessageBox(window, options);
    else await this.dialog.showMessageBox(options);
  }
}

module.exports = {
  parseVersion,
  compareVersions,
  pickNewerRelease,
  releaseNotesText,
  updateMode,
  launchCheckEnabled,
  UpdateController,
};
