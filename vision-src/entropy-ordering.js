/* Browser port of src/dicevision/entropy_ordering.py.
 * Keep the algorithm and thresholds in lockstep with the Python source.
 */
export const ORDERING_FORMAT = 'dicevision-spatial-roll-order-v2';

const EPS = 1e-12;

function unique(items) {
  return [...new Set(items)];
}

function entriesNumeric(mapping) {
  if (mapping instanceof Map) {
    return [...mapping.entries()].map(([key, value]) => [Number(key), value]);
  }
  return Object.entries(mapping || {}).map(([key, value]) => [Number(key), value]);
}

function toNumericMap(mapping) {
  return new Map(entriesNumeric(mapping));
}

function sortedNumericKeys(mapping) {
  return entriesNumeric(mapping).map(([key]) => key).sort((a, b) => a - b);
}

function median(values) {
  if (!values.length) throw new Error('median of empty sequence');
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : 0.5 * (sorted[middle - 1] + sorted[middle]);
}

function percentile(values, q) {
  if (!values.length) throw new Error('percentile of empty sequence');
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * q;
  const lo = Math.floor(position);
  const hi = Math.ceil(position);
  const fraction = position - lo;
  return sorted[lo] * (1 - fraction) + sorted[hi] * fraction;
}

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function meanPoint(points) {
  return [
    points.reduce((sum, point) => sum + point[0], 0) / points.length,
    points.reduce((sum, point) => sum + point[1], 0) / points.length,
  ];
}

function finitePoint(point) {
  return Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

function cloneQuad(quad) {
  if (!Array.isArray(quad) || quad.length !== 4) {
    throw new Error('die top quadrilateral must contain four points');
  }
  const output = quad.map(point => [Number(point[0]), Number(point[1])]);
  if (!output.every(finitePoint)) {
    throw new Error('die top quadrilaterals must contain finite coordinates');
  }
  return output;
}

function margin(best, second, scale) {
  if (scale <= EPS) return 0;
  return Math.max(0, Math.min(1, (best - second) / scale));
}

function solve3(matrix, vector) {
  const a = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(a[row][column]) > Math.abs(a[pivot][column])) pivot = row;
    }
    if (Math.abs(a[pivot][column]) <= 1e-15) return null;
    [a[column], a[pivot]] = [a[pivot], a[column]];
    const scale = a[column][column];
    for (let j = column; j < 4; j += 1) a[column][j] /= scale;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = a[row][column];
      for (let j = column; j < 4; j += 1) a[row][j] -= factor * a[column][j];
    }
  }
  return [a[0][3], a[1][3], a[2][3]];
}

function weightedLeastSquares3(design, target, weights) {
  const normal = Array.from({ length: 3 }, () => [0, 0, 0]);
  const rhs = [0, 0, 0];
  for (let i = 0; i < target.length; i += 1) {
    const weight2 = weights[i] * weights[i];
    for (let row = 0; row < 3; row += 1) {
      rhs[row] += weight2 * design[i][row] * target[i];
      for (let column = 0; column < 3; column += 1) {
        normal[row][column] += weight2 * design[i][row] * design[i][column];
      }
    }
  }
  const solved = solve3(normal, rhs);
  if (!solved) throw new Error('floor perspective fit is singular');
  return solved;
}

function robustLinearFit(design, target) {
  let weights = Array(target.length).fill(1);
  let coefficients = weightedLeastSquares3(design, target, weights);
  for (let iteration = 0; iteration < 8; iteration += 1) {
    coefficients = weightedLeastSquares3(design, target, weights);
    const residual = target.map((value, index) =>
      value - design[index].reduce((sum, component, j) => sum + component * coefficients[j], 0));
    const center = median(residual);
    const mad = 1.4826 * median(residual.map(value => Math.abs(value - center))) + 1e-9;
    weights = residual.map(value =>
      Math.min(1, 1.5 * mad / (Math.abs(value - center) + 1e-12)));
  }
  return { coefficients, weights };
}

