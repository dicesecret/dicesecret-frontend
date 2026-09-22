import cv from './opencv-runtime.js';

const INVALID_COST = 1_000_000.0;
const EPS = 1e-12;

function identity3() {
  return [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
}

function cloneMatrix(a) {
  return a.map(row => row.slice());
}

function matmul3(a, b) {
  const out = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];

  for (let i = 0; i < 3; ++i) {
    for (let j = 0; j < 3; ++j) {
      let value = 0;

      for (let k = 0; k < 3; ++k) {
        value += a[i][k] * b[k][j];
      }

      out[i][j] = value;
    }
  }

  return out;
}


function invert3(m) {
  const a = m[0][0];
  const b = m[0][1];
  const c = m[0][2];

  const d = m[1][0];
  const e = m[1][1];
  const f = m[1][2];

  const g = m[2][0];
  const h = m[2][1];
  const i = m[2][2];

  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;

  const D = -(b * i - c * h);
  const E = a * i - c * g;
  const F = -(a * h - b * g);

  const G = b * f - c * e;
  const H = -(a * f - c * d);
  const I = a * e - b * d;

  const determinant =
    a * A +
    b * B +
    c * C;

  if (
    !Number.isFinite(determinant) ||
    Math.abs(determinant) < 1e-12
  ) {
    return null;
  }

  const scale =
    1.0 / determinant;

  const inverse = [
    [
      A * scale,
      D * scale,
      G * scale,
    ],
    [
      B * scale,
      E * scale,
      H * scale,
    ],
    [
      C * scale,
      F * scale,
      I * scale,
    ],
  ];

  return finiteMatrix(inverse)
    ? inverse
    : null;
}

function finiteMatrix(a) {
  return a.every(
    row => row.every(Number.isFinite)
  );
}

function transformPoint(point, h) {
  const x = point[0];
  const y = point[1];

  const px =
    h[0][0] * x +
    h[0][1] * y +
    h[0][2];

  const py =
    h[1][0] * x +
    h[1][1] * y +
    h[1][2];

  const pw =
    h[2][0] * x +
    h[2][1] * y +
    h[2][2];

  if (Math.abs(pw) <= 1e-12) {
    return [NaN, NaN];
  }

  return [
    px / pw,
    py / pw,
  ];
}

function transformQuad(quad, h) {
  if (h == null) {
    return quad.map(p => p.slice());
  }

  return quad.map(
    point => transformPoint(point, h)
  );
}

function quadCenter(quad) {
  let x = 0;
  let y = 0;

  for (const p of quad) {
    x += p[0];
    y += p[1];
  }

  return [
    x / quad.length,
    y / quad.length,
  ];
}

function cross(o, a, b) {
  return (
    (a[0] - o[0]) * (b[1] - o[1]) -
    (a[1] - o[1]) * (b[0] - o[0])
  );
}

function convexHull(points) {
  const pts = points
    .map(p => [p[0], p[1]])
    .sort(
      (a, b) =>
        (a[0] - b[0]) ||
        (a[1] - b[1])
    );

  if (pts.length <= 1) {
    return pts;
  }

  const lower = [];

  for (const p of pts) {
    while (
      lower.length >= 2 &&
      cross(
        lower[lower.length - 2],
        lower[lower.length - 1],
        p
      ) <= 0
    ) {
      lower.pop();
    }

    lower.push(p);
  }

  const upper = [];

  for (let i = pts.length - 1; i >= 0; --i) {
    const p = pts[i];

    while (
      upper.length >= 2 &&
      cross(
        upper[upper.length - 2],
        upper[upper.length - 1],
        p
      ) <= 0
    ) {
      upper.pop();
    }

    upper.push(p);
  }

  lower.pop();
  upper.pop();

  return lower.concat(upper);
}

function polygonArea(points) {
  if (points.length < 3) {
    return 0;
  }

  let twiceArea = 0;

  for (let i = 0; i < points.length; ++i) {
    const j = (i + 1) % points.length;

    twiceArea +=
      points[i][0] * points[j][1] -
      points[i][1] * points[j][0];
  }

  return Math.abs(twiceArea) * 0.5;
}

function quadScale(quad) {
  const hull = convexHull(quad);
  const area = polygonArea(hull);

  return area > 0
    ? Math.sqrt(area)
    : 0;
}

function distance(a, b) {
  return Math.hypot(
    a[0] - b[0],
    a[1] - b[1]
  );
}

function readingQuad(reading) {
  return reading.quad_px;
}

/*
 * Hungarian / linear-sum assignment.
 *
 * Returns the same conceptual result as scipy.optimize.linear_sum_assignment:
 * min(rows, cols) row/column assignments.
 */
function hungarianRowsLeqCols(cost) {
  const n = cost.length;
  const m = cost[0].length;

  const u = new Float64Array(n + 1);
  const v = new Float64Array(m + 1);

  const p = new Int32Array(m + 1);
  const way = new Int32Array(m + 1);

  for (let i = 1; i <= n; ++i) {
    p[0] = i;

    let j0 = 0;

    const minv = new Float64Array(m + 1);
    minv.fill(Infinity);

    const used = new Uint8Array(m + 1);

    do {
      used[j0] = 1;

      const i0 = p[j0];

      let delta = Infinity;
      let j1 = 0;

      for (let j = 1; j <= m; ++j) {
        if (used[j]) {
          continue;
        }

        const cur =
          cost[i0 - 1][j - 1] -
          u[i0] -
          v[j];

        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }

        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }

      for (let j = 0; j <= m; ++j) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }

      j0 = j1;

    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  const pairs = [];

  for (let j = 1; j <= m; ++j) {
    if (p[j] !== 0) {
      pairs.push([
        p[j] - 1,
        j - 1,
      ]);
    }
  }

  return pairs;
}

