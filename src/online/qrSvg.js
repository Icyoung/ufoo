"use strict";

/**
 * Minimal, zero-dependency ISO/IEC 18004 QR Code (Byte mode, ECC Level L, Versions 1-14)
 * SVG and ASCII/Unicode renderer for ufoo device pairing URLs.
 */

// ECC Level L parameters per version (1..14):
// [totalCodewords, ecCodewordsPerBlock, group1Blocks, group1DataCw, group2Blocks, group2DataCw]
const VERSION_SPEC_L = [
  null,
  [26, 7, 1, 19, 0, 0],        // V1  (21x21)  max 17 bytes
  [44, 10, 1, 34, 0, 0],       // V2  (25x25)  max 32 bytes
  [70, 15, 1, 55, 0, 0],       // V3  (29x29)  max 53 bytes
  [100, 20, 1, 80, 0, 0],      // V4  (33x33)  max 78 bytes
  [134, 26, 1, 108, 0, 0],     // V5  (37x37)  max 106 bytes
  [172, 18, 2, 68, 0, 0],      // V6  (41x41)  max 134 bytes
  [196, 20, 2, 78, 0, 0],      // V7  (45x45)  max 154 bytes
  [242, 24, 2, 97, 0, 0],      // V8  (49x49)  max 192 bytes
  [292, 30, 2, 116, 0, 0],     // V9  (53x53)  max 230 bytes
  [346, 18, 2, 68, 2, 69],     // V10 (57x57)  max 271 bytes
  [404, 20, 4, 81, 0, 0],      // V11 (61x61)  max 321 bytes
  [466, 24, 2, 92, 2, 93],     // V12 (65x65)  max 367 bytes
  [532, 26, 4, 107, 0, 0],     // V13 (69x69)  max 425 bytes
  [581, 30, 3, 115, 1, 116],   // V14 (73x73)  max 458 bytes
];

const ALIGNMENT_CENTERS = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
];

// GF(256) with primitive polynomial 0x11D
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const res = new Uint8Array(ecCount);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.copyWithin(0, 1);
    res[ecCount - 1] = 0;
    for (let i = 0; i < ecCount; i += 1) {
      res[i] ^= gfMul(gen[i + 1], factor);
    }
  }
  return res;
}

function selectVersion(byteLen) {
  for (let v = 1; v < VERSION_SPEC_L.length; v += 1) {
    const [, , g1b, g1d, g2b, g2d] = VERSION_SPEC_L[v];
    const dataCw = g1b * g1d + g2b * g2d;
    const countBits = v <= 9 ? 8 : 16;
    const overheadBits = 4 + countBits;
    const capacityBytes = Math.floor((dataCw * 8 - overheadBits) / 8);
    if (byteLen <= capacityBytes) return v;
  }
  throw new Error(`QR payload too long (${byteLen} bytes)`);
}

function encodeDataCodewords(bytes, version) {
  const [, , g1b, g1d, g2b, g2d] = VERSION_SPEC_L[version];
  const totalDataCw = g1b * g1d + g2b * g2d;
  const bits = [];
  const pushBits = (val, count) => {
    for (let i = count - 1; i >= 0; i -= 1) {
      bits.push((val >>> i) & 1);
    }
  };

  // Mode: Byte (0100)
  pushBits(0b0100, 4);
  pushBits(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(b, 8);

  const maxBits = totalDataCw * 8;
  const termLen = Math.min(4, maxBits - bits.length);
  pushBits(0, termLen);
  while (bits.length % 8 !== 0) bits.push(0);

  const cw = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
    cw.push(byte);
  }
  const pads = [0xec, 0x11];
  let p = 0;
  while (cw.length < totalDataCw) {
    cw.push(pads[p++ & 1]);
  }
  return new Uint8Array(cw);
}

function interleaveBlocks(dataCw, version) {
  const [, ecLen, g1b, g1d, g2b, g2d] = VERSION_SPEC_L[version];
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < g1b; i += 1) {
    const slice = dataCw.subarray(offset, offset + g1d);
    offset += g1d;
    blocks.push({ data: slice, ec: rsRemainder(slice, ecLen) });
  }
  for (let i = 0; i < g2b; i += 1) {
    const slice = dataCw.subarray(offset, offset + g2d);
    offset += g2d;
    blocks.push({ data: slice, ec: rsRemainder(slice, ecLen) });
  }

  const maxData = Math.max(g1d, g2d);
  const out = [];
  for (let i = 0; i < maxData; i += 1) {
    for (const blk of blocks) {
      if (i < blk.data.length) out.push(blk.data[i]);
    }
  }
  for (let i = 0; i < ecLen; i += 1) {
    for (const blk of blocks) {
      out.push(blk.ec[i]);
    }
  }
  return new Uint8Array(out);
}

function bchFormatBits(ecLevelBits, maskPattern) {
  const data = (ecLevelBits << 3) | maskPattern;
  let rem = data << 10;
  const gen = 0b10100110111;
  for (let i = 14; i >= 10; i -= 1) {
    if ((rem >>> i) & 1) rem ^= gen << (i - 10);
  }
  return ((data << 10) | rem) ^ 0b101010000010010;
}

