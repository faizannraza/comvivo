/**
 * An in-memory ring buffer of recent log lines, for `doctor --bundle`.
 *
 * `11` §3.10.1: the last 5,000 lines at `info` or above. `08` §3.10 and `09` §3.11.3 are the reason
 * it exists: when something goes wrong, a host needs to hand over recent history, and the
 * alternative — "turn on file logging and reproduce it" — asks them to hit the problem twice.
 *
 * It is capped and content-free by construction. The bundle is written locally for the host to
 * attach **manually**; it is never uploaded (ADR-017 is zero telemetry).
 */

export interface BufferedLine {
  /** Epoch milliseconds. */
  readonly time: number;
  readonly level: string;
  readonly event: string;
  readonly msg: string;
  /** The already-redacted, already-scrubbed field object as it was written. */
  readonly fields: Readonly<Record<string, unknown>>;
}

export const DEFAULT_CAPACITY = 5_000;

/**
 * A fixed-capacity ring. Overwrites the oldest entry rather than growing, so a long-running
 * instance has a bounded memory cost — which matters when `00` §7 budgets idle RSS at 300 MB and
 * the product is expected to run on a Raspberry Pi.
 */
export class LogRingBuffer {
  readonly capacity: number;
  #entries: (BufferedLine | undefined)[];
  #next = 0;
  #written = 0;

  constructor(capacity: number = DEFAULT_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        `ring buffer capacity must be a positive integer, got ${String(capacity)}`,
      );
    }
    this.capacity = capacity;
    this.#entries = new Array<BufferedLine | undefined>(capacity);
  }

  /** How many lines are currently held. */
  get size(): number {
    return Math.min(this.#written, this.capacity);
  }

  /** How many have ever been written, including those overwritten. Tells a reader what was lost. */
  get totalWritten(): number {
    return this.#written;
  }

  get dropped(): number {
    return Math.max(0, this.#written - this.capacity);
  }

  push(line: BufferedLine): void {
    this.#entries[this.#next] = line;
    this.#next = (this.#next + 1) % this.capacity;
    this.#written += 1;
  }

  /** Every held line, oldest first. */
  toArray(): BufferedLine[] {
    const out: BufferedLine[] = [];
    const count = this.size;
    // Walk back `count` places from the write cursor, so the result is chronological even when the
    // ring has wrapped.
    const start = (this.#next - count + this.capacity) % this.capacity;
    for (let i = 0; i < count; i += 1) {
      const entry = this.#entries[(start + i) % this.capacity];
      if (entry !== undefined) out.push(entry);
    }
    return out;
  }

  /** The most recent `n` lines, oldest first. */
  recent(n: number): BufferedLine[] {
    const all = this.toArray();
    return n >= all.length ? all : all.slice(all.length - n);
  }

  clear(): void {
    this.#entries = new Array<BufferedLine | undefined>(this.capacity);
    this.#next = 0;
    this.#written = 0;
  }
}
