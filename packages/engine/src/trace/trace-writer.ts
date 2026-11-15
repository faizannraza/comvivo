/**
 * The turn-trace writer (`05` §3.10.1; `11` §3.10.4; `M3-T20`).
 *
 * A turn's phases happen in different modules at different times — the router classifies, the
 * prompt builder assembles, the model is called once per step, tools run, the guard checks, the
 * output pipeline sends — and `turn_traces` holds **one row per turn**. So this is an accumulator
 * with one `write` at the end, inside the turn's own commit.
 *
 * ## What a trace is allowed to contain
 *
 * `05` §3.10.1 is titled "(manifests only)" and that is the whole design. A trace outlives the
 * turn by 30 days (`11` §3.10.4) and is readable by anyone its `label_id` admits, so **no field
 * here holds message text, a prompt, a model response, a memory or a tool argument**. Every
 * section is ids, enums, hashes and counts; `ContextManifest` is ids and interned label ids, which
 * is what lets `09`'s dashboard re-check `canRead` per item at render time and show one member a
 * trace it shows another differently.
 *
 * `noContent` in this module's test is the assertion, and it is written as a **scan of the
 * serialised row** rather than a review of the fields: a field added later with a plausible name
 * is exactly the way content gets into a trace, and a reviewer reading a diff would not see it.
 *
 * ## The debug capture is the exception, and it is fenced four ways
 *
 * `COMVIVO_DEBUG_CONTENT=1` additionally stores the rendered requests and responses. `05` §3.10.1
 * puts four fences round it and this module implements all four: the row only exists when the
 * host-only flag is on; it is **field-encrypted** under the `field` purpose key, bound by AAD to
 * its turn; it expires in **24 hours** rather than with the trace; and it is never exported. The
 * fifth fence is `03` §3.11's startup banner, which makes its existence visible to the group — it
 * is emitted here, once per process, because the condition that turns the capture on is the
 * condition that must announce it.
 */
import type {
  ContextManifest,
  Label,
  LatencyTrace,
  ModelCallTrace,
  NewTurnTrace,
  TraceBinding,
  TraceCost,
  TraceOutput,
  TracePrompt,
  TraceReplayMeta,
  TraceRouter,
  TxToken,
  WriteResult,
} from '@comvivo/core';
import type { ConversationId, GroupId, Logger, TurnId, TurnTraceId } from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';

