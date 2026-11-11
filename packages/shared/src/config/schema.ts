/**
 * The configuration schema.
 *
 * A note on `.prefault({})` versus `.default({})`: in zod v4 `.default()` takes the **output**
 * type, so an absent object would have to be given every field already filled in. `.prefault()`
 * supplies the value as **input** and then parses it, which is what lets the inner `.default()`s
 * cascade — and it is why `parseConfig({})` returns a complete configuration rather than failing.
 *
 * ADR-014 and `01` §10 define the surface; `08` §5 adds the security keys. This is the **skeleton**
 * `M0-T6` is scoped to: the keys that exist today, validated properly. `M9` generates the full
 * reference from this schema, and each subsystem extends its own namespace as it lands — so the
 * schema grows by addition, and the generated docs cannot drift from it.
 *
 * Everything is `.default()`ed, so a host with an empty `comvivo.yaml` gets a working instance and
 * `parseConfig({})` returns the complete default configuration. That is what makes "install to
 * first useful answer in under five minutes" (`00` §3.7) achievable: nothing is required up front
 * except a model key and a bot token, both of which are secrets and live in the environment.
 */
import { BRAND } from '../brand.js';
import { z } from '../zod.js';

/** A port a host may bind. 0 means "pick a free one", which the test harness relies on. */
const port = z.number().int().min(0).max(65_535);

const instance = z
  .object({
    /** Shown in the dashboard chrome and in the bot's introduction. */
    name: z.string().min(1).max(80).default(`Our ${BRAND.displayName}`),
    /** Database, blobs, keys, backups and logs all live under here. */
    dataDir: z.string().min(1).default('./data'),
    /** Needed only for ICS feeds and shareable dashboard links; otherwise loopback is enough. */
    publicUrl: z.url().nullable().default(null),
  })
  .prefault({});

const models = z
  .object({
    preset: z.enum(['best', 'balanced', 'economy', 'local', 'custom']).default('best'),
    /** Per-route overrides. Shape is owned by `05` and validated there; opaque here. */
    routes: z.record(z.string(), z.unknown()).prefault({}),
    local: z
      .object({
        baseUrl: z.url().default('http://localhost:11434/v1'),
        model: z.string().nullable().default(null),
      })
      .prefault({}),
  })
  .prefault({});

const channels = z
  .object({
    telegram: z.object({ enabled: z.boolean().default(false) }).prefault({}),
    discord: z.object({ enabled: z.boolean().default(false) }).prefault({}),
    slack: z.object({ enabled: z.boolean().default(false) }).prefault({}),
    matrix: z
      .object({
        enabled: z.boolean().default(false),
        homeserverUrl: z.url().nullable().default(null),
      })
      .prefault({}),
    signal: z
      .object({
        enabled: z.boolean().default(false),
        cliUrl: z.url().default('http://localhost:8080'),
      })
      .prefault({}),
  })
  .prefault({});

const dashboard = z
  .object({
    /** Loopback by default. Changing it is host-only, because it changes who can reach the UI. */
    bind: z.string().min(1).default('127.0.0.1'),
    port: port.default(7777),
    publicUrl: z.url().nullable().default(null),
    allowedHosts: z.array(z.string()).default([]),
    /** `false`, `true`, or the CIDRs whose `X-Forwarded-*` headers are honoured (`09` §3.9.6). */
    trustProxy: z.union([z.boolean(), z.array(z.string())]).default(false),
    tls: z
      .object({
        certFile: z.string().nullable().default(null),
        keyFile: z.string().nullable().default(null),
      })
      .prefault({}),
    allowInsecureLan: z.boolean().default(false),
    ingress: z
      .object({
        enabled: z.boolean().default(false),
        port: port.default(8099),
        allowFrom: z.array(z.string()).default(['172.30.32.2']),
      })
      .prefault({}),
    sessions: z
      .object({
        idleHours: z.number().int().positive().default(12),
        absoluteDays: z.number().int().positive().default(7),
        rotateHours: z.number().int().positive().default(24),
        recentAuthMinutes: z.number().int().positive().default(10),
      })
      .prefault({}),
    auth: z
      .object({
        pairingCodes: z.boolean().default(true),
        pairingCodeTtlMinutes: z.number().int().min(1).max(60).default(10),
        /** `auto` = loopback only; `https` = also over HTTPS, an explicit opt-in (A9). */
        magicLinks: z.enum(['auto', 'https', 'off']).default('auto'),
        magicLinkTtlMinutes: z.number().int().min(2).max(10).default(10),
      })
      .prefault({}),
  })
  .prefault({});