function inverseSqrtSymmetric2(matrix) {
  const a = matrix[0][0];
  const b = 0.5 * (matrix[0][1] + matrix[1][0]);
  const c = matrix[1][1];
  const trace = a + c;
  const determinant = a * c - b * b;
  const discriminant = Math.sqrt(Math.max(0, trace * trace - 4 * determinant));
  const minEigenvalue = 0.5 * (trace - discriminant);
  if (!(minEigenvalue > 1e-6)) return null;

  // For a positive-definite 2x2 matrix:
  // sqrt(A) = (A + sqrt(det(A)) I) / sqrt(trace(A)+2sqrt(det(A))).
  // Invert that expression to obtain A^(-1/2).
  const rootDet = Math.sqrt(Math.max(determinant, 0));
  const scale = Math.sqrt(Math.max(trace + 2 * rootDet, EPS));
  const m00 = a + rootDet;
  const m01 = b;
  const m10 = b;
  const m11 = c + rootDet;
  const detM = m00 * m11 - m01 * m10;
  if (Math.abs(detM) <= EPS) return null;
  return [
    [scale * m11 / detM, -scale * m01 / detM],
    [-scale * m10 / detM, scale * m00 / detM],
  ];
}

function mulMat2Vec(matrix, vector) {
  return [
    matrix[0][0] * vector[0] + matrix[0][1] * vector[1],
    matrix[1][0] * vector[0] + matrix[1][1] * vector[1],
  ];
}

function rowVecMat2(vector, matrix) {
  return [
    vector[0] * matrix[0][0] + vector[1] * matrix[1][0],
    vector[0] * matrix[0][1] + vector[1] * matrix[1][1],
  ];
}