function linearSumAssignment(cost) {
  const rows = cost.length;

  if (rows === 0) {
    return [];
  }

  const cols = cost[0].length;

  if (cols === 0) {
    return [];
  }

  if (rows <= cols) {
    return hungarianRowsLeqCols(cost);
  }

  const transposed =
    Array.from(
      {length: cols},
      (_, c) =>
        Array.from(
          {length: rows},
          (_, r) => cost[r][c]
        )
    );

  return hungarianRowsLeqCols(
    transposed
  ).map(
    ([c, r]) => [r, c]
  );
}

function normalizedAssignment(
  states,
  readings,
  homography,
  maximumNormalizedDistance
) {
  if (
    states.length === 0 ||
    readings.length === 0
  ) {
    return {
      matches: [],
      unmatchedStates:
        states.map((_, i) => i),
      unmatchedReadings:
        readings.map((_, i) => i),
      meanError: Infinity,
    };
  }

  const rows = states.length;
  const cols = readings.length;

  const cost =
    Array.from(
      {length: rows},
      () =>
        Array(cols).fill(INVALID_COST)
    );

  const normalized =
    Array.from(
      {length: rows},
      () =>
        Array(cols).fill(Infinity)
    );

  for (let si = 0; si < rows; ++si) {
    const state = states[si];

    const predicted =
      transformQuad(
        state.referenceQuad,
        homography
      );

    const predictedCenter =
      quadCenter(predicted);

    const predictedScale =
      quadScale(predicted);

    for (let ri = 0; ri < cols; ++ri) {
      const reading = readings[ri];

      const quad =
        readingQuad(reading);

      const center =
        quadCenter(quad);

      const scale =
        Math.max(
          1.0,
          0.5 * (
            predictedScale +
            quadScale(quad)
          )
        );

      const error =
        distance(
          center,
          predictedCenter
        ) / scale;

      normalized[si][ri] = error;

      if (
        error <=
        maximumNormalizedDistance
      ) {
        const topConfidence =
          Number(
            reading.top_confidence ?? 0
          );

        cost[si][ri] =
          error +
          (1.0 - topConfidence) * 1e-6;
      }
    }
  }

  const assignment =
    linearSumAssignment(cost);

  const matches = [];
  const errors = [];

  const usedStates = new Set();
  const usedReadings = new Set();

  for (const [si, ri] of assignment) {
    const error =
      normalized[si][ri];

    if (
      error >
      maximumNormalizedDistance
    ) {
      continue;
    }

    matches.push([si, ri]);
    errors.push(error);

    usedStates.add(si);
    usedReadings.add(ri);
  }

  const unmatchedStates = [];

  for (let i = 0; i < rows; ++i) {
    if (!usedStates.has(i)) {
      unmatchedStates.push(i);
    }
  }

  const unmatchedReadings = [];

  for (let i = 0; i < cols; ++i) {
    if (!usedReadings.has(i)) {
      unmatchedReadings.push(i);
    }
  }

  const meanError =
    errors.length
      ? (
          errors.reduce(
            (a, b) => a + b,
            0
          ) / errors.length
        )
      : Infinity;

  return {
    matches,
    unmatchedStates,
    unmatchedReadings,
    meanError,
  };
}

function requiredRegistrationMatches(
  knownCount,
  currentCount,
  minimumMatches,
  minimumMatchFraction
) {
  const available =
    Math.min(
      knownCount,
      currentCount
    );

  if (available <= 0) {
    return 0;
  }

  const preferredFloor =
    Math.min(
      minimumMatches,
      available
    );

  const fractional =
    Math.ceil(
      minimumMatchFraction *
      available
    );

  return Math.min(
    available,
    Math.max(
      1,
      preferredFloor,
      fractional
    )
  );
}

/*
 * Gaussian elimination with partial pivoting.
 */
function solveLinear(matrix, rhs) {
  const n = rhs.length;

  const a =
    matrix.map(
      (row, i) =>
        row.slice().concat(rhs[i])
    );

  for (let col = 0; col < n; ++col) {
    let pivot = col;
    let best =
      Math.abs(a[col][col]);

    for (
      let row = col + 1;
      row < n;
      ++row
    ) {
      const value =
        Math.abs(a[row][col]);

      if (value > best) {
        best = value;
        pivot = row;
      }
    }

    if (
      !Number.isFinite(best) ||
      best < 1e-12
    ) {
      return null;
    }

    if (pivot !== col) {
      const tmp = a[col];
      a[col] = a[pivot];
      a[pivot] = tmp;
    }

    const divisor =
      a[col][col];

    for (
      let j = col;
      j <= n;
      ++j
    ) {
      a[col][j] /= divisor;
    }

    for (
      let row = 0;
      row < n;
      ++row
    ) {
      if (row === col) {
        continue;
      }

      const factor =
        a[row][col];

      if (Math.abs(factor) < EPS) {
        continue;
      }

      for (
        let j = col;
        j <= n;
        ++j
      ) {
        a[row][j] -=
          factor * a[col][j];
      }
    }
  }

  return a.map(
    row => row[n]
  );
}

function solveLeastSquares(a, b) {
  if (
    a.length === 0 ||
    a[0].length === 0
  ) {
    return null;
  }

  const rows = a.length;
  const cols = a[0].length;

  const ata =
    Array.from(
      {length: cols},
      () =>
        Array(cols).fill(0)
    );

  const atb =
    Array(cols).fill(0);

  for (let r = 0; r < rows; ++r) {
    for (let i = 0; i < cols; ++i) {
      atb[i] +=
        a[r][i] * b[r];

      for (let j = 0; j < cols; ++j) {
        ata[i][j] +=
          a[r][i] * a[r][j];
      }
    }
  }

  return solveLinear(
    ata,
    atb
  );
}