const privacy = z
  .object({
    /** A constitution may shorten this; only the host may raise the ceiling below (S13). */
    messageRetentionDays: z.number().int().min(1).default(90),
    maxMessageRetentionDays: z.number().int().min(1).default(365),
    logRetentionDays: z.number().int().min(1).default(14),
    /** `02` §3.13.1. `usage_daily` keeps the aggregate forever; this is the per-call detail. */
    usageRetentionDays: z.number().int().min(1).default(400),
    /**
     * How long the audit chain is kept. `null` means forever, which is the default.
     *
     * `02` §3.13.1 says audit events live "forever (deleted only with the group)"; `08` §3.16.2
     * says "1 year (hash chain re-anchored on purge)". The conflict is resolved in favour of `02`'s
     * default with `08`'s mechanism available, because the two documents are answering different
     * questions. An audit row holds ids, enums and counts and **never** content (`02` §3.3.9) — it
     * is what remains after an erasure precisely because there is nothing personal left in it — so
     * deleting it by default trades away the accountability the chain exists for and buys no
     * privacy. A host who needs a ceiling anyway (a policy, a jurisdiction) sets one here, and the
     * sweep then re-anchors the chain so verification can still tell a lawful purge from an edit.
     *
     * The floor is 30 days rather than 1: a chain swept faster than a host reads it cannot support
     * the "what happened last month?" question that is the whole point of having one.
     */
    auditRetentionDays: z.number().int().min(30).nullable().default(null),
    encryptAtRest: z.boolean().default(true),
    localOnly: z.boolean().default(false),
    sensitiveRoutesLocal: z.boolean().default(false),
  })
  .prefault({});

const traces = z
  .object({
    /** Manifests only, never content (`01` §14, the TurnTrace retention resolution). */
    retentionDays: z.number().int().min(7).max(365).default(30),
    captureModelIO: z.boolean().default(false),
  })
  .prefault({});

const network = z
  .object({
    egress: z
      .object({
        /** Exact `host:port` entries. The allowlist that makes invariant I5 real. */
        allowPrivate: z.array(z.string()).default([]),
        allowHttpHosts: z.array(z.string()).default([]),
        defaultTimeoutMs: z.number().int().positive().default(10_000),
        defaultMaxBytes: z.number().int().positive().default(10_485_760),
      })
      .prefault({}),
  })
  .prefault({});

const outbound = z
  .object({
    linkPreviews: z.enum(['off', 'allowlisted']).default('off'),
    allowedLinkDomains: z.array(z.string()).default([]),
    maxMentionsPerMessage: z.number().int().min(0).default(5),
  })
  .prefault({});

/**
 * The full configuration.
 *
 * `.strict()` on every object is deliberate: a typo in a key name must be an error, not a silently
 * ignored setting. A host who writes `dashbord:` and gets a working-but-wrong instance has been
 * failed by us, and "I set that and it did nothing" is among the worst bug reports to receive.
 */
