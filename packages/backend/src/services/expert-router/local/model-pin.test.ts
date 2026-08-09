import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, test } from 'vitest';
import {
  EXPERT_ROUTING_MODEL_REPO,
  EXPERT_ROUTING_MODEL_REVISION,
} from '@llm-gateway/shared';

// The download script lives outside src/ (so vitest does not treat it as a
// test file) and is copied alone into the isolated Docker `model-assets`
// build stage, so it CANNOT import these constants and must keep its own
// literals. This test pins the two together so a single-source bump (e.g.
// updating EXPERT_ROUTING_MODEL_REVISION) cannot silently desync the runtime
// loader (which validates the on-disk REVISION marker against the shared
// constant) from the script that writes that marker.
const SCRIPT_PATH = resolve(process.cwd(), 'scripts', 'download-onnx-model.ts');
const scriptSource = readFileSync(SCRIPT_PATH, 'utf8');

function extractLiteral(name: string): string | undefined {
  const match = scriptSource.match(new RegExp(`const\\s+${name}\\s*=\\s*['"]([^'"]+)['"]`));
  return match?.[1];
}

describe('download-onnx-model pin consistency', () => {
  test('script REVISION matches the shared constant', () => {
    expect(extractLiteral('REVISION')).toBe(EXPERT_ROUTING_MODEL_REVISION);
  });

  test('script REPO matches the shared constant', () => {
    expect(extractLiteral('REPO')).toBe(EXPERT_ROUTING_MODEL_REPO);
  });
});
