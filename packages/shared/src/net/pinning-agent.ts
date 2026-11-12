/**
 * DNS pinning (`08` §3.9 rule 3, `10` §3.4.6 step 3).
 *
 * The TOCTOU this closes: the classifier resolves a name, checks every address, and then the
 * request resolves the name *again*. A resolver that answers `93.184.216.34` the first time and
 * `169.254.169.254` the second has defeated every check above it — that is DNS rebinding, and it
 * needs no privileged position, only a domain and a two-second TTL.
 *
 * So the request does not resolve anything. It is handed a `lookup` that returns the one address
 * the classifier approved, and nothing else. The hostname still travels in SNI and in the `Host`
 * header, because the connection is to that host — it is only the *name resolution* that is
 * replaced.
 *
 * `08` §3.9 rule 3 describes this as a custom `lookup` on an undici `Agent`; this is the same
 * mechanism on `node:https`, for the reason `safe-fetch.ts` documents.
 */
import type { LookupFunction } from 'node:net';

/** What a `lookup` callback is handed when `options.all` is set. */
export interface LookupAddress {
  readonly address: string;
  readonly family: number;
}

/**
 * A `lookup` that answers with exactly one address, whatever it is asked.
 *
 * It ignores the hostname it is given. That is the point: there is nothing to resolve, and a
 * version that compared the name and fell back to real DNS on a mismatch would have re-opened the
 * hole it exists to close.
 */
export function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return ((
    _hostname: string,
    options: { readonly all?: boolean } | undefined,
    callback: (
      error: Error | null,
      addressOrAddresses: string | readonly LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    if (options?.all === true) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  }) as unknown as LookupFunction;
}
