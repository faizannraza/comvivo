/**
 * `safeFetch` — the only way out of this process (`08` §3.9, `10` §3.4.6).
 *
 * Invariant **I5 (guarded egress)** is this function. Everything that reaches the network for a
 * *reason the product chose* — an ICS import, a remote MCP server, a plugin's `ctx.http`, the web
 * search tool, OAuth discovery, the update check — goes through here, and the model-provider and
 * chat-platform SDKs are exempt because their endpoints are fixed host configuration validated at
 * boot (`08` §3.9, scope).
 *
 * The order is the design, and each step exists because the one before it is not enough:
 *
 * 1. **Classify the URL** (`classify.ts`) — scheme, credentials, port, local and dotless names.
 * 2. **Resolve and check every address.** Not the first: a name with an A record in public space
 *    and a second one in `192.168/16` is a single `dns.lookup` away from being both.
 * 3. **Pin.** The request connects to the address that was checked, through `pinnedLookup`, so the
 *    name is never resolved twice (`pinning-agent.ts` explains the TOCTOU).
 * 4. **Redirects by hand**, three at most, each hop re-running 1–3. A downgrade to `http:` is
 *    refused, and `Authorization` is dropped when the origin changes.
 * 5. **Limits** — connect, headers, body idle, decoded size, and a compression ratio.
 *
 * ## Why `node:https` and not undici
 *
 * `08` §3.9 rule 3 and `10` §3.4.6 step 3 describe an undici `Agent` with a custom
 * `connect.lookup`. This uses `node:https`/`node:http` with the same custom `lookup`, for three
 * reasons, in the order they decided it:
 *
 *  - **The decoded-byte cap needs the raw stream.** `08` §3.9 rule 5 counts bytes "on the decoded
 *    stream" and `10` §3.4.6 wants a decompression ratio ≤ 20. `fetch` decompresses internally and
 *    reports neither number, so the guard would have to be written around a figure it cannot see.
 *    Decompressing here gives both counters and the ability to abort between them.
 *  - **Manual redirects are required anyway** (step 4), which is most of what a fetch client does
 *    for you.
 *  - **No new dependency.** Undici is the code Node already ships; adding the package would add a
 *    supply-chain entry and a second copy for no capability this function needs.
 *
 * The `Response` it returns is a real `Response`, so a caller — the MCP transport's `fetch`
 * option, `ctx.http.fetch` — sees the shape it expects.
 *
 * Specification: `docs/plan/08-security-privacy.md` §3.9; `docs/plan/10-extensibility.md` §3.4.6.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIPv4 } from 'node:net';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { BRAND } from '../brand.js';
import { err, ok, type Result } from '../result.js';
import {
  type ClassifiedUrl,
  classifyAddress,
  classifyUrl,
  type EgressPolicy,
  type EgressReason,
  type EgressRefusal,
} from './classify.js';
import { pinnedLookup } from './pinning-agent.js';

/** The purposes `08` §3.9 scopes this function to. */
export type EgressPurpose =
  | 'ics'
  | 'mcp'
  | 'plugin'
  | 'web-search'
  | 'oauth-discovery'
  | 'update-check';

export interface EgressLimits {
  /** `08` §3.9 rule 5: connect 5 s. */
  readonly connectTimeoutMs: number;
  /** Until the response headers arrive. */
  readonly headersTimeoutMs: number;
  /** No further body bytes for this long and the socket is destroyed. */
  readonly bodyIdleTimeoutMs: number;
  /**
   * The whole response body, or `null` for a purpose whose body is a long-lived stream.
   *
   * `08` §3.9 rule 5 says "total 10 s (per purpose)". A flat total cannot apply to `mcp`, whose
   * transport is server-sent events — a 10-second total would sever every MCP session at ten
   * seconds. So the total is per purpose, as the spec says, and the streaming purposes get an
   * **idle** timeout instead, which is the property that actually distinguishes a working stream
   * from a hung one.
   */
  readonly bodyTotalTimeoutMs: number | null;
  /** `08` §3.9 rule 5: counted on the **decoded** stream. */
  readonly maxBytes: number;
  /** `10` §3.4.6: decoded ÷ encoded, above a floor where the ratio means anything. */
  readonly maxCompressionRatio: number;
  /** `08` §3.9 rule 5: a content-type allowlist per purpose. Empty means "any". */
  readonly contentTypes: readonly string[];
  /** `08` §3.9 rule 4. */
  readonly maxRedirects: number;
}

const TEN_MIB = 10 * 1024 * 1024;

