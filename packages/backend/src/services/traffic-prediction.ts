const FEATURE_COUNT = 8 as const;
const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const SHANGHAI_OFFSET = 8 * HOUR_MS;
const TWO_PI = 2 * Math.PI;

export interface HourlyActual {
  timestamp: number;
  count: number;
}

export interface HourlyPrediction {
  timestamp: number;
  predictedCount: number;
  isPeak: boolean;
  peakScore: number;
  isWorkday: boolean;
}

export interface PeakWindow {
  startTimestamp: number;
  endTimestamp: number;
  peakTimestamp: number;
  peakCount: number;
  avgBaseline: number;
  surgeRatio: number;
}

export interface TrainingData {
  timestampMs: number;
  count: number;
  isWorkday: boolean;
}

export interface RidgeModel {
  theta: number[];
  lambda: number;
  trainingSamples: number;
  featureCount: 8;
}

function getLocalHour(timestampMs: number): number {
  const normalized = ((timestampMs + SHANGHAI_OFFSET) % DAY_MS + DAY_MS) % DAY_MS;
  return Math.floor(normalized / HOUR_MS);
}

function getLocalDayOfWeek(timestampMs: number): number {
  return new Date(timestampMs + SHANGHAI_OFFSET).getUTCDay();
}

export function buildFeatureVector(timestampMs: number, isWorkday: boolean): number[] {
  const hour = getLocalHour(timestampMs);
  const dayOfWeek = getLocalDayOfWeek(timestampMs);

  return [
    1,
    Math.sin(TWO_PI * hour / 24),
    Math.cos(TWO_PI * hour / 24),
    Math.sin(2 * TWO_PI * hour / 24),
    Math.cos(2 * TWO_PI * hour / 24),
    Math.sin(TWO_PI * dayOfWeek / 7),
    Math.cos(TWO_PI * dayOfWeek / 7),
    isWorkday ? 1 : 0,
  ];
}

export function transpose(matrix: number[][]): number[][] {
  if (matrix.length === 0) {
    return [];
  }

  const rows = matrix.length;
  const cols = matrix[0].length;
  const result: number[][] = Array.from({ length: cols }, () => Array(rows).fill(0));

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      result[col][row] = matrix[row][col];
    }
  }

  return result;
}

export function matMul(a: number[][], b: number[][]): number[][] {
  if (a.length === 0 || b.length === 0) {
    return [];
  }

  const m = a.length;
  const k = a[0].length;
  const n = b[0].length;
  const result: number[][] = Array.from({ length: m }, () => Array(n).fill(0));

  for (let row = 0; row < m; row++) {
    for (let col = 0; col < n; col++) {
      let sum = 0;
      for (let pivot = 0; pivot < k; pivot++) {
        sum += a[row][pivot] * b[pivot][col];
      }
      result[row][col] = sum;
    }
  }

  return result;
}

export function inverse8x8(matrix: number[][]): number[][] {
  if (matrix.length !== FEATURE_COUNT || matrix.some(row => row.length !== FEATURE_COUNT)) {
    throw new Error('Matrix must be 8x8');
  }

  const size = FEATURE_COUNT;
  const augmented = matrix.map((row, rowIndex) => [
    ...row,
    ...Array.from({ length: size }, (_, colIndex) => (rowIndex === colIndex ? 1 : 0)),
  ]);

  for (let col = 0; col < size; col++) {
    let pivotRow = col;
    for (let row = col + 1; row < size; row++) {
      if (Math.abs(augmented[row][col]) > Math.abs(augmented[pivotRow][col])) {
        pivotRow = row;
      }
    }

    if (pivotRow !== col) {
      [augmented[col], augmented[pivotRow]] = [augmented[pivotRow], augmented[col]];
    }

    const pivot = augmented[col][col];
    if (Math.abs(pivot) < 1e-12) {
      throw new Error('Matrix is singular');
    }

    for (let idx = 0; idx < size * 2; idx++) {
      augmented[col][idx] /= pivot;
    }

    for (let row = 0; row < size; row++) {
      if (row === col) {
        continue;
      }

      const factor = augmented[row][col];
      for (let idx = 0; idx < size * 2; idx++) {
        augmented[row][idx] -= factor * augmented[col][idx];
      }
    }
  }

  return augmented.map(row => row.slice(size));
}

