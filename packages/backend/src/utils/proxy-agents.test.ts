import { describe, it, expect } from 'vitest';
import { createKeepAliveAgents } from './proxy-agents.js';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

describe('Keep-Alive Agents', () => {
  it('should pass rejectUnauthorized=false to agents when skipVerify is enabled', () => {
    const agents = createKeepAliveAgents({
      rejectUnauthorized: false,
    });
    expect(agents.httpAgent).toBeInstanceOf(HttpAgent);
    expect(agents.httpsAgent).toBeInstanceOf(HttpsAgent);
    // @ts-ignore
    expect(agents.httpsAgent.options.rejectUnauthorized).toBe(false);
    // @ts-ignore
    expect(agents.httpAgent.options.rejectUnauthorized).toBe(false);
  });

  it('should not add rejectUnauthorized when undefined', () => {
    const agents = createKeepAliveAgents();
    // @ts-ignore
    expect(agents.httpsAgent.options.rejectUnauthorized).toBeUndefined();
    // @ts-ignore
    expect(agents.httpAgent.options.rejectUnauthorized).toBeUndefined();
  });
});
