/**
 * The CLI's copy catalog (`09` §3.11.1: "ALL user-facing CLI strings"; `01` §11.12; `M3-T13`).
 *
 * Same reason as `packages/engine/src/copy.ts` and a deliberately smaller mechanism. `05` §3.11's
 * member-facing copy needs ICU — plurals, a percentage, a `select` — because it is read in a group
 * chat in the member's own language. These are a host's strings at a terminal, and every one of
 * them is a sentence with named substitutions and no grammatical agreement. So the formatter is
 * `{name}` replacement, which `09` §3.11.1's "versioned templates" is, rather than a second
 * dependency doing work nothing here needs.
 *
 * ## What the catalog is for
 *
 * Not localisation, yet — there is one locale. It is for **review**. `CLAUDE.md` §8 asks for
 * "clear fix-it messages for every error", and the only way to hold a product to that is to be
 * able to read every message it can print in one sitting. A hundred sentences spread over twenty
 * command files cannot be reviewed; one file can, and `copy.test.ts` snapshots it so a change to
 * any of them shows up as a diff in the review rather than as a line in a command.
 *
 * A missing key throws. `09` §3.11.2's output is a contract and a blank line in it is worse than a
 * crash: `copy.test.ts` renders every key, so a missing one cannot reach a host.
 */
import { readFileSync } from 'node:fs';
import { BRAND } from '@comvivo/shared';

const CATALOG = new URL('../copy/', import.meta.url);

/** The catalog, read once. */
const messages: Readonly<Record<string, string>> = JSON.parse(
  readFileSync(new URL('en.json', CATALOG), 'utf8'),
) as Record<string, string>;

export type CopyKey = string;

/**
 * Render one string.
 *
 * `brand` substitutions are supplied automatically — `{cli}`, `{product}` and `{docs}` — because
 * every third sentence needs one and a catalog that repeated `Comvivo` as a literal would fail
 * `brand:check` and, worse, would survive a rename.
 */
export function copy(key: CopyKey, params: Readonly<Record<string, string>> = {}): string {
  const template = messages[key];
  if (template === undefined) {
    throw new Error(`cli copy: there is no message for ${key}`);
  }
  const all: Record<string, string> = {
    cli: BRAND.cliName,
    product: BRAND.displayName,
    docs: BRAND.urls.docs,
    ...params,
  };
  return template.replaceAll(/\{(\w+)\}/g, (_whole, name: string) => {
    const value = all[name];
    if (value === undefined) {
      // A placeholder with no value would print as `{resetAt}` in a host's terminal. Throwing
      // means `copy.test.ts` finds it instead.
      throw new Error(`cli copy: ${key} needs {${name}}`);
    }
    return value;
  });
}

/** Every key in the catalog, for the test that renders them all. */
export function copyKeys(): readonly string[] {
  return Object.keys(messages);
}
