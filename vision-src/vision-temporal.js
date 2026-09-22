import * as ort from '/vendor/onnxruntime/ort.wasm.bundle.min.mjs';
import cv from './opencv-runtime.js';
const INPUT_SIZE = 160;
const EMBEDDING_DIM = 256;
const DARK_TOP_MEDIAN_THRESHOLD = 75.0;

// The production site vendors the exact ORT WASM artifact. Keep all inference local.
ort.env.wasm.wasmPaths = {
  wasm: new URL(
    '/vendor/onnxruntime/ort-wasm-simd-threaded.wasm',
    window.location.origin,
  ).href,
};
if (!globalThis.crossOriginIsolated) ort.env.wasm.numThreads = 1;

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function softmax(values) {
  let maximum = -Infinity;
  for (const value of values) maximum = Math.max(maximum, value);
  const exps = values.map(value => Math.exp(value - maximum));
  const total = exps.reduce((a, b) => a + b, 0);
  return exps.map(value => value / total);
}

function summarizeFace(logits) {
  const probabilities = softmax(logits);
  const ordered = probabilities
    .map((probability, index) => ({ probability, index }))
    .sort((a, b) => b.probability - a.probability);
  return {
    predicted_value: ordered[0].index + 1,
    face_confidence: ordered[0].probability,
    runner_up_value: ordered[1].index + 1,
    runner_up_confidence: ordered[1].probability,
    margin: ordered[0].probability - ordered[1].probability,
  };
}

function orderQuadForCrop(quad) {
  if (!Array.isArray(quad) || quad.length !== 4) {
    throw new Error('temporal crop requires a four-corner quad');
  }
  const points = quad.map(point => [Number(point[0]), Number(point[1])]);
  if (!points.every(point => point.every(Number.isFinite))) {
    throw new Error('temporal crop quad contains a non-finite coordinate');
  }

  const center = [
    points.reduce((sum, point) => sum + point[0], 0) / 4,
    points.reduce((sum, point) => sum + point[1], 0) / 4,
  ];

  let ordered = points
    .slice()
    .sort((a, b) =>
      Math.atan2(a[1] - center[1], a[0] - center[0]) -
      Math.atan2(b[1] - center[1], b[0] - center[0])
    );

  // Start at the visually upper-left corner, matching the Python reader's
  // stable cyclic convention, then make the first outgoing edge go right.
  let start = 0;
  for (let i = 1; i < 4; ++i) {
    const score = ordered[i][0] + ordered[i][1];
    const best = ordered[start][0] + ordered[start][1];
    if (score < best) start = i;
  }
  ordered = ordered.slice(start).concat(ordered.slice(0, start));
  if (ordered[1][0] < ordered[3][0]) {
    ordered = [ordered[0], ordered[3], ordered[2], ordered[1]];
  }
  return ordered;
}

function pointMat(points) {
  const flat = [];
  for (const [x, y] of points) flat.push(Number(x), Number(y));
  return cv.matFromArray(4, 1, cv.CV_32FC2, flat);
}

function median(values) {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  if (values.length % 2) return values[middle];
  return 0.5 * (values[middle - 1] + values[middle]);
}

function cropToChwAndLuminance(sourceRgba, quad, size = INPUT_SIZE) {
  const ordered = orderQuadForCrop(quad);
  const src = pointMat(ordered);
  const dst = pointMat([
    [0, 0],
    [size - 1, 0],
    [size - 1, size - 1],
    [0, size - 1],
  ]);
  const transform = cv.getPerspectiveTransform(src, dst);
  const warped = new cv.Mat();

  try {
    cv.warpPerspective(
      sourceRgba,
      warped,
      transform,
      new cv.Size(size, size),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(0, 0, 0, 255),
    );

    const plane = size * size;
    const chw = new Float32Array(3 * plane);
    const centerGray = [];
    const lo = Math.floor(size / 4);
    const hi = Math.floor((3 * size) / 4);

    for (let y = 0; y < size; ++y) {
      for (let x = 0; x < size; ++x) {
        const pixel = y * size + x;
        const srcOffset = 4 * pixel;
        const r = warped.data[srcOffset];
        const g = warped.data[srcOffset + 1];
        const b = warped.data[srcOffset + 2];
        chw[pixel] = r;
        chw[plane + pixel] = g;
        chw[2 * plane + pixel] = b;
        if (x >= lo && x < hi && y >= lo && y < hi) {
          centerGray.push(Math.round(0.299 * r + 0.587 * g + 0.114 * b));
        }
      }
    }

    return {
      chw,
      center_median_luminance: median(centerGray),
    };
  } finally {
    warped.delete();
    transform.delete();
    dst.delete();
    src.delete();
  }
}

