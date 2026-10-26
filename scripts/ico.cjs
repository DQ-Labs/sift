// Minimal Windows .ico encoder. Small sizes are stored as 32-bit DIBs, which
// every Windows icon consumer (Explorer, NSIS, rcedit) reads; 256 px is stored
// as PNG, the standard for large icons since Windows Vista.

const PNG_THRESHOLD = 256;

function dibImage({ size, rgba }) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  // ICO DIBs declare double height: colour rows followed by the AND mask.
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    // DIB rows run bottom-up and use BGRA order.
    const target = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4;
      const to = target + x * 4;
      pixels[to] = rgba[from + 2];
      pixels[to + 1] = rgba[from + 1];
      pixels[to + 2] = rgba[from];
      pixels[to + 3] = rgba[from + 3];
    }
  }

  // The alpha channel carries transparency, so the AND mask stays all zero.
  const maskRowBytes = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRowBytes * size);
  return Buffer.concat([header, pixels, mask]);
}

function encodeIco(images) {
  const sorted = [...images].sort((a, b) => a.size - b.size);
  for (const image of sorted) {
    if (!Number.isInteger(image.size) || image.size < 1 || image.size > 256) {
      throw new Error(`Invalid icon size ${image.size}.`);
    }
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sorted.length, 4);

  const entries = [];
  const bodies = [];
  let offset = 6 + 16 * sorted.length;
  for (const image of sorted) {
    const body = image.size >= PNG_THRESHOLD ? image.png : dibImage(image);
    if (!body) throw new Error(`Missing image data for ${image.size} px.`);
    const entry = Buffer.alloc(16);
    // A stored dimension of 0 means 256.
    entry.writeUInt8(image.size % 256, 0);
    entry.writeUInt8(image.size % 256, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(body.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    bodies.push(body);
    offset += body.length;
  }
  return Buffer.concat([header, ...entries, ...bodies]);
}

function readIcoDirectory(buffer) {
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) throw new Error('Not an icon file.');
  const count = buffer.readUInt16LE(4);
  const entries = [];
  for (let index = 0; index < count; index++) {
    const at = 6 + index * 16;
    const size = buffer.readUInt8(at) || 256;
    const length = buffer.readUInt32LE(at + 8);
    const offset = buffer.readUInt32LE(at + 12);
    const body = buffer.subarray(offset, offset + length);
    if (body.length !== length) throw new Error(`Icon entry ${size} px is truncated.`);
    const isPng = body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    entries.push({ size, bitCount: buffer.readUInt16LE(at + 6), length, offset, format: isPng ? 'png' : 'dib' });
  }
  return entries;
}

module.exports = { encodeIco, readIcoDirectory };
