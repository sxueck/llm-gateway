import type {
  AnthropicContentBlock,
  AnthropicStreamEvent,
} from "../../types/anthropic.js";

type StreamBlockType = AnthropicContentBlock["type"];

interface ActiveBlock {
  outputIndex: number;
  type: StreamBlockType;
  thinkingFromStart?: string;
  textFromStart?: string;
}

function blockTypeForDelta(
  deltaType: NonNullable<AnthropicStreamEvent["delta"]>["type"] | undefined,
): StreamBlockType | null {
  if (deltaType === "thinking_delta" || deltaType === "signature_delta")
    return "thinking";
  if (deltaType === "text_delta") return "text";
  return null;
}

function emptyContentBlock(
  block: AnthropicContentBlock | undefined,
  type: StreamBlockType,
): AnthropicContentBlock {
  const normalized = { ...(block ?? {}), type } as AnthropicContentBlock;
  if (type === "thinking") {
    delete normalized.text;
    normalized.thinking = "";
    normalized.signature = "";
  }
  if (type === "text") {
    delete normalized.thinking;
    delete normalized.signature;
    normalized.text = "";
  }
  return normalized;
}

/**
 * Converts malformed Anthropic-compatible event streams into valid content
 * blocks before they reach clients. A provider may put thinking and text in
 * one source block; each payload is emitted in its own output block.
 */
export class AnthropicStreamNormalizer {
  private activeBlock: ActiveBlock | null = null;
  private pendingStart: AnthropicStreamEvent | null = null;
  private nextOutputIndex = 0;

  push(event: AnthropicStreamEvent): AnthropicStreamEvent[] {
    if (event.type === "content_block_start") return this.startBlock(event);
    if (event.type === "content_block_delta") return this.delta(event);
    if (event.type === "content_block_stop") return this.stopBlock(event);
    if (event.type === "message_stop")
      return [...this.openPendingBlock(), ...this.closeActiveBlock(), event];
    return [event];
  }

  finish(): AnthropicStreamEvent[] {
    return [...this.openPendingBlock(), ...this.closeActiveBlock()];
  }

  private startBlock(event: AnthropicStreamEvent): AnthropicStreamEvent[] {
    const output = [...this.openPendingBlock(), ...this.closeActiveBlock()];
    this.pendingStart = event;
    return output;
  }

  private delta(event: AnthropicStreamEvent): AnthropicStreamEvent[] {
    const sourceIndex = event.index ?? 0;
    const desiredType = blockTypeForDelta(event.delta?.type);
    const output: AnthropicStreamEvent[] = [];

    if (this.pendingStart && (this.pendingStart.index ?? 0) !== sourceIndex) {
      output.push(...this.openPendingBlock(), ...this.closeActiveBlock());
    }

    if (!this.activeBlock && !this.pendingStart) {
      this.pendingStart = {
        type: "content_block_start",
        index: sourceIndex,
        content_block: { type: desiredType ?? "text", text: "" },
      };
    }

    const pendingType = this.pendingStart?.content_block?.type;
    const targetType =
      desiredType ?? pendingType ?? this.activeBlock?.type ?? "text";

    if (this.activeBlock && this.activeBlock.type !== targetType) {
      output.push(...this.closeActiveBlock());
      this.pendingStart = {
        type: "content_block_start",
        index: sourceIndex,
        content_block: { type: targetType },
      };
    }

    output.push(...this.openPendingBlock(targetType));

    if (
      this.activeBlock?.thinkingFromStart &&
      event.delta?.type === "thinking_delta" &&
      event.delta.thinking === this.activeBlock.thinkingFromStart
    ) {
      this.activeBlock.thinkingFromStart = undefined;
      return output;
    }
    if (
      this.activeBlock?.textFromStart &&
      event.delta?.type === "text_delta" &&
      event.delta.text === this.activeBlock.textFromStart
    ) {
      this.activeBlock.textFromStart = undefined;
      return output;
    }

    output.push({
      ...event,
      index: this.activeBlock?.outputIndex ?? sourceIndex,
    });
    return output;
  }

  private stopBlock(_event: AnthropicStreamEvent): AnthropicStreamEvent[] {
    const output = [...this.openPendingBlock(), ...this.closeActiveBlock()];
    return output;
  }

  private openPendingBlock(type?: StreamBlockType): AnthropicStreamEvent[] {
    if (!this.pendingStart) return [];

    const start = this.pendingStart;
    this.pendingStart = null;
    const sourceBlock = start.content_block;
    const blockType = type ?? sourceBlock?.type ?? "text";
    const outputIndex = this.nextOutputIndex++;
    const output: AnthropicStreamEvent[] = [
      {
        ...start,
        index: outputIndex,
        content_block: emptyContentBlock(sourceBlock, blockType),
      },
    ];

    this.activeBlock = { outputIndex, type: blockType };
    if (
      blockType === "thinking" &&
      typeof sourceBlock?.thinking === "string" &&
      sourceBlock.thinking.length > 0
    ) {
      this.activeBlock.thinkingFromStart = sourceBlock.thinking;
      output.push({
        type: "content_block_delta",
        index: outputIndex,
        delta: { type: "thinking_delta", thinking: sourceBlock.thinking },
      });
    }
    if (
      blockType === "text" &&
      typeof sourceBlock?.text === "string" &&
      sourceBlock.text.length > 0
    ) {
      this.activeBlock.textFromStart = sourceBlock.text;
      output.push({
        type: "content_block_delta",
        index: outputIndex,
        delta: { type: "text_delta", text: sourceBlock.text },
      });
    }
    return output;
  }

  private closeActiveBlock(): AnthropicStreamEvent[] {
    if (!this.activeBlock) return [];
    const { outputIndex } = this.activeBlock;
    this.activeBlock = null;
    return [{ type: "content_block_stop", index: outputIndex }];
  }
}
