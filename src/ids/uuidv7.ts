import { uuidv7 } from 'uuidv7';
import { createHash } from 'crypto';

export function nextUuidv7(): string {
  return uuidv7();
}

/**
 * Generate a deterministic UUIDv7 anchored at Unix epoch 0.
 *
 * Layout (16 bytes, big-endian):
 *   bytes  0–5  : timestamp (all zero — epoch 0)
 *   byte   6    : 0x70 | (sha256_byte0 >> 4)     — version nibble = 7
 *   byte   7    : sha256_byte1                    — low byte of rand_a
 *   byte   8    : 0x80 | (sha256_byte2 & 0x3f)   — variant bits = 10xx xxxx
 *   bytes  9–15 : sha256_bytes3–9                 — remaining random bits
 *
 * @param seedIndex - monotonic counter used to differentiate multiple epoch-anchored IDs
 */
export function epochAnchoredUuidv7(seedIndex: number): string {
  const hash = createHash('sha256').update(seedIndex.toString()).digest();

  const b = new Uint8Array(16);

  b[0] = 0;
  b[1] = 0;
  b[2] = 0;
  b[3] = 0;
  b[4] = 0;
  b[5] = 0;

  // byte 6: version nibble 7 + upper 4 bits of rand_a
  b[6] = 0x70 | ((hash[0]! >> 4) & 0x0f);

  // byte 7: lower 8 bits of rand_a
  b[7] = hash[1]!;

  // byte 8: variant bits 10xxxxxx
  b[8] = 0x80 | (hash[2]! & 0x3f);

  b[9]  = hash[3]!;
  b[10] = hash[4]!;
  b[11] = hash[5]!;
  b[12] = hash[6]!;
  b[13] = hash[7]!;
  b[14] = hash[8]!;
  b[15] = hash[9]!;

  const hex = Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
  return (
    hex.slice(0, 8) + '-' +
    hex.slice(8, 12) + '-' +
    hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' +
    hex.slice(20, 32)
  );
}

/**
 * Return true if `s` is a syntactically valid UUIDv7 string
 * (8-4-4-4-12 hex, version nibble = 7, variant bits = 10xx).
 */
export function isUuidv7(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}