const COMMON: EgressLimits = {
  connectTimeoutMs: 5_000,
  headersTimeoutMs: 10_000,
  bodyIdleTimeoutMs: 10_000,
  bodyTotalTimeoutMs: 10_000,
  maxBytes: TEN_MIB,
  maxCompressionRatio: 20,
  contentTypes: [],
  maxRedirects: 3,
};

/**
 * Per-purpose limits (`08` §3.9 rule 5).
 *
 * The content-type allowlists are the ones worth reading: an ICS importer that accepts
 * `text/html` is a web crawler, and a web-search tool that accepts `text/calendar` is confused.
 * `plugin` keeps the `10` §3.4.6 default of 2 MiB and allows any type, because a plugin's manifest
 * declares its own.
 */
export const PURPOSE_LIMITS: Readonly<Record<EgressPurpose, EgressLimits>> = Object.freeze({
  ics: { ...COMMON, contentTypes: ['text/calendar', 'text/plain', 'application/octet-stream'] },
  mcp: {
    ...COMMON,
    // The streaming one. See `bodyTotalTimeoutMs`.
    bodyTotalTimeoutMs: null,
    contentTypes: ['application/json', 'text/event-stream'],
  },
  plugin: { ...COMMON, maxBytes: 2 * 1024 * 1024 },
  'web-search': { ...COMMON, contentTypes: ['application/json'] },
  'oauth-discovery': { ...COMMON, contentTypes: ['application/json'] },
  'update-check': { ...COMMON, contentTypes: ['application/json'] },
});

/** What `08` §3.9 rule 7 records: no full URL, no path, no query. */
export interface EgressBlockedEvent {
  readonly purpose: EgressPurpose;
  readonly reason: EgressReason;
  readonly host: string;
}

/**
 * A refusal, as an error.
 *
 * Carries the host and the reason and **not** the URL: `08` §3.9 rule 7 keeps full URLs out of
 * logs, and an error message is the most likely thing to be logged in the product.
 */
export class EgressBlockedError extends Error {
  readonly purpose: EgressPurpose;
  readonly reason: EgressReason;
  readonly host: string;

  constructor(purpose: EgressPurpose, refusal: EgressRefusal) {
    super(refusal.detail);
    this.name = 'EgressBlockedError';
    this.purpose = purpose;
    this.reason = refusal.reason;
    this.host = refusal.host;
  }
}

/** One resolved address, in the order the resolver returned it. */
export interface ResolvedAddress {
  readonly address: string;
  readonly family: number;
}

/** The resolver, injected so the rebinding test can hand back a different answer each call. */
export type Resolver = (host: string) => Promise<readonly ResolvedAddress[]>;

/**
 * `dns.lookup(host, {all: true, order: 'verbatim'})`, as `08` §3.9 rule 2 specifies.
 *
 * **`order: 'verbatim'`, not `verbatim: true`**: the boolean is deprecated on Node 26 and the
 * type-aware lint rejects it. The meaning is the same — the resolver's own order is preserved,
 * because reordering is RFC 6724 address selection, which is the operating system's business and
 * would make "the address we checked" and "the address we connect to" differ for no reason.
 */
export const systemResolver: Resolver = async (host) =>
  dnsLookup(host, { all: true, order: 'verbatim' });

export interface SafeFetchOptions {
  readonly purpose: EgressPurpose;
  readonly policy: EgressPolicy;
  /** Overrides on top of the purpose's defaults. */
  readonly limits?: Partial<EgressLimits>;
  readonly resolver?: Resolver;
  /** `08` §3.9 rule 7: every block emits an event. */
  readonly onBlocked?: (event: EgressBlockedEvent) => void;
  readonly signal?: AbortSignal;
}

/** The User-Agent `10` §3.4.6 specifies, derived from `BRAND` so a rename carries. */
export function userAgent(purpose: EgressPurpose, version = '0.1.0'): string {
  return `${BRAND.displayName}/${version} (${purpose})`;
}

/**
 * Fetch `url`, or refuse.
 *
 * @throws {EgressBlockedError} for every refusal, after calling `onBlocked`.
 */
