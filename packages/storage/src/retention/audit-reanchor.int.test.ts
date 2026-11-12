/**
 * The audit chain's re-anchor (`M1-T26`; `08` §3.16.2, `02` §3.3.7, `08` T-T02).
 *
 * `M1-T21` left this as a recorded follow-up with the reasoning already written down: a retention
 * purge of the oldest audit rows leaves a chain that verifies perfectly from its new first row
 * onwards, because the survivors all link to each other — and `verifyChain`'s start-of-chain check
 * therefore reports it as broken, which is the safe direction but makes the purge unusable.
 *
 * The mechanism is a reserved event. Before any row is removed, an `audit.reanchor` event is
 * appended at the chain's **head**, carrying `through` (the highest `seq` removed) and
 * `throughHash` (that row's hash). `verifyChain` then accepts a first row whose `prev_hash` a
 * re-anchor vouches for, and nothing else.
 *
 * ## What this can and cannot defend against
 *
 * `08` T-T02's threat is "admin erases evidence", and against someone with write access to the
 * decrypted database no hash chain can prevent anything — they can rewrite every row. What a chain
 * gives is *detection*, and the re-anchor has to preserve it rather than open a hole. It does, in
 * three ways this suite checks one at a time:
 *
 *  - A prefix removed **without** a re-anchor still reads as broken.
 *  - A row removed from the **middle** still reads as broken, re-anchor or not: a re-anchor only
 *    ever vouches for a prefix, and the rows either side of a gap no longer link.
 *  - The re-anchor itself is chained, so it cannot be back-dated or inserted after the fact without
 *    breaking every row written after it.
 *
 * So an attacker who deletes a prefix is left holding a permanent, tamper-evident record saying
 * they did. That is strictly more than a chain that merely reads as broken, and it is the most a
 * hash chain can offer.
 */
import { AUDIT_REANCHOR_ACTION, expectWritten } from '@comvivo/core';
import { defaultConfig } from '@comvivo/shared';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  auditId,
  silentLogger,
  T0,
  type World,
  withRepos,
  withReposAsync,
} from '../repos/testing/harness.js';
import { RetentionSweep } from './sweep.js';
import { retentionWindowsFrom } from './windows.js';

/** A host who set `08` §3.16.2's one-year ceiling. */
const WITH_CEILING = retentionWindowsFrom({
  ...defaultConfig(),
  privacy: { ...defaultConfig().privacy, auditRetentionDays: 365 },
});

/** Append `count` events to the instance chain, `days` old. */
function appendOld(world: World, count: number, days: number, prefix = 'ra'): void {
  world.store.write((uow) => {
    for (let index = 1; index <= count; index += 1) {
      expectWritten(
        world.repos.audit.append(uow, {
          id: auditId(`${prefix}${index}`),
          actor: { kind: 'system' },
          action: 'test.event',
          decision: {
            outcome: 'allow',
            reason: null,
            capability: null,
            constitutionVersionId: null,
          },
          details: { n: index },
          at: T0.subtract({ hours: 24 * days }),
        }),
        `event ${String(index)}`,
      );
    }
  });
}

function sweepOf(world: World): RetentionSweep {
  return new RetentionSweep({
    store: world.store,
    db: world.drizzle,
    connection: world.db,
    logger: silentLogger,
    chunkRows: 3,
  });
}

function seqs(world: World): readonly number[] {
  return world.drizzle
    .all<{ seq: number; action: string }>(
      sql`SELECT seq, action FROM audit_events WHERE chain_key = '_instance' ORDER BY seq`,
    )
    .map((row) => row.seq);
}

function actions(world: World): readonly string[] {
  return world.drizzle
    .all<{ action: string }>(
      sql`SELECT action FROM audit_events WHERE chain_key = '_instance' ORDER BY seq`,
    )
    .map((row) => row.action);
}

