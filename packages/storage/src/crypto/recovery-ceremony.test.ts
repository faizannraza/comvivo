/**
 * The recovery-key ceremony copy (`08` §3.7.6, `CLAUDE.md` §2 "copy is product").
 *
 * The copy lives in `templates/copy/privacy/recovery-ceremony.md` rather than in string literals,
 * which is the rule — but a template file nothing reads is a file that rots. Three things are
 * asserted here, and each of them has actually gone wrong somewhere in this repository before:
 *
 *  - **The sentences `08` §3.7.6 requires are present.** The spec names specific words ("the only
 *    way to restore your data", "cannot show it again") because they are what makes a host write
 *    the key down instead of clicking past it.
 *  - **The product name is never hard-coded.** `scripts/brand/check.ts` walks the TypeScript AST,
 *    so it cannot see a Markdown file at all — a literal "Comvivo" here would survive a rename and
 *    ship wrong. This is the check that covers that gap for this file.
 *  - **Every placeholder is one a caller can actually fill.** A typo in `{{cliNmae}}` would render
 *    literally into a terminal during a recovery ceremony, which is the worst place for it.
 *
 * `M3-T13` wires this to the CLI and `M9-T33` to the wizard. Until then this file is what keeps it
 * correct, and `02` D14's lesson applies: a thing with no test is a thing that is already wrong.
 */
import { readFileSync } from 'node:fs';
import { BRAND } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { GROUP_COUNT, RECOVERY_KEY_PREFIX, RETYPE_GROUPS } from './recovery-key.js';

const PATH = new URL('../../../../templates/copy/privacy/recovery-ceremony.md', import.meta.url);
const SOURCE = readFileSync(PATH, 'utf8');

/** The placeholders a caller supplies. Anything else in `{{…}}` is a typo. */
const PLACEHOLDERS = [
  'displayName',
  'cliName',
  'recoveryKey',
  'groupA',
  'groupB',
  'keyOutPath',
] as const;

/** The `# id` sections the ceremony is made of. */
function sections(): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | undefined;
  let body: string[] = [];
  for (const line of SOURCE.split('\n')) {
    const heading = /^# (\S+)$/.exec(line);
    if (heading?.[1] !== undefined) {
      if (current !== undefined) out.set(current, body.join('\n').trim());
      current = heading[1];
      body = [];
      continue;
    }
    if (current !== undefined) body.push(line);
  }
  if (current !== undefined) out.set(current, body.join('\n').trim());
  return out;
}

/**
 * A name reversed, character by character.
 *
 * Indexed rather than spread: `no-misused-spread` is right that spreading a string yields code
 * points, and a brand name is ASCII here — but the rule applies either way and an index loop says
 * what it does.
 */
function reversed(name: string): string {
  let out = '';
  for (let index = name.length - 1; index >= 0; index -= 1) out += name.charAt(index);
  return out;
}

/** Fill the template the way a caller would, so the rendered text can be read. */
function render(values: Partial<Record<(typeof PLACEHOLDERS)[number], string>> = {}): string {
  const filled: Record<string, string> = {
    displayName: BRAND.displayName,
    cliName: BRAND.cliName,
    recoveryKey: `${RECOVERY_KEY_PREFIX}-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000`,
    groupA: String(RETYPE_GROUPS[0] ?? 0),
    groupB: String(RETYPE_GROUPS[1] ?? 0),
    keyOutPath: '/home/host/recovery.txt',
    ...values,
  };
  return SOURCE.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => filled[name] ?? `??${name}??`);
}

