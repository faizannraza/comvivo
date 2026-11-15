/**
 * `ChannelId` (`01` §1, `06` §8).
 *
 * The union is deliberately **open** (`(string & {})`): `10` §3 lets a plugin register a channel
 * adapter, and `10` §249's example is `'bluebubbles'`. So this is not an enum, and the `channel`
 * columns in `02` §3.3 are `TEXT` rather than a checked enum for the same reason.
 *
 * `(string & {})` is the TypeScript idiom for "any string, but keep autocomplete for the known
 * ones". It is not a brand and it validates nothing, which is why `channelIdSchema` exists for the
 * boundary.
 */
import { idSchema, z } from '@comvivo/shared';

/**
 * The channel ids this product ships (`00` §6.1), plus the two that are not chat platforms.
 *
 * `web` is the dashboard's own chat and `simulator` is the dev/test channel, both first-class in
 * `00` §6.1. `mcp` is named by `02` §3.3.1 — a tool call arriving through `10`'s MCP server
 * creates a conversation like any other surface, so it needs a channel id even though no adapter
 * polls it.
 */
export const CHANNEL_IDS = [
  'telegram',
  'discord',
  'slack',
  'matrix',
  'signal',
  'web',
  'simulator',
  'mcp',
] as const;

/** One of the channels this product ships. A plugin channel is a `ChannelId` but not one of these. */
export type KnownChannelId = (typeof CHANNEL_IDS)[number];

/** A channel identifier: one of {@link CHANNEL_IDS}, or a plugin's own (`10` §3). */
export type ChannelId = KnownChannelId | (string & {});

/** True for a channel this product ships, which is what adapter-specific branches switch on. */
export function isKnownChannelId(value: string): value is KnownChannelId {
  return (CHANNEL_IDS as readonly string[]).includes(value);
}

/**
 * The shape a channel id must have, including a plugin's.
 *
 * A lowercase slug, because a channel id is not only a discriminator: it appears in a `settings`
 * scope key (`02` §3.3.8), a metric label (`11` §3.1.6) and the `channel_identities_platform_uq`
 * key, and `02` §3.3.8's scope keys are `':'`-delimited strings. A channel id containing `':'`, a
 * space or an uppercase letter would make two distinct scopes collide or a metric label invalid.
 * Every id named by a spec — the eight above and `10`'s `'bluebubbles'` — satisfies this.
 */
export const channelIdSchema: z.ZodType<ChannelId> = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]{0,31}$/,
    'a channel id is 1–32 characters: a lowercase letter, then lowercase letters, digits, `_` or `-`',
  );

// --- The JSON shapes `02` §3.3's channel tables store (added at `M3-T1`) -------------------------
//
// These live here for the reason `M1-T11` moved `RichText` here: `02` §3.3.1 and §3.3.11 make them
// **columns**, and `packages/storage` may not import a channel package (`01` §4 as amended by
// A11). `02` §3.3.9's JSON catalog attributes them to `06`, which owns their *semantics*; `06`
// §4.1 is where the adapter-facing types live and it imports these.
//
// Two homes for one shape is what this avoids, and the cost of getting it wrong is specific: a
// `last_probe` the adapter writes and the dashboard reads would otherwise be two schemas that
// drift, and a drifted probe is a fix-it guide telling a host to grant a permission they have.

/**
 * One thing wrong with a chat, as `06` §3.20.3's fix-it guides and `09`'s `doctor` render it.
 *
 * `severity` is what decides whether setup can continue: `blocking` means the bot cannot work in
 * this chat at all, `degraded` means it works with less, and `advisory` is worth saying once.
 */
export const diagnosticSchema = z.strictObject({
  code: z.string().min(1).max(64),
  severity: z.enum(['blocking', 'degraded', 'advisory']),
  params: z.record(z.string().max(64), z.union([z.string().max(512), z.number()])).optional(),
});
export type Diagnostic = z.infer<typeof diagnosticSchema>;

/**
 * What a permission probe found (`06` §3.20.3), stored on `chat_bindings.last_probe`.
 *
 * Stored rather than re-probed on demand because a probe costs platform API calls and the
 * dashboard's setup page needs it on render. `06` §3.20.3 re-probes on a schedule and on demand;
 * this column is the last answer, and the `doctor` line says when it was taken.
 */
export const chatProbeSchema = z.strictObject({
  canSend: z.boolean(),
  /** Whether the bot sees every message, or only those addressing it (privacy mode, intents). */
  readsAll: z.boolean(),
  isAdmin: z.boolean().optional(),
  title: z.string().max(512).optional(),
  memberCount: z.int().min(0).optional(),
  isForum: z.boolean().optional(),
  encrypted: z.boolean().optional(),
  /** Slack Connect / an externally shared channel, which changes who can read a reply. */
  extShared: z.boolean().optional(),
  diagnostics: z.array(diagnosticSchema).max(32),
});
export type ChatProbe = z.infer<typeof chatProbeSchema>;

/**
 * What a button press does (`06` §3.7), stored on `interaction_tokens.action`.
 *
 * `kind` is a **registered string**, not an enum, and that is `06` §3.7's design: each owner
 * registers its own kinds — `05` has `confirm` and `cmd.undo`, `07` has sixteen, `06` has
 * `setup.template` and `dm.group` — and the engine rejects an unknown kind **as expired** rather
 * than as an error, because an unknown kind is what a token from a previous version looks like.
 *
 * `params` is `unknown` on purpose. Each kind's handler parses its own, which is the only place
 * that knows the shape; a union here would be every owner's params in one type, in `core`.
 */
export const interactionActionSchema = z.strictObject({
  kind: z.string().min(1).max(64),
  params: z.unknown(),
});
export type InteractionAction = z.infer<typeof interactionActionSchema>;

/**
 * Who may press a button (`06` §3.7), stored on `interaction_tokens.allowed_clickers`.
 *
 * `'any_member'` or an explicit list. **Re-checked by policy on every click** (invariant I3,
 * requester authority): this column narrows who the button was *offered* to, and it is not the
 * authorisation — a member whose role changed between the render and the press must be refused,
 * and only policy knows that.
 */
export const allowedClickersSchema = z.union([
  z.literal('any_member'),
  z.array(idSchema('mbr')).min(1).max(64),
]);
export type AllowedClickers = z.infer<typeof allowedClickersSchema>;
