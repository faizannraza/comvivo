/**
 * `DeclassApprover` — who authorised a declassification (`03` §3.4.2; `02` §3.3.2).
 *
 * `03` §1743 states the rule the column records: `approvedBy` is a set of member ids that
 * **includes every owner** of the source label, *or* the literal `'policy:GS'`.
 *
 * The literal arm is not a special case bolted on; it is the other way a declassification can be
 * legitimate. A group setting (`03`'s *group standard*) can pre-authorise a whole class of flows —
 * "relaying a parent's reply into the class group is fine" — so the declassification has no
 * individual approver and never had one. Collapsing that into an empty member list would make two
 * different facts look identical: "nobody approved this" and "the group approved this in advance".
 * I2 asks for a *recorded* declassification, and `'policy:GS'` is what that record says.
 *
 * Whether the member set actually covers the owners is `03`'s check at write time, not this
 * schema's: owners are a property of the label being declassified, which a column schema cannot
 * see. This bounds the shape; `03` §3.4.2 enforces the subset rule.
 */
import { capped, idSchema, type MemberId, z } from '@comvivo/shared';

/** The sentinel for a declassification pre-authorised by a group standard (`03` §3.4.2). */
export const POLICY_GROUP_STANDARD = 'policy:GS';

/**
 * How many individual approvers one declassification may record.
 *
 * Owners of a label are at most one owner plus `02` §3.3.2's 64 co-owners, so 65 is the ceiling a
 * legitimate "⊇ owners" set can reach. The bound exists so a malformed write cannot put an
 * unbounded array into a column `03`'s audit reader loads for every entry.
 */
export const DECLASS_APPROVERS_MAX = 65;

/** `02` §3.3.9: the `03`-owned JSON columns, this one included, are capped at 16 KiB. */
export const DECLASS_APPROVER_MAX_BYTES = 16 * 1024;

/** Who authorised a declassification: specific members, or the group standard. */
export type DeclassApprover = readonly MemberId[] | typeof POLICY_GROUP_STANDARD;

export const DeclassApproverSchema = capped(
  z.union([z.array(idSchema('mbr')).max(DECLASS_APPROVERS_MAX), z.literal(POLICY_GROUP_STANDARD)]),
  DECLASS_APPROVER_MAX_BYTES,
  'declassification approvers',
);
