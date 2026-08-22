// Stateless signed session cookie. Carries identity only — never captaincy,
// score, or question state, all of which another actor can change and must
// always be read fresh from the database (technical-design §7.6b).
const COOKIE_NAME = 'session';
const MAX_AGE_SECONDS = 12 * 60 * 60;

const insecureCookies = process.env.INSECURE_COOKIES === 'true';

export function readSession(req) {
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

export function writeSession(reply, session) {
  reply.setCookie(COOKIE_NAME, JSON.stringify(session), {
    path: '/',
    httpOnly: true,
    secure: !insecureCookies,
    sameSite: 'lax',
    signed: true,
    maxAge: MAX_AGE_SECONDS
  });
}
