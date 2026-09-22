const panels = ["setup", "roll", "capture", "processing", "report"];
const $ = (id) => document.getElementById(id);

let sessionId = null;
let stream = null;
let detecting = false;
let currentRoll = null;
let selectedPosition = null;
let selectedPhysicalId = null;
let currentRollPending = false;
let latestProgress = null;
let showOrderPath = false;
let showOrderNumbers = false;
let zoomLevel = 1;
let representationRenderSerial = 0;
let secretSession = null;
let latestRecoveryKit = null;
let latestRecoveryQrSvg = "";
let latestEncryptedRecoveryKit = null;
let latestEncryptedRecoveryQrSvg = "";
let sessionRecoveryMetadata = null;
let recoveryQrScanStream = null;
let recoveryQrScanTimer = null;
let recoveryQrScanGeneration = 0;
let errorHideTimer = null;
let detectionStartedAt = 0;
let scanHelpMode = "";

/* DICESECRET_BROWSER_LIVE_V1 */
let localVisionRuntime = null;
let localVisionRuntimePromise = null;
let localEntropyModulePromise = null;
let localEntropyCollector = null;
let localFrameInFlight = null;
let localCollection = null;
/* DICESECRET_BROWSER_REVIEW_ORDERING_V1 */

async function ensureLocalVisionRuntime() {
  if (localVisionRuntime) return localVisionRuntime;
  if (!localVisionRuntimePromise) {
    localVisionRuntimePromise = import("./vision-src/vision-live.js")
      .then((module) => module.BrowserDiceVisionRuntime.create())
      .then((runtime) => {
        localVisionRuntime = runtime;
        return runtime;
      })
      .catch((error) => {
        localVisionRuntimePromise = null;
        throw error;
      });
  }
  return localVisionRuntimePromise;
}

function localSessionId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
}

async function ensureLocalEntropyModule() {
  if (!localEntropyModulePromise) {
    localEntropyModulePromise = import("./vision-src/local-entropy.js").catch((error) => {
      localEntropyModulePromise = null;
      throw error;
    });
  }
  return localEntropyModulePromise;
}

function localPublicReport(report) {
  if (!report) return null;
  const copy = structuredClone(report);
  delete copy._manual_review_source_ordering;
  return copy;
}

function localBrowserState() {
  if (!localCollection || !localEntropyCollector) throw new Error("browser-local entropy session is unavailable");
  const pending = localPublicReport(localCollection.pending_roll);
  return {
    format: "dicesecret-inference-response-v1",
    session_id: sessionId,
    progress: localEntropyCollector.progress(),
    batches: localEntropyCollector.batches.map((batch) => structuredClone(batch)),
    pending_roll: pending,
    stopped: Boolean(localCollection.stopped),
  };
}

