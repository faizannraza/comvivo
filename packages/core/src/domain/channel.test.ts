/**
 * `ChannelId` (`01` §1, `06` §8).
 *
 * The union is open, so the interesting assertions are about the *shape* a plugin's channel id
 * must have — not about the list of known ones, which a plugin extends by design.
 */
import { describe, expect, it } from 'vitest';
import { CHANNEL_IDS, channelIdSchema, isKnownChannelId } from './channel.js';

describe('the channels this product ships', () => {
  it('is 00 §6.1 plus the two non-platform surfaces and mcp', () => {
    expect([...CHANNEL_IDS]).toEqual([
      'telegram',
      'discord',
      'slack',
      'matrix',
      'signal',
      'web',
      'simulator',
      'mcp',
    ]);
  });

  it.each(CHANNEL_IDS)('recognises %s as known', (channel) => {
    expect(isKnownChannelId(channel)).toBe(true);
    expect(channelIdSchema.parse(channel)).toBe(channel);
  });

  it('does not recognise a plugin channel as known, but still accepts it', () => {
    // `10` §249's own example. A plugin channel is a valid `ChannelId` and not one of ours, and
    // both halves of that have to hold or either the adapter registry or the switch breaks.
    expect(isKnownChannelId('bluebubbles')).toBe(false);
    expect(channelIdSchema.parse('bluebubbles')).toBe('bluebubbles');
  });
});

describe('the shape a channel id must have', () => {
  it.each(['bluebubbles', 'my-channel', 'my_channel', 'imessage2', 'a'])('accepts %s', (value) => {
    expect(channelIdSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    'Telegram',
    'tele gram',
    'member:x',
    '2fast',
    '-leading',
    '_leading',
    '',
    'a'.repeat(33),
    'tele.gram',
  ])('refuses %o', (value) => {
    expect(channelIdSchema.safeParse(value).success).toBe(false);
  });

  it('refuses a colon, which would collide with a settings scope key', () => {
    // `02` §3.3.8's settings scopes are `':'`-delimited (`'member:<memberId>'`), and a metric label
    // (`11` §3.1.6) has the same constraint. A channel id with a colon makes two scopes collide.
    expect(channelIdSchema.safeParse('web:chat').success).toBe(false);
  });

  it('refuses a non-string', () => {
    expect(channelIdSchema.safeParse(42).success).toBe(false);
    expect(channelIdSchema.safeParse(undefined).success).toBe(false);
  });
});