export function estimateFloorCenters(
  quads,
  {
    minimumDice = 6,
    maximumLogAreaResidual = 0.16,
    maximumShapeResidual = 0.16,
  } = {},
) {
  const quadMap = toNumericMap(quads);
  const ids = [...quadMap.keys()].sort((a, b) => a - b);
  if (!ids.length) {
    return {
      centers: {}, automatic: false, confidence: 0,
      reasons: ['no-detected-top-geometry'], diagnostics: {},
    };
  }

  const boxes = ids.map(id => cloneQuad(quadMap.get(id)));
  const imageCenters = boxes.map(meanPoint);
  if (ids.length === 1) {
    return {
      centers: { [ids[0]]: imageCenters[0] },
      automatic: false,
      confidence: 0,
      reasons: ['insufficient-dice-for-floor-normalization'],
      diagnostics: { method: 'raw-top-center-fallback-v1', dice_used: 1 },
    };
  }

  const nonzeroDistances = [];
  for (let i = 0; i < imageCenters.length; i += 1) {
    for (let j = 0; j < imageCenters.length; j += 1) {
      const value = distance(imageCenters[i], imageCenters[j]);
      if (value > 1e-9) nonzeroDistances.push(value);
    }
  }
  if (!nonzeroDistances.length) throw new Error('detected tops do not have distinct centers');
  const sourceScale = median(nonzeroDistances);
  const origin = [
    median(imageCenters.map(point => point[0])),
    median(imageCenters.map(point => point[1])),
  ];
  const normalizedBoxes = boxes.map(quad => quad.map(point => [
    (point[0] - origin[0]) / sourceScale,
    (point[1] - origin[1]) / sourceScale,
  ]));
  const centers = normalizedBoxes.map(meanPoint);

  const firstEdges = [];
  const secondEdges = [];
  const areas = [];
  for (const box of normalizedBoxes) {
    const first = [
      0.5 * ((box[1][0] - box[0][0]) + (box[2][0] - box[3][0])),
      0.5 * ((box[1][1] - box[0][1]) + (box[2][1] - box[3][1])),
    ];
    const second = [
      0.5 * ((box[2][0] - box[1][0]) + (box[3][0] - box[0][0])),
      0.5 * ((box[2][1] - box[1][1]) + (box[3][1] - box[0][1])),
    ];
    firstEdges.push(first);
    secondEdges.push(second);
    areas.push(Math.abs(first[0] * second[1] - first[1] * second[0]));
  }
  if (areas.some(value => !(value > 1e-12))) {
    throw new Error('a detected top has degenerate geometry');
  }

  const reasons = [];
  if (ids.length < minimumDice) reasons.push('insufficient-dice-for-floor-normalization');

  const areaScale = median(areas);
  const targetDenominator = areas.map(value => Math.pow(value / areaScale, 1 / 3));
  const design = centers.map(center => [1, center[0], center[1]]);
  const fit = robustLinearFit(design, targetDenominator);
  const intercept = fit.coefficients[0];
  let perspective;
  if (Math.abs(intercept) <= 1e-9) {
    perspective = [0, 0];
    reasons.push('floor-perspective-fit-degenerate');
  } else {
    perspective = [fit.coefficients[1] / intercept, fit.coefficients[2] / intercept];
  }

  let denominator = centers.map(center => 1 + center[0] * perspective[0] + center[1] * perspective[1]);
  if (Math.min(...denominator) <= 0.35) {
    perspective = [0, 0];
    denominator = denominator.map(() => 1);
    reasons.push('floor-perspective-fit-degenerate');
  }
  const projectiveCenters = centers.map((center, index) => [
    center[0] / denominator[index],
    center[1] / denominator[index],
  ]);

  const firstRectified = [];
  const secondRectified = [];
  for (let index = 0; index < centers.length; index += 1) {
    const center = centers[index];
    const depth = denominator[index];
    const jacobian = [
      [
        (depth - center[0] * perspective[0]) / (depth * depth),
        (-center[0] * perspective[1]) / (depth * depth),
      ],
      [
        (-center[1] * perspective[0]) / (depth * depth),
        (depth - center[1] * perspective[1]) / (depth * depth),
      ],
    ];
    firstRectified.push(mulMat2Vec(jacobian, firstEdges[index]));
    secondRectified.push(mulMat2Vec(jacobian, secondEdges[index]));
  }

  const tensors = [];
  for (let index = 0; index < firstRectified.length; index += 1) {
    const first = firstRectified[index];
    const second = secondRectified[index];
    const determinant = Math.abs(first[0] * second[1] - second[0] * first[1]);
    if (determinant <= 1e-12) continue;
    tensors.push([
      [(first[0] ** 2 + second[0] ** 2) / determinant,
       (first[0] * first[1] + second[0] * second[1]) / determinant],
      [(first[0] * first[1] + second[0] * second[1]) / determinant,
       (first[1] ** 2 + second[1] ** 2) / determinant],
    ]);
  }
  if (!tensors.length) throw new Error('floor affine fit has no usable shape tensors');
  const metric = [
    [median(tensors.map(item => item[0][0])), median(tensors.map(item => item[0][1]))],
    [median(tensors.map(item => item[1][0])), median(tensors.map(item => item[1][1]))],
  ];
  const symmetric = [
    [metric[0][0], 0.5 * (metric[0][1] + metric[1][0])],
    [0.5 * (metric[0][1] + metric[1][0]), metric[1][1]],
  ];
  let affine = inverseSqrtSymmetric2(symmetric);
  if (!affine) {
    affine = [[1, 0], [0, 1]];
    reasons.push('floor-affine-fit-degenerate');
  }

  const floorPoints = projectiveCenters.map(point => rowVecMat2(point, affine));
  const finalFirst = firstRectified.map(point => rowVecMat2(point, affine));
  const finalSecond = secondRectified.map(point => rowVecMat2(point, affine));
  const firstLengths = finalFirst.map(point => Math.hypot(point[0], point[1]));
  const secondLengths = finalSecond.map(point => Math.hypot(point[0], point[1]));
  const finalAreas = firstLengths.map((value, index) => Math.max(value * secondLengths[index], 1e-12));
  const logAreas = finalAreas.map(Math.log);
  const logAreaMean = logAreas.reduce((sum, value) => sum + value, 0) / logAreas.length;
  const logAreaResidual = Math.sqrt(logAreas.reduce((sum, value) => sum + (value - logAreaMean) ** 2, 0) / logAreas.length);
  const shapeTerms = [];
  for (let index = 0; index < firstLengths.length; index += 1) {
    shapeTerms.push(Math.log(Math.max(firstLengths[index], 1e-12) / Math.max(secondLengths[index], 1e-12)));
  }
  for (let index = 0; index < finalFirst.length; index += 1) {
    const dot = finalFirst[index][0] * finalSecond[index][0] + finalFirst[index][1] * finalSecond[index][1];
    shapeTerms.push(dot / Math.max(firstLengths[index] * secondLengths[index], 1e-12));
  }
  const shapeResidual = Math.sqrt(shapeTerms.reduce((sum, value) => sum + value * value, 0) / shapeTerms.length);
  if (logAreaResidual > maximumLogAreaResidual) reasons.push('cube-size-or-perspective-fit-is-inconsistent');
  if (shapeResidual > maximumShapeResidual) reasons.push('top-shape-fit-is-inconsistent');
  const robustFraction = fit.weights.filter(value => value >= 0.999).length / fit.weights.length;
  const confidence = Math.max(0, Math.min(
    1,
    robustFraction,
    1 - logAreaResidual / Math.max(maximumLogAreaResidual, 1e-9),
    1 - shapeResidual / Math.max(maximumShapeResidual, 1e-9),
  ));

  return {
    centers: Object.fromEntries(ids.map((id, index) => [id, floorPoints[index]])),
    automatic: reasons.length === 0,
    confidence,
    reasons: unique(reasons),
    diagnostics: {
      method: 'self-normalized-d6-top-ensemble-v1',
      dice_used: ids.length,
      projective_gradient: perspective.slice(),
      log_area_residual: logAreaResidual,
      shape_residual: shapeResidual,
      robust_inlier_fraction: robustFraction,
    },
  };
}

