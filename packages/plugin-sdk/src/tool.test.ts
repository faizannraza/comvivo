/**
 * `M2-T5`: `defineTool` and `10` §3.2.3's host-enforced rules.
 *
 * Two things are proved here that nothing else can prove:
 *
 *  - **`defineTool` fails at definition time.** Every assertion that it throws is an assertion
 *    that a plugin author finds the problem in their own test run, not in somebody's family group.
 *  - **Risk and capability only ever move one way.** `effectiveRisk` and `effectiveCapability` are
 *    the whole of rules 1–3, and a plugin that could lower either would have found the one door
 *    the approval screen promised was shut.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toolOk } from './outcome.js';
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  defaultActionKind,
  defineTool,
  effectiveCapability,
  effectiveRisk,
  MAX_TOOL_DESCRIPTION_CHARS,
  MAX_TOOL_TIMEOUT_MS,
  type ToolDefinition,
  type ToolProvider,
  toolDefinitionProblems,
  toolSchemas,
} from './tool.js';

const Input = z.object({ city: z.string() });
const Output = z.object({ summary: z.string() });

function base(
  overrides: Partial<ToolDefinition<{ city: string }, { summary: string }>> = {},
): ToolDefinition<{ city: string }, { summary: string }> {
  return {
    name: 'get_forecast',
    description: 'Return a short weather summary for one city.',
    input: Input,
    output: Output,
    effect: 'read',
    risk: 'low',
    execute: () => Promise.resolve(toolOk({ summary: 'clear' })),
    ...overrides,
  };
}

describe('defineTool', () => {
  it('returns the definition with its types intact', () => {
    const definition = defineTool(base());
    expect(definition.name).toBe('get_forecast');
  });

  it('freezes it, because the catalog hash is computed from this object', () => {
    const definition = defineTool(base());
    expect(Object.isFrozen(definition)).toBe(true);
  });

  it('leaves the zod schemas unfrozen, which keep internal caches', () => {
    const definition = defineTool(base());
    expect(Object.isFrozen(definition.input)).toBe(false);
  });

  it('lists every problem at once rather than the first', () => {
    expect(() =>
      defineTool(base({ name: 'Get__Forecast', description: '', timeoutMs: 99_999 })),
    ).toThrow(/name .*\n.*description is empty[\s\S]*timeoutMs/);
  });

  it('refuses a name with a double underscore', () => {
    expect(() => defineTool(base({ name: 'get__forecast' }))).toThrow(/no "__"/);
  });

  it('refuses an over-long description, which is paid for on every turn', () => {
    expect(() =>
      defineTool(base({ description: 'x'.repeat(MAX_TOOL_DESCRIPTION_CHARS + 1) })),
    ).toThrow(/description is 1025 characters/);
  });

  it('accepts a description exactly at the limit', () => {
    expect(() =>
      defineTool(base({ description: 'x'.repeat(MAX_TOOL_DESCRIPTION_CHARS) })),
    ).not.toThrow();
  });

  it('refuses a timeout above the ceiling and a non-integer one', () => {
    expect(() => defineTool(base({ timeoutMs: MAX_TOOL_TIMEOUT_MS + 1 }))).toThrow(/exceeds 60000/);
    expect(() => defineTool(base({ timeoutMs: 1.5 }))).toThrow(/positive integer/);
    expect(() => defineTool(base({ timeoutMs: 0 }))).toThrow(/positive integer/);
  });

  it('accepts the documented default timeout', () => {
    expect(() => defineTool(base({ timeoutMs: DEFAULT_TOOL_TIMEOUT_MS }))).not.toThrow();
  });

  it('refuses a delegation grant that grants nothing', () => {
    expect(() =>
      defineTool(
        base({ grantsDelegation: { job: 'sync', capabilities: [], purpose: 'keep in sync' } }),
      ),
    ).toThrow(/grants nothing/);
    expect(() =>
      defineTool(
        base({ grantsDelegation: { job: 'sync', capabilities: ['calendar.write'], purpose: ' ' } }),
      ),
    ).toThrow(/purpose is empty/);
  });

  it('refuses an MCP alias that is not a valid tool name', () => {
    expect(() => defineTool(base({ exposeViaMcp: { name: 'Get Forecast' } }))).toThrow(
      /exposeViaMcp\.name/,
    );
  });

  it('accepts a valid MCP alias, and `false` for a tool that is not re-exposed', () => {
    expect(() => defineTool(base({ exposeViaMcp: { name: 'weather_forecast' } }))).not.toThrow();
    expect(() => defineTool(base({ exposeViaMcp: false }))).not.toThrow();
  });

  it('refuses a schema that cannot be made strict, at definition time', () => {
    // A bare array root has no properties to be strict about, so `strict: true` is meaningless and
    // the provider would reject the tool. Better here than at install.
    expect(() =>
      defineTool({
        ...base(),
        input: z.array(z.string()) as unknown as typeof Input,
      }),
    ).toThrow(/root must be an object/);
  });

  it('refuses a recursive schema, which has no finite strict form', () => {
    const Node: z.ZodType<{ name: string; child?: unknown }> = z.lazy(() =>
      z.object({ name: z.string(), child: Node.optional() }),
    );
    expect(() => defineTool({ ...base(), input: Node as unknown as typeof Input })).toThrow();
  });
});

describe('toolDefinitionProblems', () => {
  it('is empty for a sound definition', () => {
    expect(toolDefinitionProblems(base())).toEqual([]);
  });

  it('reads only the non-generic fields, so any definition satisfies it', () => {
    expect(toolDefinitionProblems({ name: 'ok_name', description: 'fine' })).toEqual([]);
  });

  it('reports an empty capability in uses', () => {
    expect(toolDefinitionProblems({ ...base(), uses: ['  ' as never] })).toEqual([
      'uses contains an empty capability',
    ]);
  });
});

describe('toolSchemas', () => {
  it('converts both sides to strict JSON Schema', () => {
    const schemas = toolSchemas(base());
    expect(schemas.input.schema.additionalProperties).toBe(false);
    expect(schemas.input.schema.required).toEqual(['city']);
    expect(schemas.output.schema.required).toEqual(['summary']);
  });

  it('returns the same object on a second call, so the catalog hashes what defineTool proved', () => {
    const definition = defineTool(base());
    expect(toolSchemas(definition)).toBe(toolSchemas(definition));
  });

  it('records an optional field as nullable, so the model can omit it', () => {
    const schemas = toolSchemas({
      input: z.object({ city: z.string(), units: z.string().optional() }),
      output: Output,
    });
    expect(schemas.input.nullablePaths).toEqual(['units']);
    expect(schemas.input.schema.required).toEqual(['city', 'units']);
  });
});

const BUILTIN: ToolProvider = { kind: 'builtin' };
const PLUGIN: ToolProvider = { kind: 'plugin', id: 'weather' };
const MCP: ToolProvider = { kind: 'mcp', id: 'notes-server' };

describe('effectiveRisk (10 §3.2.3 rules 1 and 2)', () => {
  it('takes the maximum of the definition and the draft', () => {
    expect(effectiveRisk({ risk: 'low', effect: 'read' }, PLUGIN, 'high')).toBe('high');
    expect(effectiveRisk({ risk: 'high', effect: 'read' }, PLUGIN, 'low')).toBe('high');
  });

  it('ignores an absent draft risk', () => {
    expect(effectiveRisk({ risk: 'medium', effect: 'read' }, PLUGIN)).toBe('medium');
  });

  it('floors a plugin write at medium, whatever it declared', () => {
    expect(effectiveRisk({ risk: 'low', effect: 'write' }, PLUGIN)).toBe('medium');
    expect(effectiveRisk({ risk: 'low', effect: 'write' }, MCP)).toBe('medium');
    expect(effectiveRisk({ risk: 'high', effect: 'write' }, PLUGIN)).toBe('high');
  });

  it('does not floor a built-in write, whose risk is reviewed in this repository', () => {
    // `lists.addItems` is genuinely low risk, and forcing it to medium would ask a family to
    // confirm adding milk.
    expect(effectiveRisk({ risk: 'low', effect: 'write' }, BUILTIN)).toBe('low');
  });

  it('never returns less than the declared risk, for every combination', () => {
    const levels = ['low', 'medium', 'high'] as const;
    const effects = ['read', 'write'] as const;
    for (const risk of levels) {
      for (const effect of effects) {
        for (const draft of [undefined, ...levels]) {
          for (const provider of [BUILTIN, PLUGIN, MCP]) {
            const result = effectiveRisk({ risk, effect }, provider, draft);
            expect(levels.indexOf(result)).toBeGreaterThanOrEqual(levels.indexOf(risk));
            if (draft !== undefined) {
              expect(levels.indexOf(result)).toBeGreaterThanOrEqual(levels.indexOf(draft));
            }
          }
        }
      }
    }
  });
});

describe('effectiveCapability (10 §3.2.3 rule 3)', () => {
  it('forces a plugin capability, ignoring what the plugin asked for', () => {
    expect(
      effectiveCapability({ name: 'get_forecast', capability: 'calendar.write' }, PLUGIN),
    ).toBe('plugin:weather:get_forecast');
  });

  it('uses the same shape for an MCP server, with the server id', () => {
    expect(effectiveCapability({ name: 'append' }, MCP)).toBe('plugin:notes-server:append');
  });

  it('returns a built-in’s declared capability', () => {
    expect(effectiveCapability({ name: 'add_event', capability: 'calendar.write' }, BUILTIN)).toBe(
      'calendar.write',
    );
  });

  it('throws for a built-in with no capability, which is a bug in this repository', () => {
    expect(() => effectiveCapability({ name: 'add_event' }, BUILTIN)).toThrow(/has no capability/);
  });
});

describe('defaultActionKind', () => {
  it('is plugin.<id>.<name>', () => {
    expect(defaultActionKind({ name: 'get_forecast' }, 'weather')).toBe(
      'plugin.weather.get_forecast',
    );
  });
});
