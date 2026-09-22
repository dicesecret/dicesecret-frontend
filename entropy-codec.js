(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RollEntropyCodec = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const PINNED_WORD_LISTS = Object.freeze({
    "bip39_english.txt": { sha256: "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda", count: 2048 },
    "bytewords.txt": { sha256: "59a1ed91db2432f6a50fa5cd013d8c634cfca77fa9367ebf5791279690f48a3e", count: 256 },
    "eff_large_wordlist.txt": { sha256: "addd35536511597a02fa0a9ff1e5284677b8883b83e986e43f15a3db996b903e", count: 7776 },
    "eff_short_wordlist_1.txt": { sha256: "8f5ca830b8bffb6fe39c9736c024a00a6a6411adb3f83a9be8bfeeb6e067ae69", count: 1296 },
    "eff_short_wordlist_2_0.txt": { sha256: "22b45c52e0bd0bbf03aa522240b111eb4c7c0c1d86c4e518e1be2a7eb2a625e4", count: 1296 },
    "orchard-street-alpha-dice.txt": { sha256: "5a79c5aa802a62918c9d5c33e36f34e7f289d41a4b47d58ae986868c9d319084", count: 1296 },
    "orchard-street-diceware.txt": { sha256: "27ee55e6c4e1cdf6e85a1db2ac018786fa1f8be4415e7983976ac16f4f1c5c81", count: 7776 },
    "orchard-street-medium.txt": { sha256: "c50d42781d5ac20eeed37f271df5a0fd3573de493812f319cd71dd4da9a8a38e", count: 8192 },
    "orchard-street-qwerty.txt": { sha256: "dbcbb2c74ce70426ab6c532c0167474fd701f1b7a6a56614950eb8475589ccea", count: 1296 },
    "pgp-even.txt": { sha256: "37a65f88512467edd12a1ab3eeb5f4328230e86711a8efde6333361ce10f4fcf", count: 256 },
    "pgp-odd.txt": { sha256: "c2f23c2233d4d7291107e8f796c374d0cb1fb30c1391bcb4f6480243de8ebf5a", count: 256 },
    "rfc1751-wordlist.txt": { sha256: "57f52671ada3c689d145e18c74a64f296ea6cac2b98331e3860448ec02c89f11", count: 2048 },
  });

  const GENERIC_WORD_LISTS = Object.freeze({
    "eff-long": { filename: "eff_large_wordlist.txt", count: 7776 },
    "eff-short1": { filename: "eff_short_wordlist_1.txt", count: 1296 },
    "eff-short2": { filename: "eff_short_wordlist_2_0.txt", count: 1296 },
    "orchard-alpha": { filename: "orchard-street-alpha-dice.txt", count: 1296 },
    "orchard-diceware": { filename: "orchard-street-diceware.txt", count: 7776 },
    "orchard-medium": { filename: "orchard-street-medium.txt", count: 8192 },
    "orchard-qwerty": { filename: "orchard-street-qwerty.txt", count: 1296 },
    "rfc1751-generic": { filename: "rfc1751-wordlist.txt", count: 2048 },
  });

  const FORMAT_LABELS = Object.freeze({
    hex: "Hex",
    base32: "Base32",
    base64url: "Base64url",
    base64: "Base64",
    bip39: "BIP-39",
    bytewords: "Bytewords",
    "bytewords-raw": "Bytewords raw",
    pgp: "PGP words",
    "eff-long": "EFF Long",
    "eff-short1": "EFF Short #1",
    "eff-short2": "EFF Short #2",
    "orchard-alpha": "Orchard Alpha",
    "orchard-diceware": "Orchard Diceware",
    "orchard-medium": "Orchard Medium",
    "orchard-qwerty": "Orchard QWERTY",
    "rfc1751-generic": "RFC1751 vocabulary (generic)",
  });

  const FORMAT_ORDER = Object.freeze([
    "hex", "base32", "base64url", "base64",
    "bip39", "bytewords", "bytewords-raw", "pgp",
    "eff-long", "eff-short1", "eff-short2",
    "orchard-alpha", "orchard-diceware", "orchard-medium", "orchard-qwerty",
    "rfc1751-generic",
  ]);

  const wordListCache = new Map();

  function cryptoApi() {
    if (!root.crypto || !root.crypto.subtle) {
      throw new Error("Web Crypto SHA-256 is unavailable in this browser");
    }
    return root.crypto;
  }

  function asBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError("expected byte data");
  }

  function bytesToHex(data) {
    return Array.from(asBytes(data), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function hexToBytes(text) {
    const compact = String(text).replace(/\s+/g, "");
    if (!compact) throw new Error("encoded value is empty");
    if (compact.length % 2) throw new Error("hex input must contain an even number of digits");
    if (!/^[0-9a-fA-F]+$/.test(compact)) throw new Error("invalid hex input");
    const output = new Uint8Array(compact.length / 2);
    for (let index = 0; index < output.length; index += 1) {
      output[index] = Number.parseInt(compact.slice(index * 2, index * 2 + 2), 16);
    }
    return output;
  }

  function formatHex(text, options = {}) {
    const compact = String(text).replace(/\s+/g, "");
    if (!compact) return "";
    if (compact.length % 2) throw new Error("hex input must contain an even number of digits");
    if (!/^[0-9a-fA-F]+$/.test(compact)) throw new Error("invalid hex input");
    const groupBytes = Number(options.groupBytes ?? 4);
    const groupsPerLine = Number(options.groupsPerLine ?? 4);
    if (!Number.isInteger(groupBytes) || groupBytes < 1) throw new Error("hex group size must be a positive whole number of bytes");
    if (!Number.isInteger(groupsPerLine) || groupsPerLine < 1) throw new Error("hex groups per line must be a positive whole number");
    const width = groupBytes * 2;
    const groups = [];
    for (let index = 0; index < compact.length; index += width) groups.push(compact.slice(index, index + width));
    const lines = [];
    for (let index = 0; index < groups.length; index += groupsPerLine) lines.push(groups.slice(index, index + groupsPerLine).join(" "));
    return lines.join("\n");
  }

  async function sha256Hex(data) {
    const digest = await cryptoApi().subtle.digest("SHA-256", asBytes(data));
    return bytesToHex(new Uint8Array(digest));
  }

  function parseWordList(text) {
    const words = [];
    const cleanText = String(text).replace(/^\uFEFF/, "");
    for (const rawLine of cleanText.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const numbered = line.match(/^[0-9]+(?:-[0-9]+)*\s+(.+)$/);
      words.push(numbered ? numbered[1].trim() : line);
    }
    return words;
  }

  function foldWord(word) {
    return String(word).toLowerCase();
  }

  function validateWords(filename, words) {
    const spec = PINNED_WORD_LISTS[filename];
    if (!spec) throw new Error(`unrecognized word-list file ${filename}`);
    if (words.length !== spec.count) {
      throw new Error(`${filename} contains ${words.length} entries; expected ${spec.count}`);
    }
    const seen = new Map();
    for (const word of words) {
      const key = foldWord(word);
      if (seen.has(key)) {
        throw new Error(`${filename} contains a duplicate or case-insensitive collision: ${seen.get(key)} and ${word}`);
      }
      seen.set(key, word);
    }
    return words;
  }

  async function installWordList(filename, rawBytes) {
    const spec = PINNED_WORD_LISTS[filename];
    if (!spec) throw new Error(`unrecognized word-list file ${filename}`);
    const bytes = asBytes(rawBytes);
    const digest = await sha256Hex(bytes);
    if (digest !== spec.sha256) {
      throw new Error(`${filename} does not match the pinned word-list bytes; SHA-256 is ${digest}, expected ${spec.sha256}`);
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const words = Object.freeze(validateWords(filename, parseWordList(text)).slice());
    wordListCache.set(filename, words);
    return words;
  }

  async function loadWordList(filename, options = {}) {
    if (wordListCache.has(filename)) return wordListCache.get(filename);
    const baseUrl = options.baseUrl || "/wordlists";
    const fetchImpl = options.fetchImpl || root.fetch;
    if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable for loading word lists");
    const response = await fetchImpl(`${baseUrl}/${encodeURIComponent(filename)}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`could not load ${filename}: HTTP ${response.status}`);
    return installWordList(filename, new Uint8Array(await response.arrayBuffer()));
  }

  function buildWordIndex(words, listName) {
    const index = new Map();
    words.forEach((word, position) => {
      const key = foldWord(word);
      if (index.has(key)) throw new Error(`${listName} contains a duplicate or case-insensitive collision for ${word}`);
      index.set(key, position);
    });
    return index;
  }

  function splitPhrase(text) {
    const phrase = String(text).trim();
    return phrase ? phrase.split(/\s+/) : [];
  }

  function phraseToIndexes(phrase, words, listName) {
    const index = buildWordIndex(words, listName);
    return phrase.map((word, position) => {
      const value = index.get(foldWord(word));
      if (value === undefined) throw new Error(`word ${position + 1} ${JSON.stringify(word)} is not in ${listName}`);
      return value;
    });
  }

  function bytesToBigInt(data) {
    let value = 0n;
    for (const byte of asBytes(data)) value = (value << 8n) | BigInt(byte);
    return value;
  }

  function bigIntToBytes(value, bitCount) {
    if (bitCount % 8) throw new Error("byte-oriented output requires a target divisible by 8");
    if (value < 0n || value >= (1n << BigInt(bitCount))) throw new Error(`value does not fit in the declared ${bitCount}-bit entropy size`);
    const output = new Uint8Array(bitCount / 8);
    let remaining = value;
    for (let position = output.length - 1; position >= 0; position -= 1) {
      output[position] = Number(remaining & 0xffn);
      remaining >>= 8n;
    }
    return output;
  }

  const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

  function base32Encode(data) {
    let buffer = 0;
    let bits = 0;
    let output = "";
    for (const byte of asBytes(data)) {
      buffer = (buffer << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        output += BASE32_ALPHABET[(buffer >> bits) & 31];
        buffer &= (1 << bits) - 1;
      }
    }
    if (bits) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
    return output;
  }

  function base32Decode(text) {
    const compact = String(text).replace(/\s+/g, "").replace(/=+$/, "").toUpperCase();
    if (!compact) throw new Error("encoded value is empty");
    if (![0, 2, 4, 5, 7].includes(compact.length % 8)) throw new Error("invalid base32 input length");
    let buffer = 0;
    let bits = 0;
    const output = [];
    for (const character of compact) {
      const value = BASE32_ALPHABET.indexOf(character);
      if (value < 0) throw new Error(`invalid base32 character ${JSON.stringify(character)}`);
      buffer = (buffer << 5) | value;
      bits += 5;
      if (bits >= 8) {
        bits -= 8;
        output.push((buffer >> bits) & 0xff);
        buffer &= (1 << bits) - 1;
      }
    }
    if (bits && buffer !== 0) throw new Error("invalid non-zero base32 padding bits");
    return new Uint8Array(output);
  }

  function bytesToBinaryString(data) {
    let binary = "";
    for (const byte of asBytes(data)) binary += String.fromCharCode(byte);
    return binary;
  }

  function binaryStringToBytes(text) {
    return Uint8Array.from(text, (character) => character.charCodeAt(0));
  }

  function base64Encode(data) {
    return root.btoa(bytesToBinaryString(data));
  }

  function base64UrlEncode(data) {
    return base64Encode(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function decodeBase64(text, urlSafe) {
    let compact = String(text).replace(/\s+/g, "");
    if (!compact) throw new Error("encoded value is empty");
    if (urlSafe) {
      if (!/^[A-Za-z0-9_-]+={0,2}$/.test(compact)) throw new Error("invalid base64url input");
      compact = compact.replace(/-/g, "+").replace(/_/g, "/");
    } else if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
      throw new Error("invalid base64 input");
    }
    compact = compact.replace(/=+$/, "");
    if (compact.length % 4 === 1) throw new Error("invalid base64 input length");
    compact += "=".repeat((4 - (compact.length % 4)) % 4);
    try {
      return binaryStringToBytes(root.atob(compact));
    } catch (error) {
      throw new Error(`invalid ${urlSafe ? "base64url" : "base64"} input: ${error.message || error}`);
    }
  }

  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
      table[index] = value >>> 0;
    }
    return table;
  })();

  function crc32(data) {
    let crc = 0xffffffff;
    for (const byte of asBytes(data)) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function bytewordsEncode(data, words, includeChecksum) {
    const output = Array.from(asBytes(data), (byte) => words[byte]);
    if (includeChecksum) {
      const checksum = crc32(data);
      for (const shift of [24, 16, 8, 0]) output.push(words[(checksum >>> shift) & 0xff]);
    }
    return output;
  }

  function bytewordsDecode(phrase, words, includeChecksum) {
    const indexes = phraseToIndexes(phrase, words, "Bytewords");
    const payload = Uint8Array.from(indexes);
    if (!includeChecksum) {
      if (!payload.length) throw new Error("raw Bytewords input is empty");
      return payload;
    }
    if (payload.length < 5) throw new Error("standard Bytewords requires at least one data word plus four checksum words");
    const data = payload.slice(0, -4);
    const expected = crc32(data);
    const supplied = ((payload[payload.length - 4] << 24) | (payload[payload.length - 3] << 16) | (payload[payload.length - 2] << 8) | payload[payload.length - 1]) >>> 0;
    if (expected !== supplied) throw new Error("Bytewords CRC32 checksum does not match");
    return data;
  }

  async function bip39Encode(data, words) {
    const bytes = asBytes(data);
    const entropyBits = bytes.length * 8;
    if (![128, 160, 192, 224, 256].includes(entropyBits)) throw new Error("BIP-39 requires 128, 160, 192, 224, or 256 entropy bits");
    const checksumBits = entropyBits / 32;
    const digest = new Uint8Array(await cryptoApi().subtle.digest("SHA-256", bytes));
    const checksum = digest[0] >> (8 - checksumBits);
    const combined = (bytesToBigInt(bytes) << BigInt(checksumBits)) | BigInt(checksum);
    const wordCount = (entropyBits + checksumBits) / 11;
    const output = [];
    for (let position = wordCount - 1; position >= 0; position -= 1) {
      output.push(words[Number((combined >> BigInt(position * 11)) & 0x7ffn)]);
    }
    return output;
  }

  async function bip39Decode(phrase, words) {
    const wordCount = phrase.length;
    if (![12, 15, 18, 21, 24].includes(wordCount)) throw new Error("BIP-39 requires 12, 15, 18, 21, or 24 words");
    const indexes = phraseToIndexes(phrase, words, "BIP-39 English");
    let combined = 0n;
    for (const index of indexes) combined = (combined << 11n) | BigInt(index);
    const totalBits = wordCount * 11;
    const entropyBits = Math.floor(totalBits * 32 / 33);
    const checksumBits = entropyBits / 32;
    const checksumMask = (1n << BigInt(checksumBits)) - 1n;
    const suppliedChecksum = Number(combined & checksumMask);
    const data = bigIntToBytes(combined >> BigInt(checksumBits), entropyBits);
    const digest = new Uint8Array(await cryptoApi().subtle.digest("SHA-256", data));
    const expectedChecksum = digest[0] >> (8 - checksumBits);
    if (suppliedChecksum !== expectedChecksum) throw new Error("BIP-39 checksum does not match");
    return data;
  }

  function pgpEncode(data, evenWords, oddWords) {
    return Array.from(asBytes(data), (byte, position) => (position % 2 === 0 ? evenWords : oddWords)[byte]);
  }

  function pgpDecode(phrase, evenWords, oddWords) {
    if (!phrase.length) throw new Error("PGP word input is empty");
    const evenIndex = buildWordIndex(evenWords, "PGP even table");
    const oddIndex = buildWordIndex(oddWords, "PGP odd table");
    return Uint8Array.from(phrase.map((word, position) => {
      const index = (position % 2 === 0 ? evenIndex : oddIndex).get(foldWord(word));
      if (index === undefined) throw new Error(`word ${position + 1} ${JSON.stringify(word)} is not in the expected PGP ${position % 2 === 0 ? "even" : "odd"} table`);
      return index;
    }));
  }

  function minimumWordCount(radix, bitCount) {
    const required = 1n << BigInt(bitCount);
    const base = BigInt(radix);
    let capacity = 1n;
    let count = 0;
    while (capacity < required) {
      capacity *= base;
      count += 1;
    }
    return { count, capacity };
  }

  function genericWordEncode(data, bitCount, words) {
    const bytes = asBytes(data);
    if (bytes.length * 8 !== bitCount) throw new Error(`secret buffer contains ${bytes.length * 8} bits, not ${bitCount}`);
    const value = bytesToBigInt(bytes);
    const radix = BigInt(words.length);
    const { count, capacity } = minimumWordCount(words.length, bitCount);
    const indexes = new Array(count).fill(0);
    let remainder = value;
    for (let position = count - 1; position >= 0; position -= 1) {
      indexes[position] = Number(remainder % radix);
      remainder /= radix;
    }
    if (remainder) throw new Error("generic word encoding capacity calculation failed");
    return { words: indexes.map((index) => words[index]), indexes, capacity };
  }

  function genericWordDecode(phrase, bitCount, words, listName) {
    const { count } = minimumWordCount(words.length, bitCount);
    if (phrase.length !== count) throw new Error(`${listName} requires exactly ${count} words for ${bitCount} bits; received ${phrase.length}`);
    const indexes = phraseToIndexes(phrase, words, listName);
    let value = 0n;
    const radix = BigInt(words.length);
    for (const index of indexes) value = value * radix + BigInt(index);
    if (value >= (1n << BigInt(bitCount))) throw new Error(`this ${listName} phrase is in the unused portion of the fixed-length phrase space for ${bitCount} bits`);
    return bigIntToBytes(value, bitCount);
  }

  function verifyTargetBits(data, targetBits) {
    if (targetBits != null && asBytes(data).length * 8 !== Number(targetBits)) {
      throw new Error(`decoded phrase contains ${asBytes(data).length * 8} entropy bits, not the requested ${targetBits}`);
    }
    return data;
  }

  async function encode(format, data, options = {}) {
    const bytes = asBytes(data);
    const bitCount = options.targetBits == null ? bytes.length * 8 : Number(options.targetBits);
    if (bytes.length * 8 !== bitCount) throw new Error(`secret buffer contains ${bytes.length * 8} bits, not ${bitCount}`);
    if (format === "hex") return bytesToHex(bytes);
    if (format === "base32") return base32Encode(bytes);
    if (format === "base64url") return base64UrlEncode(bytes);
    if (format === "base64") return base64Encode(bytes);
    if (format === "bytewords" || format === "bytewords-raw") {
      const words = await loadWordList("bytewords.txt", options);
      return bytewordsEncode(bytes, words, format === "bytewords").join(" ");
    }
    if (format === "bip39") {
      const words = await loadWordList("bip39_english.txt", options);
      return (await bip39Encode(bytes, words)).join(" ");
    }
    if (format === "pgp") {
      const [evenWords, oddWords] = await Promise.all([
        loadWordList("pgp-even.txt", options), loadWordList("pgp-odd.txt", options),
      ]);
      return pgpEncode(bytes, evenWords, oddWords).join(" ");
    }
    const spec = GENERIC_WORD_LISTS[format];
    if (!spec) throw new Error(`unsupported encoding ${format}`);
    const words = await loadWordList(spec.filename, options);
    return genericWordEncode(bytes, bitCount, words).words.join(" ");
  }

  async function decode(format, text, options = {}) {
    const targetBits = options.targetBits == null ? null : Number(options.targetBits);
    if (format === "hex") return verifyTargetBits(hexToBytes(text), targetBits);
    if (format === "base32") return verifyTargetBits(base32Decode(text), targetBits);
    if (format === "base64url") return verifyTargetBits(decodeBase64(text, true), targetBits);
    if (format === "base64") return verifyTargetBits(decodeBase64(text, false), targetBits);
    const phrase = splitPhrase(text);
    if (format === "bytewords" || format === "bytewords-raw") {
      const words = await loadWordList("bytewords.txt", options);
      return verifyTargetBits(bytewordsDecode(phrase, words, format === "bytewords"), targetBits);
    }
    if (format === "bip39") {
      const words = await loadWordList("bip39_english.txt", options);
      return verifyTargetBits(await bip39Decode(phrase, words), targetBits);
    }
    if (format === "pgp") {
      const [evenWords, oddWords] = await Promise.all([
        loadWordList("pgp-even.txt", options), loadWordList("pgp-odd.txt", options),
      ]);
      return verifyTargetBits(pgpDecode(phrase, evenWords, oddWords), targetBits);
    }
    const spec = GENERIC_WORD_LISTS[format];
    if (!spec) throw new Error(`unsupported encoding ${format}`);
    if (targetBits == null) throw new Error(`target bits are required to decode the generic ${format} format`);
    const words = await loadWordList(spec.filename, options);
    return genericWordDecode(phrase, targetBits, words, format);
  }

  async function encodeMany(formats, data, options = {}) {
    const rows = {};
    await Promise.all(formats.map(async (format) => { rows[format] = await encode(format, data, options); }));
    return rows;
  }

  function bytesToBits(data) {
    return Array.from(asBytes(data), (byte) => byte.toString(2).padStart(8, "0")).join("");
  }

  function clearWordListCache() {
    wordListCache.clear();
  }

  return Object.freeze({
    PINNED_WORD_LISTS,
    GENERIC_WORD_LISTS,
    FORMAT_LABELS,
    FORMAT_ORDER,
    bytesToHex,
    hexToBytes,
    formatHex,
    bytesToBits,
    base32Encode,
    base32Decode,
    base64Encode,
    base64UrlEncode,
    parseWordList,
    installWordList,
    loadWordList,
    minimumWordCount,
    genericWordEncode,
    genericWordDecode,
    encode,
    decode,
    encodeMany,
    clearWordListCache,
  });
});
