/**
 * `@comvivo/shared/net` — guarded egress (`08` §3.9, `10` §3.4.6).
 *
 * Invariant **I5** lives here: everything that leaves this process for a reason the product chose
 * goes through `safeFetch`, and the SSRF classifier it calls is the only place that decides whether
 * an address may be reached.
 *
 * | Module | What |
 * |---|---|
 * | `blocklist` | The IANA deny ranges, named, with a `net.BlockList` oracle for the tests |
 * | `classify` | The URL and address rules — pure, so `fuzz.ssrf.classify` can reach them |
 * | `pinning-agent` | The `lookup` that answers with one pre-validated address |
 * | `safe-fetch` | Resolve, check every address, pin, redirect by hand, enforce the limits |
 *
 * `.dependency-cruiser.cjs` is what keeps `fetch` and `node:http` out of everywhere else; this
 * directory is the exception it names.
 */
export {
  addressBytes,
  blockedRange,
  DENIED_IPV4,
  DENIED_IPV6,
  DENIED_RANGES,
  type DeniedRange,
  EMBEDS_IPV4,
  nodeBlockListDenies,
} from './blocklist.js';
export {
  type ClassifiedUrl,
  classifyAddress,
  classifyUrl,
  type EgressPolicy,
  type EgressReason,
  type EgressRefusal,
  EMPTY_POLICY,
  type EmbeddedIpv4,
  embeddedIpv4,
} from './classify.js';
export { type LookupAddress, pinnedLookup } from './pinning-agent.js';
export {
  EgressBlockedError,
  type EgressBlockedEvent,
  type EgressLimits,
  type EgressPurpose,
  nextHop,
  PURPOSE_LIMITS,
  type ResolvedAddress,
  type Resolver,
  type SafeFetchOptions,
  safeFetch,
  systemResolver,
  userAgent,
} from './safe-fetch.js';