function bchVersionBits(version) {
  let rem = version << 12;
  const gen = 0b1111100100101;
  for (let i = 17; i >= 12; i -= 1) {
    if ((rem >>> i) & 1) rem ^= gen << (i - 12);
  }
  return (version << 12) | rem;
}

function buildQrMatrix(text) {
  const bytes = Buffer.from(String(text || ""), "utf8");
  const version = selectVersion(bytes.length);
  const size = version * 4 + 17;
  const dataCw = encodeDataCodewords(bytes, version);
  const finalCw = interleaveBlocks(dataCw, version);

  const grid = Array.from({ length: size }, () => new Uint8Array(size));
  const isFunction = Array.from({ length: size }, () => new Uint8Array(size));

  const setFn = (r, c, dark) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    grid[r][c] = dark ? 1 : 0;
    isFunction[r][c] = 1;
  };

  // Finder patterns + separators
  const placeFinder = (tr, tc) => {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const r = tr + dr;
        const c = tc + dc;
        if (r < 0 || c < 0 || r >= size || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFn(r, c, inOuter && (onBorder || inCenter));
      }
    }
  };
  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i += 1) {
    setFn(6, i, i % 2 === 0);
    setFn(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  const centers = ALIGNMENT_CENTERS[version] || [];
  for (const r of centers) {
    for (const c of centers) {
      if (isFunction[r][c]) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFn(r + dr, c + dc, dist === 2 || dist === 0);
        }
      }
    }
  }

  // Dark module
  setFn(4 * version + 9, 8, true);

  // Reserve format info cells
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      isFunction[8][i] = 1;
      isFunction[i][8] = 1;
    }
  }
  for (let i = size - 8; i < size; i += 1) {
    isFunction[8][i] = 1;
    isFunction[i][8] = 1;
  }

  // Version info (version >= 7)
  if (version >= 7) {
    const vBits = bchVersionBits(version);
    for (let i = 0; i < 18; i += 1) {
      const dark = Boolean((vBits >>> i) & 1);
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      setFn(a, b, dark);
      setFn(b, a, dark);
    }
  }

  // Place data bits in upward/downward zigzag
  let bitIdx = 0;
  const totalBits = finalCw.length * 8;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert += 1) {
      const r = upward ? size - 1 - vert : vert;
      for (let lr = 0; lr < 2; lr += 1) {
        const c = right - lr;
        if (isFunction[r][c]) continue;
        let dark = 0;
        if (bitIdx < totalBits) {
          dark = (finalCw[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1;
          bitIdx += 1;
        }
        grid[r][c] = dark;
      }
    }
    upward = !upward;
  }

  // Apply mask 0 ((r + c) % 2 === 0) and write format info (ECC L = 01)
  const mask = 0;
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (!isFunction[r][c] && ((r + c) % 2 === 0)) {
        grid[r][c] ^= 1;
      }
    }
  }

  const fmt = bchFormatBits(0b01, mask);
  for (let i = 0; i <= 5; i += 1) grid[8][i] = (fmt >>> (14 - i)) & 1;
  grid[8][7] = (fmt >>> 8) & 1;
  grid[8][8] = (fmt >>> 7) & 1;
  grid[7][8] = (fmt >>> 6) & 1;
  for (let i = 9; i <= 14; i += 1) grid[14 - i][8] = (fmt >>> (14 - i)) & 1;

  for (let i = 0; i <= 6; i += 1) grid[size - 1 - i][8] = (fmt >>> (14 - i)) & 1;
  for (let i = 7; i <= 14; i += 1) grid[8][size - 15 + i] = (fmt >>> (14 - i)) & 1;
  grid[4 * version + 9][8] = 1;

  return { version, size, matrix: grid };
}

function renderQrSvg(text, { margin = 4, darkColor = "#111114", lightColor = "#ffffff" } = {}) {
  const { size, matrix } = buildQrMatrix(text);
  const full = size + margin * 2;
  const rects = [];
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (matrix[r][c]) {
        rects.push(`M${c + margin},${r + margin}h1v1h-1z`);
      }
    }
  }
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full}" shape-rendering="crispEdges" role="img" aria-label="Pairing QR Code">`,
    `<rect width="${full}" height="${full}" fill="${lightColor}"/>`,
    `<path d="${rects.join("")}" fill="${darkColor}"/>`,
    `</svg>`,
  ].join("");
  return {
    svg,
    dataUrl: `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`,
    size,
  };
}

function renderQrTerminal(text, { margin = 2 } = {}) {
  const { size, matrix } = buildQrMatrix(text);
  const full = size + margin * 2;
  const at = (r, c) => {
    const mr = r - margin;
    const mc = c - margin;
    if (mr < 0 || mc < 0 || mr >= size || mc >= size) return 0;
    return matrix[mr][mc];
  };
  const lines = [];
  for (let r = 0; r < full; r += 2) {
    let line = "";
    for (let c = 0; c < full; c += 1) {
      const top = at(r, c);
      const bot = r + 1 < full ? at(r + 1, c) : 0;
      if (top && bot) line += "█";
      else if (top && !bot) line += "▀";
      else if (!top && bot) line += "▄";
      else line += " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

module.exports = {
  buildQrMatrix,
  renderQrSvg,
  renderQrTerminal,
};
