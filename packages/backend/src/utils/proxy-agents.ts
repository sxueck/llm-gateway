/**
 * Proxy agent utilities for Node.js HTTP/HTTPS requests.
 * 
 * Note: Proxy support for fetch is handled by upstream-fetch.ts using undici.
 * This module now only provides standard keep-alive agents for the OpenAI SDK
 * connection pooling. The actual proxy routing happens at the fetch level
 * via the custom fetch function provided to the OpenAI client.
 */

import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

export interface KeepAliveAgents {
  httpAgent: HttpAgent;
  httpsAgent: HttpsAgent;
}

/**
 * Create standard keep-alive agents for connection pooling.
 * 
 * Note: Proxy is handled at the fetch level in upstream-fetch.ts.
 * These agents are used for connection pooling only.
 */
export function createKeepAliveAgents(
  options: {
    keepAliveMsecs?: number;
    maxSockets?: number;
  } = {}
): KeepAliveAgents {
  const agentOptions = {
    keepAlive: true,
    keepAliveMsecs: options.keepAliveMsecs ?? 1000,
    maxSockets: options.maxSockets ?? 50,
  };

  return {
    httpAgent: new HttpAgent(agentOptions),
    httpsAgent: new HttpsAgent(agentOptions),
  };
}