/*
 * Reference homography refinement. This is the parity-proven OpenCV.js
 * cv.findHomography(..., RANSAC, threshold) path.
 */
function fitReferenceHomography(
  states,
  readings,
  matches,
  ransacReprojectionThresholdPx
) {
  if (matches.length < 4) {
    return null;
  }

  const srcValues = [];
  const dstValues = [];

  for (const [si, ri] of matches) {
    const src =
      quadCenter(
        states[si].referenceQuad
      );

    const dst =
      quadCenter(
        readingQuad(
          readings[ri]
        )
      );

    srcValues.push(
      src[0],
      src[1]
    );

    dstValues.push(
      dst[0],
      dst[1]
    );
  }

  /*
   * Python authority:
   *
   *   cv2.findHomography(
   *       src,
   *       dst,
   *       cv2.RANSAC,
   *       ransac_reprojection_threshold_px,
   *   )
   *
   * OpenCV internally converts the point sets to float32, so use an
   * N x 2 CV_32F representation here.
   */
  const srcMat =
    cv.matFromArray(
      matches.length,
      2,
      cv.CV_32F,
      srcValues
    );

  const dstMat =
    cv.matFromArray(
      matches.length,
      2,
      cv.CV_32F,
      dstValues
    );

  const mask =
    new cv.Mat();

  let homography = null;

  try {
    homography =
      cv.findHomography(
        srcMat,
        dstMat,
        cv.RANSAC,
        Number(
          ransacReprojectionThresholdPx
        ),
        mask
      );

    if (
      homography == null ||
      homography.empty() ||
      mask.empty()
    ) {
      return null;
    }

    let inliers = 0;

    for (
      let i = 0;
      i < mask.data.length;
      ++i
    ) {
      if (mask.data[i] !== 0) {
        ++inliers;
      }
    }

    /*
     * Match Python:
     *
     * if homography is None or mask is None
     * or count_nonzero(mask) < 4:
     *     return None
     */
    if (inliers < 4) {
      return null;
    }

    let values = null;

    if (
      homography.data64F &&
      homography.data64F.length >= 9
    ) {
      values =
        homography.data64F;
    } else if (
      homography.data32F &&
      homography.data32F.length >= 9
    ) {
      values =
        homography.data32F;
    } else {
      throw new Error(
        `unexpected homography storage: ` +
        `rows=${homography.rows} ` +
        `cols=${homography.cols} ` +
        `type=${homography.type()}`
      );
    }

    const result = [
      [
        Number(values[0]),
        Number(values[1]),
        Number(values[2]),
      ],
      [
        Number(values[3]),
        Number(values[4]),
        Number(values[5]),
      ],
      [
        Number(values[6]),
        Number(values[7]),
        Number(values[8]),
      ],
    ];

    return finiteMatrix(result)
      ? result
      : null;

  } finally {
    if (homography != null) {
      homography.delete();
    }

    mask.delete();
    srcMat.delete();
    dstMat.delete();
  }
}

function affineFromTriangles(
  src,
  dst
) {
  const a = [];
  const b = [];

  for (let i = 0; i < 3; ++i) {
    const x = src[i][0];
    const y = src[i][1];

    const xp = dst[i][0];
    const yp = dst[i][1];

    a.push([
      x, y, 1,
      0, 0, 0,
    ]);

    b.push(xp);

    a.push([
      0, 0, 0,
      x, y, 1,
    ]);

    b.push(yp);
  }

  const p =
    solveLinear(a, b);

  if (p == null) {
    return null;
  }

  const h = [
    [p[0], p[1], p[2]],
    [p[3], p[4], p[5]],
    [0, 0, 1],
  ];

  return finiteMatrix(h)
    ? h
    : null;
}

function refineReferenceTransform(
  states,
  readings,
  matches,
  seed,
  ransacReprojectionThresholdPx
) {
  if (matches.length === 0) {
    return null;
  }

  if (matches.length >= 4) {
    const projective =
      fitReferenceHomography(
        states,
        readings,
        matches,
        ransacReprojectionThresholdPx
      );

    if (projective != null) {
      return projective;
    }
  }

  const predicted =
    matches.map(
      ([si]) =>
        quadCenter(
          transformQuad(
            states[si].referenceQuad,
            seed
          )
        )
    );

  const observed =
    matches.map(
      ([, ri]) =>
        quadCenter(
          readingQuad(
            readings[ri]
          )
        )
    );

  let correction =
    identity3();

  if (matches.length === 1) {
    correction[0][2] =
      observed[0][0] -
      predicted[0][0];

    correction[1][2] =
      observed[0][1] -
      predicted[0][1];

  } else if (matches.length === 2) {
    const sourceVector = [
      predicted[1][0] -
        predicted[0][0],

      predicted[1][1] -
        predicted[0][1],
    ];

    const targetVector = [
      observed[1][0] -
        observed[0][0],

      observed[1][1] -
        observed[0][1],
    ];

    const sourceLength =
      Math.hypot(
        sourceVector[0],
        sourceVector[1]
      );

    const targetLength =
      Math.hypot(
        targetVector[0],
        targetVector[1]
      );

    if (
      sourceLength <= 1e-6 ||
      targetLength <= 1e-6
    ) {
      correction[0][2] =
        0.5 * (
          observed[0][0] -
          predicted[0][0] +
          observed[1][0] -
          predicted[1][0]
        );

      correction[1][2] =
        0.5 * (
          observed[0][1] -
          predicted[0][1] +
          observed[1][1] -
          predicted[1][1]
        );

    } else {
      const scale =
        targetLength /
        sourceLength;

      const cosine =
        (
          sourceVector[0] *
            targetVector[0] +
          sourceVector[1] *
            targetVector[1]
        ) /
        (
          sourceLength *
          targetLength
        );

      const sine =
        (
          sourceVector[0] *
            targetVector[1] -
          sourceVector[1] *
            targetVector[0]
        ) /
        (
          sourceLength *
          targetLength
        );

      const a =
        scale * cosine;

      const b =
        scale * sine;

      correction[0][0] = a;
      correction[0][1] = -b;

      correction[1][0] = b;
      correction[1][1] = a;

      correction[0][2] =
        observed[0][0] -
        (
          a * predicted[0][0] -
          b * predicted[0][1]
        );

      correction[1][2] =
        observed[0][1] -
        (
          b * predicted[0][0] +
          a * predicted[0][1]
        );
    }

  } else {
    const affine =
      affineFromTriangles(
        predicted.slice(0, 3),
        observed.slice(0, 3)
      );

    if (affine == null) {
      return null;
    }

    correction = affine;
  }

  const refined =
    matmul3(
      correction,
      seed
    );

  return finiteMatrix(refined)
    ? refined
    : null;
}

