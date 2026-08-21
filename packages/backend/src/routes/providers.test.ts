import { describe, expect, it } from "vitest";

import { mapUpstreamModelList } from "./providers.js";

describe("mapUpstreamModelList", () => {
  it("preserves capability metadata from upstream model entries", () => {
    const result = mapUpstreamModelList({
      data: [
        {
          id: "gpt-4o",
          object: "model",
          created: 1715367049,
          owned_by: "system",
          max_completion_tokens: 16384,
          context_length: 128000,
        },
      ],
    });

    expect(result).toEqual([
      {
        id: "gpt-4o",
        name: "gpt-4o",
        object: "model",
        created: 1715367049,
        owned_by: "system",
        max_completion_tokens: 16384,
        context_length: 128000,
      },
    ]);
  });

  it("returns an empty list when upstream payload has no data array", () => {
    expect(mapUpstreamModelList({})).toEqual([]);
    expect(mapUpstreamModelList({ data: null })).toEqual([]);
    expect(mapUpstreamModelList(null)).toEqual([]);
  });
});
