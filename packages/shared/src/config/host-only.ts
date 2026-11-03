/**
 * Host-only configuration keys.
 *
 * `01` §14 **A14**: these keys are read from **env or YAML only** and ignore anything stored in the
 * database, so a compromised or merely over-curious admin session cannot change them from the
 * dashboard. `08` §5 marks the same keys with ● and adds the enforcement rule: an attempt to set
 * one through the API is a `403 host_only` plus an audit event.
 *
 * The threat this closes is specific. Group admins are *members*, and `01` §9 trust boundary 2
 * says a member may be adversarial toward the others. If an admin could edit
 * `network.egress.allowPrivate`, they could point the instance at an address they control and
 * exfiltrate another member's data through a "feature". If they could edit
 * `privacy.localOnly` or `traces.captureModelIO`, they could turn on content capture for everyone
 * else. These are not settings — they are the walls.
 *
 * A path ending in `.*` covers the whole subtree, because a subtree is only as host-only as its
 * least-protected leaf.
 */

/**
 * Every host-only key, as a dotted path. `*` matches one or more trailing segments.
 *
 * Grouped by the reason it is protected, because the reason is what a future contributor needs in
 * order to decide correctly about a new key.
 */
export const HOST_ONLY_PATHS: readonly string[] = [
  // --- Who we talk to, and with whose money (A14: providers and API keys) --------------------
  // An admin who can change the provider can redirect every group's messages to a server they
  // control, and spend the host's budget doing it.
  'models.*',
  'embeddings.*',
  'transcription.*',

  // --- Where bytes may go (A14: egress allowlists) --------------------------------------------
  // The allowlist is what makes invariant I5 (guarded egress) real. Widening it from a session is
  // a data-exfiltration primitive.
  'network.*',
  'outbound.allowedLinkDomains',

  // --- What runs in our process (A14: plugins, MCP servers) -----------------------------------
  // Installing code or an external tool server is a host decision, always.
  'plugins.*',
  'mcp.*',

  // --- Keys and encryption --------------------------------------------------------------------
  'security.*',
  'privacy.encryptAtRest',
  'privacy.localOnly',
  'privacy.sensitiveRoutesLocal',

  // --- How the instance is exposed (A14: exposure mode) ---------------------------------------
  // Binding to 0.0.0.0, trusting a proxy's forwarded headers, or enabling magic links over the LAN
  // each change who can reach the dashboard at all.
  'dashboard.bind',
  'dashboard.port',
  'dashboard.publicUrl',
  'dashboard.allowedHosts',
  'dashboard.trustProxy',
  'dashboard.tls.*',
  'dashboard.allowInsecureLan',
  'dashboard.ingress.*',
  'dashboard.auth.magicLinks',
  'ics.*',

  // --- Ceilings a group may not raise for itself ----------------------------------------------
  // A constitution may shorten retention; only the host may lengthen the ceiling (S13).
  'privacy.maxMessageRetentionDays',
  'privacy.logRetentionDays',
  'traces.retentionDays',
  // Content capture in traces is off by default and opt-in by the host only (11 §3.10.4).
  'traces.captureModelIO',

  // --- Content debug logging (A14) -------------------------------------------------------------
  // Turning this on logs message and memory content. It is announced in the group and auto-deleted
  // after 24 hours (08 §5), and it is never an admin's call.
  'logging.debugContent',

  // --- Phoning home ---------------------------------------------------------------------------
  // ADR-017 is zero telemetry. The update check is opt-in, read-only, and host-only.
  'updates.*',
];

/** Compiled once: a path pattern becomes an exact match or a subtree prefix. */
const COMPILED: readonly { readonly exact?: string; readonly prefix?: string }[] =
  HOST_ONLY_PATHS.map((pattern) =>
    pattern.endsWith('.*') ? { prefix: `${pattern.slice(0, -2)}.` } : { exact: pattern },
  );

/**
 * Is this dotted config path host-only?
 *
 * A path *under* a protected subtree is protected, and so is the subtree root itself: setting
 * `models` wholesale must be refused as firmly as setting `models.routes.chat.provider`.
 */
export function isHostOnly(path: string): boolean {
  for (const entry of COMPILED) {
    if (entry.exact !== undefined && entry.exact === path) return true;
    if (entry.prefix !== undefined) {
      if (path.startsWith(entry.prefix)) return true;
      // The subtree root, e.g. `models` for the pattern `models.*`.
      if (`${path}.` === entry.prefix) return true;
    }
  }
  return false;
}

/** Every host-only path present in a flattened settings object. Used to build the 403 response. */
export function hostOnlyPathsIn(paths: Iterable<string>): string[] {
  return [...paths].filter(isHostOnly).sort();
}