function recursiveQuadrantOrder(transformed, indices, depth = 0) {
  if (indices.length <= 1) return { ordered: indices.slice(), confidence: 1 };
  const xValues = indices.map(index => transformed[index][0]);
  const yValues = indices.map(index => transformed[index][1]);
  const sortedX = xValues.slice().sort((a, b) => a - b);
  const sortedY = yValues.slice().sort((a, b) => a - b);
  const boundary = Math.floor(indices.length / 2);
  const splitX = 0.5 * (sortedX[boundary - 1] + sortedX[boundary]);
  const splitY = 0.5 * (sortedY[boundary - 1] + sortedY[boundary]);
  const groups = [[], [], [], []];
  for (const index of indices) {
    const quadrant = (transformed[index][1] >= splitY ? 2 : 0) +
      (transformed[index][0] >= splitX ? 1 : 0);
    groups[quadrant].push(index);
  }
  if (Math.max(...groups.map(group => group.length)) === indices.length) {
    const axis = depth % 2;
    return {
      ordered: indices.slice().sort((left, right) =>
        (transformed[left][axis] - transformed[right][axis]) ||
        (transformed[left][1 - axis] - transformed[right][1 - axis]) ||
        (left - right)),
      confidence: 0,
    };
  }
  const spread = Math.max(
    Math.max(...xValues) - Math.min(...xValues),
    Math.max(...yValues) - Math.min(...yValues),
    EPS,
  );
  const splitMargin = Math.min(
    sortedX[boundary] - sortedX[boundary - 1],
    sortedY[boundary] - sortedY[boundary - 1],
  ) / spread;
  const ordered = [];
  let confidence = Math.min(1, 4 * splitMargin);
  for (const group of groups) {
    const nested = recursiveQuadrantOrder(transformed, group, depth + 1);
    ordered.push(...nested.ordered);
    confidence = Math.min(confidence, nested.confidence);
  }
  return { ordered, confidence };
}

