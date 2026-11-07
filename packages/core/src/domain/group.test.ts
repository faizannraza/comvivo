/**
 * Group archetypes (`00` §5).
 *
 * A closed set, unlike `ChannelId`, because each one is a constitution template `03` ships. The
 * list and its spellings are asserted literally: the value is also the template file name, so a
 * drift between them is a group created from a template that cannot be found.
 */
import { describe, expect, it } from 'vitest';
import { ARCHETYPES, groupArchetypeSchema } from './group.js';

describe('the archetype list', () => {
  it('is 00 §5, in its order and with its spellings', () => {
    expect([...ARCHETYPES]).toEqual([
      'family',
      'roommates',
      'friends',
      'trip',
      'team',
      'club',
      'parents-class',
      'oss-project',
    ]);
  });

  it.each(ARCHETYPES)('accepts %s', (archetype) => {
    expect(groupArchetypeSchema.parse(archetype)).toBe(archetype);
  });

  it.each(['Family', 'parents_class', 'ossproject', 'household', ''])('refuses %o', (value) => {
    expect(groupArchetypeSchema.safeParse(value).success).toBe(false);
  });

  it('keeps the hyphenated spellings, which are also the template file names', () => {
    expect(ARCHETYPES).toContain('parents-class');
    expect(ARCHETYPES).toContain('oss-project');
  });
});
