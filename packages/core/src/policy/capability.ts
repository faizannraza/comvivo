/**
 * The capability vocabulary (`03` §3.1.2, authoritative per `01` §14 A6; extends `01` §7.3).
 *
 * A capability gates a **kind of action**. Ownership and contest rules (`03` §3.3) gate *targets*;
 * information-flow control (`03` §3.4) gates *data*. A capability never grants read access to data
 * whose label excludes the reader — that separation is what keeps "may create events" from meaning
 * "may read every event".
 *
 * ## What is here and what is not
 *
 * This module is the **closed id union** and the plugin-capability syntax, and nothing else. It is
 * pulled forward to `M2-T5` because `ToolDefinition.capability` (`01` §7.4, `10` §3.2.3) cannot be
 * typed without it and `10` §3.2.3's rule 3 is a pure function over it.
 *
 * `M4-T1` owns `core/policy/capabilities.ts`: `CAPABILITY_CATALOG` with a summary and a
 * `defaultRisk` per id, `FLOOR_CAPABILITIES`, and the CI check that no capability string exists
 * outside the catalog. Those are deliberately **not** here — `defaultRisk` is a design decision
 * `M4-T2` makes together with the action registry, and duplicating the ids in two tables is how
 * the two would come to disagree. The split is logged in `STATUS.md` → Plan changes.
 */
import { z } from '@comvivo/shared';

/**
 * Every capability `03` §3.1.2 defines, in that table's order.
 *
 * The order is the table's so the two can be diffed by eye; nothing depends on it. The combined
 * rows (`lists.read / lists.write`) are split, because a role may hold one without the other —
 * that is the whole point of listing them as a pair.
 */
export const DOMAIN_CAPABILITIES = [
  'chat.ask',
  'constitution.read',
  'constitution.propose',
  'constitution.ratify',
  'proposals.vote',
  'memory.read',
  'memory.write',
  'memory.forget.own',
  'memory.forget.any',
  'calendar.read',
  'calendar.write',
  'calendar.rsvp',
  'reminders.self',
  'reminders.others',
  'tasks.read',
  'tasks.self',
  'tasks.assign',
  'tasks.manage_rotations',
  'lists.read',
  'lists.write',
  'polls.create',
  'polls.vote',
  'plans.read',
  'plans.write',
  'decisions.read',
  'decisions.record',
  'settings.read',
  'settings.write',
  'members.invite',
  'members.manage',
  'guardian.approve',
  'profile.self',
  'export.self',
  'export.group',
  'traces.read.own',
  'traces.read.group',
  'audit.read',
  'usage.read',
  'dashboard.access',
  'participate',
  'fairness.ledger.read',
  'web.search',
  'extensions.manage',
  'mcp.connect',
] as const;

export type DomainCapability = (typeof DOMAIN_CAPABILITIES)[number];

/**
 * A capability over an extension's tools (`03` §3.1.2's last row; syntax in `10` §3.1, §3.7.3).
 *
 * Three forms, widest first: `plugin:<id>` and `plugin:<id>:*` cover every tool a provider offers,
 * `plugin:<id>:<tool>` covers one. MCP client tools use the same shape with the server id, because
 * a group granting "may use the tools from this server" is making the same decision either way and
 * a second syntax would be a second thing to get wrong.
 */
export type PluginCapability = `plugin:${string}`;

export type Capability = DomainCapability | PluginCapability;

const DOMAIN_SET: ReadonlySet<string> = new Set<string>(DOMAIN_CAPABILITIES);

/**
 * Plugin and MCP provider ids share one namespace (`10` §3.1).
 *
 * The length floor of three characters and the `[a-z0-9]` tail come from the spec's own pattern.
 * `--` is refused separately by `isProviderId`, because a hyphen pair would map to `__` under
 * `10` §3.5.1's `-` → `_` substitution and collide with the `__` that separates a provider from a
 * tool in a model-facing name.
 */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

