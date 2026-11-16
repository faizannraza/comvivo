/**
 * The waiting order (`06` §3.14; `M3-T7`).
 *
 * `06` §3.14, in one sentence: "Waiters are ordered by priority, then FIFO, with round-robin across
 * chats." Three rules, and each one exists because of a different way a group chat goes wrong.
 *
 * **Priority** (`05` §3.5.1's queue classes: `interactive`, `scheduled`, `background`). A member
 * who just asked a question is waiting in front of their phone. A nightly digest is not. Without
 * priority, a backlog of 40 queued digests at 7 a.m. puts every morning question behind them, and
 * the reply budget is four seconds.
 *
 * **Round-robin across chats.** Per-chat buckets are much tighter than global ones — Telegram
 * allows 20 messages a minute to a group against 25 a second overall — so a busy chat's waiters
 * spend most of their time blocked. Served strictly FIFO, the first of them blocks the head of the
 * queue and every other chat waits behind a bucket that has nothing to do with them. Interleaving
 * lanes is what makes "one noisy group" a local problem.
 *
 * **FIFO within a chat**, because a conversation's own messages have an order and reordering them
 * is visible: a reply arriving before the message it answers.
 *
 * ## Why the order is a value and not a comparator
 *
 * `order()` returns the whole sequence rather than just the head. The limiter needs it: a waiter
 * blocked on its own chat's bucket must not block a waiter in another chat, so the limiter walks
 * the order looking for the first entry that can actually pay — which means it needs to see past
 * the head. Exposing it also makes the three rules directly testable, which a comparator buried in
 * a `next()` would not be: the interesting cases are about the *shape* of the interleaving.
 */
import type { Priority } from '../contract.js';

/** Highest first. `05` §3.5.1's classes in the order the dispatcher serves them. */
const PRIORITY_ORDER: readonly Priority[] = ['interactive', 'scheduled', 'background'];

/** The rank of a priority, lower being served first. */
export function priorityRank(priority: Priority): number {
  return PRIORITY_ORDER.indexOf(priority);
}

export interface Waiter {
  readonly priority: Priority;
  /** The round-robin group — one chat (`06` §3.14). */
  readonly lane: string;
  /** Arrival order, for FIFO within a lane and for a stable lane order. */
  readonly seq: number;
}

/**
 * A queue ordered by priority, then round-robin across lanes, then FIFO.
 *
 * The round-robin cursor is **per priority**. A shared cursor would let a burst of `background`
 * work in lane A advance the cursor past lane B, so the next `interactive` waiter in B would be
 * served after one in C — low-priority traffic deciding the order of high-priority traffic, which
 * is the thing priority exists to prevent.
 */
export class FairQueue<T extends Waiter> {
  readonly #entries: T[] = [];
  readonly #cursors = new Map<Priority, string>();
  #nextSeq = 0;

  /** The next arrival number, so a caller can stamp its own entry. */
  nextSeq(): number {
    this.#nextSeq += 1;
    return this.#nextSeq;
  }

  get size(): number {
    return this.#entries.length;
  }

  push(entry: T): void {
    this.#entries.push(entry);
  }

  /** Drop one entry by identity. Returns whether it was there. */
  remove(entry: T): boolean {
    const at = this.#entries.indexOf(entry);
    if (at === -1) return false;
    this.#entries.splice(at, 1);
    return true;
  }

  /**
   * Record that `lane` was just served, so the next pick at that priority starts after it.
   *
   * Separate from `remove` because the limiter removes an aborted waiter without having served it,
   * and advancing the cursor then would hand the aborted lane's turn to the next lane — a chat
   * losing its place because somebody else's send was cancelled.
   */
  served(entry: T): void {
    this.#cursors.set(entry.priority, entry.lane);
  }

  /** Every waiter, in the order `06` §3.14 defines. */
  order(): readonly T[] {
    const out: T[] = [];
    for (const priority of PRIORITY_ORDER) {
      const group = this.#entries.filter((entry) => entry.priority === priority);
      if (group.length > 0) out.push(...interleave(group, this.#cursors.get(priority)));
    }
    return out;
  }
}

/**
 * One priority's waiters, interleaved across lanes starting after `cursor`.
 *
 * Lanes are ordered by the arrival of their **first** waiter, which is the only stable order
 * available — a lane has no identity beyond its name, and ordering by name would make a chat's
 * share of the bandwidth depend on its platform id. Rotating that order so the lane after the
 * cursor comes first is what turns "a stable order" into "a fair one".
 */
function interleave<T extends Waiter>(
  group: readonly T[],
  cursor: string | undefined,
): readonly T[] {
  const lanes = new Map<string, T[]>();
  for (const entry of [...group].sort((a, b) => a.seq - b.seq)) {
    const lane = lanes.get(entry.lane);
    if (lane === undefined) lanes.set(entry.lane, [entry]);
    else lane.push(entry);
  }
  const names = [...lanes.keys()];
  const at = cursor === undefined ? -1 : names.indexOf(cursor);
  const rotated = at === -1 ? names : [...names.slice(at + 1), ...names.slice(0, at + 1)];

  const out: T[] = [];
  const deepest = Math.max(...[...lanes.values()].map((queue) => queue.length));
  for (let round = 0; round < deepest; round += 1) {
    for (const name of rotated) {
      const entry = lanes.get(name)?.[round];
      if (entry !== undefined) out.push(entry);
    }
  }
  return out;
}