export function trainRidge(samples: TrainingData[], lambda: number = 0.1): number[] {
  const validSamples = samples.filter(sample => Number.isFinite(sample.count) && sample.count >= 0);

  if (validSamples.length === 0) {
    return Array(FEATURE_COUNT).fill(0);
  }

  const x = validSamples.map(sample => buildFeatureVector(sample.timestampMs, sample.isWorkday));
  const y = validSamples.map(sample => [sample.count]);
  const xt = transpose(x);
  const xtx = matMul(xt, x);

  for (let idx = 0; idx < FEATURE_COUNT; idx++) {
    xtx[idx][idx] += lambda;
  }

  try {
    const xtxInverse = inverse8x8(xtx);
    const xty = matMul(xt, y);
    const theta = matMul(xtxInverse, xty);
    return theta.map(row => row[0] ?? 0);
  } catch {
    return Array(FEATURE_COUNT).fill(0);
  }
}

export function predict(theta: number[], timestampMs: number, isWorkday: boolean): number {
  const features = buildFeatureVector(timestampMs, isWorkday);
  const rawValue = features.reduce((sum, value, index) => sum + value * (theta[index] ?? 0), 0);
  return Math.max(0, rawValue);
}

const DAY_TYPES = 2 as const; // index 0 = 非工作日, 1 = 工作日
const DAYS_OF_WEEK = 7 as const;
const HOURS_OF_DAY = 24 as const;
const DEFAULT_PRIOR_STRENGTH = 3;

export interface WeeklyEmpiricalModel {
  fineSum: number[][][]; // [dayType][dayOfWeek][hour]
  fineCount: number[][][];
  clusterSum: number[][]; // [dayType][hour]
  clusterCount: number[][];
  globalSum: number[]; // [hour]
  globalCount: number[];
  priorStrength: number;
  trainingSamples: number;
}

function zeros3(): number[][][] {
  return Array.from({ length: DAY_TYPES }, () =>
    Array.from({ length: DAYS_OF_WEEK }, () => Array(HOURS_OF_DAY).fill(0)));
}

function zeros2(): number[][] {
  return Array.from({ length: DAY_TYPES }, () => Array(HOURS_OF_DAY).fill(0));
}

/**
 * 收缩估计（经验贝叶斯）：把细粒度样本均值向更粗粒度的先验收缩。
 * 当样本数 count 较少时偏向先验，count 越大越相信自身均值。
 */
function shrink(sum: number, count: number, prior: number, k: number): number {
  if (count <= 0) {
    return prior;
  }
  return (sum + k * prior) / (count + k);
}

/**
 * 周节律经验模型：以 (星期几 × 小时) 为最细粒度直接从网关历史学习周期规律，
 * 不再硬编码“工作日=白天”这一语义先验——夜间工作者、周末重度、24/7 等节律都由数据自行呈现。
 *
 * 采用三层收缩(细→簇→全局)缓解 14 天窗口下每格样本稀疏的问题：
 *   细粒度 (dayType × 星期几 × 小时) → 簇 (dayType × 小时) → 全局 (小时)。
 * dayType 由 isWorkday(由地区节假日日历判定)给出，因此：
 *   - 区域感知天然继承；
 *   - 法定节假日(工作日历中的非工作日)会落入非工作日簇，按周末规律预测，而不会污染正常工作日的格子；
 *   - 调休补班日(周末但 isWorkday=true)则落入工作日簇，按工作日规律预测。
 */
export function trainWeeklyEmpirical(
  samples: TrainingData[],
  priorStrength: number = DEFAULT_PRIOR_STRENGTH
): WeeklyEmpiricalModel {
  const fineSum = zeros3();
  const fineCount = zeros3();
  const clusterSum = zeros2();
  const clusterCount = zeros2();
  const globalSum = Array(HOURS_OF_DAY).fill(0);
  const globalCount = Array(HOURS_OF_DAY).fill(0);
  let trainingSamples = 0;

  for (const sample of samples) {
    if (!Number.isFinite(sample.count) || sample.count < 0) {
      continue;
    }

    const hour = getLocalHour(sample.timestampMs);
    const dayOfWeek = getLocalDayOfWeek(sample.timestampMs);
    const dayType = sample.isWorkday ? 1 : 0;

    fineSum[dayType][dayOfWeek][hour] += sample.count;
    fineCount[dayType][dayOfWeek][hour] += 1;
    clusterSum[dayType][hour] += sample.count;
    clusterCount[dayType][hour] += 1;
    globalSum[hour] += sample.count;
    globalCount[hour] += 1;

    trainingSamples += 1;
  }

  return {
    fineSum,
    fineCount,
    clusterSum,
    clusterCount,
    globalSum,
    globalCount,
    priorStrength: Math.max(0, priorStrength),
    trainingSamples,
  };
}