export function isProviderId(value: string): boolean {
  return PROVIDER_ID_PATTERN.test(value) && !value.includes('--');
}

/** A tool's local name inside its provider (`10` §3.2.3): snake_case, never a double underscore. */
export const TOOL_LOCAL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;

export function isToolLocalName(value: string): boolean {
  return TOOL_LOCAL_NAME_PATTERN.test(value) && !value.includes('__');
}

export function isDomainCapability(value: string): value is DomainCapability {
  return DOMAIN_SET.has(value);
}

export function isPluginCapability(value: string): value is PluginCapability {
  return parsePluginCapability(value) !== undefined;
}

export function isCapability(value: string): value is Capability {
  return isDomainCapability(value) || isPluginCapability(value);
}

/**
 * The capability for one extension tool (`10` §3.2.3's rule 3).
 *
 * Always computed, never taken from the plugin: a plugin that could name its own capability could
 * name `calendar.write` and borrow a grant the group gave to the calendar.
 *
 * Throws on a malformed id or name rather than returning a string nobody will match, because the
 * only callers are the host's registration path and tests, and a silently wrong capability is a
 * silently open door.
 */
export function pluginCapability(providerId: string, toolName: string): PluginCapability {
  if (!isProviderId(providerId)) {
    throw new Error(
      `"${providerId}" is not a provider id: ${String(PROVIDER_ID_PATTERN)} with no "--" (10 §3.1).`,
    );
  }
  if (!isToolLocalName(toolName)) {
    throw new Error(
      `"${toolName}" is not a tool name: ${String(TOOL_LOCAL_NAME_PATTERN)} with no "__" (10 §3.2.3).`,
    );
  }
  return `plugin:${providerId}:${toolName}`;
}

/** Every tool of one provider (`plugin:<id>:*`), the form a group grant usually takes. */
export function pluginWildcardCapability(providerId: string): PluginCapability {
  if (!isProviderId(providerId)) {
    throw new Error(
      `"${providerId}" is not a provider id: ${String(PROVIDER_ID_PATTERN)} with no "--" (10 §3.1).`,
    );
  }
  return `plugin:${providerId}:*`;
}

export interface ParsedPluginCapability {
  readonly providerId: string;
  /** The tool's local name, `'*'` for every tool, or `undefined` for the bare `plugin:<id>` form. */
  readonly toolName: string | undefined;
}

/**
 * Split a plugin capability, or `undefined` if it is not one.
 *
 * Returning `undefined` rather than throwing because this is also the validator: `isPluginCapability`
 * is defined as "this parses", so there is one definition of the syntax instead of a regex here
 * and a parser there.
 */
export function parsePluginCapability(value: string): ParsedPluginCapability | undefined {
  if (!value.startsWith('plugin:')) return undefined;
  const rest = value.slice('plugin:'.length);
  const separator = rest.indexOf(':');
  if (separator === -1) {
    return isProviderId(rest) ? { providerId: rest, toolName: undefined } : undefined;
  }
  const providerId = rest.slice(0, separator);
  const toolName = rest.slice(separator + 1);
  if (!isProviderId(providerId)) return undefined;
  if (toolName !== '*' && !isToolLocalName(toolName)) return undefined;
  return { providerId, toolName };
}

/**
 * A capability, validated.
 *
 * `z.custom` rather than `z.enum(DOMAIN_CAPABILITIES).or(z.templateLiteral(...))`: the plugin form
 * has structure a template literal cannot express (the id pattern, the `--` rule, the three
 * shapes), and splitting the check across two schemas would let `plugin:--bad:x` through whichever
 * half did not own it.
 */
export const capabilitySchema = z.custom<Capability>(
  (value) => typeof value === 'string' && isCapability(value),
  { error: 'not a capability from 03 §3.1.2, nor a plugin:<id>[:<tool>|:*] capability (10 §3.1)' },
);
