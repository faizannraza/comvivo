/**
 * Record and replay (`06` §3.21.7; `11` §3.2.5; `M3-T11`).
 *
 * A run writes one JSONL line per inbound update and per outbound call; a replay feeds the inbound
 * half back. What that buys is `11` §3.2.5's cheap regression check: a simulated week driven by LLM
 * personas costs money and is not reproducible, so it is recorded once and **replayed open-loop**
 * against new code, where the model is the only thing that changed.
 *
 * ## `recordTo` takes a sink, not a path
 *
 * `06` §3.21.7 says `control.recordTo(path)`. This package may not import `node:*` (`01` §14 A11,
 * and a lint rule), and it should not: the browser demo in `13` *is* this simulator, and a path is
 * meaningless there. So the caller supplies twelve lines over whatever it has — `appendFileSync` in
 * a Node test, an array in a unit test, a download in the browser. The same argument `M3-T9` made
 * for `FixtureStore`, and amended in `06` §3.21.7 at `M3-T11`.
 *
 * ## Replay does not move the clock
 *
 * Each line carries the virtual millisecond it happened at, and replaying them *as fast as
 * possible* is not the same run: a message that arrived two minutes after the previous one tests
 * coalescing, and the same two messages back to back test cancellation. But the clock belongs to
 * whoever created it — `11` §3.2.2's `World.advance` has to **settle** Village between steps, which
 * the simulator cannot do because it has no view of the mailboxes or the outbox. So `replay` takes
 * an `advanceTo` callback and uses it when given one. Omitting it is a legitimate, documented
 * choice (the stimulus without the timing); silently replaying a week in one virtual millisecond
 * would not be.
 */
import { type SimCall, type SimRecordLine, SimRecordLineSchema, type SimUpdate } from './wire.js';

/** Where a recording goes. One line of JSON per call, newline-terminated by the writer. */
export interface SimRecordSink {
  write(line: string): void;
}

/** A sink that keeps the lines in memory, for a test and for the browser demo. */
export function arrayRecordSink(): { readonly sink: SimRecordSink; readonly lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    sink: {
      write(line) {
        lines.push(line);
      },
    },
  };
}

/**
 * Writes the lines.
 *
 * `seq` is the recorder's own counter rather than the ledger's, because a recording interleaves
 * two streams — updates in and calls out — and the order *between* them is the thing a replay has
 * to preserve. Two sequences could not express it.
 */
export class SimRecorder {
  #seq = 0;
  readonly #sink: SimRecordSink;

  constructor(sink: SimRecordSink) {
    this.#sink = sink;
  }

  inbound(update: SimUpdate, atMs: number): void {
    this.#emit({ dir: 'in', seq: this.#seq, atMs, update });
  }

  outbound(method: SimCall, args: unknown, atMs: number): void {
    this.#emit({ dir: 'out', seq: this.#seq, atMs, method, args });
  }

  #emit(line: SimRecordLine): void {
    this.#seq += 1;
    this.#sink.write(JSON.stringify(line));
  }
}

/** What a replay needs: somewhere to deliver updates, and optionally a way to move the clock. */
export interface ReplayTarget {
  deliver(update: unknown): Promise<void>;
}

export interface ReplayOptions {
  /**
   * Move the virtual clock to `atMs` (milliseconds since the platform was created) and settle.
   *
   * Supplied by the harness, because settling is a property of Village and not of the platform.
   * Without it a recording replays as a burst, which is a different test — see the module header.
   */
  readonly advanceTo?: (atMs: number) => Promise<void>;
  /** Fail on a line the current schema rejects rather than skipping it. Defaults to true. */
  readonly strict?: boolean;
}

/**
 * Replay a recording's inbound half.
 *
 * The outbound lines are skipped on purpose: they are the *expectation*, and a replay that fed
 * them back would be asserting that the new code makes the same calls by making them itself. A
 * caller diffs `control.outbound()` against them afterwards.
 */
export async function replay(
  lines: readonly string[],
  target: ReplayTarget,
  options: ReplayOptions = {},
): Promise<{ readonly delivered: number; readonly skipped: number }> {
  const strict = options.strict ?? true;
  let delivered = 0;
  let skipped = 0;
  for (const raw of lines) {
    if (raw.trim().length === 0) continue;
    const parsed = SimRecordLineSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      if (strict) {
        throw new TypeError(
          `a recorded line does not match the current schema: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`,
        );
      }
      skipped += 1;
      continue;
    }
    if (parsed.data.dir !== 'in') continue;
    if (options.advanceTo !== undefined) await options.advanceTo(parsed.data.atMs);
    await target.deliver(parsed.data.update);
    delivered += 1;
  }
  return { delivered, skipped };
}
