// Operator session cookie — separate from the player `session` cookie so a
// laptop testing both roles never collides. Carries identity only:
// event_id and role, never anything another actor can change (technical-design §7.6b).
//
// Lifetimes are enforced server-side from timestamps signed into the
// cookie, not left to the browser's maxAge: 12h absolute from sign-in for
// every role (iat), plus 2h idle for admin (seen, refreshed on each admin
// request — see app.js).
const COOKIE_NAME = 'ops';
const insecureCookies = process.env.INSECURE_COOKIES === 'true';
const ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const ADMIN_IDLE_MS = 2 * 60 * 60 * 1000;

export function readOpsSession(req) {
  const raw = req.cookies?.[COOKIE_NAME];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid) return null;
  let session;
  try {
    session = JSON.parse(unsigned.value);
  } catch {
    return null;
  }
  const now = Date.now();
  if (!Number.isFinite(session?.iat) || now - session.iat > ABSOLUTE_MS) return null;
  if (session.role === 'admin' && !(now - session.seen <= ADMIN_IDLE_MS)) return null;
  return session;
}

export function writeOpsSession(reply, session) {
  // Admin is 2h idle rather than everyone else's 12h absolute (§7.6b) — a
  // laptop left open in a venue is the hole this closes. Idle is approximated
  // by reissuing the cookie on every authenticated admin request.
  const maxAge = session.role === 'admin' ? 2 * 60 * 60 : 12 * 60 * 60;
  // A rewrite of an existing session keeps its iat; a new sign-in (a fresh
  // object) starts a new 12 hours.
  const value = { ...session, iat: session.iat ?? Date.now(), seen: Date.now() };
  reply.setCookie(COOKIE_NAME, JSON.stringify(value), {
    path: '/',
    httpOnly: true,
    secure: !insecureCookies,
    sameSite: 'lax',
    signed: true,
    maxAge
  });
}
