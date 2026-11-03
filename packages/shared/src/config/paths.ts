/**
 * Every configuration path, and its environment-variable name, **derived from the schema**.
 *
 * ADR-014 puts env at the top of the precedence chain, which needs a mapping from an environment
 * variable to a config path. Inventing a convention and maintaining it by hand would guarantee
 * drift — a key added to the schema would silently have no env override, and nobody would notice
 * until a host filed a bug.
 *
 * So the mapping is generated from the schema itself via zod's JSON Schema export. A new key gets
 * its env name for free, the generated env reference (`M3-T54`) cannot disagree with the loader,
 * and `collisions()` makes an ambiguous pair of names a test failure rather than a mystery.
 *
 * `dashboard.port` ⇄ `COMVIVO_DASHBOARD_PORT`
 * `privacy.messageRetentionDays` ⇄ `COMVIVO_PRIVACY_MESSAGE_RETENTION_DAYS`
 */
import { BRAND } from '../brand.js';
import { z } from '../zod.js';
import { configSchema } from './schema.js';

/** What a leaf expects, so an env string can be coerced to it. */
export type LeafType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'union' | 'unknown';

export interface ConfigLeaf {
  /** Dotted path, e.g. `dashboard.auth.magicLinks`. */
  readonly path: string;
  readonly type: LeafType;
  /** The schema default, when there is one. */
  readonly default?: unknown;
  /** Allowed values, for an enum. */
  readonly enumValues?: readonly string[];
  readonly nullable: boolean;
}

interface JsonSchemaNode {
  readonly type?: string | string[];
  readonly properties?: Record<string, JsonSchemaNode>;
  readonly anyOf?: readonly JsonSchemaNode[];
  readonly enum?: readonly unknown[];
  readonly default?: unknown;
}

function classify(node: JsonSchemaNode): { type: LeafType; nullable: boolean } {
  if (node.anyOf !== undefined) {
    const types = node.anyOf.map((branch) => branch.type);
    const nullable = types.includes('null');
    const concrete = node.anyOf.filter((branch) => branch.type !== 'null');
    if (concrete.length === 1) {
      const only = concrete[0];
      const sole = only === undefined ? undefined : only.type;
      return { type: typeof sole === 'string' ? toLeafType(sole) : 'unknown', nullable };
    }
    return { type: 'union', nullable };
  }
  const raw = Array.isArray(node.type) ? node.type.filter((t) => t !== 'null') : node.type;
  const nullable = Array.isArray(node.type) ? node.type.includes('null') : false;
  const single = Array.isArray(raw) ? raw[0] : raw;
  return { type: single === undefined ? 'unknown' : toLeafType(single), nullable };
}

/** Map a JSON Schema type name onto the closed set this module works with. */
function toLeafType(jsonSchemaType: string): LeafType {
  switch (jsonSchemaType) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'array':
      return jsonSchemaType;
    default:
      // `object` and `null` reach here, as would any type a future zod version emits. Treating
      // them as `unknown` means an env override falls back to JSON-then-string, which is the safe
      // behaviour for a shape we do not model.
      return 'unknown';
  }
}

function walk(node: JsonSchemaNode, prefix: string, out: ConfigLeaf[]): void {
  // An object with named properties is a branch; anything else is a leaf a host can set.
  if (node.properties !== undefined && node.anyOf === undefined) {
    for (const [key, child] of Object.entries(node.properties)) {
      walk(child, prefix === '' ? key : `${prefix}.${key}`, out);
    }
    return;
  }
  const { type, nullable } = classify(node);
  const leaf: {
    path: string;
    type: LeafType;
    nullable: boolean;
    default?: unknown;
    enumValues?: readonly string[];
  } = { path: prefix, type, nullable };
  if (node.default !== undefined) leaf.default = node.default;
  if (node.enum !== undefined) leaf.enumValues = node.enum.map(String);
  out.push(leaf);
}

let cached: readonly ConfigLeaf[] | undefined;

/** Every settable leaf in the schema, sorted by path. Computed once. */
export function configLeaves(): readonly ConfigLeaf[] {
  if (cached !== undefined) return cached;
  const json = z.toJSONSchema(configSchema, { io: 'input' }) as JsonSchemaNode;
  const leaves: ConfigLeaf[] = [];
  walk(json, '', leaves);
  leaves.sort((a, b) => a.path.localeCompare(b.path));
  cached = leaves;
  return cached;
}

/** `messageRetentionDays` → `MESSAGE_RETENTION_DAYS`. */
function screamingSnake(segment: string): string {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toUpperCase();
}

/** The environment-variable name for a config path. Prefix comes from `BRAND`, never a literal. */
export function envNameForPath(path: string): string {
  return BRAND.envPrefix + path.split('.').map(screamingSnake).join('_');
}

let envIndex: ReadonlyMap<string, ConfigLeaf> | undefined;

/** Environment-variable name → the leaf it sets. */
export function envNameIndex(): ReadonlyMap<string, ConfigLeaf> {
  if (envIndex !== undefined) return envIndex;
  const index = new Map<string, ConfigLeaf>();
  for (const leaf of configLeaves()) index.set(envNameForPath(leaf.path), leaf);
  envIndex = index;
  return envIndex;
}

/**
 * Pairs of paths whose environment names collide.
 *
 * Must always be empty. Two paths mapping to one variable would make an override silently apply to
 * whichever the map happened to hold — so this is asserted in a test rather than hoped for, and it
 * is the reason a new key cannot quietly break an existing override.
 */
export function collisions(): readonly { readonly envName: string; readonly paths: string[] }[] {
  const byName = new Map<string, string[]>();
  for (const leaf of configLeaves()) {
    const name = envNameForPath(leaf.path);
    byName.set(name, [...(byName.get(name) ?? []), leaf.path]);
  }
  return [...byName.entries()]
    .filter(([, paths]) => paths.length > 1)
    .map(([envName, paths]) => ({ envName, paths }));
}
