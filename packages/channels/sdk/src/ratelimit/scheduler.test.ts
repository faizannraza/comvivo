/**
 * The waiting order (`06` §3.14; `M3-T7`).
 *
 * `06` §3.14 gives three rules in one sentence and the interesting assertions are about how they
 * **compose**, which is why `order()` returns the whole sequence rather than a head.
 *
 * The case that matters most is the one in the middle: round-robin across chats must not be allowed
 * to reorder a single chat's own messages (a reply arriving before the message it answers), and
 * FIFO within a chat must not be allowed to let one busy chat take the whole queue. The shape of
 * the interleaving is the only thing that says both held.
 */
import { describe, expect, it } from 'vitest';
import type { Priority } from '../contract.js';
import { FairQueue, priorityRank, type Waiter } from './scheduler.js';

interface Entry extends Waiter {
  readonly name: string;
}

/** A queue loaded from `lane:name` specs, in arrival order. */
function loaded(specs: readonly (readonly [string, string, Priority])[]): {
  queue: FairQueue<Entry>;
  entries: Map<string, Entry>;
} {
  const queue = new FairQueue<Entry>();
  const entries = new Map<string, Entry>();
  for (const [lane, name, priority] of specs) {
    const entry: Entry = { lane, name, priority, seq: queue.nextSeq() };
    queue.push(entry);
    entries.set(name, entry);
  }
  return { queue, entries };
}

const names = (queue: FairQueue<Entry>): readonly string[] =>
  queue.order().map((entry) => entry.name);

describe('priorityRank', () => {
  it('is 05 §3.5.1’s classes, interactive first', () => {
    expect(priorityRank('interactive')).toBeLessThan(priorityRank('scheduled'));
    expect(priorityRank('scheduled')).toBeLessThan(priorityRank('background'));
  });
});

describe('priority', () => {
  it('comes before everything else', () => {
    const { queue } = loaded([
      ['a', 'bg', 'background'],
      ['a', 'sched', 'scheduled'],
      ['a', 'inter', 'interactive'],
    ]);
    expect(names(queue)).toEqual(['inter', 'sched', 'bg']);
  });

  it('is why a backlog of digests does not delay a morning question', () => {
    // 40 queued digests and one reply. Without priority the reply is 41st, and the reply budget is
    // four seconds (`01` §11.10).
    const specs = Array.from(
      { length: 40 },
      (_, index) => [`chat${String(index)}`, `digest${String(index)}`, 'background'] as const,
    );
    const { queue } = loaded([...specs, ['chat0', 'reply', 'interactive']]);
    expect(names(queue)[0]).toBe('reply');
  });
});

describe('FIFO within a chat', () => {
  it('keeps one chat’s own messages in order', () => {
    // Reordering here is visible to a member: a reply arriving before the message it answers.
    const { queue } = loaded([
      ['a', 'first', 'scheduled'],
      ['a', 'second', 'scheduled'],
      ['a', 'third', 'scheduled'],
    ]);
    expect(names(queue)).toEqual(['first', 'second', 'third']);
  });
});

describe('round-robin across chats', () => {
  it('interleaves lanes rather than draining the first', () => {
    // A busy chat's waiters are mostly blocked on its own tight bucket. Served strictly FIFO, the
    // first of them blocks the head and every other chat waits behind a limit that is not theirs.
    const { queue } = loaded([
      ['a', 'a1', 'scheduled'],
      ['a', 'a2', 'scheduled'],
      ['a', 'a3', 'scheduled'],
      ['b', 'b1', 'scheduled'],
      ['c', 'c1', 'scheduled'],
    ]);
    expect(names(queue)).toEqual(['a1', 'b1', 'c1', 'a2', 'a3']);
  });

  it('orders lanes by the arrival of their first waiter, not by name', () => {
    // A lane has no identity beyond its name, and ordering by name would make a chat's share of the
    // bandwidth depend on its platform id.
    const { queue } = loaded([
      ['zzz', 'z1', 'scheduled'],
      ['aaa', 'a1', 'scheduled'],
    ]);
    expect(names(queue)).toEqual(['z1', 'a1']);
  });

  it('starts after the lane that was served last', () => {
    const { queue, entries } = loaded([
      ['a', 'a1', 'scheduled'],
      ['b', 'b1', 'scheduled'],
      ['c', 'c1', 'scheduled'],
    ]);
    const a1 = entries.get('a1');
    expect(a1).toBeDefined();
    if (a1 === undefined) return;
    queue.remove(a1);
    queue.served(a1);
    expect(names(queue)).toEqual(['b1', 'c1']);

    const b1 = entries.get('b1');
    if (b1 === undefined) return;
    queue.remove(b1);
    queue.served(b1);
    expect(names(queue)).toEqual(['c1']);
  });

  it('wraps the cursor round', () => {
    const { queue, entries } = loaded([
      ['a', 'a1', 'scheduled'],
      ['b', 'b1', 'scheduled'],
      ['a', 'a2', 'scheduled'],
    ]);
    const b1 = entries.get('b1');
    if (b1 === undefined) return;
    queue.remove(b1);
    queue.served(b1);
    // Served `b`, so the next pick starts after it and wraps to `a`.
    expect(names(queue)).toEqual(['a1', 'a2']);
  });

  it('ignores a cursor pointing at a lane that has emptied', () => {
    const { queue, entries } = loaded([
      ['a', 'a1', 'scheduled'],
      ['b', 'b1', 'scheduled'],
    ]);
    const a1 = entries.get('a1');
    if (a1 === undefined) return;
    queue.remove(a1);
    queue.served(a1);
    expect(names(queue)).toEqual(['b1']);
  });
});

