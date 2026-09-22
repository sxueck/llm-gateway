import { describe, expect, it } from "vitest";
import type { AnthropicStreamEvent } from "../../types/anthropic.js";
import { AnthropicStreamNormalizer } from "./stream-normalizer.js";

function normalize(events: AnthropicStreamEvent[]): AnthropicStreamEvent[] {
  const normalizer = new AnthropicStreamNormalizer();
  return [
    ...events.flatMap((event) => normalizer.push(event)),
    ...normalizer.finish(),
  ];
}

describe("AnthropicStreamNormalizer", () => {
  it("preserves a valid thinking then text stream", () => {
    const events: AnthropicStreamEvent[] = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Thought." },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Answer." },
      },
      { type: "content_block_stop", index: 1 },
    ];

    expect(normalize(events)).toEqual(events);
  });

  it("splits mixed thinking and text deltas into separate blocks", () => {
    const events: AnthropicStreamEvent[] = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Thought." },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Answer." },
      },
      { type: "content_block_stop", index: 0 },
    ];

    expect(normalize(events)).toEqual([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Thought." },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Answer." },
      },
      { type: "content_block_stop", index: 1 },
    ]);
  });

  it("emits text included in a block start once when the first delta repeats it", () => {
    expect(
      normalize([
        {
          type: "content_block_start",
          index: 2,
          content_block: { type: "text", text: "Answer." },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "text_delta", text: "Answer." },
        },
        { type: "content_block_stop", index: 2 },
      ]),
    ).toEqual([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Answer." },
      },
      { type: "content_block_stop", index: 0 },
    ]);
  });

  it("flushes a pending block before message_stop", () => {
    expect(
      normalize([
        {
          type: "content_block_start",
          index: 2,
          content_block: { type: "text", text: "Answer." },
        },
        { type: "message_stop" },
      ]),
    ).toEqual([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Answer." },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ]);
  });

  it("emits thinking included in a block start once when the first delta repeats it", () => {
    const events: AnthropicStreamEvent[] = [
      {
        type: "content_block_start",
        index: 4,
        content_block: {
          type: "thinking",
          thinking: "Thought.",
          signature: "sig",
        },
      },
      {
        type: "content_block_delta",
        index: 4,
        delta: { type: "thinking_delta", thinking: "Thought." },
      },
      {
        type: "content_block_delta",
        index: 4,
        delta: { type: "signature_delta", signature: "sig" },
      },
      { type: "content_block_stop", index: 4 },
    ];

    expect(normalize(events)).toEqual([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "", signature: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Thought." },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig" },
      },
      { type: "content_block_stop", index: 0 },
    ]);
  });
});