export function orderSpatialRoll(centers, values, { ambiguityThreshold = 0.035 } = {}) {
  const centerMap = toNumericMap(centers);
  const valueMap = toNumericMap(values);
  const ids = [...centerMap.keys()]
    .filter(id => valueMap.has(id))
    .sort((a, b) => a - b);
  if (!ids.length) {
    return {
      format: ORDERING_FORMAT, dice: [], values: [], automatic: false, confidence: 0,
      reasons: ['no-accepted-dice'], anchor_physical_id: null, axis_physical_id: null,
      normalization: null,
    };
  }

  const points = ids.map(id => [Number(centerMap.get(id)[0]), Number(centerMap.get(id)[1])]);
  if (!points.every(finitePoint)) throw new Error('die centers must be finite two-dimensional coordinates');
  for (const id of ids) {
    const value = Number(valueMap.get(id));
    if (!Number.isInteger(value) || value < 1 || value > 6) {
      throw new Error(`D${String(id).padStart(2, '0')} is not a d6 value: ${value}`);
    }
  }
  if (ids.length === 1) {
    const die = {
      position: 1, physical_id: ids[0], id: `D${String(ids[0]).padStart(2, '0')}`,
      value: Number(valueMap.get(ids[0])), center: points[0].slice(), canonical_center: [0, 0],
    };
    return {
      format: ORDERING_FORMAT, dice: [die], values: [die.value], automatic: true,
      confidence: 1, reasons: [], anchor_physical_id: ids[0], axis_physical_id: null,
      normalization: null,
    };
  }

  const distances = points.map((point, i) => points.map((other, j) => i === j ? 0 : distance(point, other)));
  const nonzero = distances.flat().filter(value => value > 1e-9);
  if (!nonzero.length) throw new Error('accepted dice do not have distinct spatial centers');
  const scale = median(nonzero);

  const isolation = ids.map((id, index) => {
    const row = distances[index].filter((_value, j) => j !== index);
    return [Math.min(...row), median(row), row.reduce((sum, value) => sum + value, 0), -id, index];
  });
  isolation.sort((left, right) => {
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] !== right[i]) return right[i] - left[i];
    }
    return 0;
  });
  const anchorIndex = isolation[0][4];
  const anchorMargin = margin(isolation[0][0], isolation[1][0], scale);

  const fromAnchor = ids
    .map((id, index) => index === anchorIndex ? null : [distances[anchorIndex][index], -id, index])
    .filter(Boolean);
  fromAnchor.sort((left, right) => {
    for (let i = 0; i < left.length; i += 1) {
      if (left[i] !== right[i]) return right[i] - left[i];
    }
    return 0;
  });
  const axisIndex = fromAnchor[0][2];
  const axisMargin = fromAnchor.length === 1 ? 1 : margin(fromAnchor[0][0], fromAnchor[1][0], scale);
  const axis = [
    points[axisIndex][0] - points[anchorIndex][0],
    points[axisIndex][1] - points[anchorIndex][1],
  ];
  const axisLength = Math.hypot(axis[0], axis[1]);
  if (axisLength <= 1e-9) throw new Error('could not establish a spatial ordering axis');
  const unitX = [axis[0] / axisLength, axis[1] / axisLength];
  const unitY = [-unitX[1], unitX[0]];
  const relative = points.map(point => [point[0] - points[anchorIndex][0], point[1] - points[anchorIndex][1]]);
  const xValues = relative.map(point => point[0] * unitX[0] + point[1] * unitX[1]);
  let yValues = relative.map(point => point[0] * unitY[0] + point[1] * unitY[1]);
  let handednessMargin = 1;
  const reasons = [];
  const candidates = ids
    .map((id, index) => (index === anchorIndex || index === axisIndex) ? null : [Math.abs(yValues[index]), -id, index])
    .filter(Boolean);
  if (candidates.length) {
    candidates.sort((left, right) => {
      for (let i = 0; i < left.length; i += 1) {
        if (left[i] !== right[i]) return right[i] - left[i];
      }
      return 0;
    });
    const handIndex = candidates[0][2];
    if (yValues[handIndex] < 0) yValues = yValues.map(value => -value);
    const second = candidates.length > 1 ? candidates[1][0] : 0;
    handednessMargin = margin(candidates[0][0], second, scale);
    if (candidates[0][0] / scale < ambiguityThreshold) {
      handednessMargin = 0;
      reasons.push('nearly-collinear-layout');
    }
  } else {
    handednessMargin = 0;
    reasons.push('two-dice-orientation-needs-confirmation');
  }
  if (anchorMargin < ambiguityThreshold) reasons.push('anchor-choice-is-close');
  if (axisMargin < ambiguityThreshold) reasons.push('axis-choice-is-close');
  if (handednessMargin < ambiguityThreshold && ids.length > 2 && !reasons.includes('nearly-collinear-layout')) {
    reasons.push('orientation-choice-is-close');
  }

  const transformed = xValues.map((x, index) => [x / scale, yValues[index] / scale]);
  const remaining = ids.map((_id, index) => index).filter(index => index !== anchorIndex);
  const traversal = recursiveQuadrantOrder(transformed, remaining);
  if (traversal.confidence < ambiguityThreshold) reasons.push('recursive-order-is-close');
  const orderedIndices = [anchorIndex, ...traversal.ordered];
  const dice = orderedIndices.map((index, offset) => ({
    position: offset + 1,
    physical_id: ids[index],
    id: `D${String(ids[index]).padStart(2, '0')}`,
    value: Number(valueMap.get(ids[index])),
    center: points[index].slice(),
    canonical_center: transformed[index].slice(),
  }));
  return {
    format: ORDERING_FORMAT,
    dice,
    values: dice.map(item => item.value),
    automatic: reasons.length === 0,
    confidence: Math.min(anchorMargin, axisMargin, handednessMargin, traversal.confidence),
    reasons: unique(reasons),
    anchor_physical_id: ids[anchorIndex],
    axis_physical_id: ids[axisIndex],
    normalization: null,
  };
}

