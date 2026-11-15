/**
 * `defineTool` and `ToolDefinition` (`01` §7.4 plus `01` §14 A23's additive fields; `10` §3.2.3).
 *
 * One definition type for built-in tools and third-party ones. That is not tidiness: `05`'s turn
 * loop, `11`'s evals, `10`'s MCP bridge and the catalog hash all read tools through this shape, so
 * a built-in and a plugin tool are indistinguishable to everything downstream — which is what makes
 * "every feature reachable through chat" true for a plugin's features too.
 *
 * ## What the host decides, whatever the definition says
 *
 * `10` §3.2.3's five rules are not advice. Three of them are pure functions and live here, so the
 * host and `comvivo plugin check` compute the same answer from the same code:
 *
 *  1. **Effective risk** is `max(definition.risk, action().risk ?? 'low')` — `effectiveRisk`.
 *  2. A **plugin `write` tool** is at least `medium` — also `effectiveRisk`.
 *  3. A **plugin's capability** is always `plugin:<id>:<name>` — `effectiveCapability`.
 *
 * The other two belong to the executor and cannot be computed from a definition:
 * `ActionRequest.dataLabels` and `provenance` are the executor's (rule 4), and output validation
 * failures become `{ kind: 'error', code: 'internal' }` logged as `plugin.output_invalid` (rule 5).
 *
 * ## Why `defineTool` validates eagerly
 *
 * It throws at module load for a bad name, an over-long description, an impossible timeout or a
 * schema that cannot be made strict. The alternative is discovering it during
 * `village plugin add` — after a stranger has already published the package — or worse, at the
 * first tool call. A plugin author sees it in `pnpm test` instead, which is the only moment the fix
 * is cheap.
 */
import {
  type Capability,
  type EntityRef,
  isToolLocalName,
  maxRisk,
  pluginCapability,
  type Risk,
  type Sensitivity,
  TOOL_LOCAL_NAME_PATTERN,
} from '@comvivo/core';
import { type StrictConversion, toStrictJsonSchema } from '@comvivo/shared';
import type { z } from 'zod';
import type { PluginSettingsShape, ToolContext } from './context.js';
import type { ToolOutcome } from './outcome.js';
import type { PluginPermissions } from './permissions.js';

/** `10` §3.2.3: snake_case, 1–48 characters, and never a double underscore. */
export const TOOL_NAME_PATTERN = TOOL_LOCAL_NAME_PATTERN;

/**
 * `10` §3.2.3's description ceiling.
 *
 * It is a *model-facing* budget, not a database column: every tool's description sits in the cached
 * tool catalog on every request, so a verbose description is paid for on every turn of every group
 * forever. 1024 characters is enough for what the tool does, when to use it and one example.
 */
export const MAX_TOOL_DESCRIPTION_CHARS = 1024;

export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;

export const MAX_TOOL_TIMEOUT_MS = 60_000;

export type ToolEffect = 'read' | 'write';

/** What a tool call looks like to the policy engine (`01` §7.3's `ActionRequest`, minus the host's part). */
export interface ActionRequestDraft {
  /** A registered action kind, e.g. `calendar.event.update` (`03` §3.3.1's registry). */
  readonly kind: string;
  /** The existing entity being changed, when there is one. Ownership rules key off it. */
  readonly target?: EntityRef;
  /** May raise the definition's risk for this particular call. Never lowers it — see `effectiveRisk`. */
  readonly risk?: Risk;
}

/** `10` §3.2.6: a tool that hands a background job a narrower slice of the requester's authority. */
export interface DelegationGrant {
  readonly job: string;
  readonly capabilities: readonly Capability[];
  /** Shown to the requester at the confirmation and recorded in the audit row. */
  readonly purpose: string;
}

export interface ToolExample<I> {
  readonly input: I;
  readonly note?: string;
}

export interface ToolDefinition<
  I,
  O,
  P extends PluginPermissions = PluginPermissions,
  S extends PluginSettingsShape = PluginSettingsShape,