function strictPolicyFromDocument(document) {
  const profile = document?.profiles?.strict;
  const yellow = document?.yellow;
  if (!profile || !yellow) {
    throw new Error('status-policy.json is missing strict/yellow policy data');
  }
  return {
    face_confidence_threshold: Number(profile.face_confidence_threshold),
    margin_threshold: Number(profile.margin_threshold),
    minimum_observations: Number(profile.minimum_observations),
    minimum_stable_predictions: Number(profile.minimum_stable_predictions),
    yellow_face_confidence_threshold: Number(yellow.face_confidence_threshold),
    yellow_margin_threshold: Number(yellow.margin_threshold),
  };
}

function qualifiesGreen(prediction, policy) {
  return (
    prediction.observations >= policy.minimum_observations &&
    prediction.face_confidence >= policy.face_confidence_threshold &&
    prediction.margin >= policy.margin_threshold
  );
}

function statusFromPredictions(physicalId, predictions, policy, firstGreen) {
  if (!predictions.length) {
    return {
      physical_id: physicalId,
      id: `D${String(physicalId).padStart(2, '0')}`,
      state: 'gray',
      value: null,
      predicted_value: null,
      face_confidence: null,
      runner_up_value: null,
      runner_up_confidence: null,
      margin: null,
      ready_confidence: null,
      observations: 0,
      stable_predictions: 0,
      first_green_observation: firstGreen ?? null,
      reason: 'no-observations',
    };
  }

  let streak = 0;
  let streakValue = null;
  for (const prediction of predictions) {
    if (qualifiesGreen(prediction, policy)) {
      if (prediction.predicted_value === streakValue) streak += 1;
      else {
        streakValue = prediction.predicted_value;
        streak = 1;
      }
    } else {
      streak = 0;
      streakValue = null;
    }
  }

  const last = predictions[predictions.length - 1];
  let state = 'gray';
  let value = null;
  let reason = 'insufficient-evidence';
  if (streak >= Math.max(1, policy.minimum_stable_predictions)) {
    state = 'green';
    value = last.predicted_value;
    reason = 'calibrated-green-policy';
  } else if (
    last.face_confidence >= policy.yellow_face_confidence_threshold &&
    last.margin >= policy.yellow_margin_threshold
  ) {
    state = 'yellow';
    value = last.predicted_value;
    reason = 'likely-value-needs-more-evidence';
  }

  return {
    physical_id: physicalId,
    id: `D${String(physicalId).padStart(2, '0')}`,
    state,
    value,
    predicted_value: last.predicted_value,
    face_confidence: last.face_confidence,
    runner_up_value: last.runner_up_value,
    runner_up_confidence: last.runner_up_confidence,
    margin: last.margin,
    ready_confidence: last.ready_confidence,
    observations: predictions.length,
    stable_predictions: streak,
    first_green_observation: firstGreen ?? null,
    reason,
  };
}

export class TemporalPipBrowser {
  constructor(encoder, reducer, policy) {
    this.encoder = encoder;
    this.reducer = reducer;
    this.policy = policy;
    this.reset();
  }

  static async create({
    encoderUrl = '/models/temporal-frame-encoder.onnx',
    reducerUrl = '/models/temporal-reducer.onnx',
    statusPolicyUrl = '/models/status-policy.json',
  } = {}) {
    const policyResponse = await fetch(statusPolicyUrl, { cache: 'no-store' });
    if (!policyResponse.ok) {
      throw new Error(`status policy HTTP ${policyResponse.status}`);
    }
    const policyDocument = await policyResponse.json();
    const [encoder, reducer] = await Promise.all([
      ort.InferenceSession.create(encoderUrl, { executionProviders: ['wasm'] }),
      ort.InferenceSession.create(reducerUrl, { executionProviders: ['wasm'] }),
    ]);
    return new TemporalPipBrowser(
      encoder,
      reducer,
      strictPolicyFromDocument(policyDocument),
    );
  }

  reset() {
    this.embeddings = new Map();
    this.predictions = new Map();
    this.firstGreen = new Map();
    this.bestLuminance = new Map();
  }

  statuses(physicalIds = null) {
    const ids = physicalIds == null
      ? Array.from(new Set([
          ...this.embeddings.keys(),
          ...this.predictions.keys(),
        ])).sort((a, b) => a - b)
      : Array.from(new Set(physicalIds.map(Number))).sort((a, b) => a - b);

    const out = new Map();
    for (const id of ids) {
      out.set(
        id,
        statusFromPredictions(
          id,
          this.predictions.get(id) ?? [],
          this.policy,
          this.firstGreen.get(id),
        ),
      );
    }
    return out;
  }