export const configSchema = z
  .object({
    instance,
    models,
    embeddings: z
      .object({
        provider: z.enum(['local', 'openai', 'voyage', 'google', 'ollama']).default('local'),
        model: z.string().default('multilingual-e5-small'),
      })
      .prefault({}),
    transcription: z
      .object({
        provider: z.enum(['local', 'openai', 'groq', 'deepgram']).default('local'),
        model: z.string().default('whisper-base'),
      })
      .prefault({}),
    channels,
    email: z
      .object({
        enabled: z.boolean().default(false),
        imap: z
          .object({
            host: z.string().nullable().default(null),
            port: port.default(993),
            user: z.string().nullable().default(null),
          })
          .prefault({}),
      })
      .prefault({}),
    dashboard,
    ics: z
      .object({ bind: z.string().nullable().default(null), port: port.default(7778) })
      .prefault({}),
    privacy,
    traces,
    network,
    outbound,
    /** `02` §3.13.1's `jobs.*` retention. Terminal rows only; a live job is never swept. */
    jobs: z
      .object({
        retainSucceededDays: z.number().int().min(1).default(7),
        retainDeadDays: z.number().int().min(1).default(30),
      })
      .prefault({}),
    /** `02` §3.13.1's `outbox.*` retention. `retainDeadDays` is longer: a dead send is evidence. */
    outbox: z
      .object({
        retainDays: z.number().int().min(1).default(14),
        retainDeadDays: z.number().int().min(1).default(90),
      })
      .prefault({}),
    /** `02` §3.11's limits and §3.13.1's GC grace. Mirrored by `BLOB_LIMITS` in `storage`. */
    blobs: z
      .object({
        maxBytes: z.number().int().positive().default(52_428_800),
        groupQuotaBytes: z
          .number()
          .int()
          .positive()
          .default(2 * 1024 * 1024 * 1024),
        /** 0 means unlimited (`02` §3.11). */
        instanceQuotaBytes: z.number().int().min(0).default(0),
        minFreeBytes: z
          .number()
          .int()
          .positive()
          .default(1024 * 1024 * 1024),
        /** How long an unreferenced blob survives before the sweep takes it. */
        gcGraceHours: z.number().int().min(1).default(24),
      })
      .prefault({}),
    budgets: z
      .object({
        /** `auto` uses the per-preset defaults in `01` §14 A3. */
        preset: z.literal('auto').default('auto'),
        monthlyUsd: z.number().positive().nullable().default(null),
        dailyUsd: z.number().positive().nullable().default(null),
      })
      .prefault({}),
    backups: z
      .object({
        enabled: z.boolean().default(true),
        keep: z.number().int().positive().default(14),
      })
      .prefault({}),
    security: z
      .object({
        keys: z
          .object({
            store: z.enum(['keyfile', 'keychain', 'file', 'env', 'passphrase']).default('keyfile'),
            keyfilePath: z.string().default('./data/keys/master.key'),
            keychainService: z.string().default(BRAND.slug),
          })
          .prefault({}),
      })
      .prefault({}),
    plugins: z
      .object({
        runner: z.enum(['process', 'docker']).default('process'),
        /** May be `false` only outside production, and `doctor` says so loudly (`08` §5). */
        requireApproval: z.boolean().default(true),
      })
      .prefault({}),
    mcp: z
      .object({
        server: z
          .object({ http: z.object({ enabled: z.boolean().default(false) }).prefault({}) })
          .prefault({}),
      })
      .prefault({}),
    logging: z
      .object({
        level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
        format: z.enum(['pretty', 'json']).default('pretty'),
        /** Logs message and memory CONTENT. Off by default, host-only, announced in-group. */
        debugContent: z.boolean().default(false),
        /**
         * File logging, for launchd and WSL where stdout is not captured (`12` §3.11.3).
         *
         * **Off by default**, and that is the right default: stdout is captured by Docker,
         * systemd and every process manager a host is likely to use, so a file is redundant
         * almost everywhere while being one more place content could end up. When it is on the
         * file is content-free by construction — `log.content()` writes to stdout only — and is
         * rotated at 5 x 10 MiB so it cannot fill a Raspberry Pi's SD card. The transport itself
         * is wired in `M3-T14`.
         */
        file: z
          .object({
            enabled: z.boolean().default(false),
            path: z.string().nullable().default(null),
            maxSizeMib: z.number().int().positive().default(10),
            keep: z.number().int().positive().default(5),
          })
          .prefault({}),
      })
      .prefault({}),
    /**
     * Tracing and metrics (`11` §3.10.2–§3.10.3). Both off by default.
     *
     * Not telemetry in the sense ADR-017 forbids: nothing is sent to us or to anyone else. These
     * switches point at a collector the **host** runs, on the host's own machine, and with both
     * off nothing is loaded at all. The whole subtree is host-only (A14): an OTLP endpoint is an
     * egress destination, so being able to set one from a session would be an exfiltration
     * primitive.
     *
     * Content never appears in either channel, by construction rather than by configuration —
     * `Attributes` makes a GenAI content attribute a compile error and `FORBIDDEN_LABEL_NAMES`
     * keeps member identifiers out of a scrape. There is deliberately no key that would enable
     * content capture, and `OTEL_INSTRUMENTATION_GENAI_CAPTURE_CONTENT` is ignored.
     */
    observability: z
      .object({
        otel: z
          .object({
            enabled: z.boolean().default(false),
            /** OTLP **HTTP** endpoint, e.g. `http://localhost:4318`. Required when enabled. */
            endpoint: z.url().nullable().default(null),
            /** Parent-based sampler ratio. 1.0 is right on a single host: the volume is low. */
            sampleRatio: z.number().min(0).max(1).default(1),
          })
          .prefault({}),
        metrics: z
          .object({
            enabled: z.boolean().default(false),
            /**
             * Add a `group` label to the handful of metrics that declare one.
             *
             * Off by default because it multiplies those series by the number of groups, and `11`
             * §8 budgets about 5,000 series in total. On, it answers the one question a host
             * actually asks of a multi-group instance: which group is spending the money.
             */
            perGroupLabels: z.boolean().default(false),
          })
          .prefault({}),
      })
      .prefault({}),
    /** ADR-017: zero telemetry. This fetches a static release manifest, nothing more. */
    updates: z.object({ check: z.boolean().default(false) }).prefault({}),
  })
  .strict();

export type Config = z.output<typeof configSchema>;

/** The complete default configuration, as a host with an empty file would get. */
export function defaultConfig(): Config {
  return configSchema.parse({});
}
