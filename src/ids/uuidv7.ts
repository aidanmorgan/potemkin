/**
 * UUIDv7 utilities — no external imports.
 * Implementation agents will wire in the real uuidv7 library.
 */

/** Generate a real-time UUIDv7. */
export function nextUuidv7(): string {
  throw new Error('NotImplemented: ids/uuidv7.nextUuidv7');
}

/**
 * Generate a deterministic UUIDv7 anchored at Unix epoch 0.
 * @param seedIndex - monotonic counter used to differentiate multiple epoch-anchored IDs
 */
export function epochAnchoredUuidv7(seedIndex: number): string {
  throw new Error('NotImplemented: ids/uuidv7.epochAnchoredUuidv7');
}

/** Return true if `s` is a syntactically valid UUIDv7 string. */
export function isUuidv7(s: string): boolean {
  throw new Error('NotImplemented: ids/uuidv7.isUuidv7');
}