const codec = globalThis.RollEntropyCodec;
const secret = globalThis.RollEntropySecret;
const qr = globalThis.RollEntropyQr;
const recovery = globalThis.RollEntropyRecovery;
const encryption = globalThis.RollEntropyEncryption;
const defaultRepresentationFormats = new Set(["hex", "base32", "base64url", "bip39", "bytewords", "orchard-medium"]);
function reviewImageSrc(url) {
  if (!url || url.startsWith("data:")) return url || "";
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}t=${Date.now()}`;
}

function clearError() {
  if (errorHideTimer) clearTimeout(errorHideTimer);
  errorHideTimer = null;
  $("error").textContent = "";
  $("error").classList.add("hidden");
}

function show(name, status) {
  if (name !== "setup") stopRecoveryQrScan();
  panels.forEach((id) => $(id).classList.toggle("active", id === name));
  $("status").textContent = status || name;
  clearError();
}

function fail(error) {
  clearError();
  $("error").textContent = error.message || String(error);
  $("error").classList.remove("hidden");
  errorHideTimer = setTimeout(clearError, 8000);
}

function stopCamera() {
  detecting = false;
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null;
  $("video").srcObject = null;
  const context = $("overlay").getContext("2d");
  context.clearRect(0, 0, $("overlay").width, $("overlay").height);
}

function stopRecoveryQrScan() {
  recoveryQrScanGeneration += 1;
  if (recoveryQrScanTimer) clearTimeout(recoveryQrScanTimer);
  recoveryQrScanTimer = null;
  if (recoveryQrScanStream) recoveryQrScanStream.getTracks().forEach((track) => track.stop());
  recoveryQrScanStream = null;
  const video = $("recoveryQrVideo");
  if (video) video.srcObject = null;
  const scanner = $("recoveryQrScanner");
  if (scanner) scanner.classList.add("hidden");
}

function destroySecretSession() {
  if (secretSession) secretSession.destroy();
  secretSession = null;
}

function beginSecretSession(targetBits) {
  if (!secret) throw new Error("Browser private-secret module did not load");
  destroySecretSession();
  const selected = document.querySelector('input[name="secretMode"]:checked')?.value || "private";
  secretSession = secret.createSecretSession({
    targetBits,
    privateMix: selected !== "dice-only",
  });
}

async function beginCollection() {
  try {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const target_bits = Number($("bits").value);
    beginSecretSession(target_bits);
    const entropyModule = await ensureLocalEntropyModule();
    localEntropyCollector = new entropyModule.LocalExactEntropyCollection(target_bits, mode);
    sessionId = localSessionId();
    localCollection = {
      format: "dicevision-entropy-collection-v1",
      session_id: sessionId,
      mode,
      target_bits,
      pending_roll: null,
      stopped: false,
    };
    show("roll", "Roll dice");

    // Start the expensive WASM/model load while the user is physically rolling.
    // Do not block the Roll screen on it; Detect will await the same cached promise.
    void ensureLocalVisionRuntime().catch((error) => {
      console.error("DiceSecret browser-local model preload failed", error);
    });
  } catch (error) {
    localEntropyCollector = null;
    localCollection = null;
    destroySecretSession();
    fail(error);
  }
}

async function startDetection() {
  const button = $("detect");
  const previousText = button.textContent;
  button.disabled = true;
  button.textContent = "Loading models...";
  try {
    if (!localCollection || !sessionId || !localEntropyCollector) throw new Error("start an entropy session first");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const runtime = await ensureLocalVisionRuntime();
    runtime.reset();
    button.textContent = "Starting camera...";
    await new Promise((resolve) => requestAnimationFrame(resolve));
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    $("video").srcObject = stream;
    await $("video").play();
    detecting = true;
    detectionStartedAt = performance.now();
    scanHelpMode = "";
    show("capture", "Detecting locally");
    updateScanHelp();
    sendFrame();
  } catch (error) {
    stopCamera();
    fail(error);
  } finally {
    button.disabled = false;
    button.textContent = previousText || "Detect dice";
  }
}

function updateScanHelp(state = null) {
  const visible = Number(state?.visible || 0);
  const ready = Number(state?.ready || 0);
  const elapsedMs = detectionStartedAt ? performance.now() - detectionStartedAt : 0;
  let mode = "scanning";
  let title = "Scanning for dice...";
  let text = "Keep the camera steady and near a top-down view. Dice will turn green as the reader becomes confident.";

  if (ready > 0) {
    mode = "reading";
    title = "Reading dice...";
    text = "Keep the camera steady. Green dice are ready; if some remain difficult, move or tilt slightly while keeping the full group in view.";
  } else if (visible > 0) {
    mode = "detected";
    title = "Dice detected...";
    text = "Hold steady while the reader builds confidence. Dice will turn green when they are ready.";
  } else if (elapsedMs >= 8000) {
    mode = "still-scanning";
    title = "Still scanning...";
    text = "Try moving slightly closer, improving the top-down view, or slowly changing the camera angle while keeping all dice visible.";
  }

  if (mode === scanHelpMode) return;
  scanHelpMode = mode;
  $("scanHelpTitle").textContent = title;
  $("scanHelpText").textContent = text;
}

function cameraFrameBlob() {
  const video = $("video");
  const canvas = $("captureFrame");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("Could not capture camera frame")),
      "image/jpeg",
      0.88,
    );
  });
}

function drawLive(state) {
  $("readyCount").textContent = `${state.ready} ready this roll`;
  $("visibleCount").textContent = `${state.visible} visible now`;
  $("acceptLive").textContent = `Review ${state.ready} ${state.ready === 1 ? "die" : "dice"}`;
  $("acceptLive").disabled = state.ready < 1;
  updateScanHelp(state);
  const serverMs = state.timing_ms?.total;
  const roundTripMs = state.round_trip_ms;
  $("liveTiming").textContent = serverMs == null
    ? ""
    : `Model ${Math.round(serverMs)} ms | camera-to-overlay ${Math.round(roundTripMs)} ms`;

  const canvas = $("overlay");
  const video = $("video");
  const bounds = video.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(bounds.width * devicePixelRatio));
  canvas.height = Math.max(1, Math.round(bounds.height * devicePixelRatio));
  const context = canvas.getContext("2d");
  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);
  const scale = Math.min(bounds.width / state.width, bounds.height / state.height);
  const offsetX = (bounds.width - state.width * scale) / 2;
  const offsetY = (bounds.height - state.height * scale) / 2;

  state.tracks.forEach((track) => {
    const color = track.state === "green" ? "#54e887" : track.state === "yellow" ? "#ffd45a" : "#a7b2ac";
    context.beginPath();
    track.quad_px.forEach(([x, y], index) => {
      const px = offsetX + x * scale;
      const py = offsetY + y * scale;
      if (index === 0) context.moveTo(px, py); else context.lineTo(px, py);
    });
    context.closePath();
    context.strokeStyle = color;
    context.lineWidth = 3;
    context.stroke();
    const [x, y] = track.quad_px[0];
    const label = track.state === "green" ? String(track.value) : "?";
    context.font = "800 18px system-ui";
    context.fillStyle = "#020805";
    context.fillText(label, offsetX + x * scale + 2, offsetY + y * scale - 5);
    context.fillStyle = color;
    context.fillText(label, offsetX + x * scale, offsetY + y * scale - 7);
  });
}

function rejectedPhysicalIds() {
  return new Set((currentRoll?.manual_rejected_ids || []).map(Number));
}

function reviewDice() {
  if (!currentRoll) return [];
  const rejected = rejectedPhysicalIds();
  const active = (currentRoll.ordering?.dice || []).map((item) => ({ ...item, rejected: false }));
  const activeIds = new Set(active.map((item) => Number(item.physical_id)));
  const rejectedRows = (currentRoll.accepted || [])
    .filter((row) => rejected.has(Number(row.physical_id)) && !activeIds.has(Number(row.physical_id)))
    .map((row) => ({
      physical_id: Number(row.physical_id),
      id: row.id || `D${String(row.physical_id).padStart(2, "0")}`,
      value: Number(row.value),
      position: null,
      rejected: true,
    }));
  return [...active, ...rejectedRows];
}

function selectedReviewDie() {
  if (selectedPhysicalId == null) return null;
  return reviewDice().find((item) => Number(item.physical_id) === Number(selectedPhysicalId)) || null;
}

function drawReportOverlay(canvas, image) {
  const bounds = image.getBoundingClientRect();
  const pixelRatio = Math.min(devicePixelRatio, 2);
  canvas.width = Math.max(1, Math.round(bounds.width * pixelRatio));
  canvas.height = Math.max(1, Math.round(bounds.height * pixelRatio));
  const context = canvas.getContext("2d");
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);
  if (!currentRoll) return;
  const scale = Math.min(bounds.width / currentRoll.report_width, bounds.height / currentRoll.report_height);
  const offsetX = (bounds.width - currentRoll.report_width * scale) / 2;
  const offsetY = (bounds.height - currentRoll.report_height * scale) / 2;
  const dice = reviewDice().map((item) => ({
    ...item,
    quad: currentRoll.report_quads?.[String(item.physical_id)],
  })).filter((item) => item.quad);
  const activeDice = dice.filter((item) => !item.rejected);
  const point = ([x, y]) => [offsetX + x * scale, offsetY + y * scale];
  const centerOf = (quad) => quad.reduce((sum, item) => [sum[0] + item[0] / 4, sum[1] + item[1] / 4], [0, 0]);

  dice.forEach((item) => {
    const points = item.quad.map(point);
    context.beginPath();
    points.forEach(([x, y], index) => index ? context.lineTo(x, y) : context.moveTo(x, y));
    context.closePath();
    context.strokeStyle = item.rejected ? "#ff6f64" : "#36e65b";
    context.lineWidth = item.rejected ? 3 : 1.5;
    context.stroke();
    if (item.rejected) {
      const [a, b, c, d] = points;
      context.beginPath();
      context.moveTo(a[0], a[1]);
      context.lineTo(c[0], c[1]);
      context.moveTo(b[0], b[1]);
      context.lineTo(d[0], d[1]);
      context.strokeStyle = "#ff6f64";
      context.lineWidth = 3;
      context.stroke();
    }
  });

  if (showOrderPath) {
    const centers = activeDice.map((item) => point(centerOf(item.quad)));
    context.beginPath();
    centers.forEach(([x, y], index) => index ? context.lineTo(x, y) : context.moveTo(x, y));
    context.strokeStyle = "#52d9ffcc";
    context.lineWidth = 2;
    context.setLineDash([5, 4]);
    context.stroke();
    context.setLineDash([]);
  }

  if (showOrderNumbers) {
    activeDice.forEach((item) => {
      const [x, y] = point(centerOf(item.quad));
      context.beginPath();
      context.arc(x, y, 9, 0, 2 * Math.PI);
      context.fillStyle = "#07130ee6";
      context.fill();
      context.strokeStyle = "#54e887";
      context.lineWidth = 1.5;
      context.stroke();
      context.fillStyle = "#ffffff";
      context.font = "800 10px system-ui";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(String(item.position), x, y);
    });
  }

  const die = dice.find((item) => Number(item.physical_id) === Number(selectedPhysicalId));
  if (!die) return;
  const center = centerOf(die.quad);
  const expanded = die.quad.map(([x, y]) => [center[0] + 1.5 * (x - center[0]), center[1] + 1.5 * (y - center[1])]);
  context.beginPath();
  expanded.forEach(([x, y], index) => {
    const px = offsetX + x * scale;
    const py = offsetY + y * scale;
    if (index === 0) context.moveTo(px, py); else context.lineTo(px, py);
  });
  context.closePath();
  context.strokeStyle = "#ffe36c";
  context.lineWidth = 5;
  context.stroke();
  const [labelX, labelY] = point(center);
  const label = die.rejected
    ? `${die.id} | ${die.value} | rejected`
    : `#${die.position} | ${die.id} | ${die.value}`;
  context.font = "800 13px system-ui";
  context.textAlign = "center";
  context.textBaseline = "middle";
  const labelWidth = context.measureText(label).width + 16;
  const boxY = Math.max(13, labelY - 30);
  const safeLabelX = Math.max(labelWidth / 2 + 4, Math.min(bounds.width - labelWidth / 2 - 4, labelX));
  context.fillStyle = "#ffe36c";
  context.fillRect(safeLabelX - labelWidth / 2, boxY - 11, labelWidth, 22);
  context.fillStyle = "#171000";
  context.fillText(label, safeLabelX, boxY);
}

function drawAllReportOverlays() {
  drawReportOverlay($("reportOverlay"), $("reportImage"));
  if (!$("imageZoom").classList.contains("hidden")) {
    drawReportOverlay($("zoomOverlay"), $("zoomImage"));
  }
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const [x, y] = polygon[index];
    const [previousX, previousY] = polygon[previous];
    if ((y > point[1]) !== (previousY > point[1]) && point[0] < (previousX - x) * (point[1] - y) / (previousY - y) + x) {
      inside = !inside;
    }
  }
  return inside;
}

function selectZoomedDie(event) {
  if (!currentRoll) return;
  const imageBounds = $("zoomImage").getBoundingClientRect();
  const sourcePoint = [
    (event.clientX - imageBounds.left) * currentRoll.report_width / imageBounds.width,
    (event.clientY - imageBounds.top) * currentRoll.report_height / imageBounds.height,
  ];
  const item = reviewDice().find((die) => {
    const quad = currentRoll.report_quads?.[String(die.physical_id)];
    return quad && pointInPolygon(sourcePoint, quad);
  });
  if (item) selectPhysicalDie(item.physical_id, false, false);
}