/** `05` §3.10.1: the debug capture expires in 24 hours, whatever the trace's retention is. */
export const DEBUG_CAPTURE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Seal a debug payload (`08` §3.7.1's `wrap`, under the `field` purpose key).
 *
 * A one-function port rather than a key handed to the engine. `01` §4 keeps the engine on ports
 * and `apps/server` wires the implementation, which means the `field` key never enters this
 * package's reach — and the thing being protected is the most sensitive plaintext the product
 * holds, so "the engine cannot decrypt it either" is worth the indirection.
 *
 * **Synchronous**, because the write happens inside `store.write` and `02` D10 forbids an `await`
 * there. `wrap` is AES-256-GCM one-shot and sync; `sealBuffer`'s secretstream is not, and a
 * streaming construction buys nothing for a payload that is already in memory.
 */
export type SealDebugCapture = (turnId: TurnId, plaintext: Uint8Array) => Uint8Array;

/**
 * What the repository half of `02` §3.8 offers this writer. Narrowed to the two methods used.
 *
 * Structural rather than `TraceRepository` itself, so this module needs no import from
 * `packages/storage` — which `01` §4 forbids anyway — and so a test can supply a recording sink
 * without a database. `truncation` is `unknown` because its shape is the repository's and the
 * writer only asks "was anything dropped, and which columns".
 */
export interface TraceSink {
  writeTrace(
    uow: TxToken,
    trace: NewTurnTrace,
    label: Label,
  ): WriteResult<{ readonly trace: { readonly id: TurnTraceId }; readonly truncation: unknown }>;
  writeDebug(
    uow: TxToken,
    turnId: TurnId,
    ciphertext: Uint8Array,
    expiresAt: Temporal.Instant,
  ): WriteResult<TurnId>;
}

export interface TraceWriterOptions {
  readonly logger: Logger;
  /** `traces.retentionDays` (`11` §3.10.4: default 30, range 7–365). */
  readonly retentionDays: number;
  /**
   * `COMVIVO_DEBUG_CONTENT=1` (`08` §3.10's host-only key).
   *
   * Passed in rather than read from `process.env`, because `01` §14 A14 makes it host-only: a
   * value the database or the dashboard could set would be a way to turn content capture on
   * remotely, which is the one thing this flag must not be.
   */
  readonly debugContent: boolean;
  /** Required exactly when `debugContent` is on; see `TraceWriter`'s constructor. */
  readonly sealDebug?: SealDebugCapture | undefined;
}

/**
 * One turn's observations, collected as they happen.
 *
 * Mutable by design and **not** shared between turns: one instance per turn, created by the turn
 * engine (`M3-T24`) and discarded with it. A shared accumulator would attribute one turn's model
 * calls to another's trace, which is the kind of bug that makes an observability artefact worse
 * than none.
 */
export class TurnTraceDraft {
  readonly #modelCalls: ModelCallTrace[] = [];
  readonly #toolCalls: Record<string, unknown>[] = [];
  readonly #policyDecisions: Record<string, unknown>[] = [];
  readonly #guardResults: Record<string, unknown>[] = [];
  readonly #costByRoute = new Map<string, number>();
  #router: TraceRouter | undefined;
  #binding: TraceBinding | undefined;
  #prompt: TracePrompt | undefined;
  #output: TraceOutput | undefined;
  #debug: string | undefined;

  /** `05` §3.2's classification, from `M3-T21`. */
  router(router: TraceRouter): void {
    this.#router = router;
  }

  /** `05` §3.3's requester and audience — the **I3** record. */
  binding(binding: TraceBinding): void {
    this.#binding = binding;
  }

  /** `05` §3.4's prompt structure, from `M3-T19`. */
  prompt(prompt: TracePrompt): void {
    this.#prompt = prompt;
  }

  /** `05` §3.8's output shape, from `M3-T26`. Counts only. */
  output(output: TraceOutput): void {
    this.#output = output;
  }

  /**
   * One model call, and its cost.
   *
   * The cost is added here rather than summed at the end so that a truncated `modelCalls` list
   * still reports the whole spend: `02` §3.3.9's budget can drop the tail of the list, and a total
   * derived from what survived would under-report the turn in the direction that looks reassuring
   * on a cost dashboard (`01` §14 A32's argument, one layer up).
   */
  modelCall(call: ModelCallTrace, costMicros: number): void {
    this.#modelCalls.push(call);
    this.#costByRoute.set(call.route, (this.#costByRoute.get(call.route) ?? 0) + costMicros);
  }

  /** One tool call (`05` §3.6.3 step 10). The interior is `M3-T23`'s. */
  toolCall(call: Record<string, unknown>): void {
    this.#toolCalls.push(call);
  }

  /** One policy decision. The interior is `M4`'s (`03` §3.3). */
  policyDecision(decision: Record<string, unknown>): void {
    this.#policyDecisions.push(decision);
  }

  /** One guard result (`05` §3.8). The interior is `M5-T16`'s; **I5**'s `recordId` is in it. */
  guardResult(result: Record<string, unknown>): void {
    this.#guardResults.push(result);
  }

  /**
   * The rendered requests and responses, for `COMVIVO_DEBUG_CONTENT=1`.
   *
   * Accepted whether or not the flag is on, and **dropped** by the writer when it is off. That
   * ordering is deliberate: the alternative is every caller checking the flag before building the
   * payload, which is a check each of them can forget. Here the flag is consulted in exactly one
   * place.
   */
  debugCapture(rendered: string): void {
    this.#debug = rendered;
  }

  /** What `TraceWriter.write` needs. Not for callers: the fields are this class's own state. */
  snapshot(): {
    readonly router: TraceRouter | undefined;
    readonly binding: TraceBinding | undefined;
    readonly prompt: TracePrompt | undefined;
    readonly output: TraceOutput | undefined;
    readonly modelCalls: readonly ModelCallTrace[];
    readonly toolCalls: readonly Record<string, unknown>[];
    readonly policyDecisions: readonly Record<string, unknown>[];
    readonly guardResults: readonly Record<string, unknown>[];
    readonly costByRoute: TraceCost;
    readonly costMicros: number;
    readonly debug: string | undefined;
  } {
    const costByRoute = Object.fromEntries(this.#costByRoute);
    return {
      router: this.#router,
      binding: this.#binding,
      prompt: this.#prompt,
      output: this.#output,
      modelCalls: [...this.#modelCalls],
      toolCalls: [...this.#toolCalls],
      policyDecisions: [...this.#policyDecisions],
      guardResults: [...this.#guardResults],
      costByRoute,
      costMicros: Object.values(costByRoute).reduce((total, each) => total + each, 0),
      debug: this.#debug,
    };
  }
}

/** Everything the turn knows that the draft does not accumulate. */
export interface TraceContext {
  readonly id: TurnTraceId;
  readonly turnId: TurnId;
  readonly groupId: GroupId;
  readonly conversationId: ConversationId;
  readonly trigger: Record<string, unknown>;
  /** `02` §3.8's turn disposition: `replied`, `silent`, `failed`, … */
  readonly disposition: string;
  readonly contextManifest: ContextManifest;
  readonly latency: LatencyTrace;
  readonly replay: TraceReplayMeta;
  /** Who may read the trace. `03`/`09`: a trace is a datum like any other. */
  readonly label: Label;
}

/**
 * Writes one trace per turn, and the debug capture when the host asked for it.
 *
 * One instance per process, holding the retention setting and the seal. The per-turn state is in
 * `TurnTraceDraft`, which is what keeps this class free of any state a second turn could read.
 */
export class TraceWriter {
  readonly #logger: Logger;
  readonly #retentionDays: number;
  readonly #debugContent: boolean;
  readonly #sealDebug: SealDebugCapture | undefined;
  #bannerLogged = false;

  constructor(options: TraceWriterOptions) {
    this.#logger = options.logger.child({ component: 'trace' });
    if (!Number.isInteger(options.retentionDays) || options.retentionDays < 1) {
      throw new RangeError(
        `traces.retentionDays must be a positive integer, got ${String(options.retentionDays)}`,
      );
    }
    this.#retentionDays = options.retentionDays;
    this.#debugContent = options.debugContent;
    if (options.debugContent && options.sealDebug === undefined) {
      // Refused at construction rather than at the first capture. A writer that accepted the flag
      // without a seal would run normally until the first turn finished and then either drop the
      // capture the host turned on, or — worse, if written the obvious way — store it in the
      // clear. `08` §3.10 makes this flag host-only, so reaching it already took a deliberate act.
      throw new Error('debug content is on but no seal was provided; refusing to run unsealed');
    }
    this.#sealDebug = options.sealDebug;
  }

  /** A fresh accumulator for one turn. */
  draft(): TurnTraceDraft {
    return new TurnTraceDraft();
  }

  /**
   * Write the trace, and the debug row when the flag is on (`05` §3.10.1).
   *
   * In the caller's transaction, so a turn that rolled back leaves no trace of itself — which is
   * the honest outcome: `11`'s replay reads these rows as evidence that a turn ran.
   */
  write(
    uow: TxToken,
    sink: TraceSink,
    context: TraceContext,
    draft: TurnTraceDraft,
  ): WriteResult<{ readonly id: TurnTraceId }> {
    const observed = draft.snapshot();
    const trace: NewTurnTrace = {
      id: context.id,
      turnId: context.turnId,
      groupId: context.groupId,
      conversationId: context.conversationId,
      trigger: context.trigger,
      disposition: context.disposition,
      ...(observed.router === undefined ? {} : { router: observed.router }),
      ...(observed.binding === undefined ? {} : { binding: observed.binding }),
      ...(observed.prompt === undefined ? {} : { prompt: observed.prompt }),
      ...(observed.output === undefined ? {} : { output: observed.output }),
      contextManifest: context.contextManifest,
      modelCalls: observed.modelCalls,
      toolCalls: observed.toolCalls,
      policyDecisions: observed.policyDecisions,
      guardResults: observed.guardResults,
      costMicros: observed.costMicros,
      costByRoute: observed.costByRoute,
      latency: context.latency,
      replay: context.replay,
      expiresAt: uow.now.add({ hours: this.#retentionDays * 24 }),
    };

    const written = sink.writeTrace(uow, trace, context.label);
    if (written.kind !== 'ok') return written;
    if (written.value.truncation !== undefined && isTruncated(written.value.truncation)) {
      // Logged, because the caller's own observability is now incomplete and nothing else would
      // say so. `02` §3.3.9's budget is a cap on the row, and halving the longest list is the
      // right trade — but a replay that reads a truncated trace must not conclude the turn made
      // fewer calls than it did.
      this.#logger.warn('trace.truncated', {
        turnId: context.turnId,
        detail: { dropped: droppedColumns(written.value.truncation) },
      });
    }

    this.#writeDebug(uow, sink, context.turnId, observed.debug);
    return writeOkId(written.value.trace.id);
  }

  /**
   * The debug capture, or nothing.
   *
   * The flag is read **here and nowhere else**, which is the point: a caller that built a payload
   * without checking it loses nothing, and a caller that forgot to check cannot leak anything.
   */
  #writeDebug(uow: TxToken, sink: TraceSink, turnId: TurnId, rendered: string | undefined): void {
    if (!this.#debugContent || rendered === undefined) return;
    const seal = this.#sealDebug;
    if (seal === undefined) {
      // Unreachable: the constructor refuses this combination. Kept as a value rather than a `!`
      // because the consequence of being wrong is storing prompts in the clear.
      throw new Error('debug content is on but no seal was provided');
    }
    this.#banner();
    sink.writeDebug(
      uow,
      turnId,
      seal(turnId, encodeUtf8(rendered)),
      // 24 hours from **now**, not from the trace's expiry. `05` §3.10.1 and `11` §3.10.4 both
      // say so, and the reason is that the two are different promises: a trace is an audit record
      // the host configured a retention for, and this is a debugging aid that must disappear
      // whether or not anybody remembers to turn the flag off.
      uow.now.add({ milliseconds: DEBUG_CAPTURE_TTL_MS }),
    );
  }

  /**
   * `05` §3.10.1's startup warning, once per process.
   *
   * Emitted on the first capture rather than in the constructor, because the constructor runs
   * during boot where `01` §14 A15 wants the health endpoints up first — and because a process
   * configured with the flag that never completes a turn has captured nothing to warn about.
   * `03` §3.11's in-chat banner is the group-facing half and is the dashboard's to render.
   */
  #banner(): void {
    if (this.#bannerLogged) return;
    this.#bannerLogged = true;
    this.#logger.warn('debug.content_enabled');
  }
}

/** `WriteResult<{id}>`, built here so this module does not import the constructors. */
function writeOkId(id: TurnTraceId): WriteResult<{ readonly id: TurnTraceId }> {
  return { kind: 'ok', value: { id } };
}

function isTruncated(truncation: unknown): boolean {
  return (
    typeof truncation === 'object' &&
    truncation !== null &&
    (truncation as { truncated?: unknown }).truncated === true
  );
}

/** The column names the repository shortened, as a token-shaped string for `LogFields.detail`. */
function droppedColumns(truncation: unknown): string {
  const dropped = (truncation as { dropped?: unknown }).dropped;
  return Array.isArray(dropped) ? dropped.join(',') : 'unknown';
}

/**
 * UTF-8 bytes, via `TextEncoder`.
 *
 * `@comvivo/engine` may use the platform's globals — it is `@comvivo/core` that may not — so this
 * is one line rather than `traces.ts`'s hand-rolled counter.
 */
function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
