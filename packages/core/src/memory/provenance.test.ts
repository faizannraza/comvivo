/**
 * `MemoryProvenance` and `SourceSpan` (`04` §3.2.4; `02` §3.3.4, §3.3.9).
 */
import { describe, expect, it } from 'vitest';
import {
  MEMORY_PROVENANCE_MAX_BYTES,
  MemoryProvenanceSchema,
  SourceSpanSchema,
} from './provenance.js';

const MEMBER_ID = 'mbr_01jqw8z5h7e9r3t4y5v6k7p8q9';
const MESSAGE_ID = 'msg_01jqw8z5h7e9r3t4y5v6k7p8q9';
const MEMORY_ID = 'mem_01jqw8z5h7e9r3t4y5v6k7p8q9';
const TURN_ID = 'trn_01jqw8z5h7e9r3t4y5v6k7p8q9';

const extracted = {
  source: 'extraction' as const,
  sourceMessageIds: [MESSAGE_ID],
  windowKey: 'cnv_x:120:140',
  extractor: {
    version: 'extract-1.3.0',
    promptHash: 'a'.repeat(64),
    route: 'extract' as const,
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
  },
  assertion: 'explicit' as const,
  assertedBy: MEMBER_ID,
  rawConfidence: 0.82,
  calibration: { table: 'extract-v3', p: 0.74 },
  confirmedBy: [],
  derivedFrom: [],
  turnId: null,
};

describe('a provenance record extraction produces', () => {
  it('round-trips', () => {
    expect(MemoryProvenanceSchema.parse(extracted)).toEqual(extracted);
  });

  it('allows an explicit memory with no extractor', () => {
    // "Remember that the spare key is under the pot" came from a person, not a model.
    const value = {
      ...extracted,
      source: 'explicit' as const,
      windowKey: null,
      extractor: null,
      rawConfidence: null,
      calibration: null,
      turnId: TURN_ID,
    };
    expect(MemoryProvenanceSchema.parse(value)).toEqual(value);
  });

  it('accepts system and external as asserters alongside a member', () => {
    // `reported` content — "Sam says he's vegetarian" — is what `assertion` plus `assertedBy`
    // exist to keep distinguishable from a first-person statement.
    for (const assertedBy of [MEMBER_ID, 'system', 'external']) {
      expect(
        MemoryProvenanceSchema.safeParse({ ...extracted, assertedBy }).success,
        assertedBy,
      ).toBe(true);
    }
  });

  it('refuses an asserter that is neither a member id nor a known sentinel', () => {
    expect(
      MemoryProvenanceSchema.safeParse({ ...extracted, assertedBy: 'anonymous' }).success,
    ).toBe(false);
    expect(MemoryProvenanceSchema.safeParse({ ...extracted, assertedBy: MEMORY_ID }).success).toBe(
      false,
    );
  });

  it('keeps the raw self-report and the calibration separately', () => {
    // Overwriting `rawConfidence` with the calibrated number would make a recalibration
    // unapplicable to old items, which is the whole reason both fields exist.
    const parsed = MemoryProvenanceSchema.parse(extracted);
    expect(parsed.rawConfidence).toBe(0.82);
    expect(parsed.calibration?.p).toBe(0.74);
  });

  it('bounds both probabilities to 0..1', () => {
    expect(MemoryProvenanceSchema.safeParse({ ...extracted, rawConfidence: 1.2 }).success).toBe(
      false,
    );
    expect(
      MemoryProvenanceSchema.safeParse({
        ...extracted,
        calibration: { table: 't', p: -0.1 },
      }).success,
    ).toBe(false);
  });

  it('refuses a source message list that is not message ids', () => {
    expect(
      MemoryProvenanceSchema.safeParse({ ...extracted, sourceMessageIds: [MEMORY_ID] }).success,
    ).toBe(false);
  });

  it('bounds the source and derivation lists', () => {
    const many = (prefix: string, count: number) =>
      Array.from(
        { length: count },
        (_, index) => `${prefix}_01jqw8z5h7e9r3t4y5v6k7${String(index).padStart(2, '0')}`,
      );
    expect(
      MemoryProvenanceSchema.safeParse({ ...extracted, sourceMessageIds: many('msg', 51) }).success,
    ).toBe(false);
    expect(
      MemoryProvenanceSchema.safeParse({ ...extracted, derivedFrom: many('mem', 501) }).success,
    ).toBe(false);
  });

  it('enforces the 4 KiB column cap', () => {
    expect(MEMORY_PROVENANCE_MAX_BYTES).toBe(4096);
    // 50 message ids plus 200 derivations is well past 4 KiB while inside every field bound —
    // the same shape of interaction as the note body and its column cap.
    const many = (prefix: string, count: number) =>
      Array.from(
        { length: count },
        (_, index) => `${prefix}_01jqw8z5h7e9r3t4y5v6k7${String(index).padStart(2, '0')}`,
      );
    const outcome = MemoryProvenanceSchema.safeParse({
      ...extracted,
      sourceMessageIds: many('msg', 50),
      derivedFrom: many('mem', 200),
    });
    expect(outcome.success).toBe(false);
    if (outcome.success) return;
    expect(outcome.error.issues.some((issue) => issue.message.includes('4096-byte limit'))).toBe(
      true,
    );
  });
});

describe('SourceSpan', () => {
  it('accepts a half-open range and an empty one', () => {
    expect(SourceSpanSchema.parse({ start: 10, end: 24 })).toEqual({ start: 10, end: 24 });
    expect(SourceSpanSchema.parse({ start: 7, end: 7 })).toEqual({ start: 7, end: 7 });
  });

  it('refuses a reversed span', () => {
    // A reversed span renders as nothing, which looks like missing provenance rather than a bad
    // offset — so it has to fail where it is written, not where it is displayed.
    expect(SourceSpanSchema.safeParse({ start: 24, end: 10 }).success).toBe(false);
  });

  it('refuses negative and fractional offsets', () => {
    expect(SourceSpanSchema.safeParse({ start: -1, end: 4 }).success).toBe(false);
    expect(SourceSpanSchema.safeParse({ start: 0.5, end: 4 }).success).toBe(false);
  });
});