function triangleCandidates(
  points,
  maximumTriangles
) {
  const candidates = [];

  for (
    let i = 0;
    i < points.length;
    ++i
  ) {
    for (
      let j = i + 1;
      j < points.length;
      ++j
    ) {
      for (
        let k = j + 1;
        k < points.length;
        ++k
      ) {
        const a = [
          points[j][0] -
            points[i][0],

          points[j][1] -
            points[i][1],
        ];

        const b = [
          points[k][0] -
            points[i][0],

          points[k][1] -
            points[i][1],
        ];

        const area2 =
          Math.abs(
            a[0] * b[1] -
            a[1] * b[0]
          );

        const lengths = [
          distance(
            points[i],
            points[j]
          ),

          distance(
            points[i],
            points[k]
          ),

          distance(
            points[j],
            points[k]
          ),
        ];

        const shortest =
          Math.min(...lengths);

        const longest =
          Math.max(...lengths);

        if (
          shortest <= 1e-6 ||
          longest / shortest > 8.0
        ) {
          continue;
        }

        candidates.push({
          area2,
          ids: [i, j, k],
        });
      }
    }
  }

  candidates.sort(
    (a, b) =>
      b.area2 - a.area2
  );

  return candidates.slice(
    0,
    Math.max(
      1,
      maximumTriangles
    )
  );
}

function median(values) {
  const v =
    values.slice().sort(
      (a, b) => a - b
    );

  if (v.length === 0) {
    return NaN;
  }

  const middle =
    Math.floor(v.length / 2);

  if (v.length % 2) {
    return v[middle];
  }

  return 0.5 * (
    v[middle - 1] +
    v[middle]
  );
}

function coarseMutualGeometryScore(
  referencePoints,
  currentPoints,
  homography,
  scalePx,
  maximumNormalizedDistance
) {
  const projected = [];

  for (const p of referencePoints) {
    const q =
      transformPoint(
        p,
        homography
      );

    if (
      !Number.isFinite(q[0]) ||
      !Number.isFinite(q[1])
    ) {
      return {
        count: 0,
        error: Infinity,
        mapping: [],
      };
    }

    projected.push(q);
  }

  const scale =
    Math.max(
      1.0,
      scalePx
    );

  const distances =
    projected.map(
      p =>
        currentPoints.map(
          q =>
            distance(p, q) /
            scale
        )
    );

  const nearestCurrent =
    distances.map(
      row => {
        let best = 0;

        for (
          let j = 1;
          j < row.length;
          ++j
        ) {
          if (row[j] < row[best]) {
            best = j;
          }
        }

        return best;
      }
    );

  const nearestReference =
    currentPoints.map(
      (_, ci) => {
        let best = 0;

        for (
          let ri = 1;
          ri < referencePoints.length;
          ++ri
        ) {
          if (
            distances[ri][ci] <
            distances[best][ci]
          ) {
            best = ri;
          }
        }

        return best;
      }
    );

  const mapping = [];
  const errors = [];

  for (
    let ri = 0;
    ri < nearestCurrent.length;
    ++ri
  ) {
    const ci =
      nearestCurrent[ri];

    const error =
      distances[ri][ci];

    if (
      error >
      maximumNormalizedDistance
    ) {
      continue;
    }

    if (
      nearestReference[ci] !== ri
    ) {
      continue;
    }

    mapping.push([ri, ci]);
    errors.push(error);
  }

  return {
    count: mapping.length,

    error:
      errors.length
        ? errors.reduce(
            (a, b) => a + b,
            0
          ) / errors.length
        : Infinity,

    mapping,
  };
}

const TRIANGLE_PERMUTATIONS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

function mappingKey(mapping) {
  return mapping
    .map(
      ([a, b]) => `${a}:${b}`
    )
    .join(',');
}

