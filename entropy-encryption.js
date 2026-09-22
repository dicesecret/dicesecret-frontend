(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RollEntropyEncryption = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PRODUCT_NAME = "DiceSecret";
  const ENCRYPTED_KIT_FORMAT = "rollentropy-encrypted-recovery-kit-v1";
  const ENCRYPTED_KIT_VERSION = 1;
  const ENCRYPTED_QR_PREFIX = "RE1E";
  const KDF_CODE = "p6";
  const KDF_ALGORITHM = "PBKDF2-HMAC-SHA-256";
  const KDF_ITERATIONS = 600000;
  const CIPHER_CODE = "a1";
  const CIPHER_ALGORITHM = "AES-256-GCM";
  const SALT_BYTES = 16;
  const NONCE_BYTES = 12;
  const TAG_BITS = 128;
  const CORE_VERSION = 1;
  const ENVELOPE_BINARY_VERSION = 1;
  const ENVELOPE_MAGIC = Object.freeze([0x52, 0x45, 0x31, 0x45]); // ASCII RE1E
  const ENVELOPE_KDF_ID = 1;
  const ENVELOPE_CIPHER_ID = 1;
  const DEFAULT_ENCRYPTED_REPRESENTATION_FORMATS = Object.freeze([
    "hex", "base32", "bytewords", "pgp", "orchard-medium",
  ]);
  const AAD_TEXT = `${ENCRYPTED_QR_PREFIX}|v=${ENCRYPTED_KIT_VERSION}|k=${KDF_CODE}|a=${CIPHER_CODE}`;

  function utf8(text) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(String(text));
    return Uint8Array.from(Buffer.from(String(text), "utf8"));
  }

  function bytesToBase64url(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (typeof Buffer !== "undefined") return Buffer.from(data).toString("base64url");
    let binary = "";
    for (const value of data) binary += String.fromCharCode(value);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function base64urlToBytes(text) {
    const value = String(text || "");
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url recovery field");
    if (typeof Buffer !== "undefined") return Uint8Array.from(Buffer.from(value, "base64url"));
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }

  function cryptoProvider(options = {}) {
    const provider = options.crypto || (typeof globalThis !== "undefined" ? globalThis.crypto : null);
    if (!provider || !provider.subtle || typeof provider.getRandomValues !== "function") {
      throw new Error("browser cryptography is unavailable");
    }
    return provider;
  }

  function validatePassphrase(passphrase) {
    const value = String(passphrase ?? "");
    if (!value.length) throw new Error("enter a recovery passphrase");
    return value;
  }

  function randomBytes(length, provider, supplied) {
    if (supplied != null) {
      const value = supplied instanceof Uint8Array ? Uint8Array.from(supplied) : new Uint8Array(supplied);
      if (value.length !== length) throw new Error(`expected ${length} deterministic random bytes`);
      return value;
    }
    const value = new Uint8Array(length);
    provider.getRandomValues(value);
    return value;
  }

  async function deriveAesKey(passphrase, salt, provider) {
    const passwordBytes = utf8(validatePassphrase(passphrase));
    let keyBits = null;
    try {
      const material = await provider.subtle.importKey("raw", passwordBytes, "PBKDF2", false, ["deriveBits"]);
      const derived = await provider.subtle.deriveBits({
        name: "PBKDF2",
        hash: "SHA-256",
        salt,
        iterations: KDF_ITERATIONS,
      }, material, 256);
      keyBits = new Uint8Array(derived);
      return await provider.subtle.importKey("raw", keyBits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    } finally {
      passwordBytes.fill(0);
      if (keyBits) keyBits.fill(0);
    }
  }

  function coreFromKit(kit, recovery, codec) {
    if (!kit || kit.format !== recovery.KIT_FORMAT || Number(kit.version) !== recovery.KIT_VERSION) {
      throw new Error("encryption requires a normalized RollEntropy recovery kit v1");
    }
    const targetBytes = Number(kit.target_bits) / 8;
    if (!Number.isInteger(targetBytes) || targetBytes < 1 || targetBytes > 255) throw new Error("unsupported encrypted target size");
    const finalBytes = codec.hexToBytes(kit.final_hex);
    if (finalBytes.length !== targetBytes) throw new Error("recovery-kit final byte count does not match target bits");
    const mask = recovery.representationMask(kit.representation_formats, codec) >>> 0;
    const flags = (kit.secret_mode === "private-browser-mix" ? 1 : 0) | (kit.extraction?.mode === "hash" ? 2 : 0);
    const core = new Uint8Array(7 + targetBytes);
    core[0] = CORE_VERSION;
    core[1] = targetBytes;
    core[2] = flags;
    core[3] = (mask >>> 24) & 0xff;
    core[4] = (mask >>> 16) & 0xff;
    core[5] = (mask >>> 8) & 0xff;
    core[6] = mask & 0xff;
    core.set(finalBytes, 7);
    finalBytes.fill(0);
    return core;
  }

  async function kitFromCore(core, recovery, codec) {
    const data = core instanceof Uint8Array ? core : new Uint8Array(core);
    if (data.length < 8 || data[0] !== CORE_VERSION) throw new Error("unsupported encrypted recovery core version");
    const targetBytes = data[1];
    if (data.length !== 7 + targetBytes) throw new Error("encrypted recovery core length is invalid");
    const flags = data[2];
    if (flags & ~0x03) throw new Error("encrypted recovery core contains unsupported flags");
    const mask = (((data[3] << 24) >>> 0) | (data[4] << 16) | (data[5] << 8) | data[6]) >>> 0;
    const formats = recovery.formatsFromMask(mask.toString(16), codec);
    const finalBytes = data.slice(7);
    try {
      return await recovery.buildKit({
        progress: { target_bits: targetBytes * 8, mode: (flags & 2) ? "hash" : "exact" },
        secretMode: (flags & 1) ? "private-browser-mix" : "dice-only",
        finalBytes,
        representationFormats: formats,
      }, codec);
    } finally {
      finalBytes.fill(0);
    }
  }

  function buildEncryptedQrPayload({ salt, nonce, ciphertext }) {
    return `${ENCRYPTED_QR_PREFIX}|k=${KDF_CODE}|a=${CIPHER_CODE}|s=${bytesToBase64url(salt)}|n=${bytesToBase64url(nonce)}|c=${bytesToBase64url(ciphertext)}`;
  }

  function parseEncryptedQrPayload(text) {
    const parts = String(text).trim().split("|");
    if (parts.shift() !== ENCRYPTED_QR_PREFIX) throw new Error("not a RollEntropy encrypted recovery payload");
    const fields = new Map();
    for (const part of parts) {
      const separator = part.indexOf("=");
      if (separator <= 0) throw new Error("malformed encrypted recovery field");
      const key = part.slice(0, separator);
      const value = part.slice(separator + 1);
      if (fields.has(key)) throw new Error(`duplicate encrypted recovery field ${key}`);
      fields.set(key, value);
    }
    for (const key of ["k", "a", "s", "n", "c"]) if (!fields.has(key)) throw new Error(`encrypted recovery payload is missing ${key}`);
    for (const key of fields.keys()) if (!["k", "a", "s", "n", "c"].includes(key)) throw new Error(`unknown encrypted recovery field ${key}`);
    if (fields.get("k") !== KDF_CODE) throw new Error("unsupported encrypted recovery KDF");
    if (fields.get("a") !== CIPHER_CODE) throw new Error("unsupported encrypted recovery cipher");
    const salt = base64urlToBytes(fields.get("s"));
    const nonce = base64urlToBytes(fields.get("n"));
    const ciphertext = base64urlToBytes(fields.get("c"));
    if (salt.length !== SALT_BYTES) throw new Error("encrypted recovery salt has the wrong size");
    if (nonce.length !== NONCE_BYTES) throw new Error("encrypted recovery nonce has the wrong size");
    if (ciphertext.length < 16 + 8) throw new Error("encrypted recovery ciphertext is too short");
    return { salt, nonce, ciphertext };
  }

  function cleanMetadataText(value, maxLength) {
    const text = String(value ?? "").replace(/\r\n?/g, "\n").trim();
    return text.length > maxLength ? text.slice(0, maxLength) : text;
  }

  function normalizeMetadata(value) {
    if (value == null) return null;
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("encrypted recovery metadata must be an object");
    return Object.freeze({
      document_id: cleanMetadataText(value.document_id, 32),
      label: cleanMetadataText(value.label, 160),
      note: cleanMetadataText(value.note, 4000),
      derived_at: cleanMetadataText(value.derived_at, 64),
      derived_local: cleanMetadataText(value.derived_local, 160),
      timezone: cleanMetadataText(value.timezone, 120),
    });
  }

  function canonicalEncryptedKit(envelope, metadata = null) {
    const qrPayload = buildEncryptedQrPayload(envelope);
    return Object.freeze({
      product: PRODUCT_NAME,
      format: ENCRYPTED_KIT_FORMAT,
      version: ENCRYPTED_KIT_VERSION,
      kdf: Object.freeze({ algorithm: KDF_ALGORITHM, iterations: KDF_ITERATIONS, salt_b64url: bytesToBase64url(envelope.salt) }),
      cipher: Object.freeze({ algorithm: CIPHER_ALGORITHM, nonce_b64url: bytesToBase64url(envelope.nonce), tag_bits: TAG_BITS }),
      ciphertext_b64url: bytesToBase64url(envelope.ciphertext),
      qr_payload: qrPayload,
      metadata: normalizeMetadata(metadata),
    });
  }

  function encryptedEnvelopeBytes(value) {
    const normalized = normalizeEncryptedKit(value);
    const salt = base64urlToBytes(normalized.kdf.salt_b64url);
    const nonce = base64urlToBytes(normalized.cipher.nonce_b64url);
    const ciphertext = base64urlToBytes(normalized.ciphertext_b64url);
    try {
      if (ciphertext.length > 0xffff) throw new Error("encrypted recovery envelope is too large");
      const headerBytes = 11;
      const output = new Uint8Array(headerBytes + salt.length + nonce.length + ciphertext.length);
      output.set(ENVELOPE_MAGIC, 0);
      output[4] = ENVELOPE_BINARY_VERSION;
      output[5] = ENVELOPE_KDF_ID;
      output[6] = ENVELOPE_CIPHER_ID;
      output[7] = salt.length;
      output[8] = nonce.length;
      output[9] = (ciphertext.length >>> 8) & 0xff;
      output[10] = ciphertext.length & 0xff;
      output.set(salt, headerBytes);
      output.set(nonce, headerBytes + salt.length);
      output.set(ciphertext, headerBytes + salt.length + nonce.length);
      return output;
    } finally {
      salt.fill(0);
      nonce.fill(0);
      ciphertext.fill(0);
    }
  }

  function encryptedKitFromEnvelopeBytes(value) {
    const data = value instanceof Uint8Array ? value : new Uint8Array(value);
    const headerBytes = 11;
    if (data.length < headerBytes + SALT_BYTES + NONCE_BYTES + 16) throw new Error("encrypted envelope bytes are too short");
    for (let index = 0; index < ENVELOPE_MAGIC.length; index += 1) {
      if (data[index] !== ENVELOPE_MAGIC[index]) throw new Error("not a RollEntropy encrypted envelope");
    }
    if (data[4] !== ENVELOPE_BINARY_VERSION) throw new Error("unsupported encrypted envelope binary version");
    if (data[5] !== ENVELOPE_KDF_ID) throw new Error("unsupported encrypted envelope KDF identifier");
    if (data[6] !== ENVELOPE_CIPHER_ID) throw new Error("unsupported encrypted envelope cipher identifier");
    const saltLength = data[7];
    const nonceLength = data[8];
    const ciphertextLength = (data[9] << 8) | data[10];
    if (saltLength !== SALT_BYTES) throw new Error("encrypted envelope salt has the wrong size");
    if (nonceLength !== NONCE_BYTES) throw new Error("encrypted envelope nonce has the wrong size");
    if (ciphertextLength < 24) throw new Error("encrypted envelope ciphertext is too short");
    const expectedLength = headerBytes + saltLength + nonceLength + ciphertextLength;
    if (data.length !== expectedLength) throw new Error(`encrypted envelope contains ${data.length} bytes; expected ${expectedLength}`);
    const salt = data.slice(headerBytes, headerBytes + saltLength);
    const nonce = data.slice(headerBytes + saltLength, headerBytes + saltLength + nonceLength);
    const ciphertext = data.slice(headerBytes + saltLength + nonceLength);
    try {
      return canonicalEncryptedKit({ salt, nonce, ciphertext });
    } finally {
      salt.fill(0);
      nonce.fill(0);
      ciphertext.fill(0);
    }
  }

  function validateEncryptedRepresentationFormats(formats, codec) {
    const selected = Array.from(new Set(formats || []));
    if (!selected.length) throw new Error("select at least one encrypted-envelope representation");
    for (const format of selected) {
      if (!codec.FORMAT_ORDER.includes(format)) throw new Error(`unsupported encrypted-envelope encoding ${format}`);
      if (format === "bip39") {
        throw new Error("BIP-39 is not available for the encrypted envelope because BIP-39 only accepts 128, 160, 192, 224, or 256 entropy bits");
      }
    }
    return selected;
  }

  async function buildEncryptedRepresentations(encryptedKit, formats, codec, options = {}) {
    const selected = validateEncryptedRepresentationFormats(formats, codec);
    const bytes = encryptedEnvelopeBytes(encryptedKit);
    try {
      const targetBits = bytes.length * 8;
      const codecOptions = { targetBits };
      if (options.baseUrl != null) codecOptions.baseUrl = options.baseUrl;
      if (options.fetchImpl != null) codecOptions.fetchImpl = options.fetchImpl;
      const representations = await codec.encodeMany(selected, bytes, codecOptions);
      const provider = cryptoProvider(options);
      const digest = new Uint8Array(await provider.subtle.digest("SHA-256", bytes));
      try {
        const fingerprint = codec.bytesToHex(digest);
        return Object.freeze({
          format: "rollentropy-encrypted-envelope-representations-v1",
          version: 1,
          byte_length: bytes.length,
          target_bits: targetBits,
          representation_formats: Object.freeze(selected.slice()),
          representation_labels: Object.freeze(Object.fromEntries(selected.map((format) => [format, codec.FORMAT_LABELS[format] || format]))),
          representations: Object.freeze({ ...representations }),
          fingerprint_sha256: fingerprint,
          fingerprint_short: fingerprint.slice(0, 16),
        });
      } finally {
        digest.fill(0);
      }
    } finally {
      bytes.fill(0);
    }
  }

  async function importEncryptedRepresentation(format, text, targetBits, passphrase, recovery, codec, options = {}) {
    validateEncryptedRepresentationFormats([format], codec);
    const bits = Number(targetBits);
    if (!Number.isInteger(bits) || bits <= 0 || bits % 8) throw new Error("encrypted-envelope bits must be a positive multiple of 8");
    const codecOptions = { targetBits: bits };
    if (options.baseUrl != null) codecOptions.baseUrl = options.baseUrl;
    if (options.fetchImpl != null) codecOptions.fetchImpl = options.fetchImpl;
    const bytes = await codec.decode(format, text, codecOptions);
    try {
      const encryptedKit = encryptedKitFromEnvelopeBytes(bytes);
      return await decryptEnvelope(encryptedKit, passphrase, recovery, codec, options);
    } finally {
      bytes.fill(0);
    }
  }

  async function encryptKit(kit, passphrase, recovery, codec, options = {}) {
    const provider = cryptoProvider(options);
    const salt = randomBytes(SALT_BYTES, provider, options.salt);
    const nonce = randomBytes(NONCE_BYTES, provider, options.nonce);
    const core = coreFromKit(kit, recovery, codec);
    let encrypted = null;
    try {
      const key = await deriveAesKey(passphrase, salt, provider);
      encrypted = new Uint8Array(await provider.subtle.encrypt({
        name: "AES-GCM",
        iv: nonce,
        additionalData: utf8(AAD_TEXT),
        tagLength: TAG_BITS,
      }, key, core));
      return canonicalEncryptedKit({ salt, nonce, ciphertext: encrypted }, kit.metadata);
    } finally {
      core.fill(0);
      if (encrypted) encrypted.fill(0);
      salt.fill(0);
      nonce.fill(0);
    }
  }

  function normalizeEncryptedKit(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("encrypted recovery kit must be a JSON object");
    if (value.format !== ENCRYPTED_KIT_FORMAT || Number(value.version) !== ENCRYPTED_KIT_VERSION) throw new Error("unsupported encrypted recovery-kit version");
    if (value.kdf?.algorithm !== KDF_ALGORITHM || Number(value.kdf?.iterations) !== KDF_ITERATIONS) throw new Error("unsupported encrypted recovery-kit KDF parameters");
    if (value.cipher?.algorithm !== CIPHER_ALGORITHM || Number(value.cipher?.tag_bits) !== TAG_BITS) throw new Error("unsupported encrypted recovery-kit cipher parameters");
    const envelope = {
      salt: base64urlToBytes(value.kdf.salt_b64url),
      nonce: base64urlToBytes(value.cipher.nonce_b64url),
      ciphertext: base64urlToBytes(value.ciphertext_b64url),
    };
    const canonical = canonicalEncryptedKit(envelope, value.metadata);
    if (value.qr_payload != null && String(value.qr_payload) !== canonical.qr_payload) throw new Error("encrypted recovery-kit QR payload does not match its ciphertext or parameters");
    return canonical;
  }

  async function decryptEnvelope(envelope, passphrase, recovery, codec, options = {}) {
    const provider = cryptoProvider(options);
    const normalized = normalizeEncryptedKit(envelope);
    const parsed = parseEncryptedQrPayload(normalized.qr_payload);
    let plaintext = null;
    try {
      const key = await deriveAesKey(passphrase, parsed.salt, provider);
      try {
        plaintext = new Uint8Array(await provider.subtle.decrypt({
          name: "AES-GCM",
          iv: parsed.nonce,
          additionalData: utf8(AAD_TEXT),
          tagLength: TAG_BITS,
        }, key, parsed.ciphertext));
      } catch (error) {
        throw new Error("Wrong passphrase or encrypted recovery data was modified.");
      }
      const kit = await kitFromCore(plaintext, recovery, codec);
      if (!normalized.metadata) return kit;
      return Object.freeze({ ...kit, metadata: normalized.metadata });
    } finally {
      parsed.salt.fill(0);
      parsed.nonce.fill(0);
      parsed.ciphertext.fill(0);
      if (plaintext) plaintext.fill(0);
    }
  }

  async function importEncryptedText(text, passphrase, recovery, codec, options = {}) {
    const trimmed = String(text).trim();
    if (!trimmed) throw new Error("encrypted recovery input is empty");
    let envelope;
    if (trimmed.startsWith(`${ENCRYPTED_QR_PREFIX}|`)) {
      const parsed = parseEncryptedQrPayload(trimmed);
      envelope = canonicalEncryptedKit(parsed);
      parsed.salt.fill(0);
      parsed.nonce.fill(0);
      parsed.ciphertext.fill(0);
    } else {
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (error) {
        throw new Error(`encrypted recovery input is neither ${ENCRYPTED_QR_PREFIX} payload text nor valid JSON: ${error.message || error}`);
      }
      envelope = normalizeEncryptedKit(parsed);
    }
    return decryptEnvelope(envelope, passphrase, recovery, codec, options);
  }

  function serializeEncryptedKit(kit) {
    return `${JSON.stringify(kit, null, 2)}\n`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  function validateQrSvg(svg) {
    const text = String(svg || "").trim();
    if (!/^<svg\s[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"[\s\S]*<\/svg>$/.test(text)) throw new Error("encrypted printable sheet requires a local SVG QR code");
    if (/<script\b|<foreignObject\b|\b(?:href|xlink:href)\s*=|\bon[a-z]+\s*=/i.test(text)) throw new Error("encrypted printable QR contains disallowed active or external content");
    return text;
  }

  function metadataDisplay(metadata) {
    const item = normalizeMetadata(metadata) || Object.freeze({
      document_id: "", label: "", note: "", derived_at: "", derived_local: "", timezone: "",
    });
    const parts = ["DiceSecret"];
    if (item.label) parts.push(item.label);
    if (item.derived_local) parts.push(item.derived_local);
    return { item, identity: parts.join(" - ") };
  }

  function buildEncryptedPrintableSheetHtml({ encryptedKit, qrSvg }) {
    const normalized = normalizeEncryptedKit(encryptedKit);
    const safeQrSvg = validateQrSvg(qrSvg);
    const { item: metadata, identity } = metadataDisplay(normalized.metadata);
    const documentId = escapeHtml(metadata.document_id || "DiceSecret");
    const metadataRows = [
      metadata.label ? `<div><b>Name / label</b><br>${escapeHtml(metadata.label)}</div>` : "",
      metadata.derived_local ? `<div><b>Derived</b><br>${escapeHtml(metadata.derived_local)}</div>` : "",
      metadata.derived_at ? `<div><b>UTC timestamp</b><br><code>${escapeHtml(metadata.derived_at)}</code></div>` : "",
      metadata.document_id ? `<div><b>Document ID</b><br><code>${escapeHtml(metadata.document_id)}</code></div>` : "",
    ].join("");
    const note = metadata.note ? `<section class="note"><h2>Note</h2><div>${escapeHtml(metadata.note)}</div></section>` : "";
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DiceSecret encrypted recovery sheet</title>
<style>
@page{size:auto;margin:0}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{color:#111;background:#fff;font:13px/1.35 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:850px;margin:0 auto;padding:24px}
h1{font-size:26px;line-height:1.1;margin:0 0 3px}
h2{font-size:17px;margin:12px 0 6px;break-after:avoid}
h3{font-size:13px;margin:8px 0 4px}
p{margin:6px 0}
.warning{border:2px solid #111;padding:9px 11px;margin:10px 0;font-weight:600}
.meta{display:grid;grid-template-columns:1fr 1fr;gap:5px 16px;margin:8px 0}
.meta div{border-bottom:1px solid #ddd;padding:3px 0}
.note{border:1px solid #bbb;padding:7px 9px;margin:8px 0;break-inside:avoid}
.note h2{font-size:14px;margin:0 0 3px}
.note div{white-space:pre-wrap;overflow-wrap:anywhere}
.qr{width:245px;max-width:62vw;margin:8px auto}
.qr svg{display:block;width:100%;height:auto;shape-rendering:crispEdges}
.payload{font:10px/1.3 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere;border:1px solid #bbb;padding:6px}
.line{height:22px;border-bottom:1px solid #777}
.small{font-size:10.5px;line-height:1.3;color:#333;margin:5px 0}
.printIdentity,.printPageFooter{display:none}
@media print{
  body{font-size:10.5px;line-height:1.25}
  main{max-width:none;margin:0;padding:15mm 10mm 13mm}
  h1{font-size:21px;margin-bottom:2px}
  h2{font-size:13.5px;margin:5px 0 3px}
  h3{font-size:11px;margin:4px 0 2px}
  p{margin:3px 0}
  .warning{padding:6px 8px;margin:6px 0;border-width:1.5px}
  .meta{gap:2px 12px;margin:5px 0}
  .meta div{padding:2px 0}
  .note{padding:5px 7px;margin:5px 0}
  .note h2{font-size:11px;margin:0 0 2px}
  .qr{width:48mm;margin:3mm auto 2mm}
  .payload{font-size:7.5px;line-height:1.15;padding:4px}
  .line{height:13px}
  .small{font-size:8.5px;line-height:1.2;margin:3px 0}
  .printIdentity,.printPageFooter{display:flex;position:fixed;left:10mm;right:10mm;justify-content:space-between;gap:10px;font-size:8px;color:#444}
  .printIdentity{top:4mm;padding-bottom:1.5mm;border-bottom:1px solid #999}
  .printPageFooter{bottom:4mm;padding-top:1.5mm;border-top:1px solid #999}
}
</style>
</head>
<body>
<div class="printIdentity"><span>${escapeHtml(identity)}</span><span>${documentId}</span></div>
<div class="printPageFooter"><span>Encrypted recovery sheet</span><span>${documentId}</span></div>
<main>
<h1>DiceSecret encrypted recovery sheet</h1>
<p>Encrypted recovery kit format v1</p>
<div class="warning">This sheet contains an encrypted copy of the final secret. A strong passphrase is required to recover it. Anyone with this sheet can attempt offline passphrase guesses.</div>
<div class="meta">${metadataRows}<div><b>KDF</b><br>${escapeHtml(KDF_ALGORITHM)}</div><div><b>Iterations</b><br>${KDF_ITERATIONS.toLocaleString("en-US")}</div><div><b>Cipher</b><br>${escapeHtml(CIPHER_ALGORITHM)}</div><div><b>Authentication tag</b><br>${TAG_BITS} bits</div></div>
${note}
<h2>Encrypted recovery QR</h2>
<div class="qr">${safeQrSvg}</div>
<h3>Canonical RE1E payload</h3>
<div class="payload">${escapeHtml(normalized.qr_payload)}</div>
<h2>Handwritten notes</h2>
<div class="line"></div><div class="line"></div>
<p class="small"><b>Passphrase is intentionally not included.</b> Store it separately. A short PIN can be brute-forced offline. Decryption happens locally in the DiceSecret browser tool.</p>
<p class="small">The encrypted QR or encrypted kit file is the intended machine-recovery form. The RE1E text is an exact fallback, not a practical handwritten secret representation.</p>
<p class="small">Printing or saving this page may leave copies in a PDF file, operating-system print spool, printer memory, backups, or other storage outside this browser.</p>
</main>
</body>
</html>`;
  }

  function isEncryptedText(text) {
    const trimmed = String(text || "").trim();
    if (trimmed.startsWith(`${ENCRYPTED_QR_PREFIX}|`)) return true;
    if (!trimmed.startsWith("{")) return false;
    try { return JSON.parse(trimmed)?.format === ENCRYPTED_KIT_FORMAT; } catch (error) { return false; }
  }

  return Object.freeze({
    PRODUCT_NAME,
    ENCRYPTED_KIT_FORMAT,
    ENCRYPTED_KIT_VERSION,
    ENCRYPTED_QR_PREFIX,
    KDF_CODE,
    KDF_ALGORITHM,
    KDF_ITERATIONS,
    CIPHER_CODE,
    CIPHER_ALGORITHM,
    SALT_BYTES,
    NONCE_BYTES,
    TAG_BITS,
    ENVELOPE_BINARY_VERSION,
    DEFAULT_ENCRYPTED_REPRESENTATION_FORMATS,
    AAD_TEXT,
    bytesToBase64url,
    base64urlToBytes,
    buildEncryptedQrPayload,
    parseEncryptedQrPayload,
    encryptedEnvelopeBytes,
    encryptedKitFromEnvelopeBytes,
    buildEncryptedRepresentations,
    importEncryptedRepresentation,
    encryptKit,
    normalizeEncryptedKit,
    decryptEnvelope,
    importEncryptedText,
    serializeEncryptedKit,
    buildEncryptedPrintableSheetHtml,
    isEncryptedText,
  });
});
