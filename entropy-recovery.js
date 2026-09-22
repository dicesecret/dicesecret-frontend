(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RollEntropyRecovery = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PRODUCT_NAME = "DiceSecret";
  const KIT_FORMAT = "rollentropy-recovery-kit-v1";
  const KIT_VERSION = 1;
  const QR_PREFIX = "RE1";
  const HASH_ALGORITHM = "SHAKE256";
  const HASH_PROTOCOL = "RollEntropy fixed-roll hash v1";
  const EXACT_PROTOCOL = "RollEntropy exact-uniform v1";
  const DOCUMENT_ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

  function validateTargetBits(value) {
    const bits = Number(value);
    if (!Number.isInteger(bits) || bits < 8 || bits % 8 !== 0) throw new Error("target bits must be a positive whole-byte size");
    return bits;
  }

  function validateSecretMode(value) {
    if (value !== "private-browser-mix" && value !== "dice-only") throw new Error(`unsupported secret mode ${value}`);
    return value;
  }

  function validateExtractionMode(value) {
    if (value !== "exact" && value !== "hash") throw new Error(`unsupported extraction mode ${value}`);
    return value;
  }

  function normalizeFormats(formats, codec) {
    if (!codec || !Array.isArray(codec.FORMAT_ORDER)) throw new Error("browser entropy codec is unavailable");
    const requested = new Set(Array.from(formats || [], String));
    for (const format of requested) if (!codec.FORMAT_ORDER.includes(format)) throw new Error(`unsupported recovery representation ${format}`);
    return codec.FORMAT_ORDER.filter((format) => requested.has(format));
  }

  function representationMask(formats, codec) {
    const normalized = normalizeFormats(formats, codec);
    let mask = 0;
    for (const format of normalized) mask |= 1 << codec.FORMAT_ORDER.indexOf(format);
    return mask >>> 0;
  }

  function formatsFromMask(maskText, codec) {
    if (!/^[0-9a-fA-F]{1,8}$/.test(String(maskText))) throw new Error("invalid recovery representation mask");
    const mask = Number.parseInt(maskText, 16) >>> 0;
    if (codec.FORMAT_ORDER.length < 32 && (mask >>> codec.FORMAT_ORDER.length) !== 0) {
      throw new Error("recovery payload selects an unknown representation bit");
    }
    return codec.FORMAT_ORDER.filter((_, index) => ((mask >>> index) & 1) === 1);
  }

  function secretCode(mode) {
    return mode === "private-browser-mix" ? "p" : "d";
  }

  function secretModeFromCode(code) {
    if (code === "p") return "private-browser-mix";
    if (code === "d") return "dice-only";
    throw new Error(`unsupported recovery secret-mode code ${code}`);
  }

  function extractionCode(mode) {
    return mode === "exact" ? "x" : "h1";
  }

  function extractionModeFromCode(code) {
    if (code === "x") return "exact";
    if (code === "h1") return "hash";
    throw new Error(`unsupported recovery extraction code ${code}`);
  }

  function cleanMetadataText(value, maxLength, field) {
    const text = String(value ?? "").replace(/\r\n?/g, "\n").trim();
    if (text.length > maxLength) throw new Error(`recovery metadata ${field} is too long`);
    return text;
  }

  function normalizeMetadata(value) {
    if (value == null) return null;
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("recovery metadata must be an object");
    const documentId = cleanMetadataText(value.document_id, 32, "document ID");
    if (documentId && !/^(?:DS|RE)-[23456789A-HJ-NP-Z]{4}-[23456789A-HJ-NP-Z]{4}$/.test(documentId)) {
      throw new Error("recovery metadata document ID is invalid");
    }
    const derivedAt = cleanMetadataText(value.derived_at, 64, "derived timestamp");
    if (derivedAt && !Number.isFinite(Date.parse(derivedAt))) throw new Error("recovery metadata derived timestamp is invalid");
    return Object.freeze({
      document_id: documentId,
      label: cleanMetadataText(value.label, 160, "label"),
      note: cleanMetadataText(value.note, 4000, "note"),
      derived_at: derivedAt,
      derived_local: cleanMetadataText(value.derived_local, 160, "local derived time"),
      timezone: cleanMetadataText(value.timezone, 120, "timezone"),
    });
  }

  function documentIdFromBytes(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || []);
    if (bytes.length !== 5) throw new Error("DiceSecret document ID requires exactly 5 random bytes");
    let number = 0n;
    for (const byte of bytes) number = (number << 8n) | BigInt(byte);
    let code = "";
    for (let index = 0; index < 8; index += 1) {
      code = DOCUMENT_ID_ALPHABET[Number(number & 31n)] + code;
      number >>= 5n;
    }
    return `DS-${code.slice(0, 4)}-${code.slice(4)}`;
  }

  function buildQrPayload({ targetBits, secretMode, extractionMode, finalBytes, representationFormats }, codec) {
    const bits = validateTargetBits(targetBits);
    const mode = validateSecretMode(secretMode);
    const extraction = validateExtractionMode(extractionMode);
    const finalHex = codec.bytesToHex(finalBytes);
    if (finalHex.length !== bits / 4) throw new Error(`final value contains ${finalHex.length * 4} bits, not ${bits}`);
    const mask = representationMask(representationFormats, codec).toString(16).padStart(4, "0");
    return `${QR_PREFIX}|b=${bits}|s=${secretCode(mode)}|e=${extractionCode(extraction)}|r=${mask}|x=${finalHex}`;
  }

  function parseQrPayload(text, codec) {
    const parts = String(text).trim().split("|");
    if (parts.shift() !== QR_PREFIX) throw new Error("not a RollEntropy v1 QR recovery payload");
    const fields = new Map();
    for (const part of parts) {
      const separator = part.indexOf("=");
      if (separator <= 0) throw new Error("malformed QR recovery field");
      const key = part.slice(0, separator);
      const value = part.slice(separator + 1);
      if (fields.has(key)) throw new Error(`duplicate QR recovery field ${key}`);
      fields.set(key, value);
    }
    for (const key of ["b", "s", "e", "r", "x"]) if (!fields.has(key)) throw new Error(`QR recovery payload is missing ${key}`);
    for (const key of fields.keys()) if (!["b", "s", "e", "r", "x"].includes(key)) throw new Error(`unknown QR recovery field ${key}`);
    const targetBits = validateTargetBits(fields.get("b"));
    const finalHex = String(fields.get("x")).toLowerCase();
    const finalBytes = codec.hexToBytes(finalHex);
    if (finalBytes.length * 8 !== targetBits) throw new Error(`QR final value contains ${finalBytes.length * 8} bits, not ${targetBits}`);
    return Object.freeze({
      target_bits: targetBits,
      secret_mode: secretModeFromCode(fields.get("s")),
      extraction_mode: extractionModeFromCode(fields.get("e")),
      representation_formats: formatsFromMask(fields.get("r"), codec),
      final_hex: finalHex,
    });
  }

  function extractionMetadata(mode) {
    return mode === "hash"
      ? Object.freeze({ mode, algorithm: HASH_ALGORITHM, protocol: HASH_PROTOCOL })
      : Object.freeze({ mode, algorithm: null, protocol: EXACT_PROTOCOL });
  }

  async function buildKit({ progress, secretMode, finalBytes, representationFormats, metadata = null }, codec) {
    const targetBits = validateTargetBits(progress.target_bits);
    const extractionMode = validateExtractionMode(progress.mode);
    const mode = validateSecretMode(secretMode);
    const formats = normalizeFormats(representationFormats, codec);
    const finalHex = codec.bytesToHex(finalBytes);
    if (finalHex.length !== targetBits / 4) throw new Error(`final value contains ${finalHex.length * 4} bits, not ${targetBits}`);
    const representations = await codec.encodeMany(formats, finalBytes, { targetBits });
    const qrPayload = buildQrPayload({
      targetBits,
      secretMode: mode,
      extractionMode,
      finalBytes,
      representationFormats: formats,
    }, codec);
    return Object.freeze({
      product: PRODUCT_NAME,
      format: KIT_FORMAT,
      version: KIT_VERSION,
      target_bits: targetBits,
      secret_mode: mode,
      extraction: extractionMetadata(extractionMode),
      final_hex: finalHex,
      representation_formats: formats,
      representations,
      qr_payload: qrPayload,
      metadata: normalizeMetadata(metadata),
    });
  }

  function serializeKit(kit) {
    return `${JSON.stringify(kit, null, 2)}\n`;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char]);
  }

  function printableSecretMode(mode) {
    return mode === "private-browser-mix" ? "Private browser mix" : "Dice-only output";
  }

  function printableExtraction(extraction) {
    if (extraction?.mode === "hash") return `${extraction.algorithm || HASH_ALGORITHM} fixed-roll hash`;
    return "Exact uniform";
  }

  function validatePrintableQrSvg(svg) {
    const text = String(svg || "").trim();
    if (!/^<svg\s[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"[\s\S]*<\/svg>$/.test(text)) {
      throw new Error("printable recovery sheet requires a local SVG QR code");
    }
    if (/<script\b|<foreignObject\b|\b(?:href|xlink:href)\s*=|\bon[a-z]+\s*=/i.test(text)) {
      throw new Error("printable recovery QR contains disallowed active or external content");
    }
    return text;
  }

  function displayMetadata(metadata) {
    const normalized = normalizeMetadata(metadata) || Object.freeze({
      document_id: "", label: "", note: "", derived_at: "", derived_local: "", timezone: "",
    });
    const identityParts = ["DiceSecret"];
    if (normalized.label) identityParts.push(normalized.label);
    if (normalized.derived_local) identityParts.push(normalized.derived_local);
    return { metadata: normalized, identity: identityParts.join(" - ") };
  }

  function metadataRows(metadata) {
    const { metadata: item } = displayMetadata(metadata);
    const rows = [];
    if (item.label) rows.push(`<div><dt>Name / label</dt><dd>${escapeHtml(item.label)}</dd></div>`);
    if (item.derived_local) rows.push(`<div><dt>Derived</dt><dd>${escapeHtml(item.derived_local)}</dd></div>`);
    if (item.derived_at) rows.push(`<div><dt>UTC timestamp</dt><dd><code>${escapeHtml(item.derived_at)}</code></dd></div>`);
    if (item.document_id) rows.push(`<div><dt>Document ID</dt><dd><code>${escapeHtml(item.document_id)}</code></dd></div>`);
    return rows.join("\n");
  }

  function noteSection(metadata) {
    const { metadata: item } = displayMetadata(metadata);
    if (!item.note) return "";
    return `<section class="recordNote"><h2>Note</h2><div>${escapeHtml(item.note)}</div></section>`;
  }

  function printableIdentity(metadata, artifactLabel) {
    const { metadata: item, identity } = displayMetadata(metadata);
    const documentId = escapeHtml(item.document_id || "DiceSecret");
    const artifact = escapeHtml(artifactLabel || "DiceSecret document");
    return `<div class="printIdentity"><span>${escapeHtml(identity)}</span><span>${documentId}</span></div><div class="printPageFooter"><span>${artifact}</span><span>${documentId}</span></div>`;
  }

  const PRINTABLE_BASE_CSS = `
@page{size:auto;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0}body{color:#111;background:#fff;font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:850px;margin:0 auto;padding:24px}h1{font-size:28px;margin:0 0 4px}.subtitle{margin:0 0 18px;color:#444}.warning{border:2px solid #111;padding:12px 14px;margin:14px 0;font-weight:700}.meta{display:grid;grid-template-columns:1fr 1fr;gap:7px 18px;margin:16px 0}.meta div{display:grid;grid-template-columns:130px 1fr;border-bottom:1px solid #ddd;padding:4px 0}.meta dt{font-weight:700}.meta dd{margin:0}.recordNote{break-inside:avoid;border:1px solid #bbb;padding:10px 12px;margin:14px 0}.recordNote h2{font-size:16px;margin:0 0 6px}.recordNote div{white-space:pre-wrap;overflow-wrap:anywhere}.printIdentity,.printPageFooter{display:none}.footer{border-top:1px solid #bbb;margin-top:20px;padding-top:8px;font-size:11px;color:#555}.advice{font-size:12px;color:#333}.line{height:30px;border-bottom:1px solid #777}@media print{body{font-size:12px}main{max-width:none;margin:0;padding:16mm 10mm 14mm;box-decoration-break:clone;-webkit-box-decoration-break:clone}.printIdentity,.printPageFooter{display:flex;position:fixed;left:10mm;right:10mm;justify-content:space-between;gap:12px;font-size:8.5px;color:#444}.printIdentity{top:5mm;padding-bottom:2mm;border-bottom:1px solid #999}.printPageFooter{bottom:5mm;padding-top:2mm;border-top:1px solid #999}.warning{border-width:1.5px}}
`;

  function printableRepresentationValue(format, value, codec) {
    return format === "hex" ? codec.formatHex(value) : String(value);
  }

  function hexWritingBoxes(targetBits) {
    const bits = validateTargetBits(targetBits);
    const groups = Math.ceil(bits / 32);
    return `<div class="hexWriteHint">8 hex digits per box</div><div class="hexWriteGrid">${Array.from({ length: groups }, (_, index) => `<div class="hexWriteGroup"><small>${index + 1}</small><span></span></div>`).join("")}</div>`;
  }

  function buildPrintableSheetHtml({ kit, qrSvg }, codec) {
    if (!kit || kit.format !== KIT_FORMAT || Number(kit.version) !== KIT_VERSION) {
      throw new Error("printable recovery sheet requires a RollEntropy recovery kit v1");
    }
    if (!codec || !codec.FORMAT_LABELS) throw new Error("browser entropy codec is unavailable");
    const safeQrSvg = validatePrintableQrSvg(qrSvg);
    const representationRows = kit.representation_formats.map((format) => {
      const label = codec.FORMAT_LABELS[format] || format;
      const value = kit.representations?.[format];
      if (value == null) throw new Error(`recovery kit is missing ${format} representation`);
      return `<section class="representation"><h3>${escapeHtml(label)}</h3><div class="secretText">${escapeHtml(printableRepresentationValue(format, value, codec))}</div></section>`;
    }).join("\n");
    const algorithmRow = kit.extraction?.mode === "hash"
      ? `<div><dt>Hash algorithm</dt><dd>${escapeHtml(kit.extraction.algorithm || HASH_ALGORITHM)}</dd></div>`
      : "";
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DiceSecret full recovery sheet</title>
<style>${PRINTABLE_BASE_CSS}
.final{border:2px solid #111;padding:12px;margin:18px 0}.final h2,.representations h2,.qrBlock h2,.notes h2{font-size:18px;margin:0 0 8px}.secretText{font:700 13px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere;white-space:pre-wrap}.representations{margin:18px 0}.representation{break-inside:avoid;border-top:1px solid #bbb;padding:9px 0}.representation h3{font-size:14px;margin:0 0 4px}.qrBlock{break-inside:avoid;margin:20px 0}.qr{width:280px;max-width:70vw;margin:10px auto}.qr svg{display:block;width:100%;height:auto;shape-rendering:crispEdges}.payload{font:11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere;border:1px solid #bbb;padding:8px;margin-top:10px}.notes{break-inside:avoid;margin-top:22px}.field{display:grid;grid-template-columns:90px 1fr;align-items:end;gap:8px;margin:5px 0}.field span:last-child{border-bottom:1px solid #777;height:24px}@media print{.representation{padding:6px 0}.qr{width:240px}}
</style>
</head>
<body>
${printableIdentity(kit.metadata, "Full recovery sheet") }
<main>
<h1>DiceSecret full recovery sheet</h1>
<p class="subtitle">Recovery kit format v1 | browser-generated printable copy</p>
<div class="warning">THIS DOCUMENT CONTAINS THE FULL FINAL SECRET. Keep it private. Anyone who obtains this sheet can recover the secret.</div>
<dl class="meta">
${metadataRows(kit.metadata)}
<div><dt>Target</dt><dd>${escapeHtml(kit.target_bits)} bits</dd></div>
<div><dt>Secret mode</dt><dd>${escapeHtml(printableSecretMode(kit.secret_mode))}</dd></div>
<div><dt>Extraction</dt><dd>${escapeHtml(printableExtraction(kit.extraction))}</dd></div>
${algorithmRow}
<div><dt>Kit format</dt><dd>${escapeHtml(kit.format)}</dd></div>
<div><dt>QR payload</dt><dd>${escapeHtml(QR_PREFIX)} / version 1</dd></div>
</dl>
${noteSection(kit.metadata)}
<section class="final"><h2>Final output - hex</h2><div class="secretText">${escapeHtml(codec.formatHex(kit.final_hex))}</div></section>
<section class="representations"><h2>Selected recovery representations</h2>${representationRows}</section>
<section class="qrBlock"><h2>Recovery QR</h2><div class="qr">${safeQrSvg}</div><p class="advice"><b>Privacy warning:</b> scanning or photographing this QR with a cloud-connected application may expose the final secret.</p><div class="payload">${escapeHtml(kit.qr_payload)}</div></section>
<section class="notes"><h2>Additional handwritten notes</h2><div class="line"></div><div class="line"></div><div class="line"></div></section>
<p class="advice"><b>Printing warning:</b> printing or saving this page may leave copies of the secret in a PDF file, operating-system print spool, printer memory, network printer, backups, or other storage outside this browser.</p>
<p class="advice">This recovery sheet intentionally omits the server-visible dice-derived intermediate value and the browser-private XOR bytes. They are not required to recover the final output.</p>
<div class="footer">Generated locally by DiceSecret from a RollEntropy recovery kit. No external fonts, images, scripts, analytics, or network resources are required by this document.</div>
</main>
</body>
</html>
`;
  }

  function blankWritingLines(format, targetBits) {
    if (format === "hex") return hexWritingBoxes(targetBits);
    const compact = new Set(["base32", "base64url", "base64"]);
    const lineCount = compact.has(format) ? 3 : 6;
    return Array.from({ length: lineCount }, () => '<div class="writeLine"></div>').join("");
  }

  function buildRecordSheetHtml({ kit }, codec) {
    if (!kit || kit.format !== KIT_FORMAT || Number(kit.version) !== KIT_VERSION) {
      throw new Error("record sheet requires a RollEntropy recovery kit v1");
    }
    if (!codec || !codec.FORMAT_LABELS) throw new Error("browser entropy codec is unavailable");
    const algorithmRow = kit.extraction?.mode === "hash"
      ? `<div><dt>Hash algorithm</dt><dd>${escapeHtml(kit.extraction.algorithm || HASH_ALGORITHM)}</dd></div>`
      : "";
    const blanks = kit.representation_formats.map((format) => {
      const label = codec.FORMAT_LABELS[format] || format;
      return `<section class="writeBlock"><h2>${escapeHtml(label)}</h2>${blankWritingLines(format, kit.target_bits)}</section>`;
    }).join("\n");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DiceSecret blank record sheet</title>
<style>${PRINTABLE_BASE_CSS}
.safe{border:2px solid #176b36;background:#f4fff7;padding:12px 14px;margin:14px 0;font-weight:700}.writeBlock{break-inside:avoid;margin:18px 0}.writeBlock h2{font-size:17px;margin:0 0 7px}.writeLine{height:31px;border-bottom:1px solid #555}.hexWriteHint{font-size:11px;color:#555;margin:0 0 6px}.hexWriteGrid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px 10px}.hexWriteGroup{position:relative;height:42px;border:1px solid #555;border-radius:3px;padding:13px 6px 4px}.hexWriteGroup small{position:absolute;top:2px;left:5px;color:#777;font-size:8px}.hexWriteGroup span{display:block;height:18px;border-bottom:1px solid #aaa}.notes{break-inside:avoid;margin-top:24px}@media(max-width:560px){.hexWriteGrid{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style>
</head>
<body>
${printableIdentity(kit.metadata, "Blank record sheet - no secret") }
<main>
<h1>DiceSecret blank record sheet</h1>
<p class="subtitle">Print this blank worksheet, then write the secret onto the paper by hand.</p>
<div class="safe">NO SECRET OR SECRET-BEARING QR IS EMBEDDED IN THIS DOCUMENT. The print job contains only metadata and blank writing areas.</div>
<dl class="meta">
${metadataRows(kit.metadata)}
<div><dt>Target</dt><dd>${escapeHtml(kit.target_bits)} bits</dd></div>
<div><dt>Secret mode</dt><dd>${escapeHtml(printableSecretMode(kit.secret_mode))}</dd></div>
<div><dt>Extraction</dt><dd>${escapeHtml(printableExtraction(kit.extraction))}</dd></div>
${algorithmRow}
<div><dt>Record format</dt><dd>Blank human-written recovery worksheet v1</dd></div>
</dl>
${noteSection(kit.metadata)}
<section><h2>Write the final secret here after printing</h2><p class="advice">The blank areas below correspond to the representations selected in the browser. Copy carefully from the browser display after the sheet is physically printed.</p>${blanks}</section>
<section class="notes"><h2>Additional handwritten notes</h2><div class="line"></div><div class="line"></div><div class="line"></div></section>
<p class="advice"><b>Privacy property:</b> because this generated document contains no final secret, representations, recovery QR, or recovery payload, those secret values are not placed into the browser print job or a PDF created from this blank sheet. Any label or note entered above is included.</p>
<div class="footer">Generated locally. No external fonts, images, scripts, analytics, or network resources are required by this document.</div>
</main>
</body>
</html>
`;
  }

  async function normalizeImportedKit(value, codec) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("recovery kit must be a JSON object");
    if (value.format !== KIT_FORMAT || Number(value.version) !== KIT_VERSION) throw new Error("unsupported RollEntropy recovery-kit version");
    const targetBits = validateTargetBits(value.target_bits);
    const secretMode = validateSecretMode(value.secret_mode);
    const extractionMode = validateExtractionMode(value.extraction?.mode);
    const finalBytes = codec.hexToBytes(String(value.final_hex || ""));
    if (finalBytes.length * 8 !== targetBits) throw new Error(`recovery-kit final value contains ${finalBytes.length * 8} bits, not ${targetBits}`);
    const formats = normalizeFormats(value.representation_formats, codec);
    const expectedRepresentations = await codec.encodeMany(formats, finalBytes, { targetBits });
    if (value.representations && typeof value.representations === "object") {
      for (const format of formats) {
        if (String(value.representations[format] || "") !== expectedRepresentations[format]) {
          throw new Error(`recovery-kit ${format} representation does not match its final bytes`);
        }
      }
    }
    const expectedQr = buildQrPayload({
      targetBits,
      secretMode,
      extractionMode,
      finalBytes,
      representationFormats: formats,
    }, codec);
    if (value.qr_payload != null && String(value.qr_payload) !== expectedQr) throw new Error("recovery-kit QR payload does not match its final bytes or parameters");
    finalBytes.fill(0);
    return Object.freeze({
      product: PRODUCT_NAME,
      format: KIT_FORMAT,
      version: KIT_VERSION,
      target_bits: targetBits,
      secret_mode: secretMode,
      extraction: extractionMetadata(extractionMode),
      final_hex: String(value.final_hex).toLowerCase(),
      representation_formats: formats,
      representations: expectedRepresentations,
      qr_payload: expectedQr,
      metadata: normalizeMetadata(value.metadata),
    });
  }

  async function importText(text, codec) {
    const trimmed = String(text).trim();
    if (!trimmed) throw new Error("recovery-kit input is empty");
    if (trimmed.startsWith(`${QR_PREFIX}|`)) {
      const parsed = parseQrPayload(trimmed, codec);
      const finalBytes = codec.hexToBytes(parsed.final_hex);
      const representations = await codec.encodeMany(parsed.representation_formats, finalBytes, { targetBits: parsed.target_bits });
      const kit = Object.freeze({
        product: PRODUCT_NAME,
        format: KIT_FORMAT,
        version: KIT_VERSION,
        target_bits: parsed.target_bits,
        secret_mode: parsed.secret_mode,
        extraction: extractionMetadata(parsed.extraction_mode),
        final_hex: parsed.final_hex,
        representation_formats: parsed.representation_formats,
        representations,
        qr_payload: trimmed,
        metadata: null,
      });
      finalBytes.fill(0);
      return kit;
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`recovery-kit input is neither ${QR_PREFIX} payload text nor valid JSON: ${error.message || error}`);
    }
    return normalizeImportedKit(parsed, codec);
  }

  return Object.freeze({
    PRODUCT_NAME,
    KIT_FORMAT,
    KIT_VERSION,
    QR_PREFIX,
    HASH_ALGORITHM,
    HASH_PROTOCOL,
    EXACT_PROTOCOL,
    normalizeFormats,
    representationMask,
    formatsFromMask,
    normalizeMetadata,
    documentIdFromBytes,
    buildQrPayload,
    parseQrPayload,
    buildKit,
    serializeKit,
    buildPrintableSheetHtml,
    buildRecordSheetHtml,
    normalizeImportedKit,
    importText,
  });
});