export async function safeFetch(
  url: string | URL,
  init: RequestInit = {},
  options: SafeFetchOptions,
): Promise<Response> {
  const limits: EgressLimits = { ...PURPOSE_LIMITS[options.purpose], ...options.limits };
  const resolver = options.resolver ?? systemResolver;
  let current: string | URL = url;
  let origin: string | undefined;
  let headers = new Headers(init.headers);

  const method = (init.method ?? 'GET').toUpperCase();

  for (let hop = 0; ; hop += 1) {
    const target = validate(current, options);
    if (hop > limits.maxRedirects) {
      throw blocked(options, {
        reason: 'redirect-limit',
        host: target.host,
        detail: `more than ${String(limits.maxRedirects)} redirects (08 §3.9 rule 4).`,
      });
    }
    if (origin !== undefined && target.url.origin !== origin) {
      // `10` §3.4.6 step 4: a cross-origin redirect must not carry the credential that was meant
      // for the first host. Dropping it is the difference between a redirect and a credential
      // leak, and the header is the one an attacker would aim a redirect at.
      headers = withoutCredentials(headers);
    }
    const address = await pick(target, resolver, options);

    const incoming = await send(target, address, headers, init, method, limits, options);
    const location = incoming.headers['location'];
    if (!isRedirect(incoming.statusCode) || location === undefined || location === '') {
      return toResponse(incoming, method, limits, options, target);
    }
    // The body of a redirect is never read, and a socket left unread is a socket left open.
    incoming.resume();

    const next = nextHop(target.url, location);
    if (!next.ok) throw blocked(options, next.error);
    origin = target.url.origin;
    current = next.value;
  }
}

function isRedirect(status: number | undefined): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * The next hop of a redirect, or the reason it is refused (`08` §3.9 rule 4).
 *
 * A function rather than four lines inside the loop, because this is where the downgrade rule
 * lives and the rule needs a test that does not require a TLS server: proving "https must not
 * become http" over a real socket would mean a self-signed certificate **and** a way to tell
 * `safeFetch` to accept one, and a `rejectUnauthorized` escape hatch in production code is a worse
 * thing to own than a rule proven one level down. `safe-fetch.int.test.ts` covers the hops that do
 * not need TLS end to end, and this function covers the one that does.
 */
export function nextHop(from: URL, location: string): Result<URL, EgressRefusal> {
  let next: URL;
  try {
    next = new URL(location, from);
  } catch {
    return err({
      reason: 'url-unparseable',
      host: from.hostname,
      detail: `${from.hostname} redirected to something that is not a URL.`,
    });
  }
  if (from.protocol === 'https:' && next.protocol === 'http:') {
    // The attack this refuses: a host that answers over TLS and then points at plain http, so the
    // request — and anything the caller attached to it — crosses the network in the clear.
    return err({
      reason: 'redirect-downgrade',
      host: next.hostname,
      detail: `${from.hostname} redirected from https to http, which is refused (08 §3.9 rule 4).`,
    });
  }
  return ok(next);
}

/** Headers minus everything that authenticates us to the *previous* origin. */
function withoutCredentials(headers: Headers): Headers {
  const copy = new Headers(headers);
  for (const name of ['authorization', 'proxy-authorization', 'cookie', 'x-api-key']) {
    copy.delete(name);
  }
  return copy;
}

function validate(url: string | URL, options: SafeFetchOptions): ClassifiedUrl {
  const classified = classifyUrl(url, options.policy);
  if (!classified.ok) throw blocked(options, classified.error);
  return classified.value;
}

/** Resolve, check **every** address, and return the one to connect to. */
async function pick(
  target: ClassifiedUrl,
  resolver: Resolver,
  options: SafeFetchOptions,
): Promise<ResolvedAddress> {
  if (target.literalAddress !== undefined) {
    const refusal = classifyAddress(target.literalAddress, target);
    if (refusal !== undefined) throw blocked(options, refusal);
    return {
      address: target.literalAddress,
      family: isIPv4(target.literalAddress) ? 4 : 6,
    };
  }

  let resolved: readonly ResolvedAddress[];
  try {
    resolved = await resolver(target.host);
  } catch (error) {
    throw blocked(options, {
      reason: 'no-address',
      host: target.host,
      detail: `${target.host} did not resolve (${(error as Error).message}).`,
    });
  }
  // Every one, not the first: a name with one public A record and one private is otherwise a
  // coin toss decided by the resolver's ordering.
  for (const candidate of resolved) {
    const refusal = classifyAddress(candidate.address, target);
    if (refusal !== undefined) throw blocked(options, refusal);
  }
  // One guard for "no addresses", not two: a separate `length === 0` check would make this one
  // unreachable, and an unreachable guard reads as a handled case forever.
  const [first] = resolved;
  if (first === undefined) {
    throw blocked(options, {
      reason: 'no-address',
      host: target.host,
      detail: `${target.host} resolved to no addresses.`,
    });
  }
  return first;
}

