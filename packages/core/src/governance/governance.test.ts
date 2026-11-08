/**
 * The `03`-owned JSON column schemas (`02` §3.3.6).
 */
import { describe, expect, it } from 'vitest';
import { ConfirmationResponseSchema, CopyRefSchema } from './confirmations.js';
import {
  CONSTRAINT_KINDS_V1,
  ConstraintScopeSchema,
  PrivateConstraintPolicySchema,
} from './constraints.js';
import { PolicyReasonSchema } from './policy.js';
import {
  AdoptedBySchema,
  BallotRefSchema,
  ProposalOutcomeSchema,
  ProposalRuleSchema,
} from './proposals.js';

const MEMBER = 'mbr_01jqw8z5h7e9r3t4y5v6k7p8q9';
const CONVERSATION = 'cnv_01jqw8z5h7e9r3t4y5v6k7p8q9';

describe('policy reasons (03 §1207)', () => {
  it('is a closed enum, so a stored reason is a token and not a sentence', () => {
    // `02` §3.3.9: audit details hold "ids/enums only, NEVER content". The user-facing sentence is
    // `DENY_COPY_EN`'s job.
    // The whole list, verbatim. `toHaveLength(26)` with four tokens named by hand was the
    // assertion, and these tokens are written into the hash-chained, append-only
    // `audit_events.decision` column — so renaming twenty-two of them would have kept the suite
    // green while making every historical audit row refer to a reason that no longer exists, and
    // the rows cannot be migrated. Found by the M1 independent review.
    expect(PolicyReasonSchema.options).toEqual([
      'wrong_group',
      'not_a_member',
      'member_inactive',
      'host_not_group_principal',
      'capability_missing',
      'floor_violation',
      'last_admin',
      'system_not_preauthorized',
      'proposal_not_passed',
      'deferred_intent_revoked',
      'flow_violation',
      'declassification_required',
      'cross_group',
      'untrusted_context',
      'untrusted_context_high_risk',
      'high_risk',
      'guardian_approval_required',
      'claimed_authorization',
      'owner_approval_required',
      'role_precedence',
      'contested_vote',
      'contested_consensus',
      'target_missing',
      'target_stale',
      'rate_limited',
      'plugin_not_approved',
    ]);
    expect(PolicyReasonSchema.safeParse('capability_missing').success).toBe(true);
    expect(PolicyReasonSchema.safeParse('because the model said so').success).toBe(false);
  });

  it('includes the three untrusted-context reasons I3 depends on', () => {
    for (const reason of ['untrusted_context', 'untrusted_context_high_risk', 'high_risk']) {
      expect(PolicyReasonSchema.options, reason).toContain(reason);
    }
  });
});

describe('proposals (03 §3.3.6)', () => {
  const rule = {
    method: 'vote' as const,
    quorum: 3,
    threshold: { ratio: 0.5, cmp: 'gt' as const },
    deadline: '2026-11-20T12:00:00Z',
    minOpenUntil: '2026-11-14T12:00:00Z',
    tieBreak: 'status_quo' as const,
    ballot: 'secret' as const,
  };

  it('freezes the rule with both a deadline and a minimum open window', () => {
    // `minOpenUntil` is the anti-ambush field: a proposal cannot pass the moment enough votes
    // arrive if the group has not had time to notice it exists.
    expect(ProposalRuleSchema.parse(rule)).toEqual(rule);
  });

  it('bounds the threshold ratio to 0..1', () => {
    expect(
      ProposalRuleSchema.safeParse({ ...rule, threshold: { ratio: 1.5, cmp: 'gt' } }).success,
    ).toBe(false);
  });

  it('refuses a method it does not know', () => {
    expect(ProposalRuleSchema.safeParse({ ...rule, method: 'acclamation' }).success).toBe(false);
  });

  it('keeps no_quorum and needs_admin_tiebreak distinct from rejected', () => {
    // Each asks for different follow-up, and neither means the group said no.
    const base = { yes: 2, no: 1, abstain: 0, eligible: 9, decidedEarly: false };
    for (const outcome of ['pending', 'passed', 'rejected', 'no_quorum', 'needs_admin_tiebreak']) {
      expect(ProposalOutcomeSchema.safeParse({ ...base, outcome }).success, outcome).toBe(true);
    }
    expect(ProposalOutcomeSchema.safeParse({ ...base, outcome: 'maybe' }).success).toBe(false);
  });

  it('refuses a negative tally', () => {
    expect(
      ProposalOutcomeSchema.safeParse({
        outcome: 'passed',
        yes: -1,
        no: 0,
        abstain: 0,
        eligible: 1,
        decidedEarly: false,
      }).success,
    ).toBe(false);
  });

  it('records where a ballot was conducted, not its results', () => {
    expect(BallotRefSchema.parse({ conversationId: CONVERSATION })).toEqual({
      conversationId: CONVERSATION,
    });
  });

  it('lets the system adopt a constitution, as well as members', () => {
    // `template`, `migration` and `placeholder` adoptions have no member behind them.
    expect(AdoptedBySchema.parse('system')).toBe('system');
    expect(AdoptedBySchema.parse([MEMBER])).toEqual([MEMBER]);
    expect(AdoptedBySchema.safeParse('admin').success).toBe(false);
  });
});