  async update(imageData, tracks, sourceFrameId) {
    const visible = [];
    const seen = new Set();
    for (const track of tracks) {
      const physicalId = Number(track.physical_id);
      if (!Number.isInteger(physicalId) || seen.has(physicalId) || track.visible === false) continue;
      seen.add(physicalId);
      visible.push(track);
    }
    if (!visible.length) return this.statuses();

    const sourceRgba = cv.matFromImageData(imageData);
    const cropSize = 3 * INPUT_SIZE * INPUT_SIZE;
    const batch = new Float32Array(visible.length * cropSize);

    try {
      for (let i = 0; i < visible.length; ++i) {
        const track = visible[i];
        const crop = cropToChwAndLuminance(sourceRgba, track.quad_px, INPUT_SIZE);
        batch.set(crop.chw, i * cropSize);
        const id = Number(track.physical_id);
        const lum = crop.center_median_luminance;
        if (lum != null) {
          const previous = this.bestLuminance.get(id);
          if (previous == null || lum > previous) this.bestLuminance.set(id, lum);
        }
      }
    } finally {
      sourceRgba.delete();
    }

    const encoderInput = new ort.Tensor(
      'float32',
      batch,
      [visible.length, 3, INPUT_SIZE, INPUT_SIZE],
    );
    const encoderOutputs = await this.encoder.run({ images: encoderInput });
    const encoded = encoderOutputs.embeddings ?? encoderOutputs[Object.keys(encoderOutputs)[0]];
    if (!encoded || encoded.dims.length !== 2 || encoded.dims[0] !== visible.length || encoded.dims[1] !== EMBEDDING_DIM) {
      throw new Error(`unexpected temporal encoder output: ${JSON.stringify(encoded?.dims)}`);
    }

    const updatedIds = [];
    for (let i = 0; i < visible.length; ++i) {
      const id = Number(visible[i].physical_id);
      const row = new Float32Array(EMBEDDING_DIM);
      row.set(encoded.data.subarray(i * EMBEDDING_DIM, (i + 1) * EMBEDDING_DIM));
      if (!this.embeddings.has(id)) this.embeddings.set(id, []);
      this.embeddings.get(id).push(row);
      updatedIds.push(id);
    }

    // The exported reducer consumes only embeddings (all timesteps valid).
    // Group tracks by observation count so no zero-padding is interpreted as evidence.
    const byLength = new Map();
    for (const id of updatedIds) {
      const length = this.embeddings.get(id).length;
      if (!byLength.has(length)) byLength.set(length, []);
      byLength.get(length).push(id);
    }

    for (const [length, ids] of byLength.entries()) {
      const reducerData = new Float32Array(ids.length * length * EMBEDDING_DIM);
      for (let row = 0; row < ids.length; ++row) {
        const history = this.embeddings.get(ids[row]);
        for (let t = 0; t < history.length; ++t) {
          reducerData.set(
            history[t],
            (row * length + t) * EMBEDDING_DIM,
          );
        }
      }
      const reducerInput = new ort.Tensor(
        'float32',
        reducerData,
        [ids.length, length, EMBEDDING_DIM],
      );
      const reducerOutputs = await this.reducer.run({ embeddings: reducerInput });
      const face = reducerOutputs.face_logits;
      const ready = reducerOutputs.ready_logit;
      if (!face || !ready) throw new Error('temporal reducer outputs are incomplete');

      for (let row = 0; row < ids.length; ++row) {
        const logits = Array.from(face.data.subarray(row * 6, row * 6 + 6));
        const summary = summarizeFace(logits);
        const prediction = {
          ...summary,
          ready_confidence: sigmoid(Number(ready.data[row])),
          observations: length,
          source_frame_id: Number(sourceFrameId),
        };
        const id = ids[row];
        if (!this.predictions.has(id)) this.predictions.set(id, []);
        this.predictions.get(id).push(prediction);

        const status = statusFromPredictions(
          id,
          this.predictions.get(id),
          this.policy,
          this.firstGreen.get(id),
        );
        if (status.state === 'green' && !this.firstGreen.has(id)) {
          this.firstGreen.set(id, length);
        }
      }
    }

    return this.statuses();
  }

  finalRows(physicalIds) {
    const statuses = this.statuses(physicalIds);
    return physicalIds.map(id => {
      const row = { ...statuses.get(Number(id)) };
      row.first_green_observation = this.firstGreen.get(Number(id)) ?? null;
      row.best_center_median_luminance = this.bestLuminance.get(Number(id)) ?? null;
      return row;
    });
  }

  isDarkUnsupported(physicalId) {
    const luminance = this.bestLuminance.get(Number(physicalId));
    return luminance != null && luminance < DARK_TOP_MEDIAN_THRESHOLD;
  }
}

export {
  INPUT_SIZE,
  DARK_TOP_MEDIAN_THRESHOLD,
  orderQuadForCrop,
  cropToChwAndLuminance,
  strictPolicyFromDocument,
};
