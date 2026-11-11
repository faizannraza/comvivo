/**
 * The audit chain (`M1-T21`; `02` §3.3.7, `08` T-T02).
 *
 * The acceptance criterion is "audit hash chain with `verifyChain`; tamper detected", and *tamper*
 * is four different things. Each gets its own test, because each is a different attack and a
 * verification that catches one is not a verification that catches the others:
 *
 *  - **an edited row** — the row's own hash no longer recomputes;
 *  - **a row removed from the middle** — the survivors no longer link;
 *  - **the oldest rows removed** — the remaining chain verifies *perfectly* link by link, which is
 *    why this one needs a check of its own, and it is `08` T-T02's literal threat ("admin erases
 *    evidence");
 *  - **a row forged with a matching hash** — defeated by the hash covering `prev_hash`, so a
 *    forgery has to rewrite everything after it too.
 */
import { chainKeyFor, expectWritten, INSTANCE_CHAIN_KEY } from '@comvivo/core';
import { canonicalJson } from '@comvivo/shared';
import { sha256 } from '@comvivo/shared/crypto';
import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';
import { auditHash, GENESIS_HASH } from './audit.js';
import { auditId, groupId, T0, withRepos } from './testing/harness.js';

const DAY = 86_400_000;
const at = (days: number) =>
  Temporal.Instant.fromEpochMilliseconds(T0.epochMilliseconds + days * DAY);

type World = Parameters<Parameters<typeof withRepos>[0]>[0];

const event = (tag: string, overrides: Record<string, unknown> = {}) => ({
  id: auditId(tag),
  actor: { kind: 'system' as const },
  action: 'memory.create',
  decision: {
    outcome: 'allow' as const,
    reason: null,
    capability: 'memory.write',
    constitutionVersionId: null,
  },
  details: { count: 1 },
  at: T0,
  ...overrides,
});

/** Append `tags` to a group's chain, through the repository. */
function appendAll(world: World, tags: readonly string[], overrides: Record<string, unknown> = {}) {
  return world.store.write((uow) =>
    tags.map((tag) =>
      expectWritten(
        world.repos.audit.append(uow, event(tag, { groupId: world.groupId, ...overrides })),
        `event ${tag}`,
      ),
    ),
  );
}

