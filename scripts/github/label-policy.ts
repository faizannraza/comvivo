/**
 * The label policy (`13` §3.F.2): parse `.github/labels.yml`, and work out what to change.
 *
 * **Reconcile, not replace.** It creates what is missing, updates a colour or description that
 * drifted, and *reports* extras without deleting them.
 *
 * Not deleting is the important part. A label applied to a hundred old issues is somebody's triage
 * work, and a sync job that removes it because it is not in a file is a sync job that quietly eats
 * data — which is how label-syncing actions usually behave by default. Extras are printed so they
 * can be added to the file or removed deliberately by a person.
 *
 * Uses `gh` rather than a third-party action. The action would be one more thing with a token on
 * this repository (`08` §3.15), for a job that is one API call per label.
 */
import { parse as parseYaml } from 'yaml';

export interface Label {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

/** Validate one entry. Separate so `parseLabels` stays a flat loop over groups. */
function toLabel(group: string, entry: unknown, seen: Set<string>): Label {
  const label = entry as Partial<Label>;
  if (typeof label.name !== 'string' || label.name === '') {
    throw new Error(`a label in ${group} has no name`);
  }
  if (typeof label.color !== 'string' || !/^[0-9A-Fa-f]{6}$/.test(label.color)) {
    throw new Error(`${label.name} has an invalid colour: ${String(label.color)}`);
  }
  if (typeof label.description !== 'string' || label.description === '') {
    // A label with no description is a label people guess at, and two people guess differently.
    throw new Error(`${label.name} has no description`);
  }
  if (seen.has(label.name)) throw new Error(`${label.name} is declared twice`);
  seen.add(label.name);
  return { name: label.name, color: label.color.toUpperCase(), description: label.description };
}

/** Flatten the grouped file into one list, rejecting malformed entries loudly. */
export function parseLabels(source: string): Label[] {
  const parsed: unknown = parseYaml(source, { merge: false });
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('labels.yml must be a mapping of group name to a list of labels');
  }
  const labels: Label[] = [];
  const seen = new Set<string>();
  for (const [group, list] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(list)) throw new Error(`group ${group} is not a list`);
    for (const entry of list) labels.push(toLabel(group, entry, seen));
  }
  return labels;
}

export interface Plan {
  readonly create: readonly Label[];
  readonly update: readonly Label[];
  readonly extra: readonly string[];
  readonly unchanged: number;
}

export function planSync(wanted: readonly Label[], existing: readonly Label[]): Plan {
  const byName = new Map(existing.map((label) => [label.name, label]));
  const create: Label[] = [];
  const update: Label[] = [];
  let unchanged = 0;

  for (const label of wanted) {
    const current = byName.get(label.name);
    if (current === undefined) {
      create.push(label);
    } else if (
      current.color.toUpperCase() !== label.color ||
      current.description !== label.description
    ) {
      update.push(label);
    } else {
      unchanged += 1;
    }
  }

  const wantedNames = new Set(wanted.map((label) => label.name));
  const extra = existing.map((label) => label.name).filter((name) => !wantedNames.has(name));
  return { create, update, extra, unchanged };
}

/**
 * What `--check` should exit with, given a plan.
 *
 * A **policy**, not an implementation detail, so it lives next to the plan it reads and has its
 * own cases: the drift this check exists for is somebody editing a label in the web UI, which
 * shows up as an `update`. A `create` is the file introducing a label the repository has not been
 * told about yet — which is every pull request that adds one, since the sync runs on a push to
 * `main`. Failing there made the check red for exactly the change it was meant to review
 * (`M1-T35`, adding `mutation-survivor`), and a check that cannot be satisfied is a check people
 * learn to ignore.
 *
 * An `extra` label is never deleted and never a failure: a label applied to a hundred old issues
 * is somebody's triage work.
 */
export function checkExitCode(plan: Plan): number {
  return plan.update.length > 0 ? 1 : 0;
}
