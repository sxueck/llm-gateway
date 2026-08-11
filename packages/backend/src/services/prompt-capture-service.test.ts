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
});