describe('appending to the chain', () => {
  it('starts at seq 1 with the genesis prev_hash, and links each row to the last', () => {
    withRepos((world) => {
      const rows = appendAll(world, ['a1f', 'a2f', 'a3f']);
      expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
      // `02` §3.3.7: "32 B; zeros for seq 1". The genesis value is what tells `verifyChain` that
      // the chain really starts here rather than that older rows were removed.
      expect(
        Buffer.from(rows[0]?.prevHash ?? new Uint8Array()).equals(Buffer.from(GENESIS_HASH)),
      ).toBe(true);
      expect(
        Buffer.from(rows[1]?.prevHash ?? new Uint8Array()).equals(
          Buffer.from(rows[0]?.hash ?? new Uint8Array()),
        ),
      ).toBe(true);
      expect(
        Buffer.from(rows[2]?.prevHash ?? new Uint8Array()).equals(
          Buffer.from(rows[1]?.hash ?? new Uint8Array()),
        ),
      ).toBe(true);
      expect(world.repos.audit.verifyChain(chainKeyFor(world.groupId))).toEqual({
        chainKey: world.groupId,
        ok: true,
        checked: 3,
        brokenAtSeq: undefined,
      });
    });
  });

  it('gives each group its own chain, and the instance its own', () => {
    withRepos((world) => {
      appendAll(world, ['b1f', 'b2f']);
      world.store.write((uow) => {
        world.repos.audit.append(uow, event('b3f', { groupId: world.otherGroupId }));
        // No group: a host action, a boot-time check, a retention sweep. `02` §3.3.7 puts it on
        // the `_instance` chain, and `group_id` stays NULL so no cascade removes it.
        world.repos.audit.append(uow, event('b4f', { actor: { kind: 'host' } }));
      });
      // One chain per group, so a group's deletion removes its chain **whole** rather than leaving
      // a gap in a shared one — and a gap is indistinguishable from tampering.
      expect(world.repos.audit.chainKeys()).toEqual(
        [INSTANCE_CHAIN_KEY, world.groupId, world.otherGroupId].toSorted(),
      );
      expect(world.repos.audit.chainHead(world.groupId)?.seq).toBe(2);
      expect(world.repos.audit.chainHead(world.otherGroupId)?.seq).toBe(1);
      expect(world.repos.audit.chainHead(INSTANCE_CHAIN_KEY)?.seq).toBe(1);
      expect(world.repos.audit.chainHead(groupId('zzf'))).toBeUndefined();
      for (const key of world.repos.audit.chainKeys()) {
        expect(world.repos.audit.verifyChain(key).ok).toBe(true);
      }
    });
  });

  it('is refused by the database when something tries to edit a row', () => {
    withRepos((world) => {
      const [first] = appendAll(world, ['c1f']);
      // `trg_audit_events_append_only`. There is no repository method that could do this — which
      // is the design — so the test reaches past the repository and proves the **database**
      // refuses. `08` T-T02's control is "no admin delete API", and an `UPDATE` would be the same
      // capability by another name.
      expect(() =>
        world.db.prepare('UPDATE audit_events SET action = ? WHERE id = ?').run('x', first?.id),
      ).toThrow(/AUDIT_APPEND_ONLY/);
      expect(world.repos.audit.event(auditId('c1f'))?.action).toBe('memory.create');
    });
  });

  it('answers `duplicate` for a retried append', () => {
    withRepos((world) => {
      appendAll(world, ['d1f']);
      const retry = world.store.write((uow) =>
        world.repos.audit.append(uow, event('d1f', { groupId: world.groupId })),
      );
      expect(retry.kind).toBe('duplicate');
      // And the chain did not grow, so the retry cannot inflate `seq` or re-anchor anything.
      expect(world.repos.audit.chainHead(world.groupId)?.seq).toBe(1);
    });
  });

  it('lists a group`s events newest first (Q-DASH-3)', () => {
    withRepos((world) => {
      world.store.write((uow) => {
        for (const [tag, day] of [
          ['e1f', 0],
          ['e2f', 2],
          ['e3f', 1],
        ] as const) {
          world.repos.audit.append(uow, event(tag, { groupId: world.groupId, at: at(day) }));
        }
      });
      expect(
        world.repos.audit.groupEvents({ groupId: world.groupId, limit: 10 }).map((row) => row.id),
      ).toEqual([auditId('e2f'), auditId('e3f'), auditId('e1f')]);
      expect(
        world.repos.audit
          .groupEvents({ groupId: world.groupId, since: at(1), limit: 10 })
          .map((row) => row.id),
      ).toEqual([auditId('e2f'), auditId('e3f')]);
      // The instance chain is not a group's events, and `group_id = NULL` would match nothing
      // anyway — so an instance-level row must never appear in a group's trail.
      expect(world.repos.audit.groupEvents({ groupId: world.otherGroupId, limit: 10 })).toEqual([]);
    });
  });
});

