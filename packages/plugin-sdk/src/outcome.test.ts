/**
 * `M2-T5`: `ToolOutcome` and its constructors (`10` §3.2.3).
 *
 * The retryability default is the part worth testing hardest. A tool author who writes
 * `toolError('rate_limited', …)` and gets `retryable: false` has a plugin that gives up on a
 * transient failure; one who gets `retryable: true` on `invalid_input` has a plugin that sends the
 * same bad arguments in a loop. Both are silent.
 */
import { describe, expect, it } from 'vitest';
import {
  isToolError,
  isToolNeedsInput,
  isToolOk,
  RETRYABLE_BY_DEFAULT,
  TOOL_ERROR_CODES,
  type ToolOutcome,
  toolError,
  toolNeedsInput,
  toolOk,
} from './outcome.js';

describe('toolOk', () => {
  it('omits display rather than setting it to undefined', () => {
    const outcome = toolOk({ count: 1 });
    expect(outcome).toEqual({ kind: 'ok', output: { count: 1 } });
    // `exactOptionalPropertyTypes` makes these different things, and `05` serialises the key list.
    expect('display' in outcome).toBe(false);
  });

  it('carries a display hint when one is given', () => {
    const display = { blocks: [] } as never;
    expect(toolOk(1, display)).toEqual({ kind: 'ok', output: 1, display });
  });
});

describe('toolError', () => {
  it('defaults retryable from the code', () => {
    expect(toolError('rate_limited', 'slow down').retryable).toBe(true);
    expect(toolError('invalid_input', 'no such date').retryable).toBe(false);
  });

  it('lets a tool override the default in both directions', () => {
    expect(toolError('invalid_input', 'x', { retryable: true }).retryable).toBe(true);
    expect(toolError('timeout', 'x', { retryable: false }).retryable).toBe(false);
  });

  it('has a default for every code', () => {
    // A total `Record` is a compile-time guarantee; this catches the case where a code is added to
    // the array and to the map with the wrong key spelling.
    expect(Object.keys(RETRYABLE_BY_DEFAULT).toSorted()).toEqual([...TOOL_ERROR_CODES].toSorted());
  });

  it('marks exactly the four transient codes retryable', () => {
    const retryable = TOOL_ERROR_CODES.filter((code) => RETRYABLE_BY_DEFAULT[code]);
    expect(retryable).toEqual(['unavailable', 'rate_limited', 'timeout', 'upstream_error']);
  });
});

describe('toolNeedsInput', () => {
  it('omits choices when there are none', () => {
    const outcome = toolNeedsInput('Which list?');
    expect(outcome).toEqual({ kind: 'needs_input', question: 'Which list?' });
    expect('choices' in outcome).toBe(false);
  });

  it('carries the choices a channel renders as buttons', () => {
    expect(toolNeedsInput('Which list?', ['groceries', 'costco'])).toEqual({
      kind: 'needs_input',
      question: 'Which list?',
      choices: ['groceries', 'costco'],
    });
  });
});

describe('the predicates', () => {
  it('narrows each arm and nothing else', () => {
    const outcomes: ToolOutcome<number>[] = [
      toolOk(1),
      toolError('internal', 'boom'),
      toolNeedsInput('which?'),
    ];
    expect(outcomes.map(isToolOk)).toEqual([true, false, false]);
    expect(outcomes.map(isToolError)).toEqual([false, true, false]);
    expect(outcomes.map(isToolNeedsInput)).toEqual([false, false, true]);
  });

  it('gives access to the narrowed fields', () => {
    const outcome: ToolOutcome<number> = toolOk(7);
    expect(isToolOk(outcome) ? outcome.output : -1).toBe(7);
  });
});