function recoverConstellationHomography(
  states,
  readings,
  config
) {
  if (
    states.length < 3 ||
    readings.length < 3
  ) {
    return {
      homography: null,
      matches: [],
      details: {
        hypotheses: 0,
        reason: 'too-few-points',
      },
    };
  }

  const referencePoints =
    states.map(
      state =>
        quadCenter(
          state.referenceQuad
        )
    );

  const currentPoints =
    readings.map(
      reading =>
        quadCenter(
          readingQuad(reading)
        )
    );

  const currentScale =
    Math.max(
      1.0,
      median(
        readings.map(
          reading =>
            quadScale(
              readingQuad(reading)
            )
        )
      )
    );

  const sourceTriangles =
    triangleCandidates(
      referencePoints,
      config.recovery_maximum_triangles
    );

  const targetTriangles =
    triangleCandidates(
      currentPoints,
      config.recovery_maximum_triangles
    );

  const required =
    Math.max(
      config.minimum_matches,

      Math.ceil(
        config.minimum_match_fraction *
        Math.min(
          states.length,
          readings.length
        )
      )
    );

  const coarseCandidates = [];
  const seenMappings = new Set();

  let hypotheses = 0;

  const keepCandidates = 12;

  for (const sourceTriangle of sourceTriangles) {
    const src =
      sourceTriangle.ids.map(
        i => referencePoints[i]
      );

    for (const targetTriangle of targetTriangles) {
      const targetBase =
        targetTriangle.ids.map(
          i => currentPoints[i]
        );

      for (const order of TRIANGLE_PERMUTATIONS) {
        ++hypotheses;

        const dst =
          order.map(
            i => targetBase[i]
          );

        const hypothesis =
          affineFromTriangles(
            src,
            dst
          );

        if (hypothesis == null) {
          continue;
        }

        const score =
          coarseMutualGeometryScore(
            referencePoints,
            currentPoints,
            hypothesis,
            currentScale,
            config
              .recovery_coarse_maximum_center_error_scale
          );

        const key =
          mappingKey(
            score.mapping
          );

        if (
          score.count < required ||
          seenMappings.has(key)
        ) {
          continue;
        }

        seenMappings.add(key);

        coarseCandidates.push({
          count: score.count,
          error: score.error,
          mapping: score.mapping,
          key,
          homography: hypothesis,
        });

        coarseCandidates.sort(
          (a, b) =>
            (b.count - a.count) ||
            (a.error - b.error)
        );

        if (
          coarseCandidates.length >
          keepCandidates
        ) {
          const dropped =
            coarseCandidates.pop();

          seenMappings.delete(
            dropped.key
          );
        }
      }
    }
  }

  if (coarseCandidates.length === 0) {
    return {
      homography: null,
      matches: [],
      details: {
        hypotheses,
        reason: 'no-consensus',
      },
    };
  }

  const finals = [];

  for (
    const candidate of
    coarseCandidates
  ) {
    const coarse =
      normalizedAssignment(
        states,
        readings,
        candidate.homography,
        config
          .recovery_coarse_maximum_center_error_scale
      );

    if (
      coarse.matches.length <
      required
    ) {
      continue;
    }

    const refined =
      fitReferenceHomography(
        states,
        readings,
        coarse.matches,
        config.ransac_reprojection_threshold_px
      );

    const finalH =
      refined ??
      candidate.homography;

    const final =
      normalizedAssignment(
        states,
        readings,
        finalH,
        config.maximum_center_error_scale
      );

    if (
      final.matches.length <
      required
    ) {
      continue;
    }

    const finalMapping =
      final.matches
        .slice()
        .sort(
          (a, b) =>
            (a[0] - b[0]) ||
            (a[1] - b[1])
        );

    const finalKey =
      mappingKey(
        finalMapping
      );

    if (
      finals.some(
        row =>
          row.key === finalKey
      )
    ) {
      continue;
    }

    finals.push({
      count:
        final.matches.length,

      error:
        final.meanError,

      key:
        finalKey,

      homography:
        finalH,

      matches:
        final.matches,
    });
  }

  if (finals.length === 0) {
    return {
      homography: null,
      matches: [],
      details: {
        hypotheses,
        reason:
          'refinement-lost-consensus',
      },
    };
  }

  finals.sort(
    (a, b) =>
      (b.count - a.count) ||
      (a.error - b.error)
  );

  const best =
    finals[0];

  if (finals.length > 1) {
    const alternate =
      finals[1];

    if (
      alternate.count === best.count &&
      (
        alternate.error -
        best.error
      ) <
      config.recovery_ambiguity_error_margin
    ) {
      return {
        homography: null,
        matches: [],
        details: {
          hypotheses,
          reason: 'ambiguous',
          matches: best.count,
          best_error: best.error,
          alternate_error:
            alternate.error,
        },
      };
    }
  }

  return {
    homography:
      best.homography,

    matches:
      best.matches,

    details: {
      hypotheses,
      reason: 'accepted',
      matches: best.count,
      mean_error: best.error,
      final_candidates:
        finals.length,
    },
  };
}

function makeSeedStates(seedFrame) {
  if (
    seedFrame.association.mode !==
    'initialize'
  ) {
    throw new Error(
      `expected initialization frame, got ${seedFrame.association.mode}`
    );
  }

  if (
    !seedFrame.tracks ||
    seedFrame.tracks.length === 0
  ) {
    throw new Error(
      'initialization frame has no tracks'
    );
  }

  return seedFrame.tracks.map(
    track => {
      if (
        track.physical_id == null ||
        !Array.isArray(track.current_quad_px)
      ) {
        throw new Error(
          `unexpected initialization track schema: ${JSON.stringify(track)}`
        );
      }

      return {
        physicalId:
          Number(track.physical_id),

        referenceQuad:
          track.current_quad_px.map(
            p => p.slice()
          ),

        quad:
          track.current_quad_px.map(
            p => p.slice()
          ),

        visible: true,
      };
    }
  );
}

function eligibleReadings(frame) {
  return frame.raw_tops.filter(
    reading =>
      reading.tracker_eligible === true
  );
}

function sameIntegerSet(a, b) {
  const aa =
    Array.from(a)
      .map(Number)
      .sort((x, y) => x - y);

  const bb =
    Array.from(b)
      .map(Number)
      .sort((x, y) => x - y);

  return (
    aa.length === bb.length &&
    aa.every(
      (value, i) =>
        value === bb[i]
    )
  );
}

function assignmentMapFromMatches(
  states,
  readings,
  matches
) {
  const result = new Map();

  for (const [si, ri] of matches) {
    result.set(
      Number(
        readings[ri].detection_index
      ),
      Number(
        states[si].physicalId
      )
    );
  }

  return result;
}

