(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RollEntropyQr = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VERSION = 10;
  const SIZE = VERSION * 4 + 17;
  const MASK_PATTERN = 0;
  const DATA_CODEWORDS = 216;
  const TOTAL_CODEWORDS = 346;
  const RS_BLOCKS = [
    { total: 69, data: 43 },
    { total: 69, data: 43 },
    { total: 69, data: 43 },
    { total: 69, data: 43 },
    { total: 70, data: 44 },
  ];
  const ALIGNMENT_POSITIONS = [6, 28, 50];
  const MAX_PAYLOAD_BYTES = 213;

  function utf8Bytes(text) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(String(text));
    return Uint8Array.from(Buffer.from(String(text), "utf8"));
  }

  class BitBuffer {
    constructor() {
      this.bytes = [];
      this.length = 0;
    }
    put(value, length) {
      for (let bit = length - 1; bit >= 0; bit -= 1) this.putBit(((value >>> bit) & 1) !== 0);
    }
    putBit(value) {
      const index = Math.floor(this.length / 8);
      if (this.bytes.length <= index) this.bytes.push(0);
      if (value) this.bytes[index] |= 0x80 >>> (this.length % 8);
      this.length += 1;
    }
  }

  function encodeDataCodewords(payload) {
    const data = utf8Bytes(payload);
    if (data.length > MAX_PAYLOAD_BYTES) {
      throw new Error(`QR recovery payload is ${data.length} bytes; this version supports at most ${MAX_PAYLOAD_BYTES}`);
    }
    const buffer = new BitBuffer();
    buffer.put(0b0100, 4); // 8-bit byte mode
    buffer.put(data.length, 16); // versions 10..26 use a 16-bit byte count
    data.forEach((value) => buffer.put(value, 8));
    const bitLimit = DATA_CODEWORDS * 8;
    for (let index = 0; index < Math.min(bitLimit - buffer.length, 4); index += 1) buffer.putBit(false);
    while (buffer.length % 8) buffer.putBit(false);
    let pad = 0;
    while (buffer.bytes.length < DATA_CODEWORDS) {
      buffer.bytes.push(pad % 2 === 0 ? 0xec : 0x11);
      pad += 1;
    }
    return Uint8Array.from(buffer.bytes);
  }

  function gfMultiply(left, right) {
    let a = left;
    let b = right;
    let result = 0;
    while (b) {
      if (b & 1) result ^= a;
      b >>>= 1;
      a <<= 1;
      if (a & 0x100) a ^= 0x11d;
    }
    return result & 0xff;
  }

  function generatorPolynomial(degree) {
    let polynomial = [1];
    let root = 1;
    for (let index = 0; index < degree; index += 1) {
      const next = new Array(polynomial.length + 1).fill(0);
      for (let position = 0; position < polynomial.length; position += 1) {
        next[position] ^= polynomial[position];
        next[position + 1] ^= gfMultiply(polynomial[position], root);
      }
      polynomial = next;
      root = gfMultiply(root, 2);
    }
    return polynomial;
  }

  function reedSolomonRemainder(data, degree) {
    const generator = generatorPolynomial(degree);
    const remainder = new Uint8Array(degree);
    for (const byte of data) {
      const factor = byte ^ remainder[0];
      for (let index = 0; index < degree - 1; index += 1) remainder[index] = remainder[index + 1];
      remainder[degree - 1] = 0;
      for (let index = 0; index < degree; index += 1) {
        remainder[index] ^= gfMultiply(generator[index + 1], factor);
      }
    }
    return remainder;
  }

  function interleaveWithErrorCorrection(dataCodewords) {
    const dataBlocks = [];
    const eccBlocks = [];
    let offset = 0;
    let maxData = 0;
    let maxEcc = 0;
    for (const spec of RS_BLOCKS) {
      const block = dataCodewords.slice(offset, offset + spec.data);
      offset += spec.data;
      const eccCount = spec.total - spec.data;
      dataBlocks.push(block);
      eccBlocks.push(reedSolomonRemainder(block, eccCount));
      maxData = Math.max(maxData, block.length);
      maxEcc = Math.max(maxEcc, eccCount);
    }
    const output = [];
    for (let index = 0; index < maxData; index += 1) {
      dataBlocks.forEach((block) => { if (index < block.length) output.push(block[index]); });
    }
    for (let index = 0; index < maxEcc; index += 1) {
      eccBlocks.forEach((block) => { if (index < block.length) output.push(block[index]); });
    }
    if (output.length !== TOTAL_CODEWORDS) throw new Error(`QR codeword assembly produced ${output.length}, expected ${TOTAL_CODEWORDS}`);
    return Uint8Array.from(output);
  }

  function bchDigit(value) {
    let digit = 0;
    let current = value >>> 0;
    while (current) {
      digit += 1;
      current >>>= 1;
    }
    return digit;
  }

  function bchTypeInfo(data) {
    const g15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | 1;
    const mask = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);
    let value = data << 10;
    while (bchDigit(value) - bchDigit(g15) >= 0) value ^= g15 << (bchDigit(value) - bchDigit(g15));
    return ((data << 10) | value) ^ mask;
  }

  function bchVersion(version) {
    const g18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | 1;
    let value = version << 12;
    while (bchDigit(value) - bchDigit(g18) >= 0) value ^= g18 << (bchDigit(value) - bchDigit(g18));
    return (version << 12) | value;
  }

  function emptyMatrix() {
    return Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
  }

  function setupFinder(matrix, row, col) {
    for (let r = -1; r <= 7; r += 1) {
      if (row + r < 0 || row + r >= SIZE) continue;
      for (let c = -1; c <= 7; c += 1) {
        if (col + c < 0 || col + c >= SIZE) continue;
        matrix[row + r][col + c] = (
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4)
        );
      }
    }
  }

  function setupAlignment(matrix) {
    for (const row of ALIGNMENT_POSITIONS) {
      for (const col of ALIGNMENT_POSITIONS) {
        if (matrix[row][col] !== null) continue;
        for (let r = -2; r <= 2; r += 1) {
          for (let c = -2; c <= 2; c += 1) {
            matrix[row + r][col + c] = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
          }
        }
      }
    }
  }

  function setupTiming(matrix) {
    for (let row = 8; row < SIZE - 8; row += 1) if (matrix[row][6] === null) matrix[row][6] = row % 2 === 0;
    for (let col = 8; col < SIZE - 8; col += 1) if (matrix[6][col] === null) matrix[6][col] = col % 2 === 0;
  }

  function setupFormatInfo(matrix) {
    // Error correction M has format bits 00; this encoder fixes mask pattern 0.
    const bits = bchTypeInfo(MASK_PATTERN);
    for (let index = 0; index < 15; index += 1) {
      const dark = ((bits >>> index) & 1) === 1;
      if (index < 6) matrix[index][8] = dark;
      else if (index < 8) matrix[index + 1][8] = dark;
      else matrix[SIZE - 15 + index][8] = dark;
    }
    for (let index = 0; index < 15; index += 1) {
      const dark = ((bits >>> index) & 1) === 1;
      if (index < 8) matrix[8][SIZE - index - 1] = dark;
      else if (index < 9) matrix[8][15 - index] = dark;
      else matrix[8][15 - index - 1] = dark;
    }
    matrix[SIZE - 8][8] = true;
  }

  function setupVersionInfo(matrix) {
    const bits = bchVersion(VERSION);
    for (let index = 0; index < 18; index += 1) {
      const dark = ((bits >>> index) & 1) === 1;
      matrix[Math.floor(index / 3)][index % 3 + SIZE - 11] = dark;
      matrix[index % 3 + SIZE - 11][Math.floor(index / 3)] = dark;
    }
  }

  function mapCodewords(matrix, codewords) {
    let row = SIZE - 1;
    let direction = -1;
    let bitIndex = 7;
    let byteIndex = 0;
    for (let col = SIZE - 1; col > 0; col -= 2) {
      if (col === 6) col -= 1;
      while (true) {
        for (const currentCol of [col, col - 1]) {
          if (matrix[row][currentCol] !== null) continue;
          let dark = false;
          if (byteIndex < codewords.length) dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1;
          if ((row + currentCol) % 2 === 0) dark = !dark; // mask pattern 0
          matrix[row][currentCol] = dark;
          bitIndex -= 1;
          if (bitIndex < 0) {
            byteIndex += 1;
            bitIndex = 7;
          }
        }
        row += direction;
        if (row < 0 || row >= SIZE) {
          row -= direction;
          direction = -direction;
          break;
        }
      }
    }
  }

  function encodeMatrix(payload) {
    const matrix = emptyMatrix();
    setupFinder(matrix, 0, 0);
    setupFinder(matrix, SIZE - 7, 0);
    setupFinder(matrix, 0, SIZE - 7);
    setupAlignment(matrix);
    setupTiming(matrix);
    setupFormatInfo(matrix);
    setupVersionInfo(matrix);
    const data = encodeDataCodewords(payload);
    mapCodewords(matrix, interleaveWithErrorCorrection(data));
    return matrix;
  }

  function escapeXml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
  }

  function toSvg(payload, options = {}) {
    const matrix = encodeMatrix(payload);
    const border = options.border == null ? 4 : Number(options.border);
    if (!Number.isInteger(border) || border < 4) throw new Error("QR quiet-zone border must be at least 4 modules");
    const dimension = SIZE + border * 2;
    const paths = [];
    for (let row = 0; row < SIZE; row += 1) {
      for (let col = 0; col < SIZE; col += 1) if (matrix[row][col]) paths.push(`M${col + border},${row + border}h1v1h-1z`);
    }
    const label = options.label || "DiceSecret recovery QR";
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dimension} ${dimension}" role="img" aria-label="${escapeXml(label)}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${paths.join("")}" fill="#000"/></svg>`;
  }

  function matrixText(matrix) {
    return matrix.map((row) => row.map((value) => value ? "1" : "0").join("")).join("\n");
  }

  return Object.freeze({
    VERSION,
    SIZE,
    MASK_PATTERN,
    MAX_PAYLOAD_BYTES,
    encodeDataCodewords,
    encodeMatrix,
    matrixText,
    toSvg,
  });
});
