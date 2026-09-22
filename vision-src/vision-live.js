import { TopObbBrowser } from './vision-top.js';
import { MotionEstimatorBrowser } from './vision-motion.js';
import { PersistentConstellationTrackerBrowser } from './vision-tracker.js';
import { TemporalPipBrowser } from './vision-temporal.js';
import {
  orderSpatialRoll,
  orderSpatialRollFromQuadSamples,
  quadsFromIdentityMap,
} from './entropy-ordering.js';

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

function cloneQuad(quad) {
  return quad.map(point => [Number(point[0]), Number(point[1])]);
}

function cloneQuads(quads) {
  return Object.fromEntries(
    Object.entries(quads || {}).map(([id, quad]) => [String(id), cloneQuad(quad)]),
  );
}

function canvasDataUrl(canvas, quality = 0.94) {
  return canvas.toDataURL('image/jpeg', quality);
}

function visibleQuads(tracks) {
  return Object.fromEntries(
    tracks.map(track => [String(track.physical_id), cloneQuad(track.quad_px)]),
  );
}

function acceptedValueMap(rows) {
  return Object.fromEntries(rows.map(row => [String(row.physical_id), Number(row.value)]));
}

function chooseReportCandidate(candidates, acceptedIds) {
  if (!candidates.length) return null;
  let best = candidates[0];
  let bestScore = [-1, -1, -1];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const ids = new Set(Object.keys(candidate.quads).map(Number));
    const acceptedVisible = acceptedIds.reduce((count, id) => count + (ids.has(id) ? 1 : 0), 0);
    const score = [acceptedVisible, ids.size, index];
    if (
      score[0] > bestScore[0] ||
      (score[0] === bestScore[0] && score[1] > bestScore[1]) ||
      (score[0] === bestScore[0] && score[1] === bestScore[1] && score[2] > bestScore[2])
    ) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

export class BrowserDiceVisionRuntime {
  constructor(topReader, motion, tracker, temporal) {
    this.topReader = topReader;
    this.motion = motion;
    this.tracker = tracker;
    this.temporal = temporal;
    this.reset();
  }

  static async create() {
    const trackingConfigPromise = fetchJson('/models/tracking-config.json');
    const topPromise = TopObbBrowser.create('/models/top-obb.onnx');
    const temporalPromise = TemporalPipBrowser.create();
    const trackingConfig = await trackingConfigPromise;
    const [topReader, temporal] = await Promise.all([topPromise, temporalPromise]);
    return new BrowserDiceVisionRuntime(
      topReader,
      new MotionEstimatorBrowser(trackingConfig),
      new PersistentConstellationTrackerBrowser(trackingConfig),
      temporal,
    );
  }

  reset() {
    this.motion?.reset();
    this.tracker?.reset();
    this.temporal?.reset();
    this.framesProcessed = 0;
    this.bestVisibleCount = -1;
    this.bestImageUrl = '';
    this.bestQuads = {};
    this.bestWidth = 0;
    this.bestHeight = 0;
    this.lastFrame = null;
    this.geometrySamples = [];
    this.reportCandidates = [];
  }

  destroy() {
    this.motion?.destroy();
    this.reset();
  }

  rememberGeometry(quads) {
    if (Object.keys(quads).length < 3) return;
    this.geometrySamples.push(cloneQuads(quads));
    // Browser TOP is intentionally slow, so 32 views already represents a long scan.
    // Bound this tiny geometry history without retaining camera pixels.
    if (this.geometrySamples.length > 32) this.geometrySamples.shift();
  }

  rememberReportCandidate(canvas, quads) {
    if (!Object.keys(quads).length) return;
    this.reportCandidates.push({
      image_url: canvasDataUrl(canvas),
      quads: cloneQuads(quads),
      width: Number(canvas.width),
      height: Number(canvas.height),
    });
    if (this.reportCandidates.length > 12) this.reportCandidates.shift();
  }

  async processCanvas(canvas) {
    const width = Number(canvas.width);
    const height = Number(canvas.height);
    if (!width || !height) throw new Error('camera canvas has no pixels');

    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('2D canvas unavailable');
    const imageData = context.getImageData(0, 0, width, height);
    const started = performance.now();

    const motionStart = performance.now();
    const frameMotion = this.motion.update(imageData);
    const motionEnd = performance.now();

    const topStart = performance.now();
    const readings = await this.topReader.read(canvas, width, height);
    const topEnd = performance.now();

    const trackerStart = performance.now();
    const tracked = this.tracker.update(readings, frameMotion);
    const trackerEnd = performance.now();

    const temporalStart = performance.now();
    await this.temporal.update(imageData, tracked.visible, tracked.frame_index);
    const temporalEnd = performance.now();

    this.framesProcessed += 1;
    const history = this.tracker.historyViews();
    const historyIds = history.map(track => Number(track.physical_id));
    const statuses = this.temporal.statuses(historyIds);

    const tracks = tracked.visible.map(track => {
      const physicalId = Number(track.physical_id);
      const status = statuses.get(physicalId);
      return {
        physical_id: physicalId,
        quad_px: cloneQuad(track.quad_px),
        state: status?.state ?? 'gray',
        value: status?.value ?? null,
        predicted_value: status?.predicted_value ?? null,
        face_confidence: status?.face_confidence ?? null,
        observations: status?.observations ?? 0,
      };
    });

    const readyVisible = tracks.filter(row => row.state === 'green').length;
    let readyTotal = 0;
    for (const status of statuses.values()) {
      if (status.state === 'green') readyTotal += 1;
    }

    const currentQuads = visibleQuads(tracked.visible);
    if (tracked.visible.length > this.bestVisibleCount) {
      this.bestVisibleCount = tracked.visible.length;
      this.bestImageUrl = canvasDataUrl(canvas);
      this.bestQuads = cloneQuads(currentQuads);
      this.bestWidth = width;
      this.bestHeight = height;
    }
    this.rememberGeometry(currentQuads);
    this.rememberReportCandidate(canvas, currentQuads);

    const finished = performance.now();
    this.lastFrame = {
      format: 'dicevision-live-product-frame-v1',
      frame_index: tracked.frame_index,
      width,
      height,
      visible: tracks.length,
      detected_total: history.length,
      ready: readyTotal,
      ready_visible: readyVisible,
      tracks,
      timing_ms: {
        motion: motionEnd - motionStart,
        top: topEnd - topStart,
        tracker: trackerEnd - trackerStart,
        temporal: temporalEnd - temporalStart,
        model: finished - started,
        total: finished - started,
      },
      tracker_mode: tracked.mode,
    };
    return this.lastFrame;
  }

  finalizePreview() {
    const history = this.tracker.historyViews();
    if (!history.length) throw new Error('no persistent dice were established');
    const ids = history.map(track => Number(track.physical_id));
    const rows = this.temporal.finalRows(ids);
    const accepted = [];
    const skipped = [];

    for (const row of rows) {
      if (row.state === 'green' && row.value != null && !this.temporal.isDarkUnsupported(row.physical_id)) {
        accepted.push(row);
      } else {
        skipped.push({
          ...row,
          skip_reason: this.temporal.isDarkUnsupported(row.physical_id)
            ? 'dark-die-out-of-distribution'
            : `value-${row.state}`,
        });
      }
    }

    return {
      accepted,
      skipped,
      report_quads: cloneQuads(this.bestQuads),
      report_width: this.bestWidth,
      report_height: this.bestHeight,
      raw_image_url: this.bestImageUrl,
      frames_processed: this.framesProcessed,
    };
  }

  finalizeRoll() {
    const preview = this.finalizePreview();
    const values = acceptedValueMap(preview.accepted);
    const acceptedIds = preview.accepted.map(row => Number(row.physical_id));
    if (!acceptedIds.length) throw new Error('no GREEN dice are available to review');

    const identityQuads = quadsFromIdentityMap(this.tracker.persistentIdentityMap());
    const ordering = orderSpatialRollFromQuadSamples(
      [...this.geometrySamples, identityQuads],
      values,
    );
    if (!ordering.values.length) {
      throw new Error(`canonical spatial ordering produced no accepted dice (${ordering.reasons.join(', ') || 'unknown reason'})`);
    }

    const candidate = chooseReportCandidate(this.reportCandidates, acceptedIds);
    const imageUrl = candidate?.image_url || preview.raw_image_url || this.bestImageUrl;
    const reportQuads = candidate?.quads || preview.report_quads || cloneQuads(this.bestQuads);
    const report = {
      format: 'dicevision-product-roll-v1',
      frames_processed: this.framesProcessed,
      accepted_count: ordering.values.length,
      skipped_count: preview.skipped.length,
      accepted: preview.accepted.map(row => ({ ...row })),
      skipped: preview.skipped.map(row => ({ ...row })),
      ordering,
      values: ordering.values.slice(),
      total: ordering.values.reduce((sum, value) => sum + Number(value), 0),
      report_quads: cloneQuads(reportQuads),
      report_width: Number(candidate?.width || preview.report_width || this.bestWidth),
      report_height: Number(candidate?.height || preview.report_height || this.bestHeight),
      image_url: imageUrl,
      raw_image_url: imageUrl,
      disposition: ordering.automatic ? 'roll-review-required' : 'order-confirmation-required',
      manual_rejected_ids: [],
      manual_rejected_count: 0,
      detected_accepted_count: preview.accepted.length,
    };
    report._manual_review_source_ordering = structuredClone(ordering);
    return report;
  }

  rebuildPendingAfterManualRejection(report, rejectedPhysicalIds) {
    const pending = structuredClone(report);
    const sourceOrdering = pending._manual_review_source_ordering || pending.ordering;
    if (!sourceOrdering) throw new Error('pending roll has no ordering');
    pending._manual_review_source_ordering = structuredClone(sourceOrdering);

    const sourceValues = Object.fromEntries(
      (pending.accepted || [])
        .filter(row => row.physical_id != null && row.value != null)
        .map(row => [String(Number(row.physical_id)), Number(row.value)]),
    );
    const sourceIds = new Set(Object.keys(sourceValues).map(Number));
    const rejected = [...new Set(Array.from(rejectedPhysicalIds || [], Number))]
      .filter(id => sourceIds.has(id))
      .sort((a, b) => a - b);
    pending.manual_rejected_ids = rejected;
    pending.manual_rejected_count = rejected.length;
    pending.detected_accepted_count = Object.keys(sourceValues).length;

    const rejectedSet = new Set(rejected);
    const effectiveValues = Object.fromEntries(
      Object.entries(sourceValues).filter(([id]) => !rejectedSet.has(Number(id))),
    );

    let ordering;
    if (!rejected.length) {
      ordering = structuredClone(sourceOrdering);
    } else {
      const centers = {};
      for (const item of sourceOrdering.dice || []) {
        const id = Number(item.physical_id);
        if (sourceValues[id] == null) continue;
        const center = item.center || item.canonical_center;
        if (center) centers[id] = [Number(center[0]), Number(center[1])];
      }
      ordering = orderSpatialRoll(centers, effectiveValues);
      ordering.reasons = ['manual-die-rejection', ...ordering.reasons.filter(reason => reason !== 'manual-die-rejection')];
      ordering.automatic = false;
      ordering.normalization = sourceOrdering.normalization ?? null;
    }

    pending.ordering = ordering;
    pending.values = ordering.values.slice();
    pending.accepted_count = pending.values.length;
    pending.total = pending.values.reduce((sum, value) => sum + Number(value), 0);
    pending.disposition = pending.values.length ? 'roll-review-required' : 'no-accepted-dice-after-review';
    return pending;
  }
}