function expectedAssignmentMap(frame) {
  const result = new Map();

  for (const reading of frame.raw_tops) {
    if (!reading.tracker_eligible) {
      continue;
    }

    if (
      reading.assigned_physical_id ==
      null
    ) {
      continue;
    }

    result.set(
      Number(
        reading.detection_index
      ),
      Number(
        reading.assigned_physical_id
      )
    );
  }

  return result;
}

function compareMaps(a, b) {
  if (a.size !== b.size) {
    return false;
  }

  for (const [key, value] of a) {
    if (
      !b.has(key) ||
      b.get(key) !== value
    ) {
      return false;
    }
  }

  return true;
}

function formatMapDifference(
  expected,
  actual
) {
  const keys =
    new Set([
      ...expected.keys(),
      ...actual.keys(),
    ]);

  const differences = [];

  for (
    const key of
    Array.from(keys).sort(
      (a, b) => a - b
    )
  ) {
    const e =
      expected.has(key)
        ? expected.get(key)
        : null;

    const a =
      actual.has(key)
        ? actual.get(key)
        : null;

    if (e !== a) {
      differences.push(
        `det ${key}: expected ${e}, actual ${a}`
      );
    }
  }

  return differences;
}


function normalizedReferenceDistance(
  quadA,
  quadB
) {
  const scale =
    Math.max(
      1.0,
      0.5 * (
        quadScale(quadA) +
        quadScale(quadB)
      )
    );

  return (
    distance(
      quadCenter(quadA),
      quadCenter(quadB)
    ) / scale
  );
}

function createStateFromReferenceQuad(
  states,
  referenceQuad,
  reading,
  nextPhysicalId,
  frameIndex
) {
  const state = {
    physicalId:
      nextPhysicalId,

    referenceQuad:
      referenceQuad.map(
        p => p.slice()
      ),

    quad:
      readingQuad(reading).map(
        p => p.slice()
      ),

    createdFrameIndex:
      frameIndex,

    lastFrameIndex:
      frameIndex,

    visible: true,

    missedFrames: 0,

    hitCount: 1,

    lastTopConfidence:
      Number(
        reading.top_confidence
      ),
  };

  states.push(state);

  return state;
}

function updatePending(
  states,
  sceneH,
  previousPending,
  unmatchedReadings,
  nextPhysicalId,
  frameIndex,
  config
) {
  const requiredHits =
    Math.max(
      1,
      Number(
        config.new_die_confirmation_frames
      )
    );

  /*
   * Python:
   *
   * if self._scene_h is None or not unmatched_readings:
   *     self._pending = []
   *     return 0
   */
  if (
    sceneH == null ||
    unmatchedReadings.length === 0
  ) {
    return {
      pending: [],
      nextPhysicalId,
      suppressedExistingSlots: 0,
      promotions: [],
    };
  }

  const inverse =
    invert3(sceneH);

  if (inverse == null) {
    return {
      pending: [],
      nextPhysicalId,
      suppressedExistingSlots: 0,
      promotions: [],
    };
  }

  const current = [];
  const usedPrevious =
    new Set();

  let suppressedExistingSlots = 0;

  const promotions = [];

  for (
    const reading of
    unmatchedReadings
  ) {
    const referenceQuad =
      transformQuad(
        readingQuad(reading),
        inverse
      );

    /*
     * Existing permanent arrangement slots are authoritative.
     */
    let collidesWithExisting = false;

    for (const state of states) {
      const normalized =
        normalizedReferenceDistance(
          referenceQuad,
          state.referenceQuad
        );

      if (
        normalized <=
        Number(
          config
            .new_die_existing_slot_exclusion_scale
        )
      ) {
        collidesWithExisting = true;
        break;
      }
    }

    if (collidesWithExisting) {
      ++suppressedExistingSlots;
      continue;
    }

    let best = null;

    for (
      let pendingIndex = 0;
      pendingIndex < previousPending.length;
      ++pendingIndex
    ) {
      if (
        usedPrevious.has(
          pendingIndex
        )
      ) {
        continue;
      }

      const prior =
        previousPending[pendingIndex];

      const normalized =
        normalizedReferenceDistance(
          referenceQuad,
          prior.referenceQuad
        );

      if (
        normalized <=
          Number(
            config
              .new_die_reference_distance_scale
          ) &&
        (
          best == null ||
          normalized < best.error
        )
      ) {
        best = {
          error: normalized,
          pendingIndex,
          pending: prior,
        };
      }
    }

    let candidate;

    if (best == null) {
      candidate = {
        referenceQuad:
          referenceQuad.map(
            p => p.slice()
          ),

        hits: 1,

        lastFrameIndex:
          frameIndex,

        latestReading:
          reading,
      };

    } else {
      usedPrevious.add(
        best.pendingIndex
      );

      candidate = {
        referenceQuad:
          referenceQuad.map(
            p => p.slice()
          ),

        hits:
          Number(
            best.pending.hits
          ) + 1,

        lastFrameIndex:
          frameIndex,

        latestReading:
          reading,
      };
    }

    /*
     * Promotion-time re-check against the now-current permanent map.
     */
    if (
      candidate.hits >=
      requiredHits
    ) {
      let promotionCollision =
        false;

      for (const state of states) {
        const normalized =
          normalizedReferenceDistance(
            candidate.referenceQuad,
            state.referenceQuad
          );

        if (
          normalized <=
          Number(
            config
              .new_die_reference_distance_scale
          )
        ) {
          promotionCollision =
            true;
          break;
        }
      }

      if (promotionCollision) {
        ++suppressedExistingSlots;
        continue;
      }

      const newState =
        createStateFromReferenceQuad(
          states,
          candidate.referenceQuad,
          reading,
          nextPhysicalId,
          frameIndex
        );

      promotions.push({
        physicalId:
          newState.physicalId,

        reading,

        hits:
          candidate.hits,

        referenceQuad:
          candidate.referenceQuad,
      });

      ++nextPhysicalId;

    } else {
      current.push(
        candidate
      );
    }
  }

  return {
    pending: current,
    nextPhysicalId,
    suppressedExistingSlots,
    promotions,
  };
}