describe('the cursor is per priority', () => {
  it('so low-priority traffic cannot decide the order of high-priority traffic', () => {
    // The served lane has to hold a waiter at *both* priorities for the two designs to differ,
    // which the first version of this test missed: with the background send in a lane of its own,
    // a shared cursor pointed at a lane the interactive group did not contain and `indexOf`
    // returned -1, so the rotation was a no-op and the drill passed.
    //
    // Here lane `a` carries a background send and an interactive one, and lane `b` carries an
    // interactive one. Serving `a`'s background send must not cost `a` its turn in the interactive
    // group: `interA` arrived before `interB` and goes first. A shared cursor would rotate past `a`
    // and serve `interB` — low-priority traffic deciding the order of high-priority traffic, which
    // is what priority exists to prevent.
    const { queue, entries } = loaded([
      ['a', 'bgA', 'background'],
      ['a', 'interA', 'interactive'],
      ['b', 'interB', 'interactive'],
    ]);
    const bgA = entries.get('bgA');
    if (bgA === undefined) return;
    queue.remove(bgA);
    queue.served(bgA);
    expect(names(queue)).toEqual(['interA', 'interB']);
  });
});

describe('bookkeeping', () => {
  it('reports its size and removes by identity', () => {
    const { queue, entries } = loaded([
      ['a', 'a1', 'scheduled'],
      ['a', 'a2', 'scheduled'],
    ]);
    expect(queue.size).toBe(2);
    const a1 = entries.get('a1');
    if (a1 === undefined) return;
    expect(queue.remove(a1)).toBe(true);
    expect(queue.remove(a1)).toBe(false);
    expect(queue.size).toBe(1);
  });

  it('hands out increasing arrival numbers', () => {
    const queue = new FairQueue<Entry>();
    expect([queue.nextSeq(), queue.nextSeq(), queue.nextSeq()]).toEqual([1, 2, 3]);
  });

  it('is empty when empty', () => {
    expect(new FairQueue<Entry>().order()).toEqual([]);
  });

  it('separates `remove` from `served`, so an aborted send does not cost its chat a turn', () => {
    // Two waiters in `a` and one in `b`, in that arrival order. When `a1` is **served**, lane `a`
    // has had its turn and `b` goes next. When `a1` is **aborted** it never had a turn, so `a`
    // keeps the front — otherwise a chat loses its place because somebody else's send was
    // cancelled, and the loss compounds for a chat whose sends are frequently superseded.
    const order = [
      ['a', 'a1', 'scheduled'],
      ['a', 'a2', 'scheduled'],
      ['b', 'b1', 'scheduled'],
    ] as const;

    const servedCase = loaded(order);
    const servedA1 = servedCase.entries.get('a1');
    if (servedA1 === undefined) return;
    servedCase.queue.remove(servedA1);
    servedCase.queue.served(servedA1);
    expect(names(servedCase.queue)).toEqual(['b1', 'a2']);

    const abortedCase = loaded(order);
    const abortedA1 = abortedCase.entries.get('a1');
    if (abortedA1 === undefined) return;
    abortedCase.queue.remove(abortedA1);
    expect(names(abortedCase.queue)).toEqual(['a2', 'b1']);
  });
});