function drawSelectedCrop() {
  const panel = $("selectedInspection");
  const raw = $("rawReportImage");
  const die = selectedReviewDie();
  const quad = die ? currentRoll.report_quads?.[String(die.physical_id)] : null;
  panel.classList.toggle("hidden", !die || !quad);
  if (!die || !quad || !raw.complete || !raw.naturalWidth) return;
  $("selectedCropTitle").textContent = die.rejected
    ? `${die.id} | value ${die.value} | rejected`
    : `Position ${die.position} | ${die.id} | value ${die.value}`;
  const xs = quad.map((point) => point[0]);
  const ys = quad.map((point) => point[1]);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  const padding = 0.35 * Math.max(width, height);
  const sourceX = Math.max(0, Math.min(...xs) - padding);
  const sourceY = Math.max(0, Math.min(...ys) - padding);
  const sourceWidth = Math.min(currentRoll.report_width - sourceX, width + 2 * padding);
  const sourceHeight = Math.min(currentRoll.report_height - sourceY, height + 2 * padding);
  const ratioX = raw.naturalWidth / currentRoll.report_width;
  const ratioY = raw.naturalHeight / currentRoll.report_height;
  const canvas = $("selectedCrop");
  canvas.width = 220 * devicePixelRatio;
  canvas.height = 160 * devicePixelRatio;
  const context = canvas.getContext("2d");
  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.fillStyle = "#020503";
  context.fillRect(0, 0, 220, 160);
  const fit = Math.min(220 / sourceWidth, 160 / sourceHeight);
  const destinationWidth = sourceWidth * fit;
  const destinationHeight = sourceHeight * fit;
  const destinationX = (220 - destinationWidth) / 2;
  const destinationY = (160 - destinationHeight) / 2;
  context.drawImage(raw, sourceX * ratioX, sourceY * ratioY, sourceWidth * ratioX, sourceHeight * ratioY, destinationX, destinationY, destinationWidth, destinationHeight);
  const cropPoint = ([x, y]) => [destinationX + (x - sourceX) * fit, destinationY + (y - sourceY) * fit];
  context.beginPath();
  quad.map(cropPoint).forEach(([x, y], index) => index ? context.lineTo(x, y) : context.moveTo(x, y));
  context.closePath();
  context.strokeStyle = die.rejected ? "#ff6f64" : "#ffe36c";
  context.lineWidth = 3;
  context.stroke();
}

function updateSelectedDieActions(item) {
  const usable = Boolean(currentRollPending && item);
  [$("selectedDieAction"), $("zoomDieAction")].forEach((button) => {
    button.classList.toggle("hidden", !usable);
    if (!usable) return;
    button.textContent = item.rejected ? `Restore ${item.id}` : `Reject ${item.id}`;
    button.classList.toggle("danger", !item.rejected);
    button.classList.toggle("quiet", item.rejected);
  });
}

function selectPhysicalDie(physicalId, reveal = false, toggle = true) {
  const physical = Number(physicalId);
  selectedPhysicalId = toggle && Number(selectedPhysicalId) === physical ? null : physical;
  const item = selectedReviewDie();
  selectedPosition = item?.position ?? null;
  document.querySelectorAll("[data-position]").forEach((element) => {
    element.classList.toggle("selected", Number(element.dataset.position) === selectedPosition);
  });
  $("selectedDie").textContent = item
    ? item.rejected
      ? `${item.id} | value ${item.value} | rejected`
      : `Position ${item.position} | ${item.id} | value ${item.value}`
    : "Tap a value to locate that die.";
  $("zoomSelection").textContent = item
    ? item.rejected
      ? `Selected: ${item.id} | value ${item.value} | rejected`
      : `Selected: #${item.position} | ${item.id} | value ${item.value}`
    : "No die selected";
  updateSelectedDieActions(item);
  drawAllReportOverlays();
  drawSelectedCrop();
  if (item && reveal) document.querySelector(".reportVisual").scrollIntoView({ behavior: "smooth", block: "center" });
}

function selectPosition(position, reveal = false, toggle = true) {
  const item = (currentRoll?.ordering?.dice || []).find((die) => Number(die.position) === Number(position));
  if (!item) return;
  selectPhysicalDie(item.physical_id, reveal, toggle);
}

async function setSelectedDieRejected(rejected) {
  const item = selectedReviewDie();
  if (!currentRollPending || !item || !localCollection?.pending_roll) return;
  try {
    const runtime = await ensureLocalVisionRuntime();
    const rejectedIds = new Set((localCollection.pending_roll.manual_rejected_ids || []).map(Number));
    if (rejected) rejectedIds.add(Number(item.physical_id));
    else rejectedIds.delete(Number(item.physical_id));
    localCollection.pending_roll = runtime.rebuildPendingAfterManualRejection(
      localCollection.pending_roll,
      rejectedIds,
    );
    render(localBrowserState());
  } catch (error) {
    fail(error);
  }
}

function toggleSelectedDieRejected() {
  const item = selectedReviewDie();
  if (item) setSelectedDieRejected(!item.rejected);
}

function selectedRepresentationFormats() {
  return Array.from(document.querySelectorAll('#representationChoices input[type="checkbox"]:checked'), (input) => input.value);
}

function displayRepresentationValue(format, value) {
  return format === "hex" ? codec.formatHex(value) : value;
}

function makeRepresentationCard(format) {
  const card = document.createElement("article");
  card.className = "representationCard";
  card.dataset.format = format;
  const heading = document.createElement("div");
  const title = document.createElement("b");
  title.textContent = codec.FORMAT_LABELS[format] || format;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "quiet copyRepresentation";
  copy.textContent = "Copy";
  copy.disabled = true;
  heading.append(title, copy);
  const output = document.createElement("code");
  output.textContent = "Generating locally...";
  card.append(heading, output);
  return { card, copy, output };
}

function renderSecretVerification(diceDerived, finalBytes) {
  const diceHex = codec.bytesToHex(diceDerived);
  const finalHex = codec.bytesToHex(finalBytes);
  $("diceDerivedHex").textContent = codec.formatHex(diceHex);
  $("finalOutputHex").textContent = codec.formatHex(finalHex);
  const audit = secretSession.audit();
  $("browserMixRow").classList.toggle("hidden", !secretSession.privateMix);
  if (!secretSession.privateMix) {
    $("browserMixHex").textContent = "";
    $("browserMixHex").classList.add("hidden");
    $("toggleBrowserMix").textContent = "Reveal";
  }
  const status = $("mixVerificationStatus");
  if (audit.verified === true) {
    status.textContent = secretSession.privateMix
      ? "OK XOR operation verified locally: dice-derived XOR browser-private = final output."
      : "OK Dice-only output verified locally: final output matches the dice-derived bytes.";
    status.classList.remove("verificationFailed");
  } else {
    status.textContent = "Verification failed. Do not use this output.";
    status.classList.add("verificationFailed");
  }
}

function resetSecretVerification() {
  $("diceDerivedHex").textContent = "";
  $("finalOutputHex").textContent = "";
  $("browserMixHex").textContent = "";
  $("browserMixHex").classList.add("hidden");
  $("browserMixRow").classList.add("hidden");
  $("toggleBrowserMix").textContent = "Reveal";
  $("mixVerificationStatus").textContent = "";
  $("mixVerificationStatus").classList.remove("verificationFailed");
  $("verificationDetails").open = false;
}

function toggleBrowserMixReveal() {
  if (!secretSession?.privateMix) return;
  const output = $("browserMixHex");
  if (!output.classList.contains("hidden")) {
    output.textContent = "";
    output.classList.add("hidden");
    $("toggleBrowserMix").textContent = "Reveal";
    return;
  }
  let diceDerived = null;
  let finalBytes = null;
  let browserMix = null;
  try {
    diceDerived = codec.hexToBytes($("diceDerivedHex").textContent.trim());
    finalBytes = codec.hexToBytes($("finalOutputHex").textContent.trim());
    browserMix = secret.xorBytes(diceDerived, finalBytes);
    output.textContent = codec.formatHex(codec.bytesToHex(browserMix));
    output.classList.remove("hidden");
    $("toggleBrowserMix").textContent = "Hide";
  } catch (error) {
    fail(error);
  } finally {
    if (diceDerived) diceDerived.fill(0);
    if (finalBytes) finalBytes.fill(0);
    if (browserMix) browserMix.fill(0);
  }
}

