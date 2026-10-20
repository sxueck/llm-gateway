/**
 * Single source of truth for the routing-strategy contract accepted on
 * virtual keys (and per-request overrides).
 *
 * Keep this module dependency-free: the admin virtual-key routes import it for
 * request validation and must not pull in the proxy routing stack.
 */
export type PerRequestRoutingStrategy = 'default' | 'price' | 'throughput' | 'latency';

const PER_REQUEST_ROUTING_STRATEGIES: ReadonlySet<string> = new Set([
  'default', 'price', 'throughput', 'latency'
]);

export function normalizeRoutingStrategy(raw: unknown): PerRequestRoutingStrategy | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (value === 'single') return 'default';
  if (!PER_REQUEST_ROUTING_STRATEGIES.has(value)) return null;
  return value as PerRequestRoutingStrategy;
}

/**
 * Whether a raw value is accepted by the runtime routing resolver
 * ('single' is the legacy alias for 'default').
 */
export function isValidRoutingStrategyInput(raw: unknown): boolean {
  return normalizeRoutingStrategy(raw) !== null;
}