> {
  /** Local, stable, and part of the cached tool catalog — renaming one invalidates every cache. */
  readonly name: string;
  /** Model-facing copy, reviewed like UX copy (`CLAUDE.md` §2). ≤ 1024 characters. */
  readonly description: string;
  /** Must convert to a strict JSON Schema: object root, `additionalProperties: false`. */
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  /** Required for built-ins. Omitted by plugins, which are forced to `plugin:<id>:<name>`. */
  readonly capability?: Capability;
  readonly effect: ToolEffect;
  readonly risk: Risk;
  /** Optional for plugins, which default to `{ kind: 'plugin.<id>.<name>' }`. */
  readonly action?: (input: I) => ActionRequestDraft;
  readonly execute: (input: I, context: ToolContext<P, S>) => Promise<ToolOutcome<O>>;
  /** Domain capabilities this tool's `ctx.repos` calls will need, declared for the approval screen. */
  readonly uses?: readonly Capability[];
  /** `'always'` is a floor: the requester confirms even where the policy would allow it outright. */
  readonly confirm?: 'policy' | 'always';
  /** Default `15000`, max `60000`; clamped to whatever is left of the turn deadline. */
  readonly timeoutMs?: number;
  /** The sensitivity the output is labelled with. Default `'normal'`. */
  readonly outputSensitivity?: Sensitivity;
  /** Forced `true` for plugin and MCP providers; built-ins default `false`. */
  readonly untrustedOutput?: boolean;
  /** ≤ 140 characters, for external (non-repository) write effects (`10` §3.6.4). */
  readonly effectSummary?: (input: I, output: O) => string;
  readonly grantsDelegation?: DelegationGrant;
  /** Built-ins only (`10` §3.7.4). A plugin tool is never re-exposed over our MCP server. */
  readonly exposeViaMcp?: false | { readonly name: string };
  /** For docs and evals. Never sent to the model — the description carries the example that is. */
  readonly examples?: readonly ToolExample<I>[];
}

/**
 * The fields the checks below read, with no reference to `I`, `O`, `P` or `S`.
 *
 * Structural rather than `ToolDefinition<never, unknown>`: an erased alias would make every caller
 * reason about whether `z.ZodType<I>` is assignable to `z.ZodType<never>`, which is a question
 * about zod's variance and not about tools. Any `ToolDefinition` satisfies this shape directly.
 */
export interface ToolMeta {
  readonly name: string;
  readonly description: string;
  readonly timeoutMs?: number;
  readonly uses?: readonly Capability[];
  readonly grantsDelegation?: DelegationGrant;
  readonly exposeViaMcp?: false | { readonly name: string };
}

/**
 * Every way a definition is malformed, all of them at once.
 *
 * All rather than the first, for the same reason the strict-schema linter reports all: an author
 * fixing one problem per run is an author who gives up. Schema convertibility is **not** checked
 * here — it throws rather than returning a message, and `defineTool` wants both.
 */
export function toolDefinitionProblems(definition: ToolMeta): readonly string[] {
  const problems: string[] = [];

  if (!isToolLocalName(definition.name)) {
    problems.push(
      `name "${definition.name}" must match ${String(TOOL_NAME_PATTERN)} and contain no "__" ` +
        '(the "__" separates a provider from a tool in a model-facing name, 10 §3.5.1)',
    );
  }
  if (definition.description.trim() === '') {
    problems.push('description is empty; the model chooses tools by reading it');
  }
  if (definition.description.length > MAX_TOOL_DESCRIPTION_CHARS) {
    problems.push(
      `description is ${String(definition.description.length)} characters; the limit is ` +
        `${String(MAX_TOOL_DESCRIPTION_CHARS)}, and it is paid for on every turn of every group`,
    );
  }
  const { timeoutMs } = definition;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
    problems.push(`timeoutMs must be a positive integer, got ${String(timeoutMs)}`);
  }
  if (timeoutMs !== undefined && timeoutMs > MAX_TOOL_TIMEOUT_MS) {
    problems.push(
      `timeoutMs ${String(timeoutMs)} exceeds ${String(MAX_TOOL_TIMEOUT_MS)}; a member waiting ` +
        'longer than a minute for one tool has already given up',
    );
  }
  if (definition.uses?.some((capability) => capability.trim() === '') === true) {
    problems.push('uses contains an empty capability');
  }
  if (definition.grantsDelegation !== undefined) {
    const grant = definition.grantsDelegation;
    if (grant.capabilities.length === 0) {
      problems.push('grantsDelegation declares no capabilities, so it grants nothing');
    }
    if (grant.purpose.trim() === '') {
      problems.push('grantsDelegation.purpose is empty; the requester is asked to approve it');
    }
  }
  if (definition.exposeViaMcp !== undefined && definition.exposeViaMcp !== false) {
    if (!isToolLocalName(definition.exposeViaMcp.name)) {
      problems.push(
        `exposeViaMcp.name "${definition.exposeViaMcp.name}" must match ${String(TOOL_NAME_PATTERN)}`,
      );
    }
  }

  return problems;
}

export interface ToolSchemas {
  readonly input: StrictConversion;
  readonly output: StrictConversion;
}

