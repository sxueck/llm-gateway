import { nanoid } from 'nanoid';
import type { FastifyRequest } from 'fastify';
import { promptSampleDb } from '../db/index.js';
import type { VirtualKey } from '../types/index.js';
import { SignalBuilder } from './expert-router/preprocess/index.js';
import { maskRequestBodyInPlace } from './pii-protection-service.js';
import { memoryLogger } from './logger.js';

type PromptCaptureProtocol = 'openai' | 'anthropic' | 'gemini';

function copyRequestBody(body: unknown): any {
  return body === undefined ? {} : structuredClone(body);
}

export async function capturePromptSample(
  virtualKey: Pick<VirtualKey, 'id' | 'prompt_capture_enabled' | 'pii_protection_enabled'>,
  request: Pick<FastifyRequest, 'body'>,
  protocol: PromptCaptureProtocol
): Promise<void> {
  if (virtualKey.prompt_capture_enabled !== 1) return;

  const body = copyRequestBody(request.body);
  if (virtualKey.pii_protection_enabled === 1) {
    maskRequestBodyInPlace(body, true);
  }

  const signal = await SignalBuilder.buildRoutingSignal(
    { body, protocol },
    { strip_tools: true, strip_files: true, strip_system_prompt: true }
  );
  const intentText = signal.intentText.trim();
  if (!intentText) return;

  await promptSampleDb.create({
    id: nanoid(),
    virtual_key_id: virtualKey.id,
    model: typeof body.model === 'string' ? body.model : 'unknown',
    protocol,
    intent_text: intentText,
    prompt_tokens: signal.stats?.promptTokens || 0,
    intent_truncated: signal.stats?.intentTruncated ? 1 : 0,
    created_at: Date.now(),
  });
}

export function capturePromptSampleAsync(
  virtualKey: Pick<VirtualKey, 'id' | 'prompt_capture_enabled' | 'pii_protection_enabled'>,
  request: Pick<FastifyRequest, 'body'>,
  protocol: PromptCaptureProtocol
): void {
  capturePromptSample(virtualKey, request, protocol).catch((error) => {
    memoryLogger.warn(
      `Prompt sample capture failed: ${error instanceof Error ? error.message : String(error)}`,
      'PromptCapture'
    );
  });
}