describe('reanchorBefore (08 §3.16.2)', () => {
  it('does nothing at all without a configured ceiling', async () => {
    await withReposAsync(async (world) => {
      appendOld(world, 5, 400);
      // `02` §3.13.1's default is forever, and that is the resolution of its conflict with `08`
      // §3.16.2: an audit row is ids, enums and counts, so deleting it buys no privacy and costs
      // the accountability the chain exists for.
      const result = await sweepOf(world).run(T0, retentionWindowsFrom(defaultConfig()));
      expect(result.deleted['audit_events']).toBeUndefined();
      expect(seqs(world)).toEqual([1, 2, 3, 4, 5]);
    });
  });

  it('removes the oldest rows, writes one re-anchor, and still verifies', async () => {
    await withReposAsync(async (world) => {
      appendOld(world, 5, 400);
      appendOld(world, 3, 1, 'rb');
      expect(world.repos.audit.verifyChain('_instance').ok).toBe(true);

      const result = await sweepOf(world).run(T0, WITH_CEILING);

      // Three per chunk, so the five old rows go as 3 + 2, and each pass writes its own re-anchor.
      expect(result.deleted['audit_events']).toBe(5);
      expect(actions(world).filter((a) => a === AUDIT_REANCHOR_ACTION).length).toBeGreaterThan(0);
      // The chain starts at `seq` 6 now, and verification accepts it — which it must not do for
      // any other reason than a re-anchor vouching for row 5's hash.
      expect(seqs(world)[0]).toBe(6);
      expect(world.repos.audit.verifyChain('_instance').ok).toBe(true);
    });
  });

  it('never deletes a re-anchor, even one inside the deletable window', () => {
    withRepos((world) => {
      appendOld(world, 4, 1);
      const reanchor = (tag: string, limit: number) =>
        world.store.write((uow) =>
          world.repos.audit.reanchorBefore(uow, {
            chainKey: '_instance',
            // **After** the re-anchor rows' own `at`, so they are inside the window by time and
            // only the action exclusion keeps them. Aging the rows instead would have meant
            // rewriting `at`, which the hash covers — so that version of this test broke every
            // hash and failed for the wrong reason.
            before: T0.add({ hours: 1 }),
            limit,
            id: auditId(tag),
            actor: { kind: 'system' },
            at: T0,
          }),
        );
      expect(reanchor('rax', 2)).toBe(2);
      expect(reanchor('ray', 10)).toBe(2);

      // Only re-anchors left, and a third pass takes none of them: deleting row *n* while row
      // *n+1* exists breaks the link in the middle of the chain, which is indistinguishable from
      // tampering. That is the standing cost of `08` §3.16.2's ceiling — a few hundred rows a year.
      expect(actions(world)).toEqual([AUDIT_REANCHOR_ACTION, AUDIT_REANCHOR_ACTION]);
      expect(reanchor('raq', 10)).toBe(0);
      expect(actions(world)).toHaveLength(2);
      expect(world.repos.audit.verifyChain('_instance').ok).toBe(true);
    });
  });

  it('takes an earlier re-anchor it passes over, and still verifies', () => {
    withRepos((world) => {
      appendOld(world, 4, 1);
      const reanchor = (tag: string, limit: number) =>
        world.store.write((uow) =>
          world.repos.audit.reanchorBefore(uow, {
            chainKey: '_instance',
            before: T0.add({ hours: 1 }),
            limit,
            id: auditId(tag),
            actor: { kind: 'system' },
            at: T0,
          }),
        );
      expect(reanchor('rbw', 2)).toBe(2);
      expect(world.repos.audit.verifyChain('_instance').ok).toBe(true);

      // Two more real events, then a purge whose `through` is **past** the first re-anchor's seq.
      // This is the case that found the bug: excluding re-anchors from the delete as well as from
      // the select left the first one stranded at seq 5 above a deleted row 4, vouched for by
      // nothing — a chain reading as tampered with after two entirely lawful purges.
      appendOld(world, 2, 1, 'rc');
      expect(reanchor('rbx', 10)).toBe(4);

      // One re-anchor left: the newest, whose `through` subsumes the earlier claim. The chain
      // verifies, which is the property that matters — `08` T-T02's control is detection, and a
      // chain that reads as broken after a lawful purge destroys it just as surely as one that
      // reads as fine after an unlawful one.
      expect(actions(world)).toEqual([AUDIT_REANCHOR_ACTION]);
      expect(world.repos.audit.verifyChain('_instance').ok).toBe(true);
      // And a third pass takes nothing: the select excludes re-anchors, so a chain of nothing but
      // re-anchors is stable rather than eating itself one row per pass.
      expect(reanchor('rbq', 10)).toBe(0);
      expect(actions(world)).toEqual([AUDIT_REANCHOR_ACTION]);
    });
  });

  it('reduces a fully expired chain to its re-anchors, which still verify', async () => {
    await withReposAsync(async (world) => {
      // Every row outside the window. There is no "keep one row" guard, deliberately: it would
      // hold back a row the host's ceiling says to remove. The re-anchor is appended before the
      // delete, so its own `prev_hash` is the hash of the last row removed and it vouches for
      // itself — which is exactly the legitimate shape, and an attacker gains nothing from it
      // because they still have to leave the record behind.
      appendOld(world, 4, 400);
      await sweepOf(world).run(T0, WITH_CEILING);

      expect(actions(world).every((action) => action === AUDIT_REANCHOR_ACTION)).toBe(true);
      expect(actions(world).length).toBeGreaterThan(0);
      expect(world.repos.audit.verifyChain('_instance').ok).toBe(true);
    });
  });
});

