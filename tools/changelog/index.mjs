/**
 * The changelog formatter (`12` §3.10.1).
 *
 * Changesets calls `getReleaseLine` once per changeset and assembles the result under its own
 * Major/Minor/Patch headings. That grouping is right for a library and wrong for a product: a host
 * deciding whether to upgrade their family's bot wants to know what breaks and what they must do,
 * not which semver bucket a change landed in.
 *
 * So every summary starts with a type, and the type decides the heading. `TYPE_ORDER` puts the
 * things that can cost somebody their evening first — breaking changes, security fixes, required
 * upgrade steps — and the pleasant news after.
 *
 * **No network.** `@changesets/changelog-github` resolves pull-request numbers and authors through
 * the GitHub API, which needs a token and fails without one. A formatter that cannot run on a
 * contributor's laptop is a formatter that gets replaced by hand-editing, so this one links the
 * commit Changesets already recorded and nothing else. `tools/release/notes.ts` (M12) adds the
 * pull-request links, where a token genuinely is available.
 */

/**
 * The type catalog, in the order a host should read it.
 *
 * `heading` is what appears in `CHANGELOG.md`. Order is deliberate and not alphabetical: somebody
 * skimming a release note stops reading after the first section that does not concern them, so the
 * sections that could cost them something come first.
 */
export const TYPES = [
  { type: 'breaking', heading: 'Breaking changes' },
  { type: 'security', heading: 'Security' },
  { type: 'upgrade', heading: 'Upgrade notes' },
  { type: 'feat', heading: 'New' },
  { type: 'fix', heading: 'Fixed' },
  { type: 'perf', heading: 'Performance' },
  { type: 'docs', heading: 'Documentation' },
];

/** Summaries with no recognised type land here rather than being dropped. */
export const OTHER = { type: 'other', heading: 'Other changes' };

export const TYPE_ORDER = TYPES.map((entry) => entry.type);

const HEADINGS = new Map([...TYPES, OTHER].map((entry) => [entry.type, entry.heading]));

export function headingFor(type) {
  return HEADINGS.get(type) ?? OTHER.heading;
}

const TYPE_PREFIX = /^\s*([a-z]+)\s*:\s*(.*)$/s;

/**
 * Split `feat: reminders can now …` into its type and its text.
 *
 * An unrecognised prefix is **not** treated as a type: `note: something` keeps its whole text and
 * becomes `other`. Silently swallowing the first word of a summary because it happened to end in a
 * colon would quietly mangle release notes, and the author would not find out until a host read it.
 */
export function parseSummary(summary) {
  const trimmed = String(summary ?? '').trim();
  const match = TYPE_PREFIX.exec(trimmed);
  if (match === null) return { type: OTHER.type, text: trimmed };
  const [, candidate = '', rest = ''] = match;
  if (!TYPE_ORDER.includes(candidate)) return { type: OTHER.type, text: trimmed };
  return { type: candidate, text: rest.trim() };
}

/**
 * Group parsed entries into sections, in `TYPES` order, dropping empty ones.
 *
 * Pure, and exported so `tools/release/notes.ts` composes GitHub Release notes from the same
 * grouping that `CHANGELOG.md` uses — two renderings of one decision rather than two decisions
 * that drift.
 */
export function groupEntries(entries) {
  const byType = new Map();
  for (const entry of entries) {
    const type = TYPE_ORDER.includes(entry.type) ? entry.type : OTHER.type;
    const list = byType.get(type) ?? [];
    list.push(entry);
    byType.set(type, list);
  }
  return [...TYPE_ORDER, OTHER.type]
    .filter((type) => (byType.get(type) ?? []).length > 0)
    .map((type) => ({ type, heading: headingFor(type), entries: byType.get(type) ?? [] }));
}

/** Render grouped sections as Markdown. Used by `notes.ts`; `CHANGELOG.md` gets the line form. */
export function renderSections(sections) {
  return sections
    .map(({ heading, entries }) => {
      const lines = entries.map((entry) => `- ${entry.text}`).join('\n');
      return `### ${heading}\n\n${lines}`;
    })
    .join('\n\n');
}

/** `abc1234` → a short commit link, when Changesets recorded a commit. */
function commitSuffix(commit, repo) {
  if (typeof commit !== 'string' || commit === '') return '';
  const short = commit.slice(0, 7);
  if (typeof repo !== 'string' || repo === '') return ` (\`${short}\`)`;
  return ` ([\`${short}\`](https://github.com/${repo}/commit/${commit}))`;
}

/**
 * One changelog line.
 *
 * The type is rendered as a bold prefix so the grouping survives into `CHANGELOG.md`, which
 * Changesets writes under its own semver headings and which this hook cannot restructure. The
 * section headings themselves appear in the GitHub Release notes, composed by `notes.ts`.
 */
export async function getReleaseLine(changeset, _type, options) {
  const repo = options?.repo;
  const { type, text } = parseSummary(changeset.summary);
  const [first = '', ...rest] = text.split('\n');
  const label = type === OTHER.type ? '' : `**${headingFor(type)}:** `;
  const suffix = commitSuffix(changeset.commit, repo);
  const head = `\n\n- ${label}${first.trim()}`;

  // The commit link goes at the END of the entry, not at the end of its first line.
  //
  // It used to go on the first line, which on a wrapped multi-line summary dropped the link into
  // the middle of a sentence: "A `.env` line with the `=` ([`dc92996`](…)) missing had its whole
  // text echoed". Found the first time `changeset version` ever ran with a real changeset — the
  // unit tests called this function directly with one-line summaries and never saw it.
  const lines = rest.map((line) => (line.trim() === '' ? '' : `  ${line.trimEnd()}`));
  let last = lines.length - 1;
  while (last >= 0 && lines[last] === '') last -= 1;
  if (last < 0) return `${head}${suffix}`;
  lines[last] = `${lines[last]}${suffix}`;
  return `${head}\n${lines.join('\n')}`;
}

/**
 * The dependency line.
 *
 * Returns an empty string for workspace-internal bumps. Every `@comvivo/*` package except the SDKs
 * is private and bundled into the server, so "Updated dependencies: @comvivo/storage@0.0.1" tells
 * a host nothing they can act on — it is noise in the one document they read before upgrading.
 */
export async function getDependencyReleaseLine(_changesets, dependenciesUpdated, _options) {
  const external = dependenciesUpdated.filter(
    (dependency) => !String(dependency.name).startsWith('@comvivo/'),
  );
  if (external.length === 0) return '';
  const lines = external.map((dependency) => `  - ${dependency.name}@${dependency.newVersion}`);
  return `\n\n- Updated dependencies:\n${lines.join('\n')}`;
}

export default { getReleaseLine, getDependencyReleaseLine };
