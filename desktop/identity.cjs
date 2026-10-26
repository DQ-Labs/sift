// App identity, read from package.json so the name, version, app ID, publisher
// and repository are defined in one place.
const pkg = require('../package.json');

function parseGitHubRepository(value) {
  const url = typeof value === 'string' ? value : value?.url;
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url || '');
  if (!match) throw new Error(`package.json repository is not a GitHub URL: ${url}`);
  return { owner: match[1], repo: match[2] };
}

function createIdentity(manifest) {
  const { owner, repo } = parseGitHubRepository(manifest.repository);
  const repositoryUrl = `https://github.com/${owner}/${repo}`;
  return Object.freeze({
    appId: manifest.appId,
    productName: manifest.productName || manifest.name,
    version: manifest.version,
    publisher: typeof manifest.author === 'string' ? manifest.author : manifest.author?.name,
    license: manifest.license,
    owner,
    repo,
    repositoryUrl,
    releasesUrl: `${repositoryUrl}/releases`,
    newIssueUrl: `${repositoryUrl}/issues/new/choose`,
    releasesApiUrl: `https://api.github.com/repos/${owner}/${repo}/releases?per_page=30`,
  });
}

module.exports = { identity: createIdentity(pkg), createIdentity, parseGitHubRepository };
