import { describe, it, expect, vi } from 'vitest';
import { logApiRequestAsync } from './api-request-logger.js';
import { apiRequestDb } from '../db/index.js';

vi.mock('../db/index.js', () => ({
  apiRequestDb: {
    create: vi.fn(),
  },
}));

describe('logApiRequestAsync', () => {
  it('should not block on slow DB writes', async () => {
    let resolveCreate: (() => void) | undefined;
    vi.mocked(apiRequestDb.create).mockImplementation(() => new Promise((resolve) => {
      resolveCreate = () => resolve(undefined);
    }));

    const params = {
      virtualKey: { id: 'vk1' } as any,
      providerId: 'p1',
      model: 'gpt-4',
      tokenCount: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      status: 'success' as const,
      responseTime: 100,
    };

    logApiRequestAsync(params);

    // Should not be resolved immediately; the async call should be in-flight
    expect(apiRequestDb.create).toHaveBeenCalledTimes(1);
    expect(resolveCreate).toBeDefined();

    // Resolve the promise to avoid leaving unhandled promises
    resolveCreate!();
    await new Promise((r) => setTimeout(r, 10));
  });

  it('should catch and not throw on DB error', async () => {
    vi.mocked(apiRequestDb.create).mockRejectedValue(new Error('DB down'));

    const params = {
      virtualKey: { id: 'vk1' } as any,
      providerId: 'p1',
      model: 'gpt-4',
      tokenCount: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      status: 'success' as const,
      responseTime: 100,
    };

    // Should not throw
    expect(() => logApiRequestAsync(params)).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
  });
});
