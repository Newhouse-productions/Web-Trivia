// Operator session cookie — separate from the player `session` cookie so a
// laptop testing both roles never collides. Carries identity only:
// event_id and role, never anything another actor can change (technical-design §7.6b).
const COOKIE_NAME = 'ops';
const insecureCookies = process.env.INSECURE_COOKIES === 'true';

export function readOpsSession(req) {
  const raw = req.cookies?.[COOKIE_NAME];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid) return null;
  try {
    return JSON.parse(unsigned.value);
  } catch {
    return null;
  }
}

export function writeOpsSession(reply, session) {
  // Admin is 2h idle rather than everyone else's 12h absolute (§7.6b) — a
  // laptop left open in a venue is the hole this closes. Idle is approximated
  // by reissuing the cookie on every authenticated admin request.
  const maxAge = session.role === 'admin' ? 2 * 60 * 60 : 12 * 60 * 60;
  reply.setCookie(COOKIE_NAME, JSON.stringify(session), {
    path: '/',
    httpOnly: true,
    secure: !insecureCookies,
    sameSite: 'lax',
    signed: true,
    maxAge
  });
}