function processTrackedFrame(
  states,
  sceneH,
  pending,
  nextPhysicalId,
  frameIndex,
  readings,
  frameMotion,
  config
) {

  let motionSeed = null;

  if (sceneH != null) {
    if (frameMotion == null) {
      motionSeed =
        cloneMatrix(sceneH);
    } else {
      motionSeed =
        matmul3(
          frameMotion,
          sceneH
        );
    }
  }

  let matches = [];

  let unmatchedReadings =
    readings.map(
      (_, i) => i
    );

  let mode = 'hold';

  let candidateH =
    motionSeed;

  let seedMatches = [];

  const required =
    requiredRegistrationMatches(
      states.length,
      readings.length,
      config.minimum_matches,
      config.minimum_match_fraction
    );

  if (
    motionSeed != null &&
    readings.length > 0
  ) {
    const initial =
      normalizedAssignment(
        states,
        readings,
        motionSeed,
        config.maximum_center_error_scale
      );

    seedMatches =
      initial.matches;

    if (
      seedMatches.length >=
      required
    ) {
      const refined =
        refineReferenceTransform(
          states,
          readings,
          seedMatches,
          motionSeed,
          config.ransac_reprojection_threshold_px
        );

      candidateH =
        refined ??
        motionSeed;

      const final =
        normalizedAssignment(
          states,
          readings,
          candidateH,
          config.maximum_center_error_scale
        );

      if (
        final.matches.length >=
        required
      ) {
        matches =
          final.matches;

        unmatchedReadings =
          final.unmatchedReadings;

        mode =
          'propagated-global';
      }
    }
  }

  let recoveryDetails = null;

  if (
    matches.length === 0 &&
    readings.length > 0
  ) {
    const recovered =
      recoverConstellationHomography(
        states,
        readings,
        config
      );

    recoveryDetails =
      recovered.details;

    if (
      recovered.homography != null
    ) {
      candidateH =
        recovered.homography;

      const final =
        normalizedAssignment(
          states,
          readings,
          recovered.homography,
          config.maximum_center_error_scale
        );

      matches =
        final.matches;

      unmatchedReadings =
        final.unmatchedReadings;

      mode =
        'constellation-recovery';
    }
  }

  const accepted =
    matches.length > 0;

  /*
   * Python first marks all permanent states invisible.
   */
  for (const state of states) {
    state.visible = false;
  }

  let promotions = [];
  let duplicateSlotSuppressions = 0;

  if (accepted) {
    sceneH =
      cloneMatrix(
        candidateH
      );

    const matchedStateIds =
      new Set();

    for (const [si, ri] of matches) {
      const state =
        states[si];

      const reading =
        readings[ri];

      matchedStateIds.add(si);

      state.quad =
        readingQuad(
          reading
        ).map(
          p => p.slice()
        );

      state.lastFrameIndex =
        Number(frameIndex);

      state.visible = true;

      state.missedFrames = 0;

      state.hitCount =
        Number(
          state.hitCount ?? 1
        ) + 1;

      state.lastTopConfidence =
        Number(
          reading.top_confidence
        );
    }

    for (
      let si = 0;
      si < states.length;
      ++si
    ) {
      if (
        !matchedStateIds.has(si)
      ) {
        states[si].missedFrames =
          Number(
            states[si].missedFrames ?? 0
          ) + 1;
      }
    }

    /*
     * Match Python exactly:
     *
     * primary_pending_readings =
     *   [eligible[index] for index in unmatched_readings]
     *
     * _update_pending(
     *   primary_pending_readings,
     *   range(len(primary_pending_readings))
     * )
     */
    const pendingReadings =
      unmatchedReadings.map(
        index =>
          readings[index]
      );

    const pendingResult =
      updatePending(
        states,
        sceneH,
        pending,
        pendingReadings,
        nextPhysicalId,
        Number(frameIndex),
        config
      );

    pending =
      pendingResult.pending;

    nextPhysicalId =
      pendingResult.nextPhysicalId;

    promotions =
      pendingResult.promotions;

    duplicateSlotSuppressions =
      pendingResult
        .suppressedExistingSlots;

  } else {
    /*
     * Exact hold behavior:
     *
     * - advance scene_h using the motion seed if available
     * - preserve pending candidates
     * - do NOT advance candidate hits
     */
    if (motionSeed != null) {
      sceneH =
        cloneMatrix(
          motionSeed
        );
    }

    unmatchedReadings =
      readings.map(
        (_, i) => i
      );

    for (const state of states) {
      state.missedFrames =
        Number(
          state.missedFrames ?? 0
        ) + 1;
    }
  }

  return {
    sceneH,
    pending,
    nextPhysicalId,

    readings,
    matches,
    unmatchedReadings,

    promotions,
    duplicateSlotSuppressions,

    mode,
    required,
    seedMatches,
    recoveryDetails,
  };
}


