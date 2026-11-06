/**
 * Zeroing key material (`08` §3.7.13, `02` §3.6.1).
 *
 * **What this does and does not promise**, because overstating it would be worse than not having
 * it: it overwrites the bytes of a buffer you hand it. It does not and cannot guarantee that no
 * copy of those bytes exists elsewhere.
 *
 * In a garbage-collected runtime, a `Buffer` may have been copied by the allocator, and a key that
 * passed through a JavaScript *string* — as the SQLCipher hex key necessarily does, a V8 limitation
 * `02` §3.6.1 records — cannot be zeroed at all, because strings are immutable and interned.
 * `sodium_malloc`'s guard pages and `mlock` would help, and exist only if the `sodium-native`
 * fallback is active (`02` D13).
 *
 * So this is defence in depth against a *core dump* or a swapped page containing a live key, and
 * it is stated that way in `08` §3.7.13 and in the documentation rather than implied to be more.
 */

/**
 * Overwrite a buffer with zeros.
 *
 * Returns nothing: a function that returned the buffer would invite `return zeroize(key)`, which
 * reads as "a zeroed key" and is in fact "the key I just destroyed".
 */
export function zeroize(target: Uint8Array): void {
  target.fill(0);
}

/** Zero several buffers, skipping any that are already gone. */
export function zeroizeAll(...targets: readonly (Uint8Array | undefined)[]): void {
  for (const target of targets) {
    if (target !== undefined) target.fill(0);
  }
}

/** `true` when every byte is zero. For the tests that assert zeroing happened. */
export function isZeroed(target: Uint8Array): boolean {
  return target.every((byte) => byte === 0);
}

/**
 * Run `fn` with a key, then zero it however `fn` ends.
 *
 * The shape that makes zeroing hard to forget. Without it, every call site needs a `try`/`finally`,
 * and the one that forgets is the one that throws — which is exactly when a key is most likely to
 * be sitting in a buffer that outlives the request.
 */
export function withZeroed<T>(key: Uint8Array, fn: (key: Uint8Array) => T): T {
  try {
    return fn(key);
  } finally {
    key.fill(0);
  }
}

/** The asynchronous sibling, for key material held across an `await`. */
export async function withZeroedAsync<T>(
  key: Uint8Array,
  fn: (key: Uint8Array) => Promise<T>,
): Promise<T> {
  try {
    return await fn(key);
  } finally {
    key.fill(0);
  }
}
