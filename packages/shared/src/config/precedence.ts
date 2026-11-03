/**
 * Configuration precedence.
 *
 * ADR-014: **env > DB settings > `comvivo.yaml` > defaults**, with one exception that matters more
 * than the ordering itself — `01` §14 **A14**: *host-only keys never read from the database.*
 *
 * Why that exception exists, concretely. Group admins are members, and `01` §9 trust boundary 2
 * says a member may be adversarial toward the others. Dashboard settings are stored in the
 * database. If `network.egress.allowPrivate` could be set from there, an admin could point the
 * instance at a host they control and exfiltrate another member's data through a feature that looks
 * legitimate in the audit log. So DB values for those paths are not merely overridden — they are
 * **dropped and reported**, so the API can answer `403 host_only` and write an audit event
 * (`08` §5).
 *
 * Merging happens on flattened dotted paths rather than by deep object merge, because deep merge
 * has no good answer for arrays: a host who sets `network.egress.allowPrivate: []` in YAML to clear
 * a list must get an empty list, not a union with whatever was there before.
 */
import { isHostOnly } from './host-only.js';

/** A plain JSON-ish object. */
export type Settings = Record<string, unknown>;

function isPlainObject(value: unknown): value is Settings {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Flatten to dotted leaf paths. Arrays are leaves: a list is a value a host sets whole.
 */
export function flatten(value: unknown, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!isPlainObject(value)) {
    if (prefix !== '') out.set(prefix, value);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (isPlainObject(child)) {
      // An empty object is itself a leaf; otherwise it would vanish on the round trip.
      if (Object.keys(child).length === 0) out.set(path, {});
      else for (const [k, v] of flatten(child, path)) out.set(k, v);
    } else {
      out.set(path, child);
    }
  }
  return out;
}

/** Rebuild a nested object from dotted paths. */
export function unflatten(entries: Iterable<readonly [string, unknown]>): Settings {
  const root: Settings = {};
  for (const [path, value] of entries) {
    const segments = path.split('.');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const segment = segments[i] as string;
      const next = node[segment];
      if (!isPlainObject(next)) node[segment] = {};
      node = node[segment] as Settings;
    }
    node[segments[segments.length - 1] as string] = value;
  }
  return root;
}

/** Where a resolved value came from. Surfaced in the dashboard so a host can see why. */
export type Source = 'default' | 'yaml' | 'db' | 'env';

export interface MergeInput {
  /** Parsed `comvivo.yaml`. */
  readonly yaml?: Settings;
  /** Runtime settings from the database, edited through the dashboard. */
  readonly db?: Settings;
  /** Environment overrides, already coerced to their schema types. */
  readonly env?: Settings;
}

export interface MergeOutcome {
  /** The merged settings, ready to hand to the schema — which then supplies the defaults. */
  readonly settings: Settings;
  /** Which source won each path. */
  readonly origin: ReadonlyMap<string, Source>;
  /**
   * Host-only paths that the database tried to set, and that were ignored.
   *
   * Never empty by accident: reaching here means something wrote a protected key into the settings
   * table, which the API refuses with `403 host_only`. Worth logging as a security event rather
   * than discarding quietly.
   */
  readonly rejectedHostOnlyFromDb: readonly string[];
}

/**
 * Merge the sources in ADR-014's order, dropping host-only keys that came from the database.
 *
 * Defaults are deliberately *not* merged here: the schema owns them, so there is exactly one place
 * a default is written and the merge cannot drift from it.
 */
export function mergeByPrecedence(input: MergeInput): MergeOutcome {
  const settings = new Map<string, unknown>();
  const origin = new Map<string, Source>();
  const rejected: string[] = [];

  for (const [path, value] of flatten(input.yaml ?? {})) {
    settings.set(path, value);
    origin.set(path, 'yaml');
  }

  for (const [path, value] of flatten(input.db ?? {})) {
    if (isHostOnly(path)) {
      rejected.push(path);
      continue;
    }
    settings.set(path, value);
    origin.set(path, 'db');
  }

  for (const [path, value] of flatten(input.env ?? {})) {
    settings.set(path, value);
    origin.set(path, 'env');
  }

  return {
    settings: unflatten(settings),
    origin,
    rejectedHostOnlyFromDb: rejected.sort(),
  };
}
