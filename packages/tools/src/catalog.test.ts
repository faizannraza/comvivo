/**
 * Invariants of the built-in catalogue (`05` §3.6.7, `10` X-5; `M2-T17`).
 *
 * The cross-check against `05` §3.6.7's own table lives in `test/plan/builtin-catalog.test.ts`,
 * which can read the plan: `@comvivo/tools` is a pure package and may not import `node:*`.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_BLOCKS,
  BUILTIN_TOOL_ORDER,
  builtinIndex,
  isBuiltinToolName,
  OPTIONAL_BUILTIN_TOOLS,
} from './catalog.js';

describe('catalogue invariants', () => {
  it('has no duplicate name anywhere', () => {
    const all = [...BUILTIN_TOOL_ORDER, ...OPTIONAL_BUILTIN_TOOLS];
    expect(new Set(all).size).toBe(all.length);
  });

  it('never uses `__` in a built-in name', () => {
    // `10` X-5: the extension model name is `<providerId>__<tool>`, so a built-in containing `__`
    // would be indistinguishable from an extension tool and could shadow one.
    for (const name of [...BUILTIN_TOOL_ORDER, ...OPTIONAL_BUILTIN_TOOLS]) {
      expect(name, name).not.toContain('__');
    }
  });

  it('uses only the local-name shape every provider accepts', () => {
    for (const name of [...BUILTIN_TOOL_ORDER, ...OPTIONAL_BUILTIN_TOOLS]) {
      expect(name, name).toMatch(/^[a-z][a-z0-9_]{0,47}$/);
    }
  });

  it('reports a position for a built-in and nothing for anything else', () => {
    expect(builtinIndex('memory_recall')).toBe(0);
    expect(builtinIndex('member_list')).toBe(BUILTIN_TOOL_ORDER.indexOf('member_list'));
    expect(builtinIndex('not_a_tool')).toBeUndefined();
    // The optional tool has no position in the shipped order, which is what keeps the instance
    // toggle from shifting every tool after it.
    expect(builtinIndex('web_search')).toBeUndefined();
    expect(isBuiltinToolName('web_search')).toBe(true);
  });

  it('is frozen, so a hash computed from it cannot be invalidated at runtime', () => {
    expect(() => (BUILTIN_TOOL_ORDER as string[]).push('sneaky')).toThrow(TypeError);
    expect(Object.isFrozen(BUILTIN_BLOCKS)).toBe(true);
  });
});