describe('private constraints (03 §3.5)', () => {
  it('lists 03 §3.5.4s thirteen catalog kinds', () => {
    // Verbatim, not a count plus four spot-checks. This is a **versioned closed catalog** — the
    // `_V1` is the promise — so a kind renamed without a version bump silently invalidates every
    // stored constraint of that kind, and a member's "do not schedule me" stops applying with no
    // error anywhere.
    expect(CONSTRAINT_KINDS_V1).toEqual([
      'availability.busy',
      'schedule.do_not_schedule',
      'tasks.do_not_assign',
      'capacity.reduced',
      'needs.dietary',
      'needs.accessibility',
      'preference.flag',
      'budget.cap',
      'location.granularity',
      'awareness',
      'secrecy.surprise',
      'content.age_appropriate',
      'topic.avoid',
    ]);
  });

  it('keeps paused separate from every kind being never', () => {
    // Pausing and resuming must not destroy the per-kind choices a member made.
    const policy = {
      memberId: MEMBER,
      version: 1,
      kinds: {
        'availability.busy': {
          mode: 'always' as const,
          maxSourceSensitivity: 'sensitive' as const,
          defaultAttribution: 'unattributed' as const,
          defaultReason: 'none' as const,
        },
      },
      allowStandingForSensitive: false,
      approvalTtlHours: 72,
      paused: true,
    };
    const parsed = PrivateConstraintPolicySchema.parse(policy);
    expect(parsed.paused).toBe(true);
    expect(parsed.kinds['availability.busy']?.mode).toBe('always');
  });

  it('bounds the approval TTL to two weeks of hours', () => {
    const base = {
      memberId: MEMBER,
      version: 1,
      kinds: {},
      allowStandingForSensitive: false,
      approvalTtlHours: 72,
      paused: false,
    };
    expect(
      PrivateConstraintPolicySchema.safeParse({ ...base, approvalTtlHours: 337 }).success,
    ).toBe(false);
    expect(PrivateConstraintPolicySchema.safeParse({ ...base, approvalTtlHours: 0 }).success).toBe(
      false,
    );
  });

  it('refuses a kind outside the catalog', () => {
    expect(
      PrivateConstraintPolicySchema.safeParse({
        memberId: MEMBER,
        version: 1,
        kinds: { 'mood.grumpy': { mode: 'ask' } },
        allowStandingForSensitive: false,
        approvalTtlHours: 72,
        paused: false,
      }).success,
    ).toBe(false);
  });

  it('scopes a constraint and canonicalises its zone', () => {
    const parsed = ConstraintScopeSchema.parse({
      conversationIds: [],
      categories: ['chores.bins'],
      zone: 'asia/karachi',
    });
    expect(parsed.zone).toBe('Asia/Karachi');
  });
});

describe('confirmations (03 §3.3.12)', () => {
  it('is a template key plus typed params, never a sentence', () => {
    // The one message asking a human to authorise something, so it must describe the action in the
    // product's words — a model-written summary is where injection would describe something else.
    const value = {
      key: 'confirm.calendar.delete',
      params: { title: 'Soccer practice', count: 3, recurring: true },
    };
    expect(CopyRefSchema.parse(value)).toEqual(value);
  });

  it('accepts an entity ref as a param, so a summary can link', () => {
    const value = {
      key: 'confirm.task.reassign',
      params: { task: { kind: 'task' as const, id: 'tsk_01jqw8z5h7e9r3t4y5v6k7p8q9' } },
    };
    expect(CopyRefSchema.parse(value)).toEqual(value);
  });

  it('refuses a key that is empty, and a param that is an arbitrary object', () => {
    expect(CopyRefSchema.safeParse({ key: '', params: {} }).success).toBe(false);
    expect(
      CopyRefSchema.safeParse({ key: 'k', params: { blob: { arbitrary: 'shape' } } }).success,
    ).toBe(false);
  });

  it('records how each response arrived', () => {
    const response = {
      memberId: MEMBER,
      option: 'approve' as const,
      via: 'button' as const,
      at: '2026-11-06T19:04:00Z',
    };
    expect(ConfirmationResponseSchema.parse(response)).toEqual(response);
    expect(ConfirmationResponseSchema.safeParse({ ...response, option: 'maybe' }).success).toBe(
      false,
    );
  });
});
