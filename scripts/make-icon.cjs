// Regenerates build/icon.ico from public/favicon.svg using Electron's Chromium
// rasterizer, so the icon needs no image tooling beyond the dev dependencies.
//
//   npm run icon
//
// On Linux without a display: xvfb-run -a npx electron --no-sandbox scripts/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const { encodeIco } = require('./ico.cjs');

const root = path.resolve(__dirname, '..');
const source = path.join(root, 'public', 'favicon.svg');
const output = path.join(root, 'build', 'icon.ico');
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];

// Runs in the renderer: draws the SVG at each size and returns raw RGBA pixels
// plus a PNG for the largest entry.
function rasterize(svgText, sizeList) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error('The SVG could not be decoded.'));
    image.onload = () => {
      const results = sizeList.map(size => {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext('2d');
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, size, size);
        const rgba = Array.from(context.getImageData(0, 0, size, size).data);
        return { size, rgba, png: canvas.toDataURL('image/png') };
      });
      resolve(results);
    };
    image.src = 'data:image/svg+xml;base64,' + btoa(svgText);
  });
}

async function main() {
  const svg = readFileSync(source, 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await win.loadURL('data:text/html,<!doctype html><title>icon</title>');
  const script = `(${rasterize.toString()})(${JSON.stringify(svg)}, ${JSON.stringify(sizes)})`;
  const rendered = await win.webContents.executeJavaScript(script);
  win.destroy();

  const images = rendered.map(item => ({
    size: item.size,
    rgba: Buffer.from(item.rgba),
    png: Buffer.from(item.png.replace(/^data:image\/png;base64,/, ''), 'base64'),
  }));
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, encodeIco(images));
  writeFileSync(path.join(root, 'build', 'icon.png'), images.find(image => image.size === 256).png);
  console.log(`Wrote ${path.relative(root, output)} (${sizes.join(', ')} px) and build/icon.png.`);
}

app.whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch(error => {
    console.error(error);
    app.exit(1);
  });
