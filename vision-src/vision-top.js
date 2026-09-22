import * as ort from '/vendor/onnxruntime/ort.wasm.bundle.min.mjs';

ort.env.wasm.wasmPaths = {
  wasm: new URL(
    '/vendor/onnxruntime/ort-wasm-simd-threaded.wasm',
    window.location.origin,
  ).href,
};

/*
 * Until the production site sends the COOP/COEP headers needed for
 * cross-origin isolation, force the WASM backend to one thread.
 */
if (!globalThis.crossOriginIsolated) {
  ort.env.wasm.numThreads = 1;
}

const MODEL_SIZE = 1024;
const CONFIDENCE_FLOOR = 0.05;

function canvasForSource(source, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

function preprocessSource(source, sourceWidth, sourceHeight) {
  const scale = Math.min(
    MODEL_SIZE / sourceWidth,
    MODEL_SIZE / sourceHeight
  );
  const resizedWidth = Math.round(sourceWidth * scale);
  const resizedHeight = Math.round(sourceHeight * scale);
  const padWidth = MODEL_SIZE - resizedWidth;
  const padHeight = MODEL_SIZE - resizedHeight;
  const left = Math.floor(padWidth / 2);
  const top = Math.floor(padHeight / 2);

  const canvas = document.createElement('canvas');
  canvas.width = MODEL_SIZE;
  canvas.height = MODEL_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');

  ctx.fillStyle = 'rgb(114, 114, 114)';
  ctx.fillRect(0, 0, MODEL_SIZE, MODEL_SIZE);
  ctx.drawImage(source, left, top, resizedWidth, resizedHeight);

  const rgba = ctx.getImageData(0, 0, MODEL_SIZE, MODEL_SIZE).data;
  const plane = MODEL_SIZE * MODEL_SIZE;
  const chw = new Float32Array(3 * plane);

  for (let i = 0; i < plane; ++i) {
    const src = 4 * i;
    chw[i] = rgba[src] / 255.0;
    chw[plane + i] = rgba[src + 1] / 255.0;
    chw[2 * plane + i] = rgba[src + 2] / 255.0;
  }

  return {
    tensor: new ort.Tensor('float32', chw, [1, 3, MODEL_SIZE, MODEL_SIZE]),
    scale,
    left,
    top,
    sourceWidth,
    sourceHeight,
  };
}

function decodeQuad(row, transform) {
  const [cx, cy, width, height, , , angle] = row;
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const localCorners = [
    [ halfWidth,  halfHeight],
    [ halfWidth, -halfHeight],
    [-halfWidth, -halfHeight],
    [-halfWidth,  halfHeight],
  ];

  return localCorners.map(([x, y]) => {
    const modelX = cx + x * cosA - y * sinA;
    const modelY = cy + x * sinA + y * cosA;
    return [
      (modelX - transform.left) / transform.scale,
      (modelY - transform.top) / transform.scale,
    ];
  });
}

function decodeDetections(output, transform, confidenceFloor) {
  const dims = output.dims;
  if (dims.length !== 3 || dims[0] !== 1 || dims[2] !== 7) {
    throw new Error(`unexpected TOP output shape: ${JSON.stringify(dims)}`);
  }

  const detections = [];
  for (let i = 0; i < dims[1]; ++i) {
    const offset = i * 7;
    const row = Array.from(output.data.slice(offset, offset + 7));
    const confidence = Number(row[4]);
    if (confidence < confidenceFloor) continue;

    detections.push({
      detection_index: i,
      top_confidence: confidence,
      class_id: Number(row[5]),
      angle: Number(row[6]),
      quad_px: decodeQuad(row, transform),
    });
  }
  return detections;
}

export class TopObbBrowser {
  constructor(session, { confidenceFloor = CONFIDENCE_FLOOR } = {}) {
    this.session = session;
    this.confidenceFloor = Number(confidenceFloor);
  }

  static async create(
    modelUrl = '/models/top-obb.onnx',
    options = {}
  ) {
    const session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: options.executionProviders ?? ['wasm'],
    });
    return new TopObbBrowser(session, options);
  }

  async read(source, width, height) {
    const transform = preprocessSource(source, width, height);
    const outputs = await this.session.run({ images: transform.tensor });
    const output = outputs.output0 ?? outputs[Object.keys(outputs)[0]];
    if (!output) throw new Error('TOP model returned no output tensor');
    return decodeDetections(output, transform, this.confidenceFloor);
  }
}

export { MODEL_SIZE, CONFIDENCE_FLOOR, preprocessSource, decodeDetections };
