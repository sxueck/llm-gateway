import { beforeEach, describe, expect, it, vi } from 'vitest';
import { capturePromptSample } from './prompt-capture-service.js';
import { promptSampleDb } from '../db/index.js';

vi.mock('../db/index.js', () => ({
  promptSampleDb: {
    create: vi.fn(),
  },
}));

vi.mock('./expert-router/preprocess/index.js', () => ({
  SignalBuilder: {
    buildRoutingSignal: vi.fn(),
  },
}));

describe('capturePromptSample', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not persist samples when prompt capture is disabled', async () => {
    await capturePromptSample({ id: 'vk-1', prompt_capture_enabled: 0 } as any, {
      body: { messages: [{ role: 'user', content: 'hello' }] },
    } as any, 'openai');

    expect(promptSampleDb.create).not.toHaveBeenCalled();
  });

  it('persists the cleaned user prompt with capture metadata', async () => {
    const { SignalBuilder } = await import('./expert-router/preprocess/index.js');
    vi.mocked(SignalBuilder.buildRoutingSignal).mockResolvedValue({
      intentText: 'Explain this error',
      stats: { promptTokens: 4, intentTruncated: false },
    } as any);

    await capturePromptSample({ id: 'vk-1', prompt_capture_enabled: 1, pii_protection_enabled: 0 } as any, {
      body: { model: 'gpt-5', messages: [{ role: 'user', content: 'Explain this error' }] },
    } as any, 'openai');

    expect(promptSampleDb.create).toHaveBeenCalledWith(expect.objectContaining({
      virtual_key_id: 'vk-1',
      model: 'gpt-5',
      protocol: 'openai',
      intent_text: 'Explain this error',
      prompt_tokens: 4,
      intent_truncated: 0,
    }));
  });

  it('masks Gemini prompt text before persisting when PII protection is enabled', async () => {
    const { SignalBuilder } = await import('./expert-router/preprocess/index.js');
    let capturedBody: any;
    vi.mocked(SignalBuilder.buildRoutingSignal).mockImplementation(async (request: any) => {
      capturedBody = request.body;
      return {
        intentText: request.body.contents[0].parts[0].text,
        stats: { promptTokens: 4, intentTruncated: false },
      } as any;
    });

    await capturePromptSample({ id: 'vk-1', prompt_capture_enabled: 1, pii_protection_enabled: 1 } as any, {
      body: { contents: [{ role: 'user', parts: [{ text: 'Contact alice@example.com' }] }] },
    } as any, 'gemini');

    expect(capturedBody.contents[0].parts[0].text).not.toContain('alice@example.com');
    expect(promptSampleDb.create).toHaveBeenCalledWith(expect.objectContaining({
      intent_text: expect.not.stringContaining('alice@example.com'),
    }));
  });

  it('does not persist samples without user intent', async () => {
    const { SignalBuilder } = await import('./expert-router/preprocess/index.js');
    vi.mocked(SignalBuilder.buildRoutingSignal).mockResolvedValue({
      intentText: '   ',
      stats: { promptTokens: 0, intentTruncated: false },
    } as any);

    await capturePromptSample({ id: 'vk-1', prompt_capture_enabled: 1, pii_protection_enabled: 0 } as any, {
      body: { messages: [{ role: 'user', content: 'hello' }] },
    } as any, 'openai');

    expect(promptSampleDb.create).not.toHaveBeenCalled();
  });

  it('strips assistant turns when client pastes full conversation into a single user message', async () => {
    const { SignalBuilder } = await import('./expert-router/preprocess/index.js');
    const mixedConversation = [
      'User: 帮我看看这段代码',
      'Assistant: 这段代码有 bug，建议这样改……',
      'User: 还是报错，怎么办？',
    ].join('\n');
    vi.mocked(SignalBuilder.buildRoutingSignal).mockResolvedValue({
      intentText: mixedConversation,
      stats: { promptTokens: 12, intentTruncated: false },
    } as any);

    await capturePromptSample({ id: 'vk-1', prompt_capture_enabled: 1, pii_protection_enabled: 0 } as any, {
      body: { model: 'gpt-5', messages: [{ role: 'user', content: mixedConversation }] },
    } as any, 'openai');

    expect(promptSampleDb.create).toHaveBeenCalledWith(expect.objectContaining({
      intent_text: '还是报错，怎么办？',
    }));
  });

  it('keeps the original intent when a single-turn prompt has no assistant turns', async () => {
    const { SignalBuilder } = await import('./expert-router/preprocess/index.js');
    const singleTurn = '请用 TypeScript 实现一个 LRU 缓存';
    vi.mocked(SignalBuilder.buildRoutingSignal).mockResolvedValue({
      intentText: singleTurn,
      stats: { promptTokens: 8, intentTruncated: false },
    } as any);

    await capturePromptSample({ id: 'vk-1', prompt_capture_enabled: 1, pii_protection_enabled: 0 } as any, {
      body: { model: 'gpt-5', messages: [{ role: 'user', content: singleTurn }] },
    } as any, 'openai');

    expect(promptSampleDb.create).toHaveBeenCalledWith(expect.objectContaining({
      intent_text: singleTurn,
    }));
  });

  it('keeps a leading instruction that quotes an assistant exchange', async () => {
    const { SignalBuilder } = await import('./expert-router/preprocess/index.js');
    const quotedConversation = [
      '我该怎么回复下面这段对话？',
      'Assistant: 我需要帮助',
      'User: 帮什么？',
    ].join('\n');
    vi.mocked(SignalBuilder.buildRoutingSignal).mockResolvedValue({
      intentText: quotedConversation,
      stats: { promptTokens: 12, intentTruncated: false },
    } as any);

    await capturePromptSample({ id: 'vk-1', prompt_capture_enabled: 1, pii_protection_enabled: 0 } as any, {
      body: { model: 'gpt-5', messages: [{ role: 'user', content: quotedConversation }] },
    } as any, 'openai');

    expect(promptSampleDb.create).toHaveBeenCalledWith(expect.objectContaining({
      intent_text: quotedConversation,
    }));
  });

  it('strips assistant turns marked with full-width colons', async () => {
    const { SignalBuilder } = await import('./expert-router/preprocess/index.js');
    const mixedConversation = [
      'User：帮我看看这段代码',
      'Assistant：这段代码有 bug，建议这样改。',
      'User：还是报错，怎么办？',
    ].join('\n');
    vi.mocked(SignalBuilder.buildRoutingSignal).mockResolvedValue({
      intentText: mixedConversation,
      stats: { promptTokens: 12, intentTruncated: false },
    } as any);

    await capturePromptSample({ id: 'vk-1', prompt_capture_enabled: 1, pii_protection_enabled: 0 } as any, {
      body: { model: 'gpt-5', messages: [{ role: 'user', content: mixedConversation }] },
    } as any, 'openai');

    expect(promptSampleDb.create).toHaveBeenCalledWith(expect.objectContaining({
      intent_text: '还是报错，怎么办？',
    }));
  });
});
