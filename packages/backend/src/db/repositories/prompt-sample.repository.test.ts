import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const connection = {
    query: vi.fn(),
    release: vi.fn(),
  };
  return {
    connection,
    getConnection: vi.fn(async () => connection),
  };
});

vi.mock('../connection.js', () => ({
  getDatabase: () => ({ getConnection: mocks.getConnection }),
}));

import { promptSampleRepository } from './prompt-sample.repository.js';

describe('promptSampleRepository.cleanOldRecords', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));
    mocks.connection.query.mockResolvedValue([{ affectedRows: 3 }]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('deletes samples older than the requested retention window', async () => {
    await expect(promptSampleRepository.cleanOldRecords(30)).resolves.toBe(3);

    expect(mocks.connection.query).toHaveBeenCalledWith(
      'DELETE FROM prompt_samples WHERE created_at < ?',
      [Date.now() - 30 * 24 * 60 * 60 * 1000]
    );
    expect(mocks.connection.release).toHaveBeenCalled();
  });
});
