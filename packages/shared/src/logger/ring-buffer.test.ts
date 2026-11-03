/**
 * The log ring buffer (`11` §3.10.1). It feeds `doctor --bundle`, so the properties that matter are
 * chronological order after a wrap and a hard memory bound.
 */
import { describe, expect, it } from 'vitest';
import { type BufferedLine, DEFAULT_CAPACITY, LogRingBuffer } from './ring-buffer.js';

const line = (n: number): BufferedLine => ({
  time: 1_700_000_000_000 + n,
  level: 'info',
  event: 'server.ready',
  msg: 'ready',
  fields: { count: n },
});

describe('capacity', () => {
  it('defaults to the 5,000 lines the spec names', () => {
    expect(DEFAULT_CAPACITY).toBe(5_000);
    expect(new LogRingBuffer().capacity).toBe(5_000);
  });

  it('rejects a nonsensical capacity rather than silently misbehaving', () => {
    expect(() => new LogRingBuffer(0)).toThrow(/positive integer/);
    expect(() => new LogRingBuffer(-1)).toThrow(/positive integer/);
    expect(() => new LogRingBuffer(1.5)).toThrow(/positive integer/);
  });

  it('never grows past its capacity, so a long-running instance has a bounded cost', () => {
    // `00` §7 budgets idle RSS at 300 MB and expects the product to run on a Raspberry Pi, so an
    // unbounded log buffer is a real failure mode rather than a theoretical one.
    const buffer = new LogRingBuffer(10);
    for (let i = 0; i < 1000; i += 1) buffer.push(line(i));
    expect(buffer.size).toBe(10);
  });
});

describe('order', () => {
  it('returns lines oldest first before wrapping', () => {
    const buffer = new LogRingBuffer(5);
    for (let i = 0; i < 3; i += 1) buffer.push(line(i));
    expect(buffer.toArray().map((l) => l.fields['count'])).toEqual([0, 1, 2]);
  });

  it('stays chronological after wrapping, which is the case that is easy to get wrong', () => {
    const buffer = new LogRingBuffer(5);
    for (let i = 0; i < 8; i += 1) buffer.push(line(i));
    expect(buffer.toArray().map((l) => l.fields['count'])).toEqual([3, 4, 5, 6, 7]);
  });

  it('stays chronological after wrapping many times', () => {
    const buffer = new LogRingBuffer(3);
    for (let i = 0; i < 100; i += 1) buffer.push(line(i));
    expect(buffer.toArray().map((l) => l.fields['count'])).toEqual([97, 98, 99]);
  });

  it('is chronological when exactly full', () => {
    const buffer = new LogRingBuffer(4);
    for (let i = 0; i < 4; i += 1) buffer.push(line(i));
    expect(buffer.toArray().map((l) => l.fields['count'])).toEqual([0, 1, 2, 3]);
  });
});

describe('accounting', () => {
  it('reports how many lines were lost, so a bundle reader knows what is missing', () => {
    const buffer = new LogRingBuffer(5);
    for (let i = 0; i < 12; i += 1) buffer.push(line(i));
    expect(buffer.totalWritten).toBe(12);
    expect(buffer.dropped).toBe(7);
  });

  it('reports nothing dropped before wrapping', () => {
    const buffer = new LogRingBuffer(5);
    buffer.push(line(0));
    expect(buffer.dropped).toBe(0);
  });
});

describe('recent', () => {
  it('returns the last n, oldest first', () => {
    const buffer = new LogRingBuffer(10);
    for (let i = 0; i < 10; i += 1) buffer.push(line(i));
    expect(buffer.recent(3).map((l) => l.fields['count'])).toEqual([7, 8, 9]);
  });

  it('returns everything when asked for exactly its size', () => {
    const buffer = new LogRingBuffer(10);
    for (let i = 0; i < 4; i += 1) buffer.push(line(i));
    expect(buffer.recent(4).map((l) => l.fields['count'])).toEqual([0, 1, 2, 3]);
  });

  it('returns everything when asked for more than it holds', () => {
    const buffer = new LogRingBuffer(10);
    buffer.push(line(0));
    expect(buffer.recent(50)).toHaveLength(1);
  });
});

describe('clear', () => {
  it('empties the buffer and resets the accounting', () => {
    const buffer = new LogRingBuffer(5);
    for (let i = 0; i < 7; i += 1) buffer.push(line(i));
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.totalWritten).toBe(0);
    expect(buffer.toArray()).toEqual([]);
  });

  it('works correctly after being cleared mid-wrap', () => {
    const buffer = new LogRingBuffer(3);
    for (let i = 0; i < 5; i += 1) buffer.push(line(i));
    buffer.clear();
    buffer.push(line(99));
    expect(buffer.toArray().map((l) => l.fields['count'])).toEqual([99]);
  });
});

describe('an empty buffer', () => {
  it('reports nothing rather than throwing', () => {
    const buffer = new LogRingBuffer(5);
    expect(buffer.size).toBe(0);
    expect(buffer.toArray()).toEqual([]);
    expect(buffer.recent(10)).toEqual([]);
  });
});
