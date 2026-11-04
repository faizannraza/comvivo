/**
 * When a pull request needs a changeset (`12` §3.10.1).
 *
 * The rule: a change to **shipped behaviour** needs a release note, or an explicit label saying it
 * does not. Tests, docs, CI and internal tooling do not.
 *
 * The label matters more than it looks. `no-changeset` is not a way around the check — it is the
 * record that somebody decided this change does not affect a host, attached to the pull request
 * where a reviewer can disagree. A check with no escape hatch gets disabled; a check whose escape
 * hatch is visible and attributable stays on.
 */

/**
 * Paths that ship.
 *
 * The root `package.json` is here because `engines` is the supported Node floor — shipped
 * behaviour by any reading, and a host on the old floor finds out by their install failing.
 * `pnpm-workspace.yaml` likewise carries `allowBuilds` and the dependency overrides. Found by the
 * M0 independent review, which noted a change to either needed no changeset.
 */
const SHIPPED = [
  /^apps\//,
  /^packages\//,
  /^deploy\//,
  /^package\.json$/,
  /^pnpm-workspace\.yaml$/,
];

/**
 * Paths inside those trees that do not ship.
 *
 * `apps/docs` is the documentation site: it deploys, but it is not the product, and `13` owns its
 * own release path.
 */
const NOT_SHIPPED = [
  /^apps\/docs\//,
  /\.test\.tsx?$/,
  /\.int\.test\.tsx?$/,
  /\.contract\.test\.tsx?$/,
  /\.prop\.test\.tsx?$/,
  /\.scenario\.ts$/,
  /\.bench\.ts$/,
  /\/__fixtures__\//,
  /\/__snapshots__\//,
  /\/testing\//,
  /\.md$/,
  /\.mdx$/,
  /^packages\/evals\//,
];

export function isShippedPath(path: string): boolean {
  if (!SHIPPED.some((pattern) => pattern.test(path))) return false;
  return !NOT_SHIPPED.some((pattern) => pattern.test(path));
}

export interface Decision {
  readonly required: boolean;
  /** The shipped files that triggered the requirement, for the message. */
  readonly reasons: readonly string[];
  readonly satisfied: boolean;
  readonly waived: boolean;
}

export interface Inputs {
  readonly changedFiles: readonly string[];
  /** `.changeset/*.md` entries, excluding `README.md`. */
  readonly changesets: readonly string[];
  readonly labels: readonly string[];
}

export const WAIVER_LABEL = 'no-changeset';

export function decide(inputs: Inputs): Decision {
  const reasons = inputs.changedFiles.filter(isShippedPath);
  const waived = inputs.labels.some((label) => label.toLowerCase() === WAIVER_LABEL);
  return {
    required: reasons.length > 0,
    reasons,
    satisfied: inputs.changesets.length > 0,
    waived,
  };
}

/** Whether to fail. Separated from `decide` so the message and the verdict cannot disagree. */
export function shouldFail(decision: Decision): boolean {
  return decision.required && !decision.satisfied && !decision.waived;
}

export function explain(decision: Decision): string {
  if (!decision.required) {
    return 'changeset: not required — no shipped file changed.\n';
  }
  if (decision.satisfied) {
    return 'changeset: present.\n';
  }
  if (decision.waived) {
    return `changeset: waived by the \`${WAIVER_LABEL}\` label.\n`;
  }

  const shown = decision.reasons.slice(0, 10);
  const more = decision.reasons.length - shown.length;
  return [
    'changeset: this pull request changes shipped behaviour and has no changeset.',
    '',
    ...shown.map((path) => `  ${path}`),
    ...(more > 0 ? [`  …and ${String(more)} more`] : []),
    '',
    'Run `pnpm changeset` and write one sentence a host would recognise. Start it with a type —',
    'breaking:, security:, upgrade:, feat:, fix:, perf: or docs: — because the type decides which',
    'heading it appears under in the release notes. See `.changeset/README.md`.',
    '',
    `If this genuinely does not affect anybody running Comvivo, add the \`${WAIVER_LABEL}\` label.`,
    'The label is deliberate: it puts the decision, and whoever made it, in the record.',
    '',
  ].join('\n');
}
