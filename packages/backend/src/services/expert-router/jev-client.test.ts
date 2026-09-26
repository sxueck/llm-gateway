import { afterEach, beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ upstreamFetch: vi.fn() }));
vi.mock("../../utils/upstream-fetch.js", () => ({ upstreamFetch: mocks.upstreamFetch }));
import { chooseExpert, getJevConfiguration } from "./jev-client.js";

const experts = [
  { id: "review", category: "review", description: "Review code", type: "real" as const },
  { id: "fast", category: "simple", description: "Fast answer", type: "real" as const },
];
const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.JEV_API_URL = "https://api.typesafe.ai/v1/systemone";
  process.env.JEV_API_KEY = "test-key";
  process.env.JEV_MODEL = "jev-1.13.0";
  mocks.upstreamFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      model: "jev-1.13.0",
      answers: { model: { type: "choice", choice: "review", confidence: 0.75,
        probabilities: { review: 0.8, fast: 0.2 } } },
    }),
  });
});
afterEach(() => { process.env = { ...originalEnv }; });

test("sends configured candidate descriptions and sorts probabilities", async () => {
  const decision = await chooseExpert("please review", experts);
  expect(decision.ranked).toEqual([
    { expertId: "review", probability: 0.8 },
    { expertId: "fast", probability: 0.2 },
  ]);
  const [url, options] = mocks.upstreamFetch.mock.calls[0];
  expect(url.toString()).toBe("https://api.typesafe.ai/v1/systemone");
  expect(options.body).toContain('"review":"review: Review code"');
  expect(options.body).toContain('"model":"jev-1.13.0"');
});

test("rejects unknown choices and inconsistent probabilities", async () => {
  mocks.upstreamFetch.mockResolvedValueOnce({ ok: true, json: async () => ({
    model: "jev", answers: { model: { type: "choice", choice: "unknown", confidence: 0.9,
      probabilities: { review: 0.8, fast: 0.2 } } },
  }) });
  await expect(chooseExpert("review", experts)).rejects.toThrow("unknown or missing candidate");
  mocks.upstreamFetch.mockResolvedValueOnce({ ok: true, json: async () => ({
    model: "jev", answers: { model: { type: "choice", choice: "fast", confidence: 0.9,
      probabilities: { review: 0.8, fast: 0.2 } } },
  }) });
  await expect(chooseExpert("review", experts)).rejects.toThrow("highest-probability");
});

test("validates explicit endpoint and credentials", () => {
  process.env.JEV_API_URL = "file:///etc/passwd";
  expect(() => getJevConfiguration()).toThrow("HTTP(S)");
  process.env.JEV_API_URL = "not a URL";
  expect(() => getJevConfiguration()).toThrow("valid absolute");
  delete process.env.JEV_API_KEY;
  expect(() => getJevConfiguration()).toThrow("must be configured");
});
