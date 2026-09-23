/**
 * Unified client-abort semantics for api_requests audit rows.
 *
 * A client disconnect is NOT an upstream failure: it must write exactly one
 * status='error' row carrying the literal message below (never free text),
 * record no circuit-breaker verdict, and never dispatch a smart-routing
 * retry — the client is gone. Upstream-side aborts (premature close, gateway
 * timeouts) keep the normal error-row handling instead.
 */

/** Literal errorMessage persisted on client-abort rows. */
export const CLIENT_ABORTED_MESSAGE = "Client aborted";

/**
 * True when the error/signal state indicates the CLIENT went away.
 *
 * `signal.aborted` is authoritative for handlers whose abort controller is
 * aborted exclusively from the client-close listener (request.raw / reply.raw
 * 'close'). Transports that also abort the same signal for upstream timeouts
 * must instead pass `clientSocketGone` (destroyed raw socket) so a timeout is
 * not misclassified as a client abort.
 */
export function isClientAbort(
  error: any,
  signal?: AbortSignal,
  clientSocketGone?: boolean,
): boolean {
  if (signal?.aborted) {
    return true;
  }
  return error?.name === "AbortError" && clientSocketGone === true;
}
