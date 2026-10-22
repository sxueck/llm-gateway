import { describe, expect, it } from 'vitest'

import { truncateRequestBody, truncateResponseBody } from './request-logger.js'

describe('request logger truncation', () => {
  it('truncates fields without depending on an object-provided hasOwnProperty', () => {
    const content = Object.assign(Object.create(null), {
      hasOwnProperty: 'upstream field',
      text: 'x'.repeat(1000)
    })

    const parsed = JSON.parse(truncateRequestBody({ content }))

    expect(parsed.content.hasOwnProperty).toBe('upstream field')
    expect(parsed.content.text).toContain('...[truncated]')
    expect(parsed.raw_preview).toBeUndefined()
  })

  it('does not expose inherited instructions when logging a response', () => {
    const body = Object.assign(Object.create({ instructions: 'private directive' }), {
      id: 'response'
    })

    const logged = truncateResponseBody(body)

    expect(logged).not.toContain('private directive')
    expect(JSON.parse(logged).instructions).toBe('[removed:instructions]')
    expect(JSON.parse(logged).id).toBe('response')
  })

  it('fails closed when instructions cannot be removed from a frozen response', () => {
    const body = { output: Object.freeze({ instructions: 'private directive', text: 'answer' }) }

    const logged = truncateResponseBody(body)

    expect(logged).not.toContain('private directive')
    expect(JSON.parse(logged)).toEqual({ truncated: true })
    expect(body.output.instructions).toBe('private directive')
  })

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