async function renderRepresentations(progress) {
  const serial = ++representationRenderSerial;
  const container = $("representationOutputs");
  container.replaceChildren();
  resetRecoveryExport();
  if (!codec) {
    container.textContent = "Browser entropy codec did not load.";
    return;
  }
  if (!progress.output_hex) {
    container.textContent = "Completed entropy bytes are unavailable.";
    return;
  }
  let diceDerived = null;
  let data = null;
  try {
    if (!secretSession) throw new Error("browser secret state is unavailable for this completed session");
    if (secretSession.targetBits !== Number(progress.target_bits)) {
      throw new Error(`browser secret state is ${secretSession.targetBits} bits but the completed session is ${progress.target_bits} bits`);
    }
    diceDerived = codec.hexToBytes(progress.output_hex);
    data = secretSession.finalize(diceDerived);
    $("secretSourceStatus").textContent = secretSession.privateMix
      ? "Private browser mix is ON. Browser-generated random bytes were XORed with the dice-derived bytes locally. The final value below was not sent to the inference server."
      : "Dice-only output is ON. The final value below is the dice-derived value returned by the inference server, with no browser-private mix.";
    $("secretSourceStatus").classList.toggle("diceOnly", !secretSession.privateMix);
    renderSecretVerification(diceDerived, data);
  } catch (error) {
    if (diceDerived) diceDerived.fill(0);
    if (data) data.fill(0);
    fail(error);
    return;
  }
  const formats = selectedRepresentationFormats();
  if (!formats.length) {
    container.textContent = "Select at least one representation above.";
    diceDerived.fill(0);
    data.fill(0);
    return;
  }
  const rows = formats.map((format) => ({ format, ...makeRepresentationCard(format) }));
  rows.forEach(({ card }) => container.append(card));
  try {
    await Promise.all(rows.map(async ({ format, copy, output }) => {
      try {
        const value = await codec.encode(format, data, { targetBits: progress.target_bits });
        if (serial !== representationRenderSerial) return;
        output.textContent = displayRepresentationValue(format, value);
        copy.disabled = false;
        copy.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(value);
            copy.textContent = "Copied";
            setTimeout(() => { copy.textContent = "Copy"; }, 1200);
          } catch (error) {
            fail(error);
          }
        });
      } catch (error) {
        if (serial !== representationRenderSerial) return;
        output.textContent = `Unavailable: ${error.message || error}`;
        output.classList.add("encodingError");
      }
    }));
    await renderRecoveryExport(progress, data, formats, serial);
  } finally {
    diceDerived.fill(0);
    data.fill(0);
  }
}

function setupCodecUi() {
  if (!codec) {
    fail(new Error("Browser entropy codec did not load"));
    return;
  }
  if (!secret) {
    fail(new Error("Browser private-secret module did not load"));
    return;
  }
  if (!qr) {
    fail(new Error("Browser QR module did not load"));
    return;
  }
  if (!recovery) {
    fail(new Error("Browser recovery-kit module did not load"));
    return;
  }
  if (!encryption) {
    fail(new Error("Browser encrypted-recovery module did not load"));
    return;
  }
  const choices = $("representationChoices");
  codec.FORMAT_ORDER.forEach((format) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = format;
    input.checked = defaultRepresentationFormats.has(format);
    const text = document.createElement("span");
    text.textContent = codec.FORMAT_LABELS[format] || format;
    label.append(input, text);
    choices.append(label);
    input.addEventListener("change", () => {
      if (latestProgress?.complete) renderRepresentations(latestProgress);
    });
  });

  const recoveryEncoding = $("recoveryEncoding");
  codec.FORMAT_ORDER.forEach((format) => {
    const option = document.createElement("option");
    option.value = format;
    option.textContent = codec.FORMAT_LABELS[format] || format;
    recoveryEncoding.append(option);
  });
  recoveryEncoding.value = "bip39";
  const hasNativeQr = typeof globalThis.BarcodeDetector === "function";
  const hasBundledQr = typeof globalThis.jsQR === "function";
  if (hasBundledQr) {
    $("qrDecodeSupport").textContent = hasNativeQr
      ? "QR detection stays local. This browser can use its native detector, with bundled jsQR as a local fallback."
      : "QR detection stays local using the bundled jsQR decoder. Camera frames and opened images are not uploaded.";
  } else if (hasNativeQr) {
    $("qrDecodeSupport").textContent = "QR detection stays local using this browser's built-in detector. No cloud fallback is used.";
  } else {
    $("qrDecodeSupport").textContent = "Local QR decoding is unavailable because the bundled jsQR file is missing. Paste RE1/RE1E text or vendor jsQR 1.4.0 into this build.";
    $("startRecoveryQrScan").disabled = true;
    $("chooseRecoveryQrImage").disabled = true;
  }
  document.querySelectorAll('input[name="recoveryProtection"]').forEach((input) => input.addEventListener("change", renderRecoveryProtectionUi));
  renderRecoveryProtectionUi();
}

async function decodeRecovery() {
  try {
    const format = $("recoveryEncoding").value;
    const targetBits = Number($("recoveryBits").value);
    const data = await codec.decode(format, $("recoveryInput").value, { targetBits });
    $("recoverySummary").textContent = `${data.length * 8} bits recovered locally`;
    $("recoveryHex").textContent = codec.formatHex(codec.bytesToHex(data));
    $("recoveryBinary").textContent = codec.bytesToBits(data);
    $("recoveryResult").classList.remove("hidden");
  } catch (error) {
    $("recoveryResult").classList.add("hidden");
    fail(error);
  }
}

function createSessionRecoveryMetadata() {
  if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== "function") {
    throw new Error("browser cryptographic randomness is unavailable for the recovery document ID");
  }
  const random = new Uint8Array(5);
  globalThis.crypto.getRandomValues(random);
  const now = new Date();
  try {
    const metadata = recovery.normalizeMetadata({
      document_id: recovery.documentIdFromBytes(random),
      label: "",
      note: "",
      derived_at: now.toISOString(),
      derived_local: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "long" }).format(now),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    });
    return metadata;
  } finally {
    random.fill(0);
  }
}

function ensureSessionRecoveryMetadata() {
  if (!sessionRecoveryMetadata) sessionRecoveryMetadata = createSessionRecoveryMetadata();
  $("recoveryDerivedAt").textContent = sessionRecoveryMetadata.derived_local || sessionRecoveryMetadata.derived_at;
  $("recoveryDocumentId").textContent = sessionRecoveryMetadata.document_id;
  return sessionRecoveryMetadata;
}

function currentRecoveryMetadata() {
  const base = ensureSessionRecoveryMetadata();
  return recovery.normalizeMetadata({
    ...base,
    label: $("recoveryLabel").value,
    note: $("recoveryNote").value,
  });
}

function recoveryKitWithCurrentMetadata() {
  if (!latestRecoveryKit) throw new Error("recovery kit is not ready");
  return Object.freeze({ ...latestRecoveryKit, metadata: currentRecoveryMetadata() });
}

function invalidateEncryptedRecoveryExport() {
  latestEncryptedRecoveryKit = null;
  latestEncryptedRecoveryQrSvg = "";
  $("encryptedRecoveryQr").replaceChildren();
  $("encryptedQrPayloadText").textContent = "";
  $("encryptedRecoveryExport").classList.add("hidden");
}

function recoveryMetadataChanged() {
  if (!sessionRecoveryMetadata) return;
  if (latestRecoveryKit) latestRecoveryKit = Object.freeze({ ...latestRecoveryKit, metadata: currentRecoveryMetadata() });
  invalidateEncryptedRecoveryExport();
}

function resetRecoveryMetadata() {
  sessionRecoveryMetadata = null;
  $("recoveryLabel").value = "";
  $("recoveryNote").value = "";
  $("recoveryDerivedAt").textContent = "-";
  $("recoveryDocumentId").textContent = "-";
}

function resetRecoveryExport() {
  latestRecoveryKit = null;
  latestRecoveryQrSvg = "";
  invalidateEncryptedRecoveryExport();
  $("recoveryExport").classList.add("hidden");
  $("recoveryQr").replaceChildren();
  $("qrPayloadText").textContent = "";
  $("encryptedRecoveryPassphrase").value = "";
  $("encryptedRecoveryPassphraseConfirm").value = "";
}

function renderRecoveryProtectionUi() {
  const mode = document.querySelector('input[name="recoveryProtection"]:checked')?.value || "plain";
  $("plainRecoveryExport").classList.toggle("hidden", mode !== "plain");
  $("encryptedRecoveryControls").classList.toggle("hidden", mode !== "encrypted");
  $("encryptedRecoveryExport").classList.toggle("hidden", mode !== "encrypted" || !latestEncryptedRecoveryKit);
}