describe('verifyChain after a re-anchor (08 T-T02)', () => {
  it('refuses a prefix removed without one', () => {
    withRepos((world) => {
      appendOld(world, 5, 1);
      expect(world.repos.audit.verifyChain('_instance').ok).toBe(true);

      // The attack: delete the oldest rows and leave no record. Every surviving row links to the
      // next, so a link-by-link verification sees nothing wrong — the start-of-chain check is the
      // only thing that catches it, and the re-anchor must not have weakened it.
      world.drizzle.run(sql`DELETE FROM audit_events WHERE seq <= 2`);
      const verdict = world.repos.audit.verifyChain('_instance');
      expect(verdict.ok).toBe(false);
      expect(verdict.brokenAtSeq).toBe(3);
    });
  });

  it('refuses a re-anchor that vouches for the wrong hash', () => {
    withRepos((world) => {
      appendOld(world, 5, 1);
      // A **legitimately hashed** forgery: appended through `append`, so its own hash is correct
      // and `brokenLink` has nothing to say about it. Only `#startsCorrectly` can reject it.
      //
      // The first version of this test edited `details` with `json_set` instead, and passed for
      // the wrong reason: `details` is part of the hashed form, so the edit broke the row's own
      // hash and verification failed on *that* — the mutation that removes the hash comparison
      // from the start check survived it. Forging through `append` is the only way to isolate the
      // check being tested.
      world.store.write((uow) =>
        expectWritten(
          world.repos.audit.append(uow, {
            id: auditId('rax'),
            actor: { kind: 'system' },
            action: AUDIT_REANCHOR_ACTION,
            decision: {
              outcome: 'not_applicable',
              reason: null,
              capability: null,
              constitutionVersionId: null,
            },
            details: { chainKey: '_instance', through: 2, throughHash: '0'.repeat(64), removed: 2 },
            at: T0,
          }),
          'the forged re-anchor',
        ),
      );
      world.drizzle.run(sql`DELETE FROM audit_events WHERE seq <= 2`);

      const verdict = world.repos.audit.verifyChain('_instance');
      expect(verdict.ok).toBe(false);
      expect(verdict.brokenAtSeq).toBe(3);
    });
  });

  it('refuses a re-anchor that vouches for the wrong position', () => {
    withRepos((world) => {
      appendOld(world, 5, 1);
      const hashOfTwo = world.drizzle.all<{ hash: Buffer }>(
        sql`SELECT hash FROM audit_events WHERE chain_key = '_instance' AND seq = 2`,
      )[0]?.hash;
      expect(hashOfTwo).toBeDefined();

      // **The right hash at the wrong position.** The surviving first row will be `seq` 3, whose
      // `prev_hash` is the hash of row 2 — so this forgery's `throughHash` matches exactly, and
      // only its `through` is wrong. That isolation is the point: an earlier version used a
      // mismatched hash *and* a wrong position, so dropping the position check from
      // `#startsCorrectly` still failed the test and the mutation survived.
      //
      // Why it must be refused: `through` is the claim about how many rows were taken. A
      // re-anchor admitting to one row while two are gone is an attacker understating what they
      // removed, and the record is the only thing a host has to go on.
      world.store.write((uow) =>
        expectWritten(
          world.repos.audit.append(uow, {
            id: auditId('ray'),
            actor: { kind: 'system' },
            action: AUDIT_REANCHOR_ACTION,
            decision: {
              outcome: 'not_applicable',
              reason: null,
              capability: null,
              constitutionVersionId: null,
            },
            details: {
              chainKey: '_instance',
              through: 1,
              throughHash: Buffer.from(hashOfTwo ?? Buffer.alloc(0)).toString('hex'),
              removed: 1,
            },
            at: T0,
          }),
          'the understated re-anchor',
        ),
      );
      world.drizzle.run(sql`DELETE FROM audit_events WHERE seq <= 2`);

      const verdict = world.repos.audit.verifyChain('_instance');
      expect(verdict.ok).toBe(false);
      expect(verdict.brokenAtSeq).toBe(3);
    });
  });

  it('still refuses a row removed from the middle', () => {
    withRepos((world) => {
      appendOld(world, 6, 1);
      world.store.write((uow) =>
        world.repos.audit.reanchorBefore(uow, {
          chainKey: '_instance',
          before: T0.add({ hours: 1 }),
          limit: 2,
          id: auditId('raz'),
          actor: { kind: 'system' },
          at: T0,
        }),
      );
      expect(world.repos.audit.verifyChain('_instance').ok).toBe(true);

      // A re-anchor only ever vouches for a *prefix*. Removing row 4 leaves rows 3 and 5 not
      // linking, which is what `brokenLink` catches and what no re-anchor can excuse.
      world.drizzle.run(sql`DELETE FROM audit_events WHERE seq = 4`);
      const verdict = world.repos.audit.verifyChain('_instance');
      expect(verdict.ok).toBe(false);
      expect(verdict.brokenAtSeq).toBe(5);
    });
  });

  it('writes the re-anchor before deleting, so a failure deletes nothing', () => {
    withRepos((world) => {
      appendOld(world, 4, 1);
      const before = seqs(world);
      // The append is first on purpose: if it could fail after the delete, the chain would be left
      // reading as tampered with no record of why. Here the id is one already used, so `append`
      // reports a duplicate and the method throws — and nothing may have been removed.
      expect(() =>
        world.store.write((uow) =>
          world.repos.audit.reanchorBefore(uow, {
            chainKey: '_instance',
            before: T0.add({ hours: 1 }),
            limit: 2,
            id: auditId('ra1'),
            actor: { kind: 'system' },
            at: T0,
          }),
        ),
      ).toThrow(/re-anchor event could not be appended/);
      expect(seqs(world)).toEqual(before);
    });
  });

  it('is a no-op for a chain already inside the window', () => {
    withRepos((world) => {
      appendOld(world, 3, 1);
      const removed = world.store.write((uow) =>
        world.repos.audit.reanchorBefore(uow, {
          chainKey: '_instance',
          before: T0.subtract({ hours: 48 }),
          limit: 10,
          id: auditId('ra9'),
          actor: { kind: 'system' },
          at: T0,
        }),
      );
      // Zero, and **no** re-anchor row: a sweep that wrote one on every pass would fill the chain
      // with records of having removed nothing.
      expect(removed).toBe(0);
      expect(actions(world)).toEqual(['test.event', 'test.event', 'test.event']);
    });
  });
});
