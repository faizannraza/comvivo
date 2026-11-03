/**
 * Validate GitHub issue forms (`13` §3.F.2).
 *
 * A malformed issue form **fails silently**: GitHub drops it from the chooser and shows nothing
 * in the API. `repository.issueTemplates` in GraphQL returns only legacy Markdown templates —
 * verified by control, since `vitejs/vite` has four YAML forms on disk and that field reports
 * zero — and the community-profile endpoint's `issue_template` is the same legacy field. So there
 * is no way to ask GitHub whether a form parsed, and a broken one looks exactly like a working
 * one until somebody tries to file an issue and the option is not there.
 *
 * The rules below are transcribed from SchemaStore's `github-issue-forms.json`, which is the
 * machine-readable form of GitHub's own documented schema, rather than written from memory.
 */
import { parse as parseYaml } from 'yaml';

export interface Problem {
  readonly file: string;
  readonly detail: string;
}

/** Item types and what each requires, from the schema's conditional branches. */
const ITEM_RULES: Readonly<
  Record<string, { readonly required: readonly string[]; readonly allowed: readonly string[] }>
> = {
  markdown: { required: ['value'], allowed: ['value'] },
  input: { required: ['label'], allowed: ['description', 'label', 'placeholder', 'value'] },
  textarea: {
    required: ['label'],
    allowed: ['description', 'label', 'placeholder', 'render', 'value'],
  },
  dropdown: {
    required: ['label', 'options'],
    allowed: ['default', 'description', 'label', 'multiple', 'options'],
  },
  checkboxes: { required: ['label', 'options'], allowed: ['description', 'label', 'options'] },
  upload: { required: ['label'], allowed: ['description', 'label'] },
};

const TOP_LEVEL_REQUIRED = ['name', 'description', 'body'];
const TOP_LEVEL_ALLOWED = [
  'assignees',
  'body',
  'description',
  'labels',
  'name',
  'projects',
  'title',
  'type',
];

/** `validations` is only meaningful on an item the user fills in. */
const TAKES_VALIDATIONS = new Set(['input', 'textarea', 'dropdown', 'checkboxes', 'upload']);

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate one body item. Separate so `validateIssueForm` stays a flat loop. */
function validateItem(
  raw: unknown,
  at: string,
  ids: Set<string>,
  add: (detail: string) => void,
): void {
  if (!isRecord(raw)) {
    add(`${at} is not a mapping`);
    return;
  }

  const type = raw['type'];
  if (typeof type !== 'string') {
    add(`${at} has no \`type\``);
    return;
  }
  const rule = ITEM_RULES[type];
  if (rule === undefined) {
    add(`${at} has an unknown type \`${type}\` (allowed: ${Object.keys(ITEM_RULES).join(', ')})`);
    return;
  }

  validateId(raw['id'], at, ids, add);

  if (raw['validations'] !== undefined && !TAKES_VALIDATIONS.has(type)) {
    add(`${at} is a \`${type}\` and cannot take \`validations\``);
  }

  const attributes = raw['attributes'];
  if (!isRecord(attributes)) {
    add(`${at} (${type}) has no \`attributes\``);
    return;
  }
  for (const key of rule.required) {
    if (attributes[key] === undefined) add(`${at} (${type}) is missing \`attributes.${key}\``);
  }
  for (const key of Object.keys(attributes)) {
    if (!rule.allowed.includes(key)) add(`${at} (${type}) has an unknown attribute \`${key}\``);
  }

  if (type === 'dropdown' || type === 'checkboxes') {
    validateOptions(attributes['options'], at, type, add);
  }
}

function validateId(
  id: unknown,
  at: string,
  ids: Set<string>,
  add: (detail: string) => void,
): void {
  if (id === undefined) return;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    add(`${at} has an invalid id ${JSON.stringify(id)}`);
    return;
  }
  if (ids.has(id)) {
    add(`${at} reuses the id \`${id}\``);
    return;
  }
  ids.add(id);
}

function validateOptions(
  options: unknown,
  at: string,
  type: string,
  add: (detail: string) => void,
): void {
  if (!Array.isArray(options) || options.length === 0) {
    add(`${at} (${type}) needs a non-empty \`attributes.options\``);
    return;
  }
  if (type !== 'checkboxes') return;
  options.forEach((option, index) => {
    if (!isRecord(option) || typeof option['label'] !== 'string') {
      add(`${at} option ${String(index)} needs a \`label\``);
    }
  });
}

export function validateIssueForm(file: string, source: string): Problem[] {
  const problems: Problem[] = [];
  const add = (detail: string): void => {
    problems.push({ file, detail });
  };

  let form: unknown;
  try {
    form = parseYaml(source, { merge: false });
  } catch (cause) {
    add(`is not valid YAML: ${String(cause)}`);
    return problems;
  }
  if (!isRecord(form)) {
    add('must be a mapping at the top level');
    return problems;
  }

  for (const key of TOP_LEVEL_REQUIRED) {
    if (form[key] === undefined) add(`is missing the required top-level key \`${key}\``);
  }
  for (const key of Object.keys(form)) {
    if (!TOP_LEVEL_ALLOWED.includes(key)) {
      add(`has an unknown top-level key \`${key}\` — GitHub ignores the whole form`);
    }
  }

  const body = form['body'];
  if (!Array.isArray(body)) {
    if (form['body'] !== undefined) add('`body` must be a list');
    return problems;
  }
  if (body.length === 0) add('`body` is empty');

  const ids = new Set<string>();
  body.forEach((raw, index) => {
    validateItem(raw, `body[${String(index)}]`, ids, add);
  });

  return problems;
}

/** `config.yml` is the chooser, not a form, and has its own small shape. */
export function validateChooserConfig(file: string, source: string): Problem[] {
  const problems: Problem[] = [];
  const add = (detail: string): void => {
    problems.push({ file, detail });
  };

  let config: unknown;
  try {
    config = parseYaml(source, { merge: false });
  } catch (cause) {
    add(`is not valid YAML: ${String(cause)}`);
    return problems;
  }
  if (!isRecord(config)) {
    add('must be a mapping at the top level');
    return problems;
  }

  for (const key of Object.keys(config)) {
    if (!['blank_issues_enabled', 'contact_links'].includes(key)) {
      add(`has an unknown key \`${key}\``);
    }
  }
  if (typeof config['blank_issues_enabled'] !== 'boolean') {
    add('`blank_issues_enabled` must be true or false');
  }

  const links = config['contact_links'];
  if (links !== undefined) {
    if (!Array.isArray(links)) {
      add('`contact_links` must be a list');
    } else {
      links.forEach((link, index) => {
        if (!isRecord(link)) {
          add(`contact_links[${String(index)}] is not a mapping`);
          return;
        }
        for (const key of ['name', 'url', 'about']) {
          if (typeof link[key] !== 'string' || link[key] === '') {
            add(`contact_links[${String(index)}] needs a \`${key}\``);
          }
        }
        const url = link['url'];
        if (typeof url === 'string' && !url.startsWith('https://')) {
          add(`contact_links[${String(index)}] url must be https`);
        }
      });
    }
  }

  return problems;
}