function browserDownload(filename, text, contentType) {
  const blob = new Blob([text], { type: contentType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function printableRecordSheetHtml() {
  return recovery.buildRecordSheetHtml({ kit: recoveryKitWithCurrentMetadata() }, codec);
}

function printableRecoverySheetHtml() {
  if (!latestRecoveryQrSvg) throw new Error("printable recovery sheet is not ready");
  return recovery.buildPrintableSheetHtml({ kit: recoveryKitWithCurrentMetadata(), qrSvg: latestRecoveryQrSvg }, codec);
}

function printableEncryptedRecoverySheetHtml() {
  if (!latestEncryptedRecoveryKit || !latestEncryptedRecoveryQrSvg) throw new Error("encrypted printable recovery sheet is not ready");
  return encryption.buildEncryptedPrintableSheetHtml({
    encryptedKit: latestEncryptedRecoveryKit,
    qrSvg: latestEncryptedRecoveryQrSvg,
  });
}

async function createEncryptedRecoveryExport() {
  if (!latestRecoveryKit) throw new Error("plain recovery kit is not ready");
  const passphrase = $("encryptedRecoveryPassphrase").value;
  const confirmation = $("encryptedRecoveryPassphraseConfirm").value;
  if (passphrase !== confirmation) throw new Error("recovery passphrases do not match");
  const button = $("createEncryptedRecovery");
  button.disabled = true;
  const original = button.textContent;
  button.textContent = "Encrypting...";
  try {
    const encryptedKit = await encryption.encryptKit(recoveryKitWithCurrentMetadata(), passphrase, recovery, codec);
    const svg = qr.toSvg(encryptedKit.qr_payload, { label: "DiceSecret encrypted recovery QR" });
    latestEncryptedRecoveryKit = encryptedKit;
    latestEncryptedRecoveryQrSvg = svg;
    $("encryptedRecoveryQr").innerHTML = svg;
    $("encryptedQrPayloadText").textContent = encryptedKit.qr_payload;
    $("encryptedRecoveryPassphrase").value = "";
    $("encryptedRecoveryPassphraseConfirm").value = "";
    renderRecoveryProtectionUi();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function printHtmlDocument(html) {
  let printWindow = null;
  try {
    printWindow = window.open("", "_blank");
    if (!printWindow) throw new Error("browser blocked the print window; allow pop-ups for this local page and try again");
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    setTimeout(() => {
      try {
        printWindow.focus();
        printWindow.print();
      } catch (error) {
        fail(error);
      }
    }, 100);
  } catch (error) {
    if (printWindow && !printWindow.closed) printWindow.close();
    throw error;
  }
}

function printRecordSheet() {
  try { printHtmlDocument(printableRecordSheetHtml()); } catch (error) { fail(error); }
}

function printRecoverySheet() {
  let printWindow = null;
  try {
    const html = printableRecoverySheetHtml();
    printWindow = window.open("", "_blank");
    if (!printWindow) throw new Error("browser blocked the print window; allow pop-ups for this local page and try again");
    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();
    setTimeout(() => {
      try {
        printWindow.focus();
        printWindow.print();
      } catch (error) {
        fail(error);
      }
    }, 100);
  } catch (error) {
    if (printWindow && !printWindow.closed) printWindow.close();
    fail(error);
  }
}

async function renderRecoveryExport(progress, finalBytes, formats, serial) {
  if (secretSession.audit().verified !== true) throw new Error("cannot export an unverified final secret");
  const kit = await recovery.buildKit({
    progress,
    secretMode: secretSession.mode,
    finalBytes,
    representationFormats: formats,
    metadata: currentRecoveryMetadata(),
  }, codec);
  if (serial !== representationRenderSerial) return;
  const svg = qr.toSvg(kit.qr_payload, { label: "DiceSecret recovery QR" });
  latestRecoveryKit = kit;
  latestRecoveryQrSvg = svg;
  $("recoveryQr").innerHTML = svg;
  $("qrPayloadText").textContent = kit.qr_payload;
  $("recoveryExport").classList.remove("hidden");
}

function makeImportedRepresentation(format, value) {
  const card = document.createElement("article");
  card.className = "representationCard";
  const heading = document.createElement("div");
  const title = document.createElement("b");
  title.textContent = codec.FORMAT_LABELS[format] || format;
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "quiet copyRepresentation";
  copy.textContent = "Copy";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(value);
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = "Copy"; }, 1200);
    } catch (error) {
      fail(error);
    }
  });
  const output = document.createElement("code");
  output.textContent = displayRepresentationValue(format, value);
  heading.append(title, copy);
  card.append(heading, output);
  return card;
}

function renderImportedRecovery(kit) {
  const source = kit.secret_mode === "private-browser-mix" ? "private browser mix" : "dice-only";
  const extraction = kit.extraction.mode === "hash" ? `${kit.extraction.algorithm} hash` : "exact uniform";
  $("importedRecoverySummary").textContent = `${kit.target_bits} bits | ${source} | ${extraction}`;
  $("importedRecoveryHex").textContent = codec.formatHex(kit.final_hex);
  const container = $("importedRecoveryRepresentations");
  container.replaceChildren();
  kit.representation_formats.forEach((format) => container.append(makeImportedRepresentation(format, kit.representations[format])));
  $("importedRecovery").classList.remove("hidden");
}

async function importRecoveryKitText(text) {
  try {
    let kit;
    if (encryption.isEncryptedText(text)) {
      kit = await encryption.importEncryptedText(text, $("importRecoveryPassphrase").value, recovery, codec);
      $("importRecoveryPassphrase").value = "";
    } else {
      kit = await recovery.importText(text, codec);
    }
    renderImportedRecovery(kit);
    clearError();
  } catch (error) {
    $("importedRecovery").classList.add("hidden");
    fail(error);
  }
}


async function createLocalQrDetector() {
  if (typeof globalThis.BarcodeDetector === "function") {
    try {
      if (typeof globalThis.BarcodeDetector.getSupportedFormats === "function") {
        const formats = await globalThis.BarcodeDetector.getSupportedFormats();
        if (!formats.includes("qr_code")) throw new Error("native detector does not support QR codes");
      }
      const nativeDetector = new globalThis.BarcodeDetector({ formats: ["qr_code"] });
      return Object.freeze({
        kind: "native BarcodeDetector",
        detect: (source) => nativeDetector.detect(source),
      });
    } catch (error) {
      if (typeof globalThis.jsQR !== "function") throw error;
    }
  }
  if (typeof globalThis.jsQR !== "function") {
    throw new Error("local QR decoder is unavailable; the bundled jsQR 1.4.0 asset is missing");
  }
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("browser canvas image access is unavailable for local QR decoding");
  return Object.freeze({
    kind: "bundled jsQR",
    async detect(source) {
      const sourceWidth = Number(source.videoWidth || source.naturalWidth || source.width || 0);
      const sourceHeight = Number(source.videoHeight || source.naturalHeight || source.height || 0);
      if (!sourceWidth || !sourceHeight) return [];
      const maxDimension = 960;
      const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      context.drawImage(source, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height);
      const result = globalThis.jsQR(pixels.data, width, height, { inversionAttempts: "attemptBoth" });
      return result?.data ? [{ rawValue: result.data }] : [];
    },
  });
}

function recoveryPayloadsFromDetections(detected) {
  return Array.from(new Set(detected.map((item) => String(item.rawValue || "").trim()).filter((value) =>
    value.startsWith(`${recovery.QR_PREFIX}|`) || value.startsWith(`${encryption.ENCRYPTED_QR_PREFIX}|`)
  )));
}

async function handleDetectedRecoveryPayload(payload) {
  $("recoveryKitInput").value = payload;
  if (payload.startsWith(`${encryption.ENCRYPTED_QR_PREFIX}|`) && !$("importRecoveryPassphrase").value) {
    $("recoveryQrScanStatus").textContent = "Encrypted DiceSecret QR read locally. Enter its passphrase, then click Recover / import.";
    $("importRecoveryPassphrase").focus();
    return;
  }
  await importRecoveryKitText(payload);
  $("recoveryQrScanStatus").textContent = "DiceSecret QR recovered locally.";
}

async function startRecoveryQrScan() {
  let detector;
  try {
    detector = await createLocalQrDetector();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("camera access is unavailable in this browser");
    stopRecoveryQrScan();
    const generation = recoveryQrScanGeneration;
    const requestedStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    if (generation !== recoveryQrScanGeneration) {
      requestedStream.getTracks().forEach((track) => track.stop());
      return;
    }
    recoveryQrScanStream = requestedStream;
    const video = $("recoveryQrVideo");
    video.srcObject = recoveryQrScanStream;
    await video.play();
    $("recoveryQrScanner").classList.remove("hidden");
    $("recoveryQrScanStatus").textContent = `Scanning locally with ${detector.kind}... point the camera at a DiceSecret QR.`;

    const scan = async () => {
      if (!recoveryQrScanStream || generation !== recoveryQrScanGeneration) return;
      try {
        const payloads = recoveryPayloadsFromDetections(await detector.detect(video));
        if (payloads.length > 1) throw new Error("camera sees more than one DiceSecret recovery QR");
        if (payloads.length === 1) {
          const payload = payloads[0];
          stopRecoveryQrScan();
          await handleDetectedRecoveryPayload(payload);
          return;
        }
      } catch (error) {
        stopRecoveryQrScan();
        fail(error);
        return;
      }
      recoveryQrScanTimer = setTimeout(scan, 180);
    };
    recoveryQrScanTimer = setTimeout(scan, 80);
  } catch (error) {
    stopRecoveryQrScan();
    fail(error);
  }
}

