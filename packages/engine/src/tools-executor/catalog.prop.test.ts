/**
 * **P5 (G4)**: the catalogue hash is invariant to provider registration order, and changes iff a
 * model-facing definition changes (`10` §12 P5; `M2-T17`).
 *
 * This one has to be a property. The hash keys breakpoint 1 of the prompt cache (`01` §14 A13), so
 * the claim is about *every* set of providers a host might end up with — and the failure mode is
 * silent: a hash that depended on registration order would rewrite the largest layer in the prompt
 * on turns that changed nothing, with no error and no log line. An example-based test would assert
 * it for the three providers somebody thought of.
 *
 * Both halves are asserted, because a hash of a constant would satisfy the first half perfectly.
 */

import { fcConfig } from '@comvivo/shared/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildCatalog, type CatalogTool } from './catalog.js';

/** A provider id: `10` §3.2's shape, which forbids `--` so the `-` → `_` mapping stays injective. */
const providerId = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'),
    fc.stringMatching(/^[a-z0-9-]{0,12}$/),
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'),
  )
  .map(([first, middle, last]) => `${first}${middle}${last}`)
  .filter((id) => !id.includes('--'));

const localName = fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/).filter((n) => !n.includes('__'));

const schema = fc.constantFrom(
  {
    type: 'object',
    properties: { q: { type: 'string' } },
    required: ['q'],
    additionalProperties: false,
  },
  {
    type: 'object',
    properties: { n: { type: 'number' } },
    required: ['n'],
    additionalProperties: false,
  },
  { type: 'object', properties: {}, required: [], additionalProperties: false },
) as fc.Arbitrary<CatalogTool['inputSchema']>;

const extensionTool: fc.Arbitrary<CatalogTool> = fc.record({
  localName,
  provider: fc.record({ kind: fc.constantFrom('plugin' as const, 'mcp' as const), id: providerId }),
  description: fc.string({ maxLength: 40 }),
  inputSchema: schema,
  strict: fc.boolean(),
});

/** A set of extension tools with no two sharing a model name, which registration already enforces. */
const extensionSet = fc.array(extensionTool, { maxLength: 12 }).map((tools) => {
  const seen = new Set<string>();
  return tools.filter((t) => {
    const key = `${t.provider.kind === 'builtin' ? '' : t.provider.id}__${t.localName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
});

const builtinSet = fc
  .array(localName, { maxLength: 6 })
  .map((names) => [...new Set(names)])
  .map((names): readonly CatalogTool[] =>
    names.map((name) => ({
      localName: name,
      provider: { kind: 'builtin' } as const,
      description: `does ${name}`,
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      } as CatalogTool['inputSchema'],
      strict: true,
    })),
  );

/** A permutation of an array, driven by fast-check so a counterexample replays. */
function permute<T>(items: readonly T[], swaps: readonly [number, number][]): readonly T[] {
  const out = [...items];
  for (const [a, b] of swaps) {
    if (out.length === 0) break;
    const i = a % out.length;
    const j = b % out.length;
    const left = out[i];
    const right = out[j];
    if (left === undefined || right === undefined) continue;
    out[i] = right;
    out[j] = left;
  }
  return out;
}

/** Which model-facing field to change. */
type MutableField = 'description' | 'strict' | 'localName';

/**
 * Change one model-facing field.
 *
 * A named function with a declared return type rather than an inline arrow: an exhaustive `switch`
 * over a closed union carries no `default` (`allowDefaultCaseForExhaustiveSwitch: false`), and
 * Biome's `useIterableCallbackReturn` cannot see that every path returns when the switch is inline
 * in a `map`. The declared return type is what reconciles the two rules.
 */
function mutate(tool: CatalogTool, field: MutableField): CatalogTool {
  switch (field) {
    case 'description':
      return { ...tool, description: `${tool.description}!` };
    case 'strict':
      return { ...tool, strict: !tool.strict };
    case 'localName':
      return { ...tool, localName: `${tool.localName}_x` };
  }
}

describe('P5 — catalogue hash (10 §12)', { tags: ['prop'] }, () => {
  it('is invariant to the order providers were registered in', () => {
    fc.assert(
      fc.property(
        builtinSet,
        extensionSet,
        fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 20 }),
        (builtins, extensions, swaps) => {
          const a = buildCatalog({ builtins, extensions });
          const b = buildCatalog({ builtins, extensions: permute(extensions, swaps) });
          expect(b.hash).toBe(a.hash);
          // And the emitted order is identical, not merely the digest — the digest could agree by
          // a canonicalization accident while the model was shown a different list.
          expect(b.tools.map((t) => t.modelName)).toEqual(a.tools.map((t) => t.modelName));
        },
      ),
      fcConfig(),
    );
  });

  it('is NOT invariant to the order of built-ins, which is fixed by 05 §3.6.7', () => {
    // The other half of the ordering rule. Built-ins are emitted in the catalogue's order, not
    // sorted — so a change to that order is a change to the prompt, and must change the hash.
    fc.assert(
      fc.property(builtinSet, (builtins) => {
        fc.pre(builtins.length >= 2);
        const reversed = [...builtins].reverse();
        expect(buildCatalog({ builtins: reversed, extensions: [] }).hash).not.toBe(
          buildCatalog({ builtins, extensions: [] }).hash,
        );
      }),
      fcConfig(),
    );
  });

  it('changes when any model-facing field of any tool changes', () => {
    fc.assert(
      fc.property(
        builtinSet,
        extensionSet,
        fc.nat(),
        fc.constantFrom<MutableField>('description', 'strict', 'localName'),
        (builtins, extensions, pick, field) => {
          fc.pre(extensions.length > 0);
          const index = pick % extensions.length;
          const target = extensions[index];
          if (target === undefined) return;

          const mutated = extensions.map((tool, i) => (i === index ? mutate(tool, field) : tool));

          expect(buildCatalog({ builtins, extensions: mutated }).hash).not.toBe(
            buildCatalog({ builtins, extensions }).hash,
          );
        },
      ),
      fcConfig(),
    );
  });

  it('agrees for two groups with the same enabled set, however they got there', () => {
    // The claim A13 actually rests on: groups share a cache entry. If this were false, every group
    // would pay to write its own copy of the largest layer in the prompt.
    fc.assert(
      fc.property(
        builtinSet,
        extensionSet,
        fc.array(fc.tuple(fc.nat(), fc.nat()), { maxLength: 20 }),
        (builtins, extensions, swaps) => {
          const groupOne = buildCatalog({ builtins, extensions });
          const groupTwo = buildCatalog({ builtins, extensions: permute(extensions, swaps) });
          expect(groupTwo.hash).toBe(groupOne.hash);
        },
      ),
      fcConfig(),
    );
  });
});
