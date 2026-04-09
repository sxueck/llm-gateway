import { describe, expect, it } from 'bun:test'

import { truncateRequestBody, truncateResponseBody } from './request-logger.js'

describe('request logger truncation', () => {
  it('keeps truncated request bodies parseable as JSON', () => {
    const body = {
      model: 'kimi-for-coding',
      messages: [
        {
          role: 'system',
          content: 'x'.repeat(8000)
        },
        {
          role: 'user',
          content: 'y'.repeat(4000)
        }
      ],
      tools: new Array(20).fill({ type: 'function', function: { name: 'demo' } })
    }

    const truncated = truncateRequestBody(body)
    const parsed = JSON.parse(truncated)

    expect(typeof truncated).toBe('string')
    expect(() => JSON.parse(truncated)).not.toThrow()
    expect(parsed.model).toBe('kimi-for-coding')
    expect(parsed.messages?.length).toBe(2)
  })

  it('keeps truncated response bodies parseable as JSON', () => {
    const body = {
      id: 'resp_123',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'z'.repeat(9000),
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'memory_open_nodes',
                  arguments: JSON.stringify({ names: ['UserProfile', 'Project:E:\\git\\llm-gateway'] })
                }
              }
            ]
          },
          finish_reason: 'tool_calls'
        }
      ],
      usage: {
        input_tokens: 1000,
        output_tokens: 200
      }
    }

    const truncated = truncateResponseBody(body)
    const parsed = JSON.parse(truncated)

    expect(() => JSON.parse(truncated)).not.toThrow()
    expect(parsed.choices?.[0]?.message?.tool_calls).toBe('[工具调用已截断]')
    expect(parsed.usage?.input_tokens).toBe(1000)
  })
})
