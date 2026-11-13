/**
 * The group tool catalogue and its hash (`10` §3.5.1; `05` §3.4.8–§3.4.9; `M2-T17`).
 *
 * The hash is a **cache key**, and that is what makes these tests worth having. `01` §14 A13 keys
 * breakpoint 1 by the catalogue hash, so every group with the same enabled set shares one entry. A
 * hash that varied with registration order would rewrite that layer on turns that changed nothing:
 * no error, no log line, identical answers, roughly double the cost of the largest layer in the
 * prompt. The only way that surfaces is a test.
 *
 * So the suite asserts both directions of P5 — invariant to order, *and* sensitive to every
 * model-facing field — because a hash of a constant would pass the first half perfectly.
 */
import { describe, expect, it } from 'vitest';
import {
  buildCatalog,
  type CatalogTool,
  catalogHash,
  MAX_MODEL_TOOL_NAME_CHARS,
  modelToolName,
  ToolCatalogService,
  ToolNameTooLongError,
  toolSpecs,
} from './catalog.js';

function tool(
  localName: string,
  provider: CatalogTool['provider'] = { kind: 'builtin' },
  overrides: Partial<CatalogTool> = {},
): CatalogTool {
  return {
    localName,
    provider,
    description: `does ${localName}`,
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
      additionalProperties: false,
    },
    strict: true,
    ...overrides,
  };
}

const plugin = (id: string): CatalogTool['provider'] => ({ kind: 'plugin', id });
const mcp = (id: string): CatalogTool['provider'] => ({ kind: 'mcp', id });

describe('model names (10 §3.5.1 step 3)', () => {
  it('leaves a built-in name alone', () => {
    expect(modelToolName({ kind: 'builtin' }, 'memory_recall')).toBe('memory_recall');
  });

  it('prefixes an extension tool with its provider id', () => {
    expect(modelToolName(plugin('weather'), 'forecast')).toBe('weather__forecast');
    expect(modelToolName(mcp('github'), 'list_issues')).toBe('github__list_issues');
  });

  it('maps `-` in a provider id to `_`', () => {
    expect(modelToolName(plugin('home-assistant'), 'turn_on')).toBe('home_assistant__turn_on');
  });

  it('cannot manufacture a `__` inside a provider id', () => {
    // `10` §3.2.3 forbids `--` in an id precisely so this mapping is injective. If `a--b` were a
    // legal id it would become `a__b`, which is indistinguishable from provider `a`, tool `b` —
    // and a plugin could then shadow another plugin's tool.
    const name = modelToolName(plugin('home-assistant'), 'turn_on');
    expect(name.split('__')).toHaveLength(2);
  });

  it('refuses a name longer than every provider accepts', () => {
    const longId = 'a'.repeat(31);
    const longTool = 'b'.repeat(47);
    expect(() => modelToolName(plugin(longId), longTool)).toThrow(ToolNameTooLongError);
    try {
      modelToolName(plugin(longId), longTool);
    } catch (error) {
      // The message has to say what to do: this is surfaced at install or snapshot approval.
      expect((error as Error).message).toContain('Shorten');
      expect((error as Error).message).toContain(String(MAX_MODEL_TOOL_NAME_CHARS));
    }
  });

  it('accepts a name of exactly the limit', () => {
    // `a`(30) + `__` + `b`(32) = 64.
    const name = modelToolName(plugin('a'.repeat(30)), 'b'.repeat(32));
    expect(name).toHaveLength(MAX_MODEL_TOOL_NAME_CHARS);
  });
});

describe('catalogue order (10 §3.5.1 step 2; 05 §3.4.9)', () => {
  it('emits built-ins first, in the order given, never sorted', () => {
    const catalog = buildCatalog({
      // Deliberately not alphabetical: `05` §3.6.7's table is grouped by owning document.
      builtins: [tool('memory_recall'), tool('calendar_create_event'), tool('agenda_view')],
      extensions: [],
    });
    expect(catalog.tools.map((t) => t.modelName)).toEqual([
      'memory_recall',
      'calendar_create_event',
      'agenda_view',
    ]);
  });

  it('sorts extension providers bytewise and their tools by local name', () => {
    const catalog = buildCatalog({
      builtins: [tool('memory_recall')],
      extensions: [
        tool('zebra', plugin('weather')),
        tool('alpha', plugin('weather')),
        tool('only', plugin('calendar_sync')),
      ],
    });
    expect(catalog.tools.map((t) => t.modelName)).toEqual([
      'memory_recall',
      'calendar_sync__only',
      'weather__alpha',
      'weather__zebra',
    ]);
  });

  it('interleaves plugins and MCP servers rather than grouping by kind', () => {
    // `10` X-5: they share one id namespace. Grouping by kind would make a provider's position
    // depend on how it was installed, which is not something the model can see — and would mean
    // converting a plugin to an MCP server invalidated the cache for every group on the host.
    const catalog = buildCatalog({
      builtins: [],
      extensions: [tool('t', plugin('bravo')), tool('t', mcp('alpha')), tool('t', mcp('charlie'))],
    });
    expect(catalog.tools.map((t) => t.modelName)).toEqual(['alpha__t', 'bravo__t', 'charlie__t']);
  });

  it('sorts bytewise, not by locale', () => {
    // `localeCompare` orders `B` before `a` in some locales and after it in others, so a
    // locale-aware sort would hash the same catalogue differently depending on the host's LANG.
    const catalog = buildCatalog({
      builtins: [],
      extensions: [tool('b_tool', plugin('p')), tool('a_tool', plugin('p'))],
    });
    expect(catalog.tools.map((t) => t.localName)).toEqual(['a_tool', 'b_tool']);
  });

  it('refuses two tools claiming one model name', () => {
    expect(() => buildCatalog({ builtins: [tool('x'), tool('x')], extensions: [] })).toThrow(
      /claim the model name/,
    );
  });

  it('produces the ToolSpec shape the model port wants', () => {
    const catalog = buildCatalog({ builtins: [tool('memory_recall')], extensions: [] });
    expect(toolSpecs(catalog)).toEqual([
      {
        name: 'memory_recall',
        description: 'does memory_recall',
        inputSchema: tool('memory_recall').inputSchema,
      },
    ]);
  });
});

