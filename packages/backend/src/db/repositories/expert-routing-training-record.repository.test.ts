import { beforeEach, describe, expect, test, vi } from 'vitest';

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

import { expertRoutingTrainingRecordRepository } from './expert-routing-training-record.repository.js';

describe('expertRoutingTrainingRecordRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connection.query.mockResolvedValue([[]]);
  });

  test('resets a reviewed record when the judge label or prompt version changes', async () => {
    await expertRoutingTrainingRecordRepository.createOrIncrement({
      id: 'record-1',
      expert_routing_id: 'routing-1',
      input_hash: 'a'.repeat(64),
      input_text: 'review this',
      judge_prompt_version: 'intent-router-v2',
      judge_intent_label: 'code_review',
      judge_confidence: 0.9,
      final_intent_label: 'code_review',
      status: 'pending_review',
    });

    const query = mocks.connection.query.mock.calls[0][0] as string;
    expect(query).toContain("status = IF(");
    expect(query).toContain("'pending_review'");
    expect(query).toContain('judge_prompt_version = VALUES(judge_prompt_version)');
    expect(query).toContain('judge_intent_label = VALUES(judge_intent_label)');
  });

  test('omits LIMIT when exporting every accepted record', async () => {
    await expertRoutingTrainingRecordRepository.getByConfigId('routing-1', 'accepted');

    expect(mocks.connection.query).toHaveBeenCalledWith(
      expect.stringContaining('ORDER BY updated_at DESC'),
      ['routing-1', 'accepted']
    );
    expect(mocks.connection.query.mock.calls[0][0]).not.toContain('LIMIT');
  });
});
