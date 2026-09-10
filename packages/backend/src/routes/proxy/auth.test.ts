import { beforeEach, expect, test, vi } from 'vitest';

import { hotConfigCache } from '../../services/hot-config-cache.js';
import { memoryLogger } from '../../services/logger.js';
import { maskKey } from '../../utils/crypto.js';
import { authenticateVirtualKey } from './auth.js';

vi.mock('../../services/hot-config-cache.js', () => ({
  hotConfigCache: {
    getVirtualKeyByKeyValue: vi.fn(),
  },
}));

const SECRET_KEY = 'sk-test-secret-value-123456';

beforeEach(() => {
  vi.clearAllMocks();
  memoryLogger.clear();
});

test('unknown virtual key: log is masked, never the raw value', async () => {
  vi.mocked(hotConfigCache.getVirtualKeyByKeyValue).mockResolvedValue(undefined);

  const result = await authenticateVirtualKey(`Bearer ${SECRET_KEY}`);

  expect('error' in result && result.error.code).toBe(401);

  const logs = memoryLogger.getLogs();
  expect(logs.some((l) => l.message.includes(SECRET_KEY))).toBe(false);

  const warn = logs.find((l) => l.level === 'WARN');
  expect(warn?.message).toBe(`Virtual key not found: ***${SECRET_KEY.slice(-4)}`);
});

test('disabled virtual key: log is masked, never the raw value', async () => {
  vi.mocked(hotConfigCache.getVirtualKeyByKeyValue).mockResolvedValue({
    key_value: SECRET_KEY,
    enabled: false,
  } as any);

  const result = await authenticateVirtualKey(`Bearer ${SECRET_KEY}`);

  expect('error' in result && result.error.code).toBe(403);

  const logs = memoryLogger.getLogs();
  expect(logs.some((l) => l.message.includes(SECRET_KEY))).toBe(false);

  const warn = logs.find((l) => l.level === 'WARN');
  expect(warn?.message).toBe(`Virtual key disabled: ***${SECRET_KEY.slice(-4)}`);
});

test('maskKey reveals only the last 4 chars and fully masks short keys', () => {
  expect(maskKey(SECRET_KEY)).toBe('***3456');
  expect(maskKey('vk_abc12')).toBe('***');
  expect(maskKey('abc')).toBe('***');
});
