const allowedEvents = new Set([
  'registration_completed',
  'login_succeeded',
  'password_reset_completed',
  'calculation_succeeded',
  'calculation_failed',
  'xlsx_generated'
]);

// Store aggregate counters only. Call from the server after the corresponding outcome.
export function recordMetric(store, event, now = new Date()) {
  if (!allowedEvents.has(event)) throw new RangeError('Unknown metric');
  return store.increment(now.toISOString().slice(0, 10), event);
}