export function orderSpatialRollFromQuads(quads, values, { ambiguityThreshold = 0.035 } = {}) {
  const valueMap = toNumericMap(values);
  const acceptedQuads = Object.fromEntries(
    entriesNumeric(quads).filter(([id]) => valueMap.has(id)).map(([id, quad]) => [id, quad]),
  );
  const estimate = estimateFloorCenters(acceptedQuads);
  const ordered = orderSpatialRoll(estimate.centers, valueMap, { ambiguityThreshold });
  const reasons = unique([...estimate.reasons, ...ordered.reasons]);
  return {
    ...ordered,
    automatic: Boolean(estimate.automatic && ordered.automatic),
    confidence: Math.min(estimate.confidence, ordered.confidence),
    reasons,
    normalization: {
      ...estimate.diagnostics,
      confidence: estimate.confidence,
      automatic: estimate.automatic,
    },
  };
}

function alignCentersBySimilarity(source, target) {
  const sourceMap = toNumericMap(source);
  const targetMap = toNumericMap(target);
  const common = [...sourceMap.keys()].filter(id => targetMap.has(id)).sort((a, b) => a - b);
  if (common.length < 3) return null;
  const sourcePoints = common.map(id => sourceMap.get(id));
  const targetPoints = common.map(id => targetMap.get(id));
  const sourceMean = meanPoint(sourcePoints);
  const targetMean = meanPoint(targetPoints);
  const x = sourcePoints.map(point => [point[0] - sourceMean[0], point[1] - sourceMean[1]]);
  const y = targetPoints.map(point => [point[0] - targetMean[0], point[1] - targetMean[1]]);

  let c00 = 0; let c01 = 0; let c10 = 0; let c11 = 0;
  for (let i = 0; i < x.length; i += 1) {
    c00 += x[i][0] * y[i][0];
    c01 += x[i][0] * y[i][1];
    c10 += x[i][1] * y[i][0];
    c11 += x[i][1] * y[i][1];
  }
  const p = c00 + c11;
  const q = c10 - c01;
  const norm = Math.hypot(p, q);
  if (norm <= EPS) return null;
  const rotation = [
    [p / norm, -q / norm],
    [q / norm, p / norm],
  ];
  const denominator = x.reduce((sum, point) => sum + point[0] ** 2 + point[1] ** 2, 0);
  if (denominator <= EPS) return null;
  let numerator = 0;
  for (let i = 0; i < x.length; i += 1) {
    const transformed = rowVecMat2(x[i], rotation);
    numerator += transformed[0] * y[i][0] + transformed[1] * y[i][1];
  }
  const scale = numerator / denominator;
  if (!Number.isFinite(scale) || scale <= EPS) return null;

  const result = {};
  for (const [id, point] of sourceMap.entries()) {
    const centered = [point[0] - sourceMean[0], point[1] - sourceMean[1]];
    const rotated = rowVecMat2(centered, rotation);
    result[id] = [scale * rotated[0] + targetMean[0], scale * rotated[1] + targetMean[1]];
  }
  return result;
}