export function predictWeeklyEmpirical(
  model: WeeklyEmpiricalModel,
  timestampMs: number,
  isWorkday: boolean
): number {
  const hour = getLocalHour(timestampMs);
  const dayOfWeek = getLocalDayOfWeek(timestampMs);
  const dayType = isWorkday ? 1 : 0;
  const k = model.priorStrength;

  const global = model.globalCount[hour] > 0 ? model.globalSum[hour] / model.globalCount[hour] : 0;
  const cluster = shrink(model.clusterSum[dayType][hour], model.clusterCount[dayType][hour], global, k);
  const fine = shrink(model.fineSum[dayType][dayOfWeek][hour], model.fineCount[dayType][dayOfWeek][hour], cluster, k);

  return Math.max(0, fine);
}

/**
 * 导出某一 dayType 的簇级小时画像（向全局收缩后），用于展示/调试。
 */
export function clusterProfile(model: WeeklyEmpiricalModel, isWorkday: boolean): number[] {
  const dayType = isWorkday ? 1 : 0;
  const k = model.priorStrength;

  return Array.from({ length: HOURS_OF_DAY }, (_, hour) => {
    const global = model.globalCount[hour] > 0 ? model.globalSum[hour] / model.globalCount[hour] : 0;
    return Math.max(0, shrink(model.clusterSum[dayType][hour], model.clusterCount[dayType][hour], global, k));
  });
}

export function detectPeaks(predictions: HourlyPrediction[]): PeakWindow[] {
  if (predictions.length === 0) {
    return [];
  }

  const counts = predictions.map(item => item.predictedCount);
  const mean = counts.reduce((sum, value) => sum + value, 0) / counts.length;
  const threshold = mean * 1.2;
  const peakIndices: number[] = [];

  for (let index = 0; index < counts.length; index++) {
    const current = counts[index];
    const prev = counts[index - 1] ?? current;
    const next = counts[index + 1] ?? current;

    if (current > prev && current >= next && current > threshold) {
      peakIndices.push(index);
    }
  }

  if (peakIndices.length === 0) {
    return [];
  }

  const windows: PeakWindow[] = [];
  let groupStart = peakIndices[0];
  let groupEnd = peakIndices[0];
  let groupPeak = peakIndices[0];

  for (let index = 1; index < peakIndices.length; index++) {
    const candidate = peakIndices[index];
    const previous = peakIndices[index - 1];

    if (candidate - previous <= 2) {
      groupEnd = candidate;
      if (counts[candidate] > counts[groupPeak]) {
        groupPeak = candidate;
      }
      continue;
    }

    windows.push({
      startTimestamp: predictions[groupStart].timestamp,
      endTimestamp: predictions[groupEnd].timestamp,
      peakTimestamp: predictions[groupPeak].timestamp,
      peakCount: counts[groupPeak],
      avgBaseline: mean,
      surgeRatio: mean > 0 ? counts[groupPeak] / mean - 1 : 0,
    });

    groupStart = candidate;
    groupEnd = candidate;
    groupPeak = candidate;
  }

  windows.push({
    startTimestamp: predictions[groupStart].timestamp,
    endTimestamp: predictions[groupEnd].timestamp,
    peakTimestamp: predictions[groupPeak].timestamp,
    peakCount: counts[groupPeak],
    avgBaseline: mean,
    surgeRatio: mean > 0 ? counts[groupPeak] / mean - 1 : 0,
  });

  return windows;
}

export const trafficPredictionService = {
  buildFeatureVector,
  trainRidge,
  predict,
  trainWeeklyEmpirical,
  predictWeeklyEmpirical,
  clusterProfile,
  detectPeaks,
};
