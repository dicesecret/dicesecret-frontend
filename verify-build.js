function bytesToHex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256(payload) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", payload)));
}

async function verifyBuild() {
  const status = document.getElementById("verifyBuildStatus");
  const meta = document.getElementById("verifyBuildMeta");
  const results = document.getElementById("verifyBuildResults");
  try {
    const response = await fetch("/build-manifest.json", { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok) throw new Error(`Build manifest is unavailable (${response.status}). This may be a source/development build rather than an exported release.`);
    const manifestBytes = new Uint8Array(await response.arrayBuffer());
    const manifestHash = await sha256(manifestBytes);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    if (manifest.$schema !== "https://dicesecret.com/schema/dicesecret-frontend-build-manifest-v1.schema.json") throw new Error("Unsupported build manifest schema");
    if (manifest.format !== "dicesecret-frontend-build-manifest-v1") throw new Error("Unsupported build manifest format");
    meta.innerHTML = `<dt>Source commit</dt><dd><code>${manifest.source_commit}</code></dd><dt>Manifest SHA-256</dt><dd><code>${manifestHash}</code></dd><dt>Inference API</dt><dd><code>${manifest.api_origin}</code></dd>`;
    const lines = [];
    for (const name of Object.keys(manifest.assets).sort()) {
      const assetResponse = await fetch(`/${name}`, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
      if (!assetResponse.ok) throw new Error(`Could not load manifested asset: ${name}`);
      const payload = new Uint8Array(await assetResponse.arrayBuffer());
      const digest = await sha256(payload);
      const expected = manifest.assets[name];
      if (digest !== expected.sha256 || payload.byteLength !== expected.bytes) throw new Error(`Manifest mismatch: ${name}`);
      lines.push(`OK  ${digest}  ${name}`);
    }
    results.textContent = lines.join("\n");
    status.textContent = `Verified ${lines.length} manifested frontend assets against this build manifest.`;
  } catch (error) {
    status.textContent = `Verification failed: ${error.message || String(error)}`;
    results.textContent = "";
  }
}

verifyBuild();
