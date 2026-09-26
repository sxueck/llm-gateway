import { afterEach, describe, expect, test } from "vitest";
import {
  BAND_ORDER,
  DEFAULT_JEV_OUTPUT_RATIO,
  blendedPriceOf,
  buildBands,
  difficultyToBand,
  getJevOutputRatio,
  resolveBandCandidates,
} from "./bands.js";
import type { ExpertTarget } from "../../types/expert-routing.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function expert(id: string, band?: string): ExpertTarget {
  return { id, category: id, type: "real", ...(band ? { band } : {}) } as ExpertTarget;
}

function priced(id: string, _input?: number): ExpertTarget {
  return { id, category: id, type: "real" } as ExpertTarget;
}

describe("blendedPriceOf", () => {
  test("weights input at 75% and output at the configured ratio", () => {
    expect(blendedPriceOf({ input_cost_per_token: 4, output_cost_per_token: 2 })).toBe(3.5);
    expect(
      blendedPriceOf({ input_cost_per_token: 4, output_cost_per_token: 2 }, 0.5),
    ).toBe(3);
  });

  test("defaults to the documented JEV output ratio", () => {
    delete process.env.JEV_OUTPUT_RATIO;
    expect(getJevOutputRatio()).toBe(DEFAULT_JEV_OUTPUT_RATIO);
    expect(blendedPriceOf({ input_cost_per_token: 1, output_cost_per_token: 1 })).toBe(1);
  });

  test("honours a valid JEV_OUTPUT_RATIO override and rejects invalid values", () => {
    process.env.JEV_OUTPUT_RATIO = "0.5";
    expect(getJevOutputRatio()).toBe(0.5);
    process.env.JEV_OUTPUT_RATIO = "not-a-number";
    expect(getJevOutputRatio()).toBe(DEFAULT_JEV_OUTPUT_RATIO);
    process.env.JEV_OUTPUT_RATIO = "-1";
    expect(getJevOutputRatio()).toBe(DEFAULT_JEV_OUTPUT_RATIO);
  });

  test("unknown or invalid cost components price as Infinity", () => {
    expect(blendedPriceOf(undefined)).toBe(Infinity);
    expect(blendedPriceOf(null)).toBe(Infinity);
    expect(blendedPriceOf({})).toBe(Infinity);
    expect(blendedPriceOf({ input_cost_per_token: 0.01 })).toBe(Infinity);
    expect(blendedPriceOf({ input_cost_per_token: -1, output_cost_per_token: 1 })).toBe(Infinity);
  });
});

describe("buildBands", () => {
  test("keeps explicit bands and auto-splits the remainder three-way by price", () => {
    const expensive = expert("explicit-high", "high");
    const inputs: Record<string, number> = { a: 0.1, b: 0.2, c: 0.3, d: 0.4, e: 0.5, f: 0.6 };
    const remainder = Object.keys(inputs).map((id) => priced(id, inputs[id]));
    const bands = buildBands(
      [expensive, ...remainder],
      (e) => ({ input_cost_per_token: inputs[e.id], output_cost_per_token: 0 }),
    );
    expect(bands.low.map((e) => e.id)).toEqual(["a", "b"]);
    expect(bands.medium.map((e) => e.id)).toEqual(["c", "d"]);
    expect(bands.high.map((e) => e.id)).toEqual(["explicit-high", "e", "f"]);
  });

  test("unknown costs sort last and ties break by id", () => {
    const bands = buildBands(
      [expert("z"), priced("m", 0.2), expert("a")],
      (e) => (e.id === "m" ? { input_cost_per_token: 0.2, output_cost_per_token: 0.2 } : undefined),
    );
    expect(bands.low.map((e) => e.id)).toEqual(["m"]);
    expect(bands.medium.map((e) => e.id)).toEqual([]);
    expect(bands.high.map((e) => e.id)).toEqual(["a", "z"]);
  });

  test("splits uneven remainders with the cheapest third in low", () => {
    const experts = [priced("p1", 1), priced("p2", 2), priced("p3", 3), priced("p4", 4)];
    const bands = buildBands(experts, (e) => ({ input_cost_per_token: Number(e.id.slice(1)), output_cost_per_token: 0 }));
    expect(bands.low.map((e) => e.id)).toEqual(["p1", "p2"]);
    expect(bands.medium.map((e) => e.id)).toEqual(["p3"]);
    expect(bands.high.map((e) => e.id)).toEqual(["p4"]);
  });

  test.each([1, 2])("assigns %i unknown-cost candidates high", (count) => {
    const bands = buildBands(Array.from({ length: count }, (_, i) => expert(`u${i}`)), () => undefined);
    expect(bands.low).toEqual([]);
    expect(bands.medium).toEqual([]);
    expect(bands.high).toHaveLength(count);
  });

  test("preserves explicit bands even with unknown costs", () => {
    const bands = buildBands([expert("x", "low")], () => undefined);
    expect(bands.low.map((e) => e.id)).toEqual(["x"]);
  });

  test("assigns one or two priced candidates to low first", () => {
    for (const count of [1, 2]) {
      const bands = buildBands(Array.from({ length: count }, (_, i) => expert(`p${i}`)),
        (e) => ({ input_cost_per_token: Number(e.id.slice(1)), output_cost_per_token: 1 }));
      expect(bands.low).toHaveLength(1);
      expect(bands.high).toEqual([]);
    }
  });

  test("ignores invalid explicit band values", () => {
    const bands = buildBands([expert("x", "bogus" as any)], () => undefined);
    expect(bands.high.map((e) => e.id)).toEqual(["x"]);
  });
});

describe("resolveBandCandidates", () => {
  const low = [expert("l2"), expert("l1")];
  const medium = [expert("m1")];
  const bands = { low, medium, high: [] as ExpertTarget[] };

  test("returns the verdict band sorted cheapest first", () => {
    // Unknown costs: id tie-break keeps l1 before l2.
    expect(resolveBandCandidates(bands, "low").map((e) => e.id)).toEqual(["l1", "l2"]);
  });

  test("escalates an empty band to the nearest cheaper neighbour first", () => {
    expect(resolveBandCandidates({ low: [], medium, high: [] }, "low").map((e) => e.id)).toEqual(["m1"]);
    expect(resolveBandCandidates({ low: [], medium, high: [] }, "high").map((e) => e.id)).toEqual(["m1"]);
  });

  test("returns empty when no band has candidates", () => {
    expect(resolveBandCandidates({ low: [], medium: [], high: [] }, "medium")).toEqual([]);
  });

  test("band order is low → medium → high", () => {
    expect(BAND_ORDER).toEqual(["low", "medium", "high"]);
  });
});

describe("difficultyToBand", () => {
  test("maps the fixed difficulty vocabulary onto bands", () => {
    expect(difficultyToBand("low")).toBe("low");
    expect(difficultyToBand("medium")).toBe("medium");
    expect(difficultyToBand("high")).toBe("high");
  });

  test("absent or unknown verdicts degrade to the low band", () => {
    expect(difficultyToBand(undefined)).toBe("low");
    expect(difficultyToBand(null)).toBe("low");
    expect(difficultyToBand("extreme" as any)).toBe("low");
  });
});
