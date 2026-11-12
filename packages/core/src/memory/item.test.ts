/**
 * `retrievalStateFor` and `subjectRefToColumn` (`04` R5, `02` §3.3.4).
 *
 * `retrievalStateFor` is the rule the memory repository and `04`'s nightly maintenance both apply,
 * and a disagreement between them would be invisible: the state is a *filter*, so too high and an
 * item stops being retrievable, too low and a superseded item answers as current. Neither raises.
 * So the rule is tested here, where it lives, rather than only through the repository.
 */
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import {
  MEMORY_KINDS,
  MEMORY_STATUSES,
  RETRACT_REASONS,
  RETRIEVAL_STATES,
  retrievalStateFor,
  subjectRefToColumn,
} from './item.js';

const NOW = Temporal.Instant.from('2026-11-08T12:00:00Z');
const PAST = Temporal.Instant.from('2026-01-01T00:00:00Z');
const FUTURE = Temporal.Instant.from('2027-01-01T00:00:00Z');

describe('retrievalStateFor (04 R5)', () => {
  it('puts an active item with no archive at active-current', () => {
    expect(
      retrievalStateFor({ status: 'active', archivedAt: undefined, validTo: undefined, now: NOW }),
    ).toBe(RETRIEVAL_STATES.activeCurrent);
    // An open-ended validity, and one that has not run out yet, are both still current.
    expect(
      retrievalStateFor({ status: 'active', archivedAt: undefined, validTo: FUTURE, now: NOW }),
    ).toBe(RETRIEVAL_STATES.activeCurrent);
  });

  it('puts a proposed item at proposed', () => {
    expect(
      retrievalStateFor({
        status: 'proposed',
        archivedAt: undefined,
        validTo: undefined,
        now: NOW,
      }),
    ).toBe(RETRIEVAL_STATES.proposed);
  });

  it('puts a superseded item at history regardless of anything else', () => {
    // First test in the chain, so it wins over `archivedAt` and over the validity window: once
    // something newer answers the question, how this item was archived stops mattering.
    for (const archivedAt of [undefined, NOW]) {
      for (const validTo of [undefined, PAST, FUTURE]) {
        expect(
          retrievalStateFor({ status: 'superseded', archivedAt, validTo, now: NOW }),
          `${String(archivedAt)}/${String(validTo)}`,
        ).toBe(RETRIEVAL_STATES.history);
      }
    }
  });

  it('distinguishes archived-for-disuse from archived-past-its-validity', () => {
    // `04` §3.7's maintenance table draws this line and it is the subtle one: an item archived
    // because nobody used it is `archived` and can come back, while one archived *because* its
    // validity passed is `history` and cannot.
    expect(
      retrievalStateFor({ status: 'active', archivedAt: NOW, validTo: undefined, now: NOW }),
    ).toBe(RETRIEVAL_STATES.archived);
    expect(
      retrievalStateFor({ status: 'active', archivedAt: NOW, validTo: FUTURE, now: NOW }),
    ).toBe(RETRIEVAL_STATES.archived);
    expect(retrievalStateFor({ status: 'active', archivedAt: NOW, validTo: PAST, now: NOW })).toBe(
      RETRIEVAL_STATES.history,
    );
  });

  it('treats a validity ending exactly now as still valid', () => {
    // `validTo` is an end *bound*, and `02` §3.5's vector filter is `valid_to_ms > :nowMs` — so
    // "expires at noon" is valid up to noon. The comparison here has to agree with that query, or
    // the vec channel and the state filter would disagree for one millisecond on every boundary.
    expect(retrievalStateFor({ status: 'active', archivedAt: NOW, validTo: NOW, now: NOW })).toBe(
      RETRIEVAL_STATES.archived,
    );
  });

  it('gives a retracted item the highest ceiling, not the lowest', () => {
    // This assertion and its comment used to disagree — the comment argued for `history` and the
    // assertion asserted `activeCurrent`, which is what the function then returned. Chasing the
    // contradiction found a real bug: the base-table reads filter on `retrieval_state <= :maxState`
    // with no status predicate, so a retracted item at state `0` came back as **current**.
    //
    // Both layers are fixed. The predicate is the real one
    // (`search/retracted-invisible.int.test.ts`); this is the second, so a read that ever forgets
    // it again surfaces the item only at `maxState: 3` rather than as the current answer.
    for (const archivedAt of [undefined, NOW]) {
      for (const validTo of [undefined, PAST, FUTURE]) {
        expect(
          retrievalStateFor({ status: 'retracted', archivedAt, validTo, now: NOW }),
          `${String(archivedAt)}/${String(validTo)}`,
        ).toBe(RETRIEVAL_STATES.history);
      }
    }
  });

  it('covers every declared status, so a new one cannot be added unnoticed', () => {
    expect([...MEMORY_STATUSES]).toEqual(['proposed', 'active', 'superseded', 'retracted']);
    // Every status produces a state in the declared range, which is what the `memory_state_ck`
    // CHECK constraint requires of the column.
    for (const status of MEMORY_STATUSES) {
      const state = retrievalStateFor({
        status,
        archivedAt: undefined,
        validTo: undefined,
        now: NOW,
      });
      expect(Object.values(RETRIEVAL_STATES), status).toContain(state);
    }
  });
});

describe('subjectRefToColumn', () => {
  it('spells each subject the way the column stores it', () => {
    expect(subjectRefToColumn({ type: 'member', memberId: 'mbr_1' })).toBe('mbr_1');
    expect(subjectRefToColumn({ type: 'entity', entityId: 'ent_1' })).toBe('ent_1');
    // `group` has no id of its own, so it is the sentinel — the same choice `Label.owner` makes,
    // and for the same reason: a case to handle reads better than a value that might be missing.
    expect(subjectRefToColumn({ type: 'group' })).toBe('group');
  });
});

describe('the declared sets', () => {
  it('lists the kinds and retract reasons 02 §3.3.4 and 04 name', () => {
    expect([...MEMORY_KINDS]).toEqual([
      'fact',
      'preference',
      'decision',
      'commitment',
      'note',
      'profile',
    ]);
    // A closed set where the column is free text, so a dashboard cannot end up with six spellings
    // of "expired".
    expect(RETRACT_REASONS).toContain('expired');
    expect(RETRACT_REASONS).toContain('source_deleted');
    expect(new Set(RETRACT_REASONS).size).toBe(RETRACT_REASONS.length);
  });
});
