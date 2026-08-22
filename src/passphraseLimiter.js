// Layer 1 rate limiting for the room passphrase, keyed by session id — never
// by IP, since 240 phones share one NAT address (CLAUDE.md #10). This is a
// doormat, not a lock: short delay after 5 failures, longer after 10
// (technical-design §7.4). In-memory is fine — the passphrase keeps only
// layer 1, and resetting on a restart costs nothing over a three-hour night.
const attempts = new Map();

export function checkLimiter(sid) {
  const entry = attempts.get(sid);
  if (entry && entry.lockedUntil > Date.now()) {
    return { allowed: false, retryAfterMs: entry.lockedUntil - Date.now() };
  }
  return { allowed: true };
}

export function recordFailure(sid) {
  const entry = attempts.get(sid) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  let lockMs = 0;
  if (entry.count >= 10) lockMs = 5 * 60 * 1000;
  else if (entry.count >= 5) lockMs = 30 * 1000;
  entry.lockedUntil = lockMs ? Date.now() + lockMs : 0;
  attempts.set(sid, entry);
}

export function recordSuccess(sid) {
  attempts.delete(sid);
}