describe('the ceremony copy exists and is well formed', () => {
  it('declares the spec section it implements', () => {
    expect(SOURCE).toContain('spec: 08 §3.7.6');
  });

  it('has every section the ceremony needs', () => {
    // Named rather than counted, so adding a section is free and removing one that a caller
    // renders is a failure here instead of a blank screen during a recovery.
    const ids = [...sections().keys()];
    expect(ids).toEqual([
      'write-this-down',
      'retype',
      'retype-mismatch',
      'retype-abandoned',
      'key-out-warning',
      'loss-consequences',
      'verify-reminder',
    ]);
  });

  it('uses only placeholders a caller can fill', () => {
    const used = new Set([...SOURCE.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]));
    for (const name of used) {
      expect(PLACEHOLDERS as readonly string[]).toContain(name);
    }
    expect(used.size).toBeGreaterThan(0);
  });

  it('declares its placeholders in the front matter, matching what it uses', () => {
    // The front matter is what a renderer reads to know what to supply, so a mismatch between it
    // and the body is how a placeholder ends up unfilled.
    const declared = /^placeholders: \[(.+)\]$/m
      .exec(SOURCE)?.[1]
      ?.split(',')
      .map((name) => name.trim());
    expect(declared).toBeDefined();
    expect(new Set(declared)).toEqual(new Set(PLACEHOLDERS));
  });

  it('leaves nothing unfilled once rendered', () => {
    expect(render()).not.toMatch(/\{\{|\?\?/);
  });
});

describe('08 §3.7.6 step 1 — write this down', () => {
  it('says it is the only way back, and that it will not be shown again', () => {
    // The spec quotes these almost verbatim, and they are the two facts that decide whether a host
    // writes the key down or clicks past the screen.
    const body = sections().get('write-this-down') ?? '';
    expect(body).toContain('the only way to restore your data');
    expect(body).toContain('cannot show it again');
    expect(body.toLowerCase()).toContain('write this down');
  });

  it('shows the key itself', () => {
    expect(sections().get('write-this-down')).toContain('{{recoveryKey}}');
  });

  it('says what having the key means, not only what losing it means', () => {
    // A host who leaves it in a shared drive has not lost anything yet, so the warning has to be
    // about disclosure as well as about loss.
    expect(sections().get('write-this-down')).toContain('Anyone who has it');
  });
});

describe('08 §3.7.6 step 2 — retype', () => {
  it('asks for the two groups the codec nominates', () => {
    // Driven from `RETYPE_GROUPS` rather than written out, so the copy and the check cannot
    // disagree about which groups the user is asked for.
    const rendered = render();
    const [first, second] = RETYPE_GROUPS;
    expect(rendered).toContain(`group ${String(first)} and group ${String(second)}`);
  });

  it('explains the numbering, because the tag looks like a group', () => {
    const body = sections().get('retype') ?? '';
    expect(body).toContain('starting at 1');
    expect(body).toContain(RECOVERY_KEY_PREFIX);
  });

  it('tells the user the forgiving bits are forgiving', () => {
    // Otherwise somebody stares at an `O` wondering whether it is a zero, which is exactly the
    // anxiety Crockford base32 exists to remove.
    const body = sections().get('retype') ?? '';
    expect(body).toContain('Case does not');
    expect(body).toMatch(/`I`, `L` and `O`/);
  });

  it('offers a way out that loses nothing', () => {
    // `rotateRecovery` keeps the old key when the ceremony is abandoned, and the copy has to say
    // so — a user who thinks they have broken something will press on with a key they cannot read.
    const body = sections().get('retype-abandoned') ?? '';
    expect(body).toContain('still works');
    expect(body).toContain('nothing has been lost');
    expect(render()).toContain(`${BRAND.cliName} keys rotate-recovery`);
  });
});

describe('08 §3.7.6 step 3 — writing it to a file', () => {
  it('warns about the file, specifically about backups', () => {
    const body = sections().get('key-out-warning') ?? '';
    expect(body).toContain('weaker than paper');
    expect(body).toContain('backs this machine up');
  });

  it('says the data directory is refused, and why', () => {
    // `08` §3.7.6: "never into `dataDir`". The reason is worth stating: it would put the key that
    // decrypts a backup inside the backup.
    const body = sections().get('key-out-warning') ?? '';
    expect(body).toContain('refuse to write it inside the data directory');
    expect(body).toContain('inside the backup');
  });
});

describe('08 §3.7.8 — the loss table, in bold at init', () => {
  it('lists exactly the three routes back', () => {
    const body = sections().get('loss-consequences') ?? '';
    expect(body).toContain('key file');
    expect(body).toContain('recovery key');
    expect(body).toContain('passphrase');
  });

  it('says total loss is permanent and by design, in bold', () => {
    // `08` §3.7.8: "All encrypted data is unrecoverable, by design. Docs say so in bold at init."
    const body = sections().get('loss-consequences') ?? '';
    expect(body).toMatch(/\*\*[^*]*gone — permanently, and by design\.\*\*/);
  });

  it('does not offer a recovery path that does not exist', () => {
    // The failure mode here is reassurance: a sentence implying support could help would be a lie,
    // and a host who believed it would not write the key down.
    const body = sections().get('loss-consequences') ?? '';
    expect(body).toContain('no account to recover through');
    expect(render()).toContain(`nobody at ${BRAND.displayName} who can help`);
  });
});

describe('the name is never hard-coded', () => {
  it('contains no literal product name anywhere', () => {
    // `scripts/brand/check.ts` walks the TypeScript AST, so it never reads this file. A literal
    // "Comvivo" here would survive a rename and ship wrong, and this is the check that covers it.
    expect(SOURCE.toLowerCase()).not.toContain(BRAND.codename);
  });

  it('renders the name from BRAND where it appears', () => {
    const rendered = render();
    expect(rendered).toContain(BRAND.displayName);
    expect(rendered).toContain(BRAND.cliName);
  });

  it('survives a rename, which is the whole point', () => {
    // Proven rather than asserted: rendered under a different brand, nothing says the old name.
    //
    // The foreign brand is **derived**, not written out. The first version used `'Zzbrand'`, which
    // is exactly the throwaway slug the weekly rename drill renames the tree to — so during the
    // drill `BRAND.codename` *was* `zzbrand` and this test's deliberately-foreign literal became a
    // real hard-coded brand literal. Reversing the name guarantees a different one whatever the
    // product is called, and the assertion below guarantees it is a usable counter-example.
    const other = reversed(BRAND.displayName);
    const otherCli = reversed(BRAND.cliName);
    expect(
      otherCli.toLowerCase().includes(BRAND.codename),
      'the reversed name still contains the codename, so this test proves nothing',
    ).toBe(false);

    const renamed = render({ displayName: other, cliName: otherCli });
    expect(renamed).toContain(`${other} cannot show it again`);
    expect(renamed).toContain(`${otherCli} keys rotate-recovery`);
    expect(renamed.toLowerCase()).not.toContain(BRAND.codename);
  });
});

describe('the copy agrees with the codec', () => {
  it('shows a key with the right number of groups', () => {
    // A sample in the copy that did not look like a real key would train a host to accept the
    // wrong shape. Checked against `GROUP_COUNT` so the two cannot drift.
    const sample = /^ {4}(VRK1-\S+)$/m.exec(render())?.[1];
    expect(sample).toBeDefined();
    expect(sample?.split('-').slice(1)).toHaveLength(GROUP_COUNT);
  });

  it('names the key directory the keyring actually uses', () => {
    expect(sections().get('loss-consequences')).toContain('data/keys/');
  });
});
