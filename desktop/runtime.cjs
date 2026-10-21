const path = require('node:path');

function desktopDataPath({ packaged, root, appData, env = process.env }) {
  return path.resolve(env.SIFT_DATA_DIR || (packaged ? path.join(appData, 'Sift') : path.join(root, 'data')));
}

module.exports = { desktopDataPath };
