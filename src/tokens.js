// Crockford's base32 alphabet — no 0/O or 1/l/I confusion (technical-design §7.2).
import { randomInt } from 'node:crypto';

export const TOKEN_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function randomToken(length) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)];
  }
  return out;
}

// 6-digit role PINs (technical-design §7.6): four is 10,000 guesses, an hour
// at five/second — six is a million, the doormat the design calls for.
export function randomPin(length = 6) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += String(randomInt(10));
  }
  return out;
}
