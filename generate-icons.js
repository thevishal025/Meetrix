// Script to generate clean, high-resolution PNG icons for Meetrix
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function createPng(width, height) {
  // We will generate an uncompressed RGBA bitmap and wrap in PNG format
  // meetrix brand: Dark blue/purple background, vibrant cyan-teal M or hexagonal matrix badge
  const rowLength = width * 4 + 1; // 1 filter byte per row
  const rawData = Buffer.alloc(rowLength * height);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * rowLength;
    rawData[rowOffset] = 0; // Filter type None

    for (let x = 0; x < width; x++) {
      const pixelOffset = rowOffset + 1 + x * 4;

      // Distance from center
      const cx = width / 2;
      const cy = height / 2;
      const dx = (x - cx) / cx;
      const dy = (y - cy) / cy;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Rounded squircle / rounded rect container
      const cornerR = 0.22;
      const inBoxX = Math.abs(x - cx) <= cx * 0.88;
      const inBoxY = Math.abs(y - cy) <= cy * 0.88;

      let inIcon = false;
      let isEdge = false;
      const nx = Math.abs(x - cx) / cx;
      const ny = Math.abs(y - cy) / cy;

      // Squircle shape: x^4 + y^4 <= 1
      const squircle = Math.pow(nx, 4) + Math.pow(ny, 4);

      if (squircle <= 0.85) {
        inIcon = true;
      }

      if (!inIcon) {
        // Transparent outside squircle
        rawData[pixelOffset] = 0;
        rawData[pixelOffset + 1] = 0;
        rawData[pixelOffset + 2] = 0;
        rawData[pixelOffset + 3] = 0;
        continue;
      }

      // Background gradient: Deep indigo to dark slate
      const grad = y / height;
      let r = Math.round(15 * (1 - grad) + 10 * grad);
      let g = Math.round(23 * (1 - grad) + 25 * grad);
      let b = Math.round(42 * (1 - grad) + 50 * grad);
      let a = 255;

      // Draw the stylized "M" logo with cyan/teal accent
      // Normalized coordinates within the icon: -1 to 1
      const mx = (x - cx) / (cx * 0.65);
      const my = (y - cy) / (cy * 0.65);

      // Draw "M" strokes
      const thickness = width <= 16 ? 0.35 : 0.22;
      let isM = false;
      let isDot = false;

      // Left leg of M: mx between -0.85 and -0.45, my between -0.65 and 0.65
      if (mx >= -0.85 && mx <= -0.85 + thickness && my >= -0.65 && my <= 0.65) {
        isM = true;
      }
      // Right leg of M: mx between 0.85 - thickness and 0.85, my between -0.65 and 0.65
      else if (mx >= 0.85 - thickness && mx <= 0.85 && my >= -0.65 && my <= 0.65) {
        isM = true;
      }
      // Left diagonal: from (-0.85, -0.65) to (0, 0.25)
      else {
        // line 1: y = m*x + c
        const d1 = Math.abs(my - (1.1 * mx + 0.25));
        const inDiag1X = mx >= -0.85 && mx <= 0.05 && my >= -0.65 && my <= 0.35;
        if (inDiag1X && d1 <= thickness * 0.9) {
          isM = true;
        }

        // Right diagonal: from (0, 0.25) to (0.85, -0.65)
        const d2 = Math.abs(my - (-1.1 * mx + 0.25));
        const inDiag2X = mx >= -0.05 && mx <= 0.85 && my >= -0.65 && my <= 0.35;
        if (inDiag2X && d2 <= thickness * 0.9) {
          isM = true;
        }
      }

      // Live matrix beacon dot at top right
      const dotX = (x - (cx + cx * 0.52)) / (cx * 0.18);
      const dotY = (y - (cy - cy * 0.52)) / (cy * 0.18);
      if (dotX * dotX + dotY * dotY <= 1.0) {
        isDot = true;
      }

      if (isDot) {
        // Vibrant neon green/emerald presence dot
        r = 16;
        g = 217;
        b = 140;
      } else if (isM) {
        // Vibrant cyan-blue glow
        const mGrad = (my + 0.65) / 1.3;
        r = Math.round(56 * (1 - mGrad) + 14 * mGrad);
        g = Math.round(189 * (1 - mGrad) + 165 * mGrad);
        b = Math.round(248 * (1 - mGrad) + 233 * mGrad);
      } else {
        // Subtle border highlight
        if (squircle >= 0.72) {
          r = Math.min(255, r + 30);
          g = Math.min(255, g + 45);
          b = Math.min(255, b + 70);
        }
      }

      rawData[pixelOffset] = r;
      rawData[pixelOffset + 1] = g;
      rawData[pixelOffset + 2] = b;
      rawData[pixelOffset + 3] = a;
    }
  }

  return buildPng(width, height, rawData);
}

function buildPng(width, height, rawData) {
  const compressed = zlib.deflateSync(rawData);

  // PNG Signature: 89 50 4E 47 0D 0A 1A 0A
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR Chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // Bit depth: 8
  ihdr[9] = 6; // Color type: RGBA (6)
  ihdr[10] = 0; // Compression method
  ihdr[11] = 0; // Filter method
  ihdr[12] = 0; // Interlace method

  const ihdrChunk = createChunk('IHDR', ihdr);
  const idatChunk = createChunk('IDAT', compressed);
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const len = data.length;
  const chunk = Buffer.alloc(len + 12);
  chunk.writeUInt32BE(len, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);

  const crc = crc32(chunk.subarray(4, len + 8));
  chunk.writeInt32BE(crc, len + 8);
  return chunk;
}

// Precomputed CRC table
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    if (c & 1) {
      c = 0xedb88320 ^ (c >>> 1);
    } else {
      c = c >>> 1;
    }
  }
  crcTable[n] = c;
}

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  }
  return crc ^ -1;
}

const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) {
  fs.mkdirSync(iconsDir, { recursive: true });
}

[16, 48, 128].forEach(size => {
  const png = createPng(size, size);
  const p = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(p, png);
  console.log(`Generated ${p} (${size}x${size}, ${png.length} bytes)`);
});
