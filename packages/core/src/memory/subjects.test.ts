/**
 * Subjects and external entities (`04` §3.2.3).
 */
import { describe, expect, it } from 'vitest';
import { EntityRelationSchema, RelationKindSchema, SubjectRefSchema } from './subjects.js';

const MEMBER_ID = 'mbr_01jqw8z5h7e9r3t4y5v6k7p8q9';
const ENTITY_ID = 'ent_01jqw8z5h7e9r3t4y5v6k7p8q9';

describe('SubjectRef', () => {
  it('accepts a member, the group, and an external entity', () => {
    expect(SubjectRefSchema.parse({ type: 'member', memberId: MEMBER_ID })).toEqual({
      type: 'member',
      memberId: MEMBER_ID,
    });
    expect(SubjectRefSchema.parse({ type: 'group' })).toEqual({ type: 'group' });
    expect(SubjectRefSchema.parse({ type: 'entity', entityId: ENTITY_ID })).toEqual({
      type: 'entity',
      entityId: ENTITY_ID,
    });
  });

  it('requires the id to match its subject type', () => {
    // A branded id is the only thing separating "about member m" from "about entity e", and both
    // feed `04`'s sensitivity floor differently.
    expect(SubjectRefSchema.safeParse({ type: 'member', memberId: ENTITY_ID }).success).toBe(false);
    expect(SubjectRefSchema.safeParse({ type: 'entity', entityId: MEMBER_ID }).success).toBe(false);
  });

  it('refuses an unknown subject type', () => {
    expect(SubjectRefSchema.safeParse({ type: 'person', personId: MEMBER_ID }).success).toBe(false);
  });
});

describe('EntityRelation', () => {
  it('accepts a relation to a member', () => {
    const value = { toMemberId: MEMBER_ID, kind: 'parent' as const };
    expect(EntityRelationSchema.parse(value)).toEqual(value);
  });

  it('covers the relation kinds 04 §3.2.3 lists, including pet_of', () => {
    expect(RelationKindSchema.options).toContain('pet_of');
    expect(RelationKindSchema.options).toContain('guardian');
    expect(RelationKindSchema.options).toContain('other');
    expect(RelationKindSchema.options).toHaveLength(17);
  });

  it('refuses a relation kind outside the list', () => {
    expect(EntityRelationSchema.safeParse({ toMemberId: MEMBER_ID, kind: 'boss' }).success).toBe(
      false,
    );
  });
});
