import cv from './opencv-runtime.js';

function finiteMatrix(a) {
  return a.every(row => row.every(Number.isFinite));
}

function cvPointMat(points) {
  const mat = new cv.Mat(points.length, 1, cv.CV_32FC2);
  const flat = new Float32Array(points.length * 2);
  for (let i = 0; i < points.length; ++i) {
    flat[i * 2] = Number(points[i][0]);
    flat[i * 2 + 1] = Number(points[i][1]);
  }
  mat.data32F.set(flat);
  return mat;
}

function cvHomographyToArray(mat) {
  const data =
    mat.data64F && mat.data64F.length >= 9
      ? mat.data64F
      : (mat.data32F && mat.data32F.length >= 9 ? mat.data32F : null);

  if (data == null) return null;

  return [
    [Number(data[0]), Number(data[1]), Number(data[2])],
    [Number(data[3]), Number(data[4]), Number(data[5])],
    [Number(data[6]), Number(data[7]), Number(data[8])],
  ];
}

function motionParameters(configDocument) {
  const motion = configDocument?.tracking?.motion;
  if (!motion) throw new Error('tracking-config.json is missing tracking.motion');

  return {
    max_corners: Number(motion.max_corners),
    quality_level: Number(motion.quality_level),
    minimum_corner_distance_px: Number(motion.minimum_corner_distance_px),
    corner_block_size: Number(motion.corner_block_size),
    lk_window_px: Number(motion.lk_window_px),
    lk_max_level: Number(motion.lk_max_level),
    lk_iterations: Number(motion.lk_iterations),
    lk_epsilon: Number(motion.lk_epsilon),
    minimum_inliers: Number(motion.minimum_inliers),
    ransac_reprojection_threshold_px: Number(
      motion.ransac_reprojection_threshold_px
    ),
  };
}

export function grayFromImageData(imageData) {
  const rgba = cv.matFromImageData(imageData);
  const gray = new cv.Mat();

  try {
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  } finally {
    rgba.delete();
  }

  return gray;
}

export function estimateMotionHomography(previousGray, currentGray, P) {
  const detector = new cv.GFTTDetector();
  const keypoints = new cv.KeyPointVector();

  let cornersMat = null;
  let nextPoints = null;
  let status = null;
  let errors = null;
  let srcMat = null;
  let dstMat = null;
  let inlierMask = null;
  let rawH = null;

  try {
    detector.setMaxFeatures(P.max_corners);
    detector.setQualityLevel(P.quality_level);
    detector.setMinDistance(P.minimum_corner_distance_px);
    detector.setBlockSize(P.corner_block_size);
    detector.setHarrisDetector(false);
    detector.setK(0.04);
    detector.detect(previousGray, keypoints);

    if (keypoints.size() < 4) return null;

    const corners = [];
    for (let i = 0; i < keypoints.size(); ++i) {
      const kp = keypoints.get(i);
      corners.push([Number(kp.pt.x), Number(kp.pt.y)]);
    }

    cornersMat = cvPointMat(corners);
    nextPoints = new cv.Mat();
    status = new cv.Mat();
    errors = new cv.Mat();

    const criteria = new cv.TermCriteria(
      cv.TermCriteria_COUNT | cv.TermCriteria_EPS,
      P.lk_iterations,
      P.lk_epsilon
    );

    const winSize = new cv.Size(P.lk_window_px, P.lk_window_px);

    cv.calcOpticalFlowPyrLK(
      previousGray,
      currentGray,
      cornersMat,
      nextPoints,
      status,
      errors,
      winSize,
      P.lk_max_level,
      criteria,
      0,
      1e-4
    );

    const src = [];
    const dst = [];

    for (let i = 0; i < corners.length; ++i) {
      if (!status.data[i]) continue;

      const sx = corners[i][0];
      const sy = corners[i][1];
      const dx = Number(nextPoints.data32F[i * 2]);
      const dy = Number(nextPoints.data32F[i * 2 + 1]);

      if (
        !Number.isFinite(sx) ||
        !Number.isFinite(sy) ||
        !Number.isFinite(dx) ||
        !Number.isFinite(dy)
      ) {
        continue;
      }

      src.push([sx, sy]);
      dst.push([dx, dy]);
    }

    if (src.length < 4) return null;

    srcMat = cvPointMat(src);
    dstMat = cvPointMat(dst);
    inlierMask = new cv.Mat();

    rawH = cv.findHomography(
      srcMat,
      dstMat,
      cv.RANSAC,
      P.ransac_reprojection_threshold_px,
      inlierMask
    );

    if (rawH == null || rawH.rows !== 3 || rawH.cols !== 3) return null;

    let inlierCount = 0;
    for (let i = 0; i < inlierMask.data.length; ++i) {
      if (inlierMask.data[i]) ++inlierCount;
    }

    if (inlierCount < P.minimum_inliers) return null;

    const H = cvHomographyToArray(rawH);
    return H != null && finiteMatrix(H) ? H : null;
  } finally {
    if (rawH) rawH.delete();
    if (inlierMask) inlierMask.delete();
    if (dstMat) dstMat.delete();
    if (srcMat) srcMat.delete();
    if (errors) errors.delete();
    if (status) status.delete();
    if (nextPoints) nextPoints.delete();
    if (cornersMat) cornersMat.delete();
    keypoints.delete();
    detector.delete();
  }
}

export class MotionEstimatorBrowser {
  constructor(configDocument) {
    this.parameters = motionParameters(configDocument);
    this.previousGray = null;
  }

  reset() {
    if (this.previousGray) this.previousGray.delete();
    this.previousGray = null;
  }

  update(imageData) {
    const currentGray = grayFromImageData(imageData);
    let H = null;

    try {
      if (this.previousGray) {
        H = estimateMotionHomography(
          this.previousGray,
          currentGray,
          this.parameters
        );
      }
    } finally {
      if (this.previousGray) this.previousGray.delete();
      this.previousGray = currentGray;
    }

    return H;
  }

  destroy() {
    this.reset();
  }
}

export { motionParameters };
