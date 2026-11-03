/**
 * Exhaustiveness checking (`01` §11.3). The compile-time half is the point; this covers the runtime
 * half, which exists for data that arrived from an older database or a provider that added a
 * variant.
 */
import { describe, expect, it } from 'vitest';
import { assertNever } from './assert-never.js';
import { BugError } from './errors.js';

describe('assertNever', () => {
  it('throws a BugError, because an unhandled variant is our bug and not bad input', () => {
    expect(() => assertNever('surprise' as never)).toThrow(BugError);
  });

  it('names the variant it did not expect', () => {
    expect(() => assertNever('contested' as never)).toThrow(/"contested"/);
  });

  it('reads the discriminant off a tagged union, which is the common case', () => {
    // `PolicyDecision`, `FlowDecision` and `ToolOutcome` are all `{ kind: ... }`, so the message
    // should say which kind rather than printing `[object Object]`.
    expect(() => assertNever({ kind: 'needs_confirmation' } as never)).toThrow(
      /"needs_confirmation"/,
    );
  });

  it('includes the call site when given one', () => {
    expect(() => assertNever('x' as never, 'renderPolicyDecision')).toThrow(
      /in renderPolicyDecision/,
    );
  });

  it('tells the reader to handle the case rather than widen a default', () => {
    expect(() => assertNever('x' as never)).toThrow(/rather than widening a default/);
  });

  it('used exhaustively, is unreachable', () => {
    type Decision = { kind: 'allow' } | { kind: 'deny' };
    const render = (d: Decision): string => {
      switch (d.kind) {
        case 'allow':
          return 'yes';
        case 'deny':
          return 'no';
        default:
          return assertNever(d, 'render');
      }
    };
    expect(render({ kind: 'allow' })).toBe('yes');
    expect(render({ kind: 'deny' })).toBe('no');
  });
});