async function decodeRecoveryQrImage() {
  const file = $("recoveryQrImage").files?.[0];
  if (!file) return fail(new Error("choose a QR image first"));
  let bitmap = null;
  try {
    const detector = await createLocalQrDetector();
    bitmap = await createImageBitmap(file);
    const payloads = recoveryPayloadsFromDetections(await detector.detect(bitmap));
    if (payloads.length !== 1) throw new Error(payloads.length ? "QR image contains more than one DiceSecret recovery payload" : "no DiceSecret recovery QR was found in the image");
    await handleDetectedRecoveryPayload(payloads[0]);
  } catch (error) {
    fail(error);
  } finally {
    if (bitmap && typeof bitmap.close === "function") bitmap.close();
  }
}

function orderingReviewExplanation(ordering) {
  const labels = {
    "insufficient-dice-for-floor-normalization": "too few dice to estimate the floor reliably",
    "floor-perspective-fit-degenerate": "the perspective fit was underconstrained",
    "floor-affine-fit-degenerate": "the top-down shape correction was underconstrained",
    "cube-size-or-perspective-fit-is-inconsistent": "the detected cube sizes did not agree with one perspective",
    "top-shape-fit-is-inconsistent": "the detected top shapes did not agree",
    "anchor-choice-is-close": "two dice were nearly tied for position 1",
    "axis-choice-is-close": "two directions were nearly tied",
    "orientation-choice-is-close": "the orientation choice was close",
    "nearly-collinear-layout": "the layout was nearly a line",
    "recursive-order-is-close": "dice were close to a recursive region boundary",
    "no-usable-floor-geometry": "no usable floor geometry was available",
    "floor-consensus-alignment-failed": "the live views could not be aligned",
    "incomplete-multi-view-floor-consensus": "not every accepted die had a floor position",
    "insufficient-views-for-floor-consensus": "too few useful live views agreed",
    "multi-view-floor-centers-disagree": "the estimated floor centers changed between live views",
  };
  const normalization = ordering?.normalization || {};
  const used = normalization.dice_used == null ? "" : ` from ${normalization.dice_used} tops`;
  const area = normalization.log_area_residual == null ? "" : `; size/perspective residual ${(100 * normalization.log_area_residual).toFixed(1)}%`;
  const shape = normalization.shape_residual == null ? "" : `; top-shape residual ${(100 * normalization.shape_residual).toFixed(1)}%`;
  const views = normalization.views_used == null ? "" : ` across ${normalization.views_used} live views`;
  const jitter = normalization.center_jitter_p90 == null ? "" : `; center disagreement ${(100 * normalization.center_jitter_p90).toFixed(1)}%`;
  const reasons = (ordering?.reasons || []).map((reason) => labels[reason] || reason).join("; ");
  const fit = normalization.method ? `Best-attempt top-down fit${used}${views}${area}${shape}${jitter}. ` : "";
  return `${fit}${reasons ? `Review required: ${reasons}. ` : ""}`;
}

async function sendFrame() {
  if (!detecting) return;
  try {
    const runtime = await ensureLocalVisionRuntime();
    const started = performance.now();
    const video = $("video");
    const canvas = $("captureFrame");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    const inference = runtime.processCanvas(canvas);
    localFrameInFlight = inference;
    let state;
    try {
      state = await inference;
    } finally {
      if (localFrameInFlight === inference) localFrameInFlight = null;
    }

    if (!detecting) return;
    state.round_trip_ms = performance.now() - started;
    drawLive(state);
    setTimeout(() => {
      if (detecting) requestAnimationFrame(sendFrame);
    }, 80);
  } catch (error) {
    if (!detecting) return;
    detecting = false;
    fail(error);
  }
}

async function acceptLiveRoll() {
  const button = $("acceptLive");
  const priorText = button.textContent;
  const pendingFrame = localFrameInFlight;
  detecting = false;
  button.disabled = true;
  button.textContent = "Preparing review...";
  try {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (pendingFrame) await pendingFrame;
    const runtime = await ensureLocalVisionRuntime();
    const report = runtime.finalizeRoll();
    if (!localCollection) throw new Error("browser-local entropy session is unavailable");
    localCollection.pending_roll = report;

    // Keep the live camera visible until the report is actually ready.  Only then
    // release it and move directly into the existing Review this roll UI.
    stopCamera();
    render(localBrowserState());
  } catch (error) {
    if (stream) {
      detecting = true;
      show("capture", "Detecting locally");
      sendFrame();
    }
    fail(error);
  } finally {
    button.textContent = priorText;
    button.disabled = false;
  }
}

