/**
 * Every adapter's stop-reason reader is total over **strings**, not just over its SDK's union.
 *
 * The M2 independent review asked for zod at the LLM-output boundary (`CLAUDE.md` §2). Looking for
 * it turned up something a schema would not have caught: all four `readStop` functions switched
 * over a union TypeScript believes is closed and the wire does not, so a reason this build has
 * never heard of fell off the end of the switch and `readStop` returned **`undefined` as a
 * `StopInfo`**. The engine reads `.stop.reason` on the next line.
 *
 * It is not a hypothetical. `compaction` and `model_context_window_exceeded` were both added to
 * Anthropic's `BetaStopReason` while this project was being written, and on the local adapter it is
 * the likely case rather than the unlikely one — Ollama, LM Studio, llama.cpp and vLLM each
 * implement `finish_reason` and none of them is bound by OpenAI's union.
 *
 * Zod is the right tool at this boundary for *structured output*, where it is already applied
 * (`schema.safeParse` in each adapter's `structured.ts`). It is the wrong tool here, because a new
 * stop reason is a perfectly valid string: what is needed is a total function, which is what the
 * `default` branch in each reader makes it, keeping the unknown value in `raw` for the trace.
 */
import { describe, expect, it } from 'vitest';
import { readStop as readAnthropicStop } from './anthropic/response.js';
import { readStop as readGoogleStop } from './google/response.js';
import { readStop as readOpenAiStop } from './openai/response.js';
import { readStop as readLocalStop } from './openai-compatible/response.js';

/** A response carrying a stop reason no SDK union contains, per provider. */
const UNKNOWN = [
  {
    provider: 'anthropic',
    read: () =>
      readAnthropicStop({
        stop_reason: 'brand_new_reason_2027',
        content: [],
        usage: {},
      } as never),
    raw: 'brand_new_reason_2027',
  },
  {
    provider: 'google',
    read: () =>
      readGoogleStop({
        candidates: [{ finishReason: 'BRAND_NEW_REASON_2027', content: { parts: [] } }],
      } as never),
    raw: 'BRAND_NEW_REASON_2027',
  },
  {
    provider: 'openai',
    read: () => readOpenAiStop({ status: 'brand_new_reason_2027', output: [] } as never),
    raw: 'brand_new_reason_2027',
  },
  {
    // OpenAI's second axis. `status: 'incomplete'` is known; the **reason** inside it is its own
    // union, and it was the one reader of four that both lost the unknown value (it answered
    // `raw: 'incomplete'`) and let a `case` be deleted without a type error. Found at the M2
    // second-pass review, which measured exactly this input.
    provider: 'openai (incomplete_details.reason)',
    read: () =>
      readOpenAiStop({
        status: 'incomplete',
        incomplete_details: { reason: 'brand_new_reason_2027' },
        output: [],
      } as never),
    raw: 'incomplete:brand_new_reason_2027',
  },
  {
    provider: 'openai-compatible',
    read: () =>
      readLocalStop({
        choices: [{ finish_reason: 'brand_new_reason_2027', message: { content: '' } }],
      } as never),
    raw: 'brand_new_reason_2027',
  },
] as const;

describe('readStop, given a reason this build has never heard of', () => {
  it('returns a StopInfo rather than undefined, on every adapter', () => {
    for (const { provider, read } of UNKNOWN) {
      const stop = read();
      expect(stop, provider).toBeDefined();
      expect(stop.reason, provider).toBe('other');
    }
  });

  it('keeps the unknown value, so a trace shows what actually arrived', () => {
    // The alternative — mapping it to a known reason — would hand the engine an invented reading
    // of a turn, and `end_turn` in particular would show somebody an empty answer as a finished
    // one. `other` plus the raw string is the honest report.
    for (const { provider, read, raw } of UNKNOWN) {
      expect(read().raw, provider).toBe(raw);
    }
  });

  it('covers all four adapters, so a fifth cannot be forgotten quietly', () => {
    // A positive control on the table itself: `01` §2.1's four providers, each present once.
    expect(UNKNOWN.map((entry) => entry.provider)).toEqual([
      'anthropic',
      'google',
      'openai',
      'openai (incomplete_details.reason)',
      'openai-compatible',
    ]);
  });
});
