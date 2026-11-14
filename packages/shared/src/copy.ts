/**
 * Small helpers for text a host or a member actually reads.
 *
 * `CLAUDE.md` §2 says copy is product, and §8 asks for "clear fix-it messages for every error".
 * `(s)` is neither. The M2 second-pass review counted the pattern in nine strings across the three
 * surfaces a host reads most — `doctor`'s check lines, the boot refusal, and the privacy
 * disclosure — including `all 1 routed model(s) are priced` and `1 problem(s) prevent
 * privacy.localOnly from being honoured`. A line that reads as machine output is a line a host
 * trusts a little less than the one above it, and these are the lines that have to be trusted.
 *
 * English only, on purpose. `06` §3.5 owns localisation for member-facing chat; these are
 * host-facing diagnostics in the language the CLI is written in, and a pluralisation library for
 * nine strings would be a dependency where a function will do.
 */

/**
 * `1 route`, `2 routes` — the count and its noun, agreeing.
 *
 * `plural` rather than two call sites choosing: the mistake the `(s)` spelling exists to avoid is
 * a wrong agreement, and the way to avoid it is to not write the agreement twice.
 */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${String(count)} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}

/** The noun alone, agreeing with a count that is printed elsewhere or not at all. */
export function noun(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`);
}

/**
 * `a`, `b` and `c` — a list a person can read aloud.
 *
 * `join(', ')` gives `a, b, c`, which is a serialisation. The Oxford comma is omitted for two
 * items and kept for three or more, which is the house style in `13` §5's Vale configuration.
 */
export function listOf(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0] ?? ''} and ${items[1] ?? ''}`;
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}