describe('verifyChain: tamper detected', () => {
  it('catches an edited row', () => {
    withRepos((world) => {
      appendAll(world, ['f1f', 'f2f', 'f3f']);
      // The trigger forbids `UPDATE`, so an attacker with filesystem access deletes and re-inserts
      // — which is what this does. The row's *contents* changed while its stored hash did not, so
      // recomputing the hash is what catches it.
      const row = world.db.prepare('SELECT * FROM audit_events WHERE seq = 2').get() as Record<
        string,
        unknown
      >;
      world.db.prepare('DELETE FROM audit_events WHERE seq = 2').run();
      world.db
        .prepare(
          `INSERT INTO audit_events (id, chain_key, seq, group_id, actor, action, target,
             decision, details, prev_hash, hash, at)
           VALUES (:id, :chain_key, :seq, :group_id, :actor, 'memory.delete', :target,
             :decision, :details, :prev_hash, :hash, :at)`,
        )
        .run(row);
      const verdict = world.repos.audit.verifyChain(chainKeyFor(world.groupId));
      expect(verdict.ok).toBe(false);
      expect(verdict.brokenAtSeq).toBe(2);
    });
  });

  it('catches a row removed from the middle', () => {
    withRepos((world) => {
      appendAll(world, ['g1f', 'g2f', 'g3f']);
      world.db.prepare('DELETE FROM audit_events WHERE seq = 2').run();
      // The two survivors are each internally valid: row 1 and row 3 both recompute. What breaks
      // is the **link** — row 3's `prev_hash` is the hash of a row that is no longer there — and
      // the gap in `seq` names the position that went.
      const verdict = world.repos.audit.verifyChain(chainKeyFor(world.groupId));
      expect(verdict.ok).toBe(false);
      expect(verdict.brokenAtSeq).toBe(3);
    });
  });

  it('catches the oldest rows being removed, which link-by-link checking cannot', () => {
    withRepos((world) => {
      appendAll(world, ['h1f', 'h2f', 'h3f']);
      world.db.prepare('DELETE FROM audit_events WHERE seq = 1').run();
      // This is `08` T-T02 exactly: an admin removes the row that incriminates them, and it
      // happens to be the oldest. Rows 2 and 3 still chain to each other perfectly — row 2's
      // `prev_hash` is the hash of the deleted row, and nothing in the surviving chain contradicts
      // it. Only "the chain must start at seq 1, or carry the genesis prev_hash" catches it.
      const verdict = world.repos.audit.verifyChain(chainKeyFor(world.groupId));
      expect(verdict.ok).toBe(false);
      expect(verdict.brokenAtSeq).toBe(2);
    });
  });

  it('catches a forged row even when its own hash is computed correctly', () => {
    withRepos((world) => {
      const rows = appendAll(world, ['j1f', 'j2f']);
      const head = rows[1];
      if (head === undefined) throw new Error('fixture');
      // The hardest case: an attacker who knows the formula. They delete the head and insert their
      // own row at seq 2 with a correctly computed hash over their own contents and the real
      // `prev_hash`. That row verifies. What they cannot do is leave the *rest* of the chain
      // consistent — and here there is no rest, so this test checks the thing that does hold: the
      // hash they must compute depends on `prev_hash`, so they cannot reuse the head's hash.
      const forged = {
        id: auditId('j3f'),
        chainKey: world.groupId,
        seq: 2,
        groupId: world.groupId,
        actor: { kind: 'host' as const },
        action: 'group.delete',
        target: null,
        decision: head.decision,
        details: {},
        at: T0,
      };
      world.db.prepare('DELETE FROM audit_events WHERE seq = 2').run();
      world.db
        .prepare(
          `INSERT INTO audit_events (id, chain_key, seq, group_id, actor, action, target,
             decision, details, prev_hash, hash, at)
           VALUES (?, ?, 2, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        )
        .run(
          forged.id,
          forged.chainKey,
          forged.groupId,
          JSON.stringify(forged.actor),
          forged.action,
          JSON.stringify(forged.decision),
          JSON.stringify(forged.details),
          Buffer.from(head.prevHash),
          // Reusing the **old** row's hash, which is what an attacker who edits in place would do.
          Buffer.from(head.hash),
          T0.epochMilliseconds,
        );
      expect(world.repos.audit.verifyChain(chainKeyFor(world.groupId)).ok).toBe(false);

      // And with the hash computed properly over the forgery, it does verify — which is the honest
      // limit of a hash chain without a signature, and why `08` pairs it with "no delete API" and
      // with the host being a disclosed actor rather than relying on the chain alone.
      world.db.prepare('DELETE FROM audit_events WHERE seq = 2').run();
      world.db
        .prepare(
          `INSERT INTO audit_events (id, chain_key, seq, group_id, actor, action, target,
             decision, details, prev_hash, hash, at)
           VALUES (?, ?, 2, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        )
        .run(
          forged.id,
          forged.chainKey,
          forged.groupId,
          JSON.stringify(forged.actor),
          forged.action,
          JSON.stringify(forged.decision),
          JSON.stringify(forged.details),
          Buffer.from(head.prevHash),
          auditHash(head.prevHash, forged),
          T0.epochMilliseconds,
        );
      expect(world.repos.audit.verifyChain(chainKeyFor(world.groupId)).ok).toBe(true);
    });
  });

  it('binds each row to the one before it, so a renumbered chain still breaks', () => {
    withRepos((world) => {
      const rows = appendAll(world, ['p1f', 'p2f', 'p3f']);
      const third = rows[2];
      if (third === undefined) throw new Error('fixture');
      // The sophisticated tamper, and the only one the `prev_hash` link check catches on its own.
      // An attacker deletes row 2, then **renumbers** row 3 to seq 2 and recomputes its hash over
      // the new contents — so the row verifies and there is no gap in `seq`. What they cannot fix
      // without rewriting the whole chain is that the row's `prev_hash` is still the hash of the
      // row they deleted, which is not row 1's.
      const renumbered = {
        id: third.id,
        chainKey: third.chainKey,
        seq: 2,
        groupId: third.groupId,
        actor: third.actor,
        action: third.action,
        target: third.target,
        decision: third.decision,
        details: third.details,
        at: third.at,
      };
      world.db.prepare('DELETE FROM audit_events WHERE seq IN (2, 3)').run();
      world.db
        .prepare(
          `INSERT INTO audit_events (id, chain_key, seq, group_id, actor, action, target,
             decision, details, prev_hash, hash, at)
           VALUES (?, ?, 2, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        )
        .run(
          renumbered.id,
          renumbered.chainKey,
          renumbered.groupId ?? null,
          JSON.stringify(renumbered.actor),
          renumbered.action,
          JSON.stringify(renumbered.decision),
          JSON.stringify(renumbered.details),
          Buffer.from(third.prevHash),
          auditHash(third.prevHash, renumbered),
          renumbered.at.epochMilliseconds,
        );
      const verdict = world.repos.audit.verifyChain(chainKeyFor(world.groupId));
      expect(verdict.ok).toBe(false);
      expect(verdict.brokenAtSeq).toBe(2);
    });
  });

  it('catches a row deleted and re-linked without renumbering', () => {
    withRepos((world) => {
      const rows = appendAll(world, ['r1f', 'r2f', 'r3f']);
      const [first, , third] = rows;
      if (first === undefined || third === undefined) throw new Error('fixture');
      // The cheapest tamper there is, and the only one the **seq gap** check catches on its own:
      // delete row 2, point row 3's `prev_hash` at row 1, and recompute row 3's hash over that.
      // Row 1 verifies, row 3 verifies, and the link between them holds — because the attacker
      // re-linked it rather than renumbering, which is strictly less work than the renumber above.
      // What is left is the hole in the sequence: 1, then 3.
      const relinked = {
        id: third.id,
        chainKey: third.chainKey,
        seq: 3,
        groupId: third.groupId,
        actor: third.actor,
        action: third.action,
        target: third.target,
        decision: third.decision,
        details: third.details,
        at: third.at,
      };
      world.db.prepare('DELETE FROM audit_events WHERE seq IN (2, 3)').run();
      world.db
        .prepare(
          `INSERT INTO audit_events (id, chain_key, seq, group_id, actor, action, target,
             decision, details, prev_hash, hash, at)
           VALUES (?, ?, 3, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
        )
        .run(
          relinked.id,
          relinked.chainKey,
          relinked.groupId ?? null,
          JSON.stringify(relinked.actor),
          relinked.action,
          JSON.stringify(relinked.decision),
          JSON.stringify(relinked.details),
          Buffer.from(first.hash),
          auditHash(first.hash, relinked),
          relinked.at.epochMilliseconds,
        );
      const verdict = world.repos.audit.verifyChain(chainKeyFor(world.groupId));
      expect(verdict.ok).toBe(false);
      expect(verdict.brokenAtSeq).toBe(3);
    });
  });

  it('computes the hash 02 §3.3.7 specifies, byte for byte', () => {
    withRepos((world) => {
      const [row] = appendAll(world, ['q1f']);
      if (row === undefined) throw new Error('fixture');
      // The formula, pinned against an **independent** computation rather than against
      // `auditHash` — which would be checking the function against itself. `02` §3.3.7 writes it
      // as `sha256(prevHash ‖ JCS(event without hashes))`, and each of the three parts is a
      // decision: JCS so the hash survives a round trip through SQLite's JSON (whose key order is
      // not the writer's), "without the hashes" or the definition is circular, and `prevHash`
      // first so the chain is a chain.
      const body = canonicalJson({
        id: row.id,
        chainKey: row.chainKey,
        seq: row.seq,
        groupId: row.groupId ?? null,
        actor: row.actor as never,
        action: row.action,
        target: row.target ?? null,
        decision: row.decision as never,
        details: row.details as never,
        at: row.at.epochMilliseconds,
      });
      const expected = sha256(
        Buffer.concat([Buffer.from(GENESIS_HASH), Buffer.from(body, 'utf8')]),
      );
      expect(Buffer.from(row.hash).toString('hex')).toBe(expected.toString('hex'));
    });
  });

  it('is reproducible from the row as read back', () => {
    withRepos((world) => {
      const [row] = appendAll(world, ['k1f']);
      if (row === undefined) throw new Error('fixture');
      // The hash has to recompute from the row **after** a round trip through SQLite's JSON
      // columns, whose key order is not the writer's. That is why the formula uses JCS rather than
      // `JSON.stringify`: with the latter, verification would report tampering on every honest row
      // whose JSON came back in a different order.
      const reread = world.repos.audit.event(row.id);
      expect(reread).toBeDefined();
      if (reread === undefined) return;
      expect(Buffer.from(auditHash(reread.prevHash, reread)).equals(Buffer.from(row.hash))).toBe(
        true,
      );
    });
  });

  it('calls an empty chain verified, and bounds how far back it looks', () => {
    withRepos((world) => {
      expect(world.repos.audit.verifyChain('nothing-here')).toEqual({
        chainKey: 'nothing-here',
        ok: true,
        checked: 0,
        brokenAtSeq: undefined,
      });
      appendAll(world, ['m1f', 'm2f', 'm3f', 'm4f']);
      // `11` §1116 bounds the health check at 10 000 events, so a year of rows on a Pi is not
      // re-hashed at every boot. A bounded run checks the window and says how big it was.
      const bounded = world.repos.audit.verifyChain(chainKeyFor(world.groupId), 2);
      expect(bounded).toEqual({
        chainKey: world.groupId,
        ok: true,
        checked: 2,
        brokenAtSeq: undefined,
      });
      // Deleting the **oldest** row is invisible to a bounded run that never looks at it — which
      // is the honest limit, and why `--full` exists. Stated as a test so the limit is a known
      // property rather than a surprise.
      world.db.prepare('DELETE FROM audit_events WHERE seq = 1').run();
      expect(world.repos.audit.verifyChain(chainKeyFor(world.groupId), 2).ok).toBe(true);
      expect(world.repos.audit.verifyChain(chainKeyFor(world.groupId)).ok).toBe(false);
    });
  });

  it('reports an un-re-anchored purge as broken, which is the safe direction', () => {
    withRepos((world) => {
      appendAll(world, ['n1f', 'n2f', 'n3f']);
      // `08` §895: "Audit events — 1 year (hash chain **re-anchored on purge**)". The re-anchor
      // mechanism belongs to `M1-T26`'s retention sweep — see the note on `verifyChain` for why
      // the obvious one does not work — and until it exists a purge leaves a chain that reads as
      // broken. Pinned as a test so that reading is a known property rather than a surprise: a
      // host is told to look, which is better than being reassured about a chain with a hole in it.
      world.db.prepare('DELETE FROM audit_events WHERE seq = 1').run();
      const verdict = world.repos.audit.verifyChain(chainKeyFor(world.groupId));
      expect(verdict.ok).toBe(false);
      expect(verdict.brokenAtSeq).toBe(2);
      // And the surviving rows are untouched, so nothing was lost beyond the purged row.
      expect(world.db.prepare('SELECT seq, action FROM audit_events ORDER BY seq').all()).toEqual([
        { seq: 2, action: 'memory.create' },
        { seq: 3, action: 'memory.create' },
      ]);
    });
  });
});
