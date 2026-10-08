// Stateless signed session cookie. Carries identity only — never captaincy,
// score, or question state, all of which another actor can change and must
// always be read fresh from the database (technical-design §7.6b).
//
// The 12h lifetime is enforced here, from the issued-at time signed into
// the cookie — a browser's maxAge is only a request, and a copied cookie
// would otherwise work forever (scope §2 "Sessions").
const COOKIE_NAME = 'session';
const MAX_AGE_SECONDS = 12 * 60 * 60;

const insecureCookies = process.env.INSECURE_COOKIES === 'true';

export function readSession(req) {
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
  if (!Number.isFinite(session?.iat) || Date.now() - session.iat > MAX_AGE_SECONDS * 1000) return null;
  return session;
}

// Keeps the original issued-at when rewriting an existing session (gate,
// join); a fresh object — a token exchange — starts a new 12 hours.
export function writeSession(reply, session) {
  const value = { ...session, iat: session.iat ?? Date.now() };
  reply.setCookie(COOKIE_NAME, JSON.stringify(value), {
    path: '/',
    httpOnly: true,
    secure: !insecureCookies,
    sameSite: 'lax',
    signed: true,
    maxAge: MAX_AGE_SECONDS
  });
}
