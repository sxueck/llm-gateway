/**
 * Routing-strategy resolution for the proxy stack. The accepted value set lives in
 * @llm-gateway/shared so admin request validation and runtime resolution cannot
 * drift apart; this module only maps an accepted input onto the runtime strategy.
 *
 * Keep it free of the proxy routing stack: the admin virtual-key routes depend on it.
 */
import {
  LEGACY_SINGLE_ROUTING_STRATEGY,
  PER_REQUEST_ROUTING_STRATEGIES,
  type PerRequestRoutingStrategy,
} from '@llm-gateway/shared';

export type { PerRequestRoutingStrategy };

const RUNTIME_ROUTING_STRATEGIES: ReadonlySet<string> = new Set<string>(PER_REQUEST_ROUTING_STRATEGIES);

export function normalizeRoutingStrategy(raw: unknown): PerRequestRoutingStrategy | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value === LEGACY_SINGLE_ROUTING_STRATEGY) return 'default';
  if (!RUNTIME_ROUTING_STRATEGIES.has(value)) return null;
  return value as PerRequestRoutingStrategy;
}
