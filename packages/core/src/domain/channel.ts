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
import { z } from '@comvivo/shared';

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