function render(state) {
  const progress = state.progress;
  latestProgress = progress;
  const roll = state.pending_roll || state.latest_roll || state.batches.at(-1)?.report || null;
  const pending = Boolean(state.pending_roll);
  currentRoll = roll;
  currentRollPending = pending;
  selectedPosition = null;
  selectedPhysicalId = null;
  updateSelectedDieActions(null);
  showOrderPath = false;
  showOrderNumbers = false;
  $("toggleOrderPath").textContent = "Show order path";
  $("toggleOrderNumbers").textContent = "Show positions";
  $("zoomTogglePath").classList.remove("active");
  $("zoomToggleNumbers").classList.remove("active");
  $("zoomSelection").textContent = "No die selected";
  $("selectedInspection").classList.add("hidden");
  $("selectedDie").textContent = "Tap a value to locate that die.";
  show("report", progress.complete ? "Complete" : "Roll more");
  const percent = Math.min(100, 100 * progress.pool_entropy_bits / progress.target_bits);
  $("progressBar").style.width = `${percent}%`;
  $("bitProgress").textContent = `${progress.pool_entropy_bits.toFixed(2)} / ${progress.target_bits} bits`;
  $("rollProgress").textContent = pending
    ? `${roll?.accepted_count || 0} dice pending approval`
    : `${progress.accepted_rolls} accepted dice`;
  const displayImageUrl = roll?.raw_image_url || roll?.image_url;
  $("reportImage").classList.toggle("hidden", !displayImageUrl);
  if (displayImageUrl) $("reportImage").src = reviewImageSrc(displayImageUrl);
  if (roll?.raw_image_url) $("rawReportImage").src = reviewImageSrc(roll.raw_image_url);
  else if (roll?.image_url) $("rawReportImage").src = reviewImageSrc(roll.image_url);
  const accepted = roll?.accepted_count || 0;
  const rejected = roll?.manual_rejected_count || 0;
  const skipped = roll?.skipped_count || 0;
  const total = roll?.total || 0;
  const summaryItems = [
    `<div><b>${accepted}</b><span>${pending ? "ready this roll" : "accepted this roll"}</span></div>`,
    ...(pending || rejected ? [`<div><b>${rejected}</b><span>rejected</span></div>`] : []),
    `<div><b>${skipped}</b><span>skipped</span></div>`,
    `<div><b>${total}</b><span>roll total</span></div>`,
  ];
  $("summary").innerHTML = summaryItems.join("");
  const values = roll?.values || [];
  $("values").innerHTML = values.map((value, index) => `<button type="button" data-position="${index + 1}" aria-label="Highlight entropy position ${index + 1}, value ${value}"><small>${index + 1}</small><b>${value}</b></button>`).join("");
  $("values").querySelectorAll("button").forEach((button) => button.addEventListener("click", () => selectPosition(Number(button.dataset.position))));
  const rejectedSet = rejectedPhysicalIds();
  const rejectedRowsForChips = (roll?.accepted || []).filter((item) => rejectedSet.has(Number(item.physical_id)));
  $("rejectedDice").classList.toggle("hidden", !rejectedRowsForChips.length);
  $("rejectedDice").innerHTML = rejectedRowsForChips.map((item) => `<button type="button" data-physical-id="${item.physical_id}">Rejected ${item.id || `D${String(item.physical_id).padStart(2, "0")}`} | value ${item.value}</button>`).join("");
  $("rejectedDice").querySelectorAll("button").forEach((button) => button.addEventListener("click", () => selectPhysicalDie(Number(button.dataset.physicalId), true)));
  const statusById = Object.fromEntries((roll?.accepted || []).map((item) => [item.physical_id, item]));
  const acceptedRows = (roll?.ordering?.dice || []).map((item) => {
    const status = statusById[item.physical_id] || {};
    const confidence = status.face_confidence == null ? "-" : `${(100 * status.face_confidence).toFixed(1)}%`;
    const margin = status.margin == null ? "-" : `${(100 * status.margin).toFixed(1)}%`;
    const ready = status.ready_confidence == null ? "-" : `${(100 * status.ready_confidence).toFixed(1)}%`;
    const runnerUp = status.runner_up_value == null || status.runner_up_confidence == null ? "-" : `${status.runner_up_value} at ${(100 * status.runner_up_confidence).toFixed(1)}%`;
    const luminance = status.best_center_median_luminance == null ? "-" : Number(status.best_center_median_luminance).toFixed(1);
    return `<button type="button" data-position="${item.position}"><b>Position ${item.position} | ${item.id} | value ${item.value}</b><small>face ${confidence} | runner-up ${runnerUp} | margin ${margin} | ready ${ready}<br>${status.observations ?? 0} observations | ${status.stable_predictions ?? 0} stable | first ready ${status.first_green_observation ?? "-"} | luminance ${luminance} | ${status.reason || "accepted"}</small></button>`;
  });
  const rejectedRows = (roll?.accepted || []).filter((item) => rejectedSet.has(Number(item.physical_id))).map((item) => `<button type="button" class="rejectedRow" data-physical-id="${item.physical_id}"><b>${item.id || `D${String(item.physical_id).padStart(2, "0")}`} | value ${item.value} | rejected by you</b><small>Excluded from this roll. Select it to restore before accepting.</small></button>`);
  const skippedRows = (roll?.skipped || []).map((item) => `<div><b>${item.id || "Die"} | skipped</b><small>predicted ${item.predicted_value ?? "-"} | face ${item.face_confidence == null ? "-" : `${(100 * item.face_confidence).toFixed(1)}%`} | margin ${item.margin == null ? "-" : `${(100 * item.margin).toFixed(1)}%`} | ready ${item.ready_confidence == null ? "-" : `${(100 * item.ready_confidence).toFixed(1)}%`}<br>${item.observations ?? 0} observations | ${item.stable_predictions ?? 0} stable | ${item.skip_reason || item.reason || "uncertain"}</small></div>`);
  $("detailRows").innerHTML = [...acceptedRows, ...rejectedRows, ...skippedRows].join("") || "No accepted dice in this roll.";
  $("detailRows").querySelectorAll("button[data-position]").forEach((button) => button.addEventListener("click", () => selectPosition(Number(button.dataset.position), true)));
  $("detailRows").querySelectorAll("button[data-physical-id]").forEach((button) => button.addEventListener("click", () => selectPhysicalDie(Number(button.dataset.physicalId), true)));
  const finished = progress.complete || state.stopped;
  $("orderWarning").classList.toggle("hidden", !pending);
  if (pending) {
    const anchor = roll?.ordering?.anchor_physical_id;
    const axis = roll?.ordering?.axis_physical_id;
    const geometryNote = anchor == null
      ? ""
      : axis == null
        ? ` Position 1 is D${String(anchor).padStart(2, "0")}.`
        : ` Position 1 is D${String(anchor).padStart(2, "0")}; D${String(axis).padStart(2, "0")} establishes the primary direction.`;
    const orderNote = roll?.disposition === "order-confirmation-required" ? orderingReviewExplanation(roll?.ordering) : "";
    $("orderReviewTitle").textContent = "Review this roll";
    $("orderExplanation").textContent = `${orderNote}Check that every included die is real and the proposed order is correct.${geometryNote} Tap a numbered value or a die in the zoomed image to inspect it. Reject any false detection before accepting.`;
    $("acceptOrder").textContent = "Accept roll";
    $("acceptOrder").disabled = accepted === 0;
  }
  $("nextActions").classList.toggle("hidden", pending || finished);
  $("rollMore").textContent = progress.estimated_more_dice ? `Roll more | about ${progress.estimated_more_dice} dice` : "Roll more";
  $("complete").classList.toggle("hidden", !finished);
  $("completeTitle").textContent = state.stopped ? "Session ended" : "Complete";
  $("finishedOutput").classList.toggle("hidden", !progress.complete);
  $("incompleteOutput").classList.toggle("hidden", progress.complete);
  $("incompleteOutput").textContent = progress.complete ? "" : `${progress.accepted_rolls} accepted dice | ${progress.pool_entropy_bits.toFixed(2)} bits accrued`;
  if (progress.complete) renderRepresentations(progress);
  else if (state.stopped) destroySecretSession();
}

function rollMore() {
  stopCamera();
  show("roll", "Roll dice");
}

async function pending(action) {
  try {
    if (!localCollection || !localEntropyCollector) throw new Error("browser-local entropy session is unavailable");
    if (action === "retake") {
      localCollection.pending_roll = null;
      show("roll", "Roll dice");
      return;
    }
    if (action !== "accept-order") throw new Error(`unsupported local pending action ${action}`);
    const pendingRoll = localCollection.pending_roll;
    if (!pendingRoll) throw new Error("there is no pending roll");
    if (!(pendingRoll.ordering?.values || []).length) throw new Error("no dice remain in this roll; retake it instead");
    localEntropyCollector.appendBatch({
      values: pendingRoll.ordering.values,
      ordering: pendingRoll.ordering,
      report: pendingRoll,
    });
    localCollection.pending_roll = null;
    render(localBrowserState());
  } catch (error) {
    fail(error);
  }
}

async function endSession() {
  try {
    if (!localCollection || !localEntropyCollector) throw new Error("browser-local entropy session is unavailable");
    if (localEntropyCollector.complete) throw new Error("completed entropy collection cannot be stopped");
    localCollection.pending_roll = null;
    localCollection.stopped = true;
    stopCamera();
    render(localBrowserState());
  } catch (error) {
    fail(error);
  }
}

function clearCanvas(id) {
  const canvas = $(id);
  if (!canvas) return;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
}