export function orderSpatialRollFromQuadSamples(
  quadSamples,
  values,
  {
    ambiguityThreshold = 0.035,
    minimumConsensusViews = 4,
    maximumCenterJitter = 0.045,
  } = {},
) {
  const valueMap = toNumericMap(values);
  const acceptedIds = new Set(valueMap.keys());
  const estimates = [];
  for (const sample of quadSamples || []) {
    const accepted = Object.fromEntries(
      entriesNumeric(sample).filter(([id]) => acceptedIds.has(id)).map(([id, quad]) => [id, quad]),
    );
    if (Object.keys(accepted).length < 3) continue;
    try {
      estimates.push(estimateFloorCenters(accepted));
    } catch (_error) {
      // Match Python: unusable geometry samples are skipped.
    }
  }
  if (!estimates.length) {
    return {
      ...orderSpatialRoll({}, {}, { ambiguityThreshold }),
      reasons: ['no-usable-floor-geometry'],
      normalization: {
        method: 'multi-view-self-normalized-d6-top-ensemble-v1',
        dice_used: 0,
        views_used: 0,
        confidence: 0,
        automatic: false,
      },
    };
  }

  let reference = estimates[0];
  for (const estimate of estimates.slice(1)) {
    const currentKey = [Object.keys(estimate.centers).length, estimate.confidence];
    const bestKey = [Object.keys(reference.centers).length, reference.confidence];
    if (currentKey[0] > bestKey[0] || (currentKey[0] === bestKey[0] && currentKey[1] > bestKey[1])) {
      reference = estimate;
    }
  }
  let aligned = [];
  for (const estimate of estimates) {
    const transformed = alignCentersBySimilarity(estimate.centers, reference.centers);
    if (transformed) aligned.push({ estimate, transformed });
  }
  if (!aligned.length) {
    const ordered = orderSpatialRoll(reference.centers, valueMap, { ambiguityThreshold });
    return {
      ...ordered,
      automatic: false,
      confidence: 0,
      reasons: unique(['floor-consensus-alignment-failed', ...ordered.reasons]),
      normalization: {
        method: 'single-view-floor-center-fallback-v1',
        dice_used: Object.keys(reference.centers).length,
        views_used: 1,
        confidence: 0,
        automatic: false,
      },
    };
  }

  let consensus = { ...reference.centers };
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const realigned = [];
    for (const row of aligned) {
      const transformed = alignCentersBySimilarity(row.estimate.centers, consensus);
      if (transformed) realigned.push({ estimate: row.estimate, transformed });
    }
    aligned = realigned;
    consensus = {};
    for (const id of acceptedIds) {
      const observations = aligned
        .filter(row => row.transformed[id] != null)
        .map(row => row.transformed[id]);
      if (observations.length) {
        consensus[id] = [
          median(observations.map(point => point[0])),
          median(observations.map(point => point[1])),
        ];
      }
    }
  }

  if ([...acceptedIds].some(id => consensus[id] == null)) {
    return {
      ...orderSpatialRoll({}, {}, { ambiguityThreshold }),
      reasons: ['incomplete-multi-view-floor-consensus'],
      normalization: {
        method: 'multi-view-self-normalized-d6-top-ensemble-v1',
        dice_used: Object.keys(consensus).length,
        views_used: aligned.length,
        confidence: 0,
        automatic: false,
      },
    };
  }

  const consensusPoints = Object.values(consensus);
  const scaleValues = [];
  for (let i = 0; i < consensusPoints.length; i += 1) {
    for (let j = 0; j < consensusPoints.length; j += 1) {
      const value = distance(consensusPoints[i], consensusPoints[j]);
      if (value > 1e-9) scaleValues.push(value);
    }
  }
  const consensusScale = scaleValues.length ? median(scaleValues) : 1;
  const deviations = [];
  for (const row of aligned) {
    for (const [id, point] of entriesNumeric(row.transformed)) {
      if (consensus[id] == null) continue;
      deviations.push(distance(point, consensus[id]) / Math.max(consensusScale, EPS));
    }
  }
  const centerJitter = deviations.length ? percentile(deviations, 0.9) : 1;
  const reasons = [];
  if (aligned.length < minimumConsensusViews) reasons.push('insufficient-views-for-floor-consensus');
  if (centerJitter > maximumCenterJitter) reasons.push('multi-view-floor-centers-disagree');

  const ordered = orderSpatialRoll(consensus, valueMap, { ambiguityThreshold });
  const fitConfidence = aligned.length
    ? Math.min(...aligned.map(row => row.estimate.confidence))
    : 0;
  const jitterConfidence = Math.max(0, Math.min(1, 1 - centerJitter / Math.max(maximumCenterJitter, EPS)));
  const combinedReasons = unique([...reasons, ...ordered.reasons]);
  return {
    ...ordered,
    automatic: combinedReasons.length === 0,
    confidence: Math.min(ordered.confidence, fitConfidence, jitterConfidence),
    reasons: combinedReasons,
    normalization: {
      method: 'multi-view-self-normalized-d6-top-ensemble-v1',
      dice_used: Object.keys(consensus).length,
      views_used: aligned.length,
      center_jitter_p90: centerJitter,
      maximum_center_jitter: maximumCenterJitter,
      confidence: Math.min(fitConfidence, jitterConfidence),
      automatic: reasons.length === 0,
    },
  };
}

export function quadsFromIdentityMap(document) {
  const output = {};
  for (const item of document?.dice || []) {
    output[Number(item.physical_id)] = cloneQuad(item.reference_quad_px);
  }
  return output;
}
