/**
 * The published schemas as a contract in their own right (`02` §3.15).
 *
 * `format.contract.int.test.ts` proves the export's records satisfy these schemas. This proves the
 * schemas say something — that they would **refuse** the records a consumer must never be handed.
 * A contract that accepts anything is not one, and the two failure modes below are the ones the
 * format exists to prevent.
 */
import { describe, expect, it } from 'vitest';
import { EXPORT_RECORD_VERSION } from './export.js';
import { ExportRecordSchemas, MemberRecordSchema, MessageRecordSchema } from './schemas.js';

const MESSAGE = {
  $type: 'message',
  $v: EXPORT_RECORD_VERSION,
  rid: 1,
  id: 'msg_01jxpf00000000000000000000',
  groupId: 'grp_01jrep10000000000000000000',
  conversationId: 'cnv_01jxpf00000000000000000000',
  kind: 'member',
  text: 'hello',
  untrusted: false,
  label: {
    readers: { kind: 'group' },
    owner: 'group',
    sensitivity: 'normal',
    influence: 'none',
    untrusted: false,
  },
  sentAt: '2026-11-08T12:00:00Z',
  receivedAt: '2026-11-08T12:00:00Z',
  deliveredLate: false,
  truncated: false,
  editCount: 0,
};

describe('instants (02 §3.15: "ISO-8601 instants")', () => {
  it('refuses epoch milliseconds, in either form', () => {
    expect(MessageRecordSchema.safeParse(MESSAGE).success).toBe(true);
    // The regression this guards: a mapper missed, so the column's raw integer reaches the file.
    // A pattern match on `\d{4}-` would catch the number and miss the **string** — which is what
    // `JSON.stringify` writes when a value is a number held in a string column.
    for (const value of [1_762_603_200_000, '1762603200000', '2026-11-08', 'yesterday', '']) {
      const parsed = MessageRecordSchema.safeParse({ ...MESSAGE, sentAt: value });
      expect(parsed.success, `sentAt ${JSON.stringify(value)} is refused`).toBe(false);
    }
  });

  it('accepts the offsets and sub-second precision a real instant can carry', () => {
    for (const value of [
      '2026-11-08T12:00:00Z',
      '2026-11-08T12:00:00.310Z',
      '2026-11-08T13:00:00+01:00',
    ]) {
      expect(
        MessageRecordSchema.safeParse({ ...MESSAGE, sentAt: value }).success,
        `sentAt ${value}`,
      ).toBe(true);
    }
  });
});

describe('the format is additive within $v (02 §3.15)', () => {
  it('passes unknown keys through rather than failing or dropping them', () => {
    // The reason these are loose: a domain object gains an optional field whenever a feature does,
    // and a consumer built against today's schema has to keep working. Dropping the key would be
    // just as bad as failing — the consumer would see an archive the exporter never wrote.
    const parsed = MessageRecordSchema.parse({ ...MESSAGE, somethingNew: { nested: 1 } });
    expect(parsed['somethingNew']).toEqual({ nested: 1 });
  });

  it('still refuses a record whose required fields are missing or mistyped', () => {
    expect(MessageRecordSchema.safeParse({ ...MESSAGE, label: undefined }).success).toBe(false);
    expect(MessageRecordSchema.safeParse({ ...MESSAGE, id: 'msg_short' }).success).toBe(false);
    expect(MessageRecordSchema.safeParse({ ...MESSAGE, $v: 2 }).success).toBe(false);
    expect(MessageRecordSchema.safeParse({ ...MESSAGE, $type: 'memory' }).success).toBe(false);
    // A label with an unknown shape is refused, because `renderLabel` is ours: drift there is a
    // bug in this package rather than a domain object growing a field.
    expect(
      MessageRecordSchema.safeParse({ ...MESSAGE, label: { ...MESSAGE.label, extra: 1 } }).success,
    ).toBe(false);
  });

  it('refuses a null where a field is absent-or-present', () => {
    // `serialiseRecord` drops `undefined` and never writes `null`, so a `null` in an archive means
    // something upstream broke — a missing join row, most likely (`members.displayName`).
    expect(
      MemberRecordSchema.safeParse({ $type: 'member', $v: 1, displayName: null }).success,
    ).toBe(false);
  });
});

describe('the schema map', () => {
  it('has one entry per $type, keyed by it', () => {
    // The map is how a consumer dispatches, so a schema filed under the wrong key would send a
    // record to the wrong contract — and both would be wrong in a way neither test notices.
    for (const [type, schema] of Object.entries(ExportRecordSchemas)) {
      const parsed = schema.safeParse({ $type: type, $v: EXPORT_RECORD_VERSION });
      expect(parsed.success, `${type} alone is not a complete record`).toBe(false);
      const issues = parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join('.'));
      expect(issues, `${type}'s schema is filed under its own $type`).not.toContain('$type');
    }
  });
});