function resetForAnotherSession() {
  representationRenderSerial += 1;
  localCollection = null;
  localEntropyCollector = null;
  localFrameInFlight = null;
  stopRecoveryQrScan();
  stopCamera();
  destroySecretSession();
  sessionId = null;
  currentRoll = null;
  selectedPosition = null;
  selectedPhysicalId = null;
  currentRollPending = false;
  latestProgress = null;
  showOrderPath = false;
  showOrderNumbers = false;
  zoomLevel = 1;

  $("representationOutputs").replaceChildren();
  resetRecoveryExport();
  resetRecoveryMetadata();
  resetSecretVerification();
  $("secretSourceStatus").textContent = "";
  $("values").replaceChildren();
  $("rejectedDice").replaceChildren();
  $("rejectedDice").classList.add("hidden");
  $("summary").replaceChildren();
  $("detailRows").replaceChildren();
  $("progressBar").style.width = "0%";
  $("bitProgress").textContent = "0 bits";
  $("rollProgress").textContent = "0 accepted dice";
  $("incompleteOutput").textContent = "";
  $("complete").classList.add("hidden");
  $("orderWarning").classList.add("hidden");
  $("selectedInspection").classList.add("hidden");
  $("selectedDie").textContent = "Tap a value to locate that die.";
  $("toggleOrderPath").textContent = "Show order path";
  $("toggleOrderNumbers").textContent = "Show positions";
  $("zoomTogglePath").classList.remove("active");
  $("zoomToggleNumbers").classList.remove("active");
  $("zoomSelection").textContent = "No die selected";
  $("imageZoom").classList.add("hidden");
  document.body.classList.remove("noScroll");
  ["reportImage", "rawReportImage", "zoomImage"].forEach((id) => $(id).removeAttribute("src"));
  ["reportOverlay", "selectedCrop", "zoomOverlay"].forEach(clearCanvas);
  show("setup", "Ready");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

$("start").addEventListener("click", beginCollection);
$("detect").addEventListener("click", startDetection);
$("acceptLive").addEventListener("click", acceptLiveRoll);
$("rollMore").addEventListener("click", rollMore);
$("endSession").addEventListener("click", endSession);
$("startAnother").addEventListener("click", resetForAnotherSession);
$("toggleBrowserMix").addEventListener("click", toggleBrowserMixReveal);
$("acceptOrder").addEventListener("click", () => pending("accept-order"));
$("retakeOrder").addEventListener("click", () => pending("retake"));
$("selectedDieAction").addEventListener("click", toggleSelectedDieRejected);
$("zoomDieAction").addEventListener("click", toggleSelectedDieRejected);
$("toggleOrderPath").addEventListener("click", () => {
  showOrderPath = !showOrderPath;
  $("toggleOrderPath").textContent = showOrderPath ? "Hide order path" : "Show order path";
  $("zoomTogglePath").classList.toggle("active", showOrderPath);
  drawAllReportOverlays();
});
$("toggleOrderNumbers").addEventListener("click", () => {
  showOrderNumbers = !showOrderNumbers;
  $("toggleOrderNumbers").textContent = showOrderNumbers ? "Hide positions" : "Show positions";
  $("zoomToggleNumbers").classList.toggle("active", showOrderNumbers);
  drawAllReportOverlays();
});
$("decodeRecovery").addEventListener("click", decodeRecovery);
$("importRecoveryKit").addEventListener("click", () => importRecoveryKitText($("recoveryKitInput").value));
$("importRecoveryPassphrase").addEventListener("input", clearError);
$("startRecoveryQrScan").addEventListener("click", startRecoveryQrScan);
$("stopRecoveryQrScan").addEventListener("click", stopRecoveryQrScan);
$("chooseRecoveryQrImage").addEventListener("click", () => $("recoveryQrImage").click());
$("recoveryQrImage").addEventListener("change", async () => {
  await decodeRecoveryQrImage();
  $("recoveryQrImage").value = "";
});
$("recoveryKitFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    $("recoveryKitInput").value = text;
    await importRecoveryKitText(text);
  } catch (error) {
    fail(error);
  }
});
$("recoveryLabel").addEventListener("input", recoveryMetadataChanged);
$("recoveryNote").addEventListener("input", recoveryMetadataChanged);
$("createEncryptedRecovery").addEventListener("click", async () => {
  try { await createEncryptedRecoveryExport(); } catch (error) { fail(error); }
});
$("printEncryptedRecoverySheet").addEventListener("click", () => {
  try { printHtmlDocument(printableEncryptedRecoverySheetHtml()); } catch (error) { fail(error); }
});
$("downloadEncryptedRecoverySheet").addEventListener("click", () => {
  try { browserDownload("rollentropy-encrypted-recovery-sheet-v1.html", printableEncryptedRecoverySheetHtml(), "text/html;charset=utf-8"); } catch (error) { fail(error); }
});
$("downloadEncryptedRecoveryKit").addEventListener("click", () => {
  if (!latestEncryptedRecoveryKit) return fail(new Error("encrypted recovery kit is not ready"));
  browserDownload("rollentropy-encrypted-recovery-kit-v1.json", encryption.serializeEncryptedKit(latestEncryptedRecoveryKit), "application/json;charset=utf-8");
});
$("copyEncryptedRecoveryKit").addEventListener("click", async () => {
  if (!latestEncryptedRecoveryKit) return fail(new Error("encrypted recovery kit is not ready"));
  try { await navigator.clipboard.writeText(encryption.serializeEncryptedKit(latestEncryptedRecoveryKit)); } catch (error) { fail(error); }
});
$("downloadEncryptedRecoveryQr").addEventListener("click", () => {
  if (!latestEncryptedRecoveryQrSvg) return fail(new Error("encrypted recovery QR is not ready"));
  browserDownload("rollentropy-encrypted-recovery-qr-v1.svg", latestEncryptedRecoveryQrSvg, "image/svg+xml;charset=utf-8");
});
$("copyEncryptedQrPayload").addEventListener("click", async () => {
  if (!latestEncryptedRecoveryKit) return fail(new Error("encrypted recovery QR payload is not ready"));
  try { await navigator.clipboard.writeText(latestEncryptedRecoveryKit.qr_payload); } catch (error) { fail(error); }
});
$("printRecordSheet").addEventListener("click", printRecordSheet);
$("downloadRecordSheet").addEventListener("click", () => {
  try { browserDownload("rollentropy-blank-record-sheet-v1.html", printableRecordSheetHtml(), "text/html;charset=utf-8"); } catch (error) { fail(error); }
});
$("printRecoverySheet").addEventListener("click", printRecoverySheet);
$("downloadRecoverySheet").addEventListener("click", () => {
  try {
    browserDownload("rollentropy-recovery-sheet-v1.html", printableRecoverySheetHtml(), "text/html;charset=utf-8");
  } catch (error) {
    fail(error);
  }
});
$("downloadRecoveryKit").addEventListener("click", () => {
  if (!latestRecoveryKit) return fail(new Error("recovery kit is not ready"));
  try { browserDownload("rollentropy-recovery-kit-v1.json", recovery.serializeKit(recoveryKitWithCurrentMetadata()), "application/json;charset=utf-8"); } catch (error) { fail(error); }
});
$("copyRecoveryKit").addEventListener("click", async () => {
  if (!latestRecoveryKit) return fail(new Error("recovery kit is not ready"));
  try { await navigator.clipboard.writeText(recovery.serializeKit(recoveryKitWithCurrentMetadata())); } catch (error) { fail(error); }
});
$("downloadRecoveryQr").addEventListener("click", () => {
  if (!latestRecoveryQrSvg) return fail(new Error("recovery QR is not ready"));
  browserDownload("rollentropy-recovery-qr-v1.svg", latestRecoveryQrSvg, "image/svg+xml;charset=utf-8");
});
$("copyQrPayload").addEventListener("click", async () => {
  if (!latestRecoveryKit) return fail(new Error("recovery QR payload is not ready"));
  try { await navigator.clipboard.writeText(latestRecoveryKit.qr_payload); } catch (error) { fail(error); }
});
setupCodecUi();
window.addEventListener("pagehide", () => {
  stopRecoveryQrScan();
  stopCamera();
  destroySecretSession();
});
$("reportImage").addEventListener("load", drawAllReportOverlays);
$("rawReportImage").addEventListener("load", drawSelectedCrop);
$("zoomReport").addEventListener("click", () => {
  zoomLevel = 1;
  $("zoomImage").src = $("reportImage").src;
  $("zoomStage").style.width = "100%";
  $("imageZoom").classList.remove("hidden");
  document.body.classList.add("noScroll");
  const item = (currentRoll?.ordering?.dice || []).find((die) => die.position === selectedPosition);
  $("zoomSelection").textContent = item ? `Selected: #${item.position} | ${item.id} | value ${item.value}` : "No die selected";
  requestAnimationFrame(drawAllReportOverlays);
});
$("reportImage").addEventListener("click", () => $("zoomReport").click());
$("closeZoom").addEventListener("click", () => {
  $("imageZoom").classList.add("hidden");
  document.body.classList.remove("noScroll");
});
function setZoom(change) {
  zoomLevel = Math.max(1, Math.min(4, change === 0 ? 1 : zoomLevel + change));
  $("zoomStage").style.width = `${100 * zoomLevel}%`;
  requestAnimationFrame(drawAllReportOverlays);
}
$("zoomIn").addEventListener("click", () => setZoom(0.5));
$("zoomOut").addEventListener("click", () => setZoom(-0.5));
$("zoomReset").addEventListener("click", () => setZoom(0));
$("zoomTogglePath").addEventListener("click", () => $("toggleOrderPath").click());
$("zoomToggleNumbers").addEventListener("click", () => $("toggleOrderNumbers").click());
$("zoomImage").addEventListener("load", drawAllReportOverlays);
$("zoomOverlay").addEventListener("click", selectZoomedDie);
window.addEventListener("resize", () => {
  drawAllReportOverlays();
  drawSelectedCrop();
});

async function loadBuildIdentity() {
  const target = $("buildIdentity");
  if (!target) return;
  try {
    const response = await fetch("/build-manifest.json", { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok) {
      target.textContent = "source / unverified build";
      return;
    }
    const payload = new Uint8Array(await response.arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", payload));
    const manifestHash = Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join("");
    const manifest = JSON.parse(new TextDecoder().decode(payload));
    target.textContent = `build ${String(manifest.source_commit || "unknown").slice(0, 12)} / manifest ${manifestHash.slice(0, 12)}`;
  } catch (error) {
    target.textContent = `build identity unavailable: ${error.message || String(error)}`;
  }
}

loadBuildIdentity();
