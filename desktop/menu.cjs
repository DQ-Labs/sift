const TOOL_SOURCES = {
  bundled: 'bundled with Sift',
  environment: 'from SIFT_FFMPEG / SIFT_FFPROBE',
  winget: 'from WinGet',
  path: 'from PATH',
};

function describeTool(tool) {
  if (!tool) return 'not found';
  return `${tool.version} (${TOOL_SOURCES[tool.source] || tool.source})`;
}

const UPDATE_MODES = {
  installer: 'Installed build: updates install from GitHub Releases',
  portable: 'Portable build: notifies about new GitHub Releases',
  development: 'Development checkout: manual checks only',
};

function aboutDetail({ identity, versions, audioTools, dataDirectory, updateMode }) {
  return [
    `Version ${identity.version}`,
    `Electron ${versions.electron} · Chromium ${versions.chrome} · Node.js ${versions.node}`,
    `FFmpeg ${describeTool(audioTools?.ffmpeg)}`,
    `FFprobe ${describeTool(audioTools?.ffprobe)}`,
    UPDATE_MODES[updateMode] || '',
    '',
    `Data folder: ${dataDirectory}`,
    '',
    `Licence: ${identity.license}. Bundled FFmpeg is GPLv3; see THIRD_PARTY.md.`,
    `Published by ${identity.publisher} · ${identity.repositoryUrl}`,
  ].join('\n');
}

// The application menu. Help carries About, data and log shortcuts and update
// controls; Edit keeps the standard clipboard shortcuts working.
function menuTemplate({ identity, actions, updateMode, checkOnLaunch }) {
  const help = [
    { label: `About ${identity.productName}`, click: actions.about },
    { type: 'separator' },
    { label: 'Open data folder', click: actions.openDataFolder },
    { label: 'View logs', click: actions.viewLogs },
    { type: 'separator' },
    { label: 'Check for updates…', click: actions.checkForUpdates },
  ];
  if (updateMode !== 'development') {
    help.push({
      label: 'Check for updates on launch',
      type: 'checkbox',
      checked: checkOnLaunch,
      click: item => actions.setCheckOnLaunch(item.checked),
    });
  }
  help.push(
    { type: 'separator' },
    { label: 'Releases and downloads', click: actions.openReleases },
    { label: 'Report an issue', click: actions.reportIssue },
  );

  return [
    {
      label: 'File',
      submenu: [
        { label: 'Open data folder', click: actions.openDataFolder },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { label: 'Help', role: 'help', submenu: help },
  ];
}

module.exports = { aboutDetail, menuTemplate, describeTool };