/**
 * The strict JSON Schemas for a definition, converted once.
 *
 * Cached in a `WeakMap` keyed by the definition object, so the catalog (`M2-T17`) hashes exactly
 * the bytes `defineTool` already proved convertible rather than converting again and risking a
 * different result. The map holds no strong reference, so a definition that goes out of scope is
 * collected with its schemas.
 *
 * The output is converted with `io: 'output'` and is held to the same object-root rule as the
 * input. A tool whose result is a bare list should return `{ items: [...] }` — which the model also
 * reads better, because a named field says what the list is. Logged as a plan change: `10` §3.2.3
 * says outputs are validated, not that they must be strict.
 */
const SCHEMA_CACHE = new WeakMap<object, ToolSchemas>();

export function toolSchemas<I, O>(
  definition: Pick<ToolDefinition<I, O>, 'input' | 'output'>,
): ToolSchemas {
  const cached = SCHEMA_CACHE.get(definition);
  if (cached !== undefined) return cached;
  const schemas: ToolSchemas = {
    input: toStrictJsonSchema(definition.input, { io: 'input' }),
    output: toStrictJsonSchema(definition.output, { io: 'output' }),
  };
  SCHEMA_CACHE.set(definition, schemas);
  return schemas;
}

/** Where a tool came from. Three of `10` §3.2.3's rules depend on it and nothing else does. */
export type ToolProvider =
  | { readonly kind: 'builtin' }
  | { readonly kind: 'plugin' | 'mcp'; readonly id: string };

/**
 * `10` §3.2.3's rules 1 and 2.
 *
 * A plugin may raise its risk and never lower it, and a plugin `write` tool is at least `medium`
 * whatever it declared. Built-ins are exempt from the floor because their risk is reviewed in this
 * repository against `03`'s action registry — `lists.addItems` is genuinely low-risk, and forcing
 * it to `medium` would ask the group to confirm adding milk.
 */
export function effectiveRisk(
  definition: { readonly risk: Risk; readonly effect: ToolEffect },
  provider: ToolProvider,
  draftRisk?: Risk,
): Risk {
  const declared = maxRisk(definition.risk, ...(draftRisk === undefined ? [] : [draftRisk]));
  if (provider.kind === 'builtin' || definition.effect !== 'write') return declared;
  return maxRisk(declared, 'medium');
}

/**
 * `10` §3.2.3's rule 3.
 *
 * Never the plugin's own `capability` field: a plugin that could name its capability could name
 * `calendar.write` and borrow a grant the group gave to the calendar. For a built-in the field is
 * required, and a built-in without one is a bug in this repository — so it throws rather than
 * inventing something that would quietly fail every authorization.
 */
export function effectiveCapability(
  definition: { readonly name: string; readonly capability?: Capability },
  provider: ToolProvider,
): Capability {
  if (provider.kind !== 'builtin') return pluginCapability(provider.id, definition.name);
  if (definition.capability === undefined) {
    throw new Error(
      `built-in tool "${definition.name}" has no capability; built-ins must declare one from ` +
        "03 §3.1.2's catalog (10 §3.2.3)",
    );
  }
  return definition.capability;
}

/** The action draft for a tool that declared none: `10` §3.2.3's `{ kind: 'plugin.<id>.<name>' }`. */
export function defaultActionKind(
  definition: { readonly name: string },
  providerId: string,
): string {
  return `plugin.${providerId}.${definition.name}`;
}

/**
 * Declare a tool.
 *
 * Validates, proves both schemas convert to strict JSON Schema, freezes the definition, and returns
 * it with its types intact. The freeze is shallow and deliberate: the catalog hash is computed from
 * this object, so a definition that could be mutated after registration is a hash that lies. A deep
 * freeze would freeze the zod schemas, which keep internal caches.
 *
 * Throws an `Error` whose message lists every problem, one per line.
 */
export function defineTool<
  I,
  O,
  P extends PluginPermissions = PluginPermissions,
  S extends PluginSettingsShape = PluginSettingsShape,
>(definition: ToolDefinition<I, O, P, S>): ToolDefinition<I, O, P, S> {
  const problems = toolDefinitionProblems(definition);
  if (problems.length > 0) {
    throw new Error(
      `tool "${definition.name}" is not a valid definition:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
    );
  }
  // Eager, so a schema that cannot be made strict fails in the author's own test run rather than
  // during somebody else's install. `toolSchemas` caches, so the catalog pays nothing for this.
  toolSchemas(definition);
  return Object.freeze(definition);
}