function trackerConfigFromDocument(document) {
  const tracking = document?.tracking;
  const persistent = tracking?.persistent_constellation;

  if (!tracking || !persistent) {
    throw new Error('tracking-config.json is missing tracking.persistent_constellation');
  }

  if (persistent.enabled === false) {
    throw new Error('browser runtime requires persistent_constellation.enabled');
  }

  if ((persistent.identity_evidence ?? 'geometry-only') !== 'geometry-only') {
    throw new Error("browser runtime requires identity_evidence='geometry-only'");
  }

  return {
    minimum_top_confidence: Number(tracking.minimum_top_confidence ?? 0.25),
    maximum_center_error_scale: Number(persistent.maximum_center_error_scale ?? 0.85),
    minimum_matches: Number(persistent.minimum_matches ?? 4),
    minimum_match_fraction: Number(persistent.minimum_match_fraction ?? 0.60),
    initialization_stable_frames: Number(persistent.initialization_stable_frames ?? 3),
    recovery_maximum_triangles: Number(persistent.recovery_maximum_triangles ?? 12),
    recovery_coarse_maximum_center_error_scale: Number(
      persistent.recovery_coarse_maximum_center_error_scale ?? 1.35
    ),
    recovery_ambiguity_error_margin: Number(
      persistent.recovery_ambiguity_error_margin ?? 0.08
    ),
    ransac_reprojection_threshold_px: Number(
      persistent.ransac_reprojection_threshold_px ?? 5.0
    ),
    new_die_confirmation_frames: Number(
      persistent.new_die_confirmation_frames ?? 4
    ),
    new_die_reference_distance_scale: Number(
      persistent.new_die_reference_distance_scale ?? 0.80
    ),
    new_die_existing_slot_exclusion_scale: Number(
      persistent.new_die_existing_slot_exclusion_scale ?? 0.90
    ),
  };
}

function trackView(state) {
  return {
    physical_id: Number(state.physicalId),
    quad_px: state.quad.map(point => point.slice()),
    visible: Boolean(state.visible),
    created_frame_index: Number(state.createdFrameIndex ?? 0),
    last_frame_index: Number(state.lastFrameIndex ?? 0),
    hit_count: Number(state.hitCount ?? 0),
    missed_frames: Number(state.missedFrames ?? 0),
    top_confidence: Number(state.lastTopConfidence ?? 0),
  };
}

export class PersistentConstellationTrackerBrowser {
  constructor(configDocument) {
    this.config = trackerConfigFromDocument(configDocument);
    this.reset();
  }

  reset() {
    this.frameIndex = 0;
    this.nextPhysicalId = 1;
    this.initializationCount = null;
    this.initializationStreak = 0;
    this.states = [];
    this.pending = [];
    this.sceneH = null;
    this.lastMode = 'startup';
    this.lastMatches = 0;
    this.lastRequired = 0;
    this.lastDuplicateSlotSuppressions = 0;
    this.lastPromotions = [];
  }

  update(readings, frameMotion = null) {
    this.frameIndex += 1;

    const eligible = readings.filter(
      reading =>
        Number.isFinite(Number(reading.top_confidence)) &&
        Number(reading.top_confidence) >= this.config.minimum_top_confidence
    );

    if (this.states.length === 0) {
      const count = eligible.length;

      if (count > 0 && count === this.initializationCount) {
        this.initializationStreak += 1;
      } else if (count > 0) {
        this.initializationCount = count;
        this.initializationStreak = 1;
      } else {
        this.initializationCount = null;
        this.initializationStreak = 0;
      }

      const locked =
        this.initializationStreak >= this.config.initialization_stable_frames;

      if (locked) {
        this.sceneH = identity3();

        for (const reading of eligible) {
          createStateFromReferenceQuad(
            this.states,
            readingQuad(reading),
            reading,
            this.nextPhysicalId,
            this.frameIndex
          );
          this.nextPhysicalId += 1;
        }
      }

      this.lastMode = locked ? 'initialize' : 'initializing';
      this.lastMatches = locked ? eligible.length : 0;
      this.lastRequired = 0;
      this.lastDuplicateSlotSuppressions = 0;
      this.lastPromotions = [];

      return {
        frame_index: this.frameIndex,
        mode: this.lastMode,
        matches: this.lastMatches,
        persistent_dice: this.states.length,
        visible: this.views(true),
        all: this.views(false),
        promotions: [],
      };
    }

    const result = processTrackedFrame(
      this.states,
      this.sceneH,
      this.pending,
      this.nextPhysicalId,
      this.frameIndex,
      eligible,
      frameMotion,
      this.config
    );

    this.sceneH = result.sceneH;
    this.pending = result.pending;
    this.nextPhysicalId = result.nextPhysicalId;
    this.lastMode = result.mode;
    this.lastMatches = result.matches.length;
    this.lastRequired = result.required;
    this.lastDuplicateSlotSuppressions = result.duplicateSlotSuppressions;
    this.lastPromotions = result.promotions.map(row => ({
      physical_id: Number(row.physicalId),
      hits: Number(row.hits),
    }));

    return {
      frame_index: this.frameIndex,
      mode: this.lastMode,
      matches: this.lastMatches,
      required: this.lastRequired,
      persistent_dice: this.states.length,
      visible: this.views(true),
      all: this.views(false),
      promotions: this.lastPromotions.slice(),
      duplicate_slot_suppressions: this.lastDuplicateSlotSuppressions,
      recovery: result.recoveryDetails,
    };
  }

  views(visibleOnly = false) {
    return this.states
      .filter(state => !visibleOnly || Boolean(state.visible))
      .map(trackView);
  }

  historyViews() {
    return this.views(false);
  }

  referenceHomography() {
    return this.sceneH == null ? null : cloneMatrix(this.sceneH);
  }

  persistentIdentityMap() {
    return {
      format: 'dicevision-persistent-identity-map-browser-v1',
      reference_frame_index: this.states.length ? this.states[0].createdFrameIndex : null,
      scene_homography: this.referenceHomography(),
      dice: this.states.map(state => ({
        physical_id: Number(state.physicalId),
        reference_quad_px: state.referenceQuad.map(point => point.slice()),
        current_quad_px: state.quad.map(point => point.slice()),
        visible: Boolean(state.visible),
      })),
    };
  }
}

export { trackerConfigFromDocument };
