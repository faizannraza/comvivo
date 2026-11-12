/**
 * The pinned `lookup` (`08` §3.9 rule 3).
 *
 * Both callback shapes, because Node uses either depending on the call site: `net.connect` asks
 * with `{all: true}` and some callers ask without it, and a `lookup` that answered only one of
 * them would work until it did not.
 */
import { describe, expect, it } from 'vitest';
import { type LookupAddress, pinnedLookup } from './pinning-agent.js';

/** Call the lookup the way Node does, and collect what it answers. */
function ask(
  lookup: ReturnType<typeof pinnedLookup>,
  options: { readonly all?: boolean } | undefined,
): unknown[] {
  const answers: unknown[] = [];
  (
    lookup as unknown as (
      host: string,
      options: unknown,
      callback: (
        error: Error | null,
        a: string | readonly LookupAddress[],
        family?: number,
      ) => void,
    ) => void
  )('whatever.example', options, (...args) => answers.push(...args));
  return answers;
}

describe('pinnedLookup', () => {
  it('answers with the one address, whatever it is asked', () => {
    const lookup = pinnedLookup('93.184.216.34', 4);
    // `{all: true}` — an array of one.
    expect(ask(lookup, { all: true })).toEqual([null, [{ address: '93.184.216.34', family: 4 }]]);
    // Without it — the address and its family, positionally.
    expect(ask(lookup, undefined)).toEqual([null, '93.184.216.34', 4]);
    expect(ask(lookup, { all: false })).toEqual([null, '93.184.216.34', 4]);
  });

  it('ignores the hostname it is given, which is the point', () => {
    // A version that compared the name and fell back to real DNS on a mismatch would have
    // re-opened the rebinding hole this closes. There is nothing to resolve.
    const lookup = pinnedLookup('2606:4700::1111', 6);
    expect(ask(lookup, { all: true })).toEqual([null, [{ address: '2606:4700::1111', family: 6 }]]);
  });
});
