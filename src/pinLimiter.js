// Two-layer rate limiting for operator PINs (CLAUDE.md #10, technical-design
// §7.4). Layer 1 is per pre-auth session id, generous, for honest mistyping.
// Layer 2 is global per event+role — the layer that actually constrains an
// attacker, since layer 1 alone is bypassed by discarding the cookie.
const sessionAttempts = new Map();
const roleAttempts = new Map();

const ROLE_WINDOW_MS = 10 * 60 * 1000;
const ROLE_LOCK_THRESHOLD = 50;

export function checkSessionLimiter(sid) {
  const entry = sessionAttempts.get(sid);
  if (entry && entry.lockedUntil > Date.now()) {
    return { allowed: false, retryAfterMs: entry.lockedUntil - Date.now() };
  }
  return { allowed: true };
}

export function recordSessionFailure(sid) {
  const entry = sessionAttempts.get(sid) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  let lockMs = 0;
  if (entry.count >= 10) lockMs = 5 * 60 * 1000;
  else if (entry.count >= 5) lockMs = 30 * 1000;
  entry.lockedUntil = lockMs ? Date.now() + lockMs : 0;
  sessionAttempts.set(sid, entry);
}

export function recordSessionSuccess(sid) {
  sessionAttempts.delete(sid);
}

export function checkRoleLockout(eventId, role) {
  const key = `${eventId}:${role}`;
  const entry = roleAttempts.get(key);
  if (!entry || Date.now() - entry.windowStart > ROLE_WINDOW_MS) return { allowed: true };
  return { allowed: entry.count < ROLE_LOCK_THRESHOLD, count: entry.count };
}

export function recordRoleFailure(eventId, role) {
  const key = `${eventId}:${role}`;
  const now = Date.now();
  let entry = roleAttempts.get(key);
  if (!entry || now - entry.windowStart > ROLE_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
  }
  entry.count += 1;
  roleAttempts.set(key, entry);
  return entry.count;
}

export function recordRoleSuccess(eventId, role) {
  roleAttempts.delete(`${eventId}:${role}`);
}
