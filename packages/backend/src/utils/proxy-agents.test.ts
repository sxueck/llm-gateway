import { describe, it, expect } from 'bun:test';
import { createKeepAliveAgents } from './proxy-agents.js';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

describe('Keep-Alive Agents', () => {
  it('should create keep-alive agents with default options', () => {
    const agents = createKeepAliveAgents();
    expect(agents.httpAgent).toBeInstanceOf(HttpAgent);
    expect(agents.httpsAgent).toBeInstanceOf(HttpsAgent);
  });

  it('should accept custom agent options', () => {
    const agents = createKeepAliveAgents({
      maxSockets: 100,
      keepAliveMsecs: 5000,
    });
    expect(agents.httpAgent).toBeInstanceOf(HttpAgent);
    expect(agents.httpsAgent).toBeInstanceOf(HttpsAgent);
  });
});