describe('what the hash covers (10 §3.5.1 step 4)', () => {
  const base = buildCatalog({
    builtins: [tool('memory_recall')],
    extensions: [tool('forecast', plugin('weather'))],
  });

  it('changes when a model-facing field changes', () => {
    const cases: readonly (readonly [string, Partial<CatalogTool>])[] = [
      ['description', { description: 'does something else' }],
      ['strict', { strict: false }],
      [
        'input schema',
        {
          inputSchema: {
            type: 'object',
            properties: { q: { type: 'number' } },
            required: ['q'],
            additionalProperties: false,
          },
        },
      ],
    ];
    for (const [what, override] of cases) {
      const changed = buildCatalog({
        builtins: [tool('memory_recall', { kind: 'builtin' }, override)],
        extensions: [tool('forecast', plugin('weather'))],
      });
      expect(changed.hash, what).not.toBe(base.hash);
    }
  });

  it('changes when a model name changes', () => {
    const renamed = buildCatalog({
      builtins: [tool('memory_recall')],
      extensions: [tool('forecast', plugin('weather_v2'))],
    });
    expect(renamed.hash).not.toBe(base.hash);
  });

  it('does not change when something the model never sees changes', () => {
    // The provider *kind* is not hashed: whether a tool arrived by plugin or by MCP does not
    // change a byte the model reads, and invalidating a host-wide cache layer for it would be a
    // cost with no benefit. The id is hashed, because it is in the name.
    const asMcp = buildCatalog({
      builtins: [tool('memory_recall')],
      extensions: [tool('forecast', mcp('weather'))],
    });
    expect(asMcp.hash).toBe(base.hash);
  });

  it('is a lowercase sha256 hex digest', () => {
    expect(base.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('distinguishes an empty catalogue from a one-tool catalogue', () => {
    expect(catalogHash([])).not.toBe(base.hash);
    expect(catalogHash([])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('ToolCatalogService memoization (10 §3.5.1 step 5)', () => {
  function service(): {
    readonly svc: ToolCatalogService;
    readonly state: { registryGeneration: number; groupExtensionsVersion: number; builds: number };
    readonly extensions: CatalogTool[];
  } {
    const state = { registryGeneration: 1, groupExtensionsVersion: 1, builds: 0 };
    const extensions: CatalogTool[] = [tool('forecast', plugin('weather'))];
    const svc = new ToolCatalogService({
      builtins: () => [tool('memory_recall')],
      extensionsFor: () => {
        state.builds += 1;
        return extensions;
      },
      versionFor: () => ({
        registryGeneration: state.registryGeneration,
        groupExtensionsVersion: state.groupExtensionsVersion,
      }),
    });
    return { svc, state, extensions };
  }

  it('builds once while the versions hold', () => {
    const { svc, state } = service();
    const first = svc.forGroup('grp_1');
    expect(svc.forGroup('grp_1')).toBe(first);
    expect(state.builds).toBe(1);
  });

  it('rebuilds when the registry generation bumps', () => {
    const { svc, state, extensions } = service();
    svc.forGroup('grp_1');
    extensions.push(tool('alerts', plugin('weather')));
    state.registryGeneration = 2;
    expect(svc.forGroup('grp_1').tools).toHaveLength(3);
  });

  it('rebuilds when this group enables something', () => {
    const { svc, state, extensions } = service();
    const before = svc.forGroup('grp_1').hash;
    extensions.length = 0;
    state.groupExtensionsVersion = 2;
    expect(svc.forGroup('grp_1').hash).not.toBe(before);
  });

  it('keeps each group’s catalogue separate', () => {
    const svc = new ToolCatalogService({
      builtins: () => [tool('memory_recall')],
      extensionsFor: (groupId) =>
        groupId === 'grp_1' ? [tool('forecast', plugin('weather'))] : [],
      versionFor: () => ({ registryGeneration: 1, groupExtensionsVersion: 1 }),
    });
    expect(svc.forGroup('grp_1').hash).not.toBe(svc.forGroup('grp_2').hash);
    // Two groups with the *same* enabled set share a hash, which is the whole point of A13.
    expect(svc.forGroup('grp_2').hash).toBe(svc.forGroup('grp_3').hash);
  });

  it('hands out a frozen snapshot, so a turn keeps the catalogue it was given (10 F9)', () => {
    const { svc } = service();
    const catalog = svc.forGroup('grp_1');
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(() => ((catalog as { hash: string }).hash = 'tampered')).toThrow(TypeError);
  });

  it('rebuilds after clear()', () => {
    const { svc, state } = service();
    svc.forGroup('grp_1');
    svc.clear();
    svc.forGroup('grp_1');
    expect(state.builds).toBe(2);
  });
});
