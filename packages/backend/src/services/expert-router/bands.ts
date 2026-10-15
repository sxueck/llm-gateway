import type {
  CostInput,
  ExpertRoutingBands,
  ExpertTarget,
  DifficultyLevel,
  RoutingBand,
} from "../../types/expert-routing.js";

export const DEFAULT_JEV_OUTPUT_RATIO = 0.25;

/**
 * Output weight for the blended price, overridable via JEV_OUTPUT_RATIO.
 * Values outside [0, 1] fall back to the documented default.
 */
export function getJevOutputRatio(): number {
  const raw = Number(process.env.JEV_OUTPUT_RATIO);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1
    ? raw
    : DEFAULT_JEV_OUTPUT_RATIO;
}

/**
 * Blended per-token price: input * (1 - outputRatio) + output * outputRatio.
 * Unknown (missing / non-finite / negative) cost information yields Infinity
 * so such candidates sort as the most expensive within a band.
 */
export function blendedPriceOf(
  cost?: CostInput | null,
  outputRatio: number = getJevOutputRatio(),
): number {
  const input = Number(cost?.input_cost_per_token);
  const output = Number(cost?.output_cost_per_token);
  if (!Number.isFinite(input) || input < 0) return Infinity;
  if (!Number.isFinite(output) || output < 0) return Infinity;
  return input * (1 - outputRatio) + output * outputRatio;
}

export const BAND_ORDER: readonly RoutingBand[] = ["low", "medium", "high"];

/**
 * Candidate whose band may still be unassigned — the auto-banding input
 * (preview tooling and the v2 migration).
 */
export type BandCandidate = Omit<ExpertTarget, "band"> & { band?: RoutingBand };

/** A candidate with a definite band (buildBands output). */
export type BandedCandidate = BandCandidate & { band: RoutingBand };

export interface BandAssignment {
  low: BandedCandidate[];
  medium: BandedCandidate[];
  high: BandedCandidate[];
}

export type CostOfFn = (expert: BandCandidate) => CostInput | undefined | null;

const defaultCostOf: CostOfFn = () => undefined;

function sortByPrice(experts: BandCandidate[], costOf: CostOfFn): BandCandidate[] {
  const price = new Map<BandCandidate, number>(
    experts.map((expert) => [expert, blendedPriceOf(costOf(expert))]),
  );
  return [...experts].sort((a, b) => {
    const aPrice = price.get(a)!;
    const bPrice = price.get(b)!;
    if (aPrice === bPrice) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    return aPrice - bPrice;
  });
}

/**
 * Partition candidates into bands. Candidates with an explicit `band` keep
 * it; the remainder is sorted by blended price ascending and split three-way
 * (cheapest third → low, middle third → medium, most expensive third → high).
 * Returned candidates always carry a definite `band` (stamped on auto-split).
 */
export function buildBands(
  experts: BandCandidate[],
  costOf: CostOfFn = defaultCostOf,
): BandAssignment {
  const bands: BandAssignment = { low: [], medium: [], high: [] };
  const remainder: BandCandidate[] = [];
  for (const expert of experts) {
    if (expert.band && (BAND_ORDER as readonly string[]).includes(expert.band)) {
      bands[expert.band].push({ ...expert, band: expert.band });
    } else {
      remainder.push(expert);
    }
  }
  const priced = remainder.filter((expert) => Number.isFinite(blendedPriceOf(costOf(expert))));
  const unknown = remainder.filter((expert) => !Number.isFinite(blendedPriceOf(costOf(expert))));
  const sorted = sortByPrice(priced, costOf);
  const lowEnd = Math.ceil(sorted.length / 3);
  const mediumEnd = lowEnd + Math.ceil((sorted.length - lowEnd) / 2);
  bands.low.push(...sorted.slice(0, lowEnd).map((e) => ({ ...e, band: "low" as const })));
  bands.medium.push(...sorted.slice(lowEnd, mediumEnd).map((e) => ({ ...e, band: "medium" as const })));
  bands.high.push(
    ...sorted.slice(mediumEnd).map((e) => ({ ...e, band: "high" as const })),
    ...sortByPrice(unknown, costOf).map((e) => ({ ...e, band: "high" as const })),
  );
  return bands;
}

/**
 * Ordered candidate list for a verdict band: the band's experts in config
 * array order (v2 tie-break rule). An empty band escalates to the nearest
 * non-empty band (cheaper neighbour first, then the more expensive one), so
 * a lookup never returns nothing while candidates exist.
 */
export function resolveBandCandidates(
  bands: ExpertRoutingBands,
  band: RoutingBand,
): ExpertTarget[] {
  const index = BAND_ORDER.indexOf(band);
  for (let offset = 0; offset < BAND_ORDER.length; offset++) {
    for (const direction of offset === 0 ? [0] : [-1, 1]) {
      const candidateIndex = index + offset * direction;
      if (candidateIndex < 0 || candidateIndex >= BAND_ORDER.length) continue;
      const candidates = bands[BAND_ORDER[candidateIndex]];
      if (candidates.length > 0) return [...candidates];
    }
  }
  return [];
}

/**
 * Map a difficulty verdict onto a band. Absent or unknown verdicts resolve to
 * the low band (cheapest), per the PR-2 fallback chain spec.
 */
export function difficultyToBand(verdict?: DifficultyLevel | null): RoutingBand {
  switch (verdict) {
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "low":
      return "low";
    default:
      return "low";
  }
}