/** Send one hop and wait for its headers. */
async function send(
  target: ClassifiedUrl,
  address: ResolvedAddress,
  headers: Headers,
  init: RequestInit,
  method: string,
  limits: EgressLimits,
  options: SafeFetchOptions,
): Promise<IncomingMessage> {
  const requestFn = target.url.protocol === 'https:' ? httpsRequest : httpRequest;
  const outgoing: Record<string, string> = {};
  for (const [name, value] of headers) {
    // `10` §3.4.6: no cookies, ever. Not "none by default" — none at all, including one a caller
    // tried to set, because a cookie shared across purposes is a way for one fetch to authenticate
    // another. Filtered on the way in rather than deleted after, so there is no moment where the
    // header exists.
    if (name.toLowerCase() === 'cookie') continue;
    outgoing[name] = value;
  }
  outgoing['user-agent'] ??= userAgent(options.purpose);
  outgoing['accept-encoding'] ??= 'gzip, br, deflate';

  return await new Promise<IncomingMessage>((resolve, reject) => {
    // CodeQL reports `js/request-forgery` here, and it is reporting the function's own purpose:
    // `safeFetch` exists to fetch a URL a caller supplied. What makes it safe is everything above
    // this line — `classifyUrl` refusing a private, link-local, loopback, metadata, NAT64, 6to4 or
    // mapped address and every literal spelling of one (`08` §3.9), `refuseByName` for local and
    // dotless names, a per-purpose allowlist where one applies, and `pinnedLookup` below, which
    // pins the resolution so the address checked is the address connected to. A taint tracker
    // cannot see that chain; the suppression says so rather than leaving a permanent critical
    // alert that trains everyone to ignore the list.
    //
    // codeql[js/request-forgery]
    const request = requestFn(target.url, {
      method,
      headers: outgoing,
      lookup: pinnedLookup(address.address, address.family === 4 ? 4 : 6),
      // The hostname, not the address: SNI and `Host` are about who we are talking to, and only
      // the resolution step is pinned.
      servername: target.host,
      // A fresh agent per request, so no socket is ever reused across a pinning decision.
      agent: false,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    // Both timeouts go through `report`, so they emit `egress.blocked` like every other refusal
    // (`08` §3.9 rule 7). The first version built the error directly here and skipped the event —
    // caught by the test that asserts the event rather than the message, which is the only
    // difference between the two assertions and the reason the test asserts both.
    const timers = [
      setTimeout(() => {
        request.destroy(
          report(options, {
            reason: 'timeout',
            host: target.host,
            detail: `${target.host} did not send headers within ${String(limits.headersTimeoutMs)} ms.`,
          }),
        );
      }, limits.headersTimeoutMs),
    ];
    request.setTimeout(limits.connectTimeoutMs, () => {
      // `setTimeout` on a request is an **idle** timeout on its socket, which before the response
      // starts is the connect-and-first-byte window `08` §3.9 rule 5 bounds at 5 s.
      request.destroy(
        report(options, {
          reason: 'timeout',
          host: target.host,
          detail: `${target.host} did not answer within ${String(limits.connectTimeoutMs)} ms.`,
        }),
      );
    });
    request.on('response', (response) => {
      for (const timer of timers) clearTimeout(timer);
      resolve(response);
    });
    request.on('error', (error) => {
      for (const timer of timers) clearTimeout(timer);
      reject(
        error instanceof EgressBlockedError
          ? error
          : report(options, {
              reason: 'transport',
              host: target.host,
              detail: `the connection to ${target.host} failed: ${error.message}`,
            }),
      );
    });
    if (init.body === undefined || init.body === null) {
      request.end();
      return;
    }
    void bodyBytes(init.body as NonNullable<RequestInit['body']>).then(
      (bytes) => {
        request.end(bytes);
      },
      (error: unknown) => {
        request.destroy(error as Error);
      },
    );
  });
}

/** A request body as bytes. Only the shapes this product sends. */
async function bodyBytes(body: NonNullable<RequestInit['body']>): Promise<Buffer> {
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.from(await new Response(body).arrayBuffer());
}

/**
 * The Node response as a web `Response`, with the limits enforced while it streams.
 *
 * Streaming rather than buffering, because the `mcp` purpose is server-sent events and a buffered
 * body would never arrive. The caps are therefore enforced *in* the stream: the first chunk that
 * crosses one destroys the socket and errors the body, which is what `10` §3.4.6's "streamed and
 * aborted at the cap" asks for.
 */
function toResponse(
  incoming: IncomingMessage,
  method: string,
  limits: EgressLimits,
  options: SafeFetchOptions,
  target: ClassifiedUrl,
): Response {
  const status = incoming.statusCode ?? 0;
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }

  if (!isRedirect(status) && limits.contentTypes.length > 0) {
    const type = (incoming.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (!limits.contentTypes.includes(type)) {
      incoming.destroy();
      throw blocked(options, {
        reason: 'content-type',
        host: target.host,
        detail: `${target.host} answered with ${type === '' ? 'no content type' : type}, which ${options.purpose} does not accept.`,
      });
    }
  }

  // 204 and 304 have no body at all; a `Response` with one would be a TypeError.
  const bodyless = status === 204 || status === 304 || method === 'HEAD';
  const body = bodyless ? null : capped(incoming, limits, options, target);
  return new Response(body, { status, statusText: incoming.statusMessage ?? '', headers });
}

/** Decompress, count, and abort at the first chunk that crosses a cap. */
function capped(
  incoming: IncomingMessage,
  limits: EgressLimits,
  options: SafeFetchOptions,
  target: ClassifiedUrl,
): ReadableStream<Uint8Array> {
  let encoded = 0;
  incoming.on('data', (chunk: Buffer) => {
    encoded += chunk.byteLength;
  });

  const decoded = decompress(incoming);
  let total = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let whole: ReturnType<typeof setTimeout> | undefined;

  const fail = (refusal: EgressRefusal): Error => {
    incoming.destroy();
    return blocked(options, refusal);
  };

  const web = Readable.toWeb(decoded) as ReadableStream<Uint8Array>;
  return web.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start: (controller) => {
        if (limits.bodyTotalTimeoutMs !== null) {
          whole = setTimeout(() => {
            controller.error(
              fail({
                reason: 'timeout',
                host: target.host,
                detail: `the body from ${target.host} took longer than ${String(limits.bodyTotalTimeoutMs)} ms.`,
              }),
            );
          }, limits.bodyTotalTimeoutMs);
        }
      },
      transform: (chunk, controller) => {
        if (idle !== undefined) clearTimeout(idle);
        idle = setTimeout(() => {
          controller.error(
            fail({
              reason: 'timeout',
              host: target.host,
              detail: `${target.host} stopped sending for ${String(limits.bodyIdleTimeoutMs)} ms.`,
            }),
          );
        }, limits.bodyIdleTimeoutMs);

        total += chunk.byteLength;
        if (total > limits.maxBytes) {
          controller.error(
            fail({
              reason: 'too-large',
              host: target.host,
              detail: `${target.host} sent more than ${String(limits.maxBytes)} decoded bytes.`,
            }),
          );
          return;
        }
        // The ratio, above a floor: a 30-byte gzip header that expands to 600 bytes is a ratio of
        // 20 and is not an attack. A bomb is large *and* disproportionate, which is why both
        // conditions are here and why the cap above is not enough on its own — 10 MiB of zeros
        // compresses to about 10 KiB, so a decompression bomb passes any check on the wire size.
        if (encoded > 0 && total > 64 * 1024 && total / encoded > limits.maxCompressionRatio) {
          controller.error(
            fail({
              reason: 'compression-ratio',
              host: target.host,
              detail: `${target.host} sent ${String(total)} bytes compressed as ${String(encoded)} — a ratio above ${String(limits.maxCompressionRatio)}.`,
            }),
          );
          return;
        }
        controller.enqueue(chunk);
      },
      flush: () => {
        if (idle !== undefined) clearTimeout(idle);
        if (whole !== undefined) clearTimeout(whole);
      },
    }),
  );
}

/** `Content-Encoding`, as the server actually used it. */
function decompress(incoming: IncomingMessage): Readable {
  const encoding = (incoming.headers['content-encoding'] ?? '').toLowerCase().trim();
  if (encoding === 'gzip' || encoding === 'x-gzip') return incoming.pipe(createGunzip());
  if (encoding === 'br') return incoming.pipe(createBrotliDecompress());
  if (encoding === 'deflate') return incoming.pipe(createInflate());
  return incoming;
}

/** Emit the audit event and build the error. */
function blocked(options: SafeFetchOptions, refusal: EgressRefusal): EgressBlockedError {
  return report(options, refusal);
}

function report(options: SafeFetchOptions, refusal: EgressRefusal): EgressBlockedError {
  options.onBlocked?.({ purpose: options.purpose, reason: refusal.reason, host: refusal.host });
  return new EgressBlockedError(options.purpose, refusal);
}
