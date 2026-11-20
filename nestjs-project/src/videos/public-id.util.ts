import { randomBytes } from 'crypto';

const ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const PUBLIC_ID_LENGTH = 11;
const MAX_UNBIASED = 62 * 4;

export function createPublicId(length = PUBLIC_ID_LENGTH): string {
  let id = '';
  while (id.length < length) {
    const bytes = randomBytes(length);
    for (const byte of bytes) {
      if (byte < MAX_UNBIASED) {
        id += ALPHABET[byte % 62];
        if (id.length === length) break;
      }
    }
  }
  return id;
}

export function isPublicId(value: string): boolean {
  return /^[0-9A-Za-z]{11}$/.test(value);
}
