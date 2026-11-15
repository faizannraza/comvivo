/**
 * `08` SD-04: **no command prints an existing recovery key** (`M3-T13`'s AC).
 *
 * The rule is a property of the product, not of one module, so it is checked over the whole
 * command tree and over the whole source of this package rather than over `keys/index.ts`. Two
 * complementary assertions, because each misses what the other catches:
 *
 *  - **the command tree** has no command that could: nothing named to suggest showing a key, and
 *    no option that would produce one;
 *  - **the source** calls the one function that can print a key (`deps.ceremony`) from exactly one
 *    place, which is `rotate-recovery` — the command that prints a key that **did not exist a
 *    moment ago**.
 *
 * That second assertion is the one that keeps working. SD-04 is not broken by somebody adding
 * `keys show-recovery`; it is broken by a well-meaning `keys status --verbose` that prints a slot's
 * contents, or by a `--json` envelope that serialises a `RotateRecoveryResult` whole. Both of those
 * are a new call to something that has a key in hand, and a reviewer reading the diff would see a
 * printer call rather than a leak.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keysCommand } from './index.js';

/** Every `.ts` under `apps/cli/src`, excluding tests. */
function sourceFiles(root: string): readonly string[] {
  const found: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(path);
    }
  };
  walk(root);
  return found;
}

const SRC = new URL('../../', import.meta.url).pathname;

/** The deps a command tree needs to be *built*. None of them is called by these tests. */
const inert = {
  context: () => {
    throw new Error('not called');
  },
  printer: () => {
    throw new Error('not called');
  },
  env: {},
  canPrompt: () => false,
  keyStore: () => 'keyfile' as const,
  readSecretLine: () => Promise.resolve(''),
  readNewPassphrase: () => Promise.resolve(''),
  confirm: () => Promise.resolve(),
  ceremony: () => Promise.resolve(false),
  storeMasterKey: () => Promise.resolve(),
  setExitCode: () => undefined,
};

describe('08 SD-04: a recovery key is printed once and never shown again', () => {
  it('registers no command that would show one', () => {
    const names = keysCommand(inert).commands.map((command) => command.name());
    // The eight that `M3-T13` wires. `rotate-data` and `rotate-sessions` are M9's — they need
    // maintenance mode and a running server — and `09` §3.11.3's milestone column says so.
    expect(names.toSorted()).toEqual([
      'add-passphrase',
      'purge-retired',
      'recover',
      'remove-slot',
      'rotate-master',
      'rotate-recovery',
      'status',
      'verify-recovery',
    ]);
    // And nothing that reads as "show me the key". A `show`, `print`, `export` or `reveal` here
    // would be the feature SD-04 forbids, whatever its implementation did.
    for (const name of names) {
      expect(name, `\`keys ${name}\` reads as a command that would reveal a key`).not.toMatch(
        /^(show|print|export|reveal|get|dump)/,
      );
    }
  });

  it('offers no option that would produce one', () => {
    for (const command of keysCommand(inert).commands) {
      for (const option of command.options) {
        const flag = option.long ?? option.short ?? '';
        // `--recovery-key-out` is allowed and is the exception that proves the rule: it writes the
        // **new** key `rotate-recovery` just made, to a path the host chose, at mode 0600. An
        // `--show-recovery-key` or a `--recovery-key-in` on any other command would be a way to
        // get the existing one out.
        if (command.name() === 'rotate-recovery' && flag === '--recovery-key-out') continue;
        expect(flag, `\`keys ${command.name()} ${flag}\``).not.toMatch(/recovery-key-out|show/);
      }
    }
  });

  it('calls the one key-printing function from exactly one place', () => {
    // `deps.ceremony` is the only member of `CommandDeps` that receives a recovery key, so the
    // number of its call sites is the number of places a key can reach a stream. One, in
    // `rotate-recovery`.
    const callSites = sourceFiles(SRC)
      .map((path) => ({ path, text: readFileSync(path, 'utf8') }))
      // `deps.ceremony(` — the call, not the declaration in `deps.ts` or the implementation in
      // `main.ts`, both of which are the plumbing rather than a use of it.
      .filter((file) => file.text.includes('deps.ceremony('));
    expect(callSites.map((file) => file.path.replace(SRC, ''))).toEqual(['commands/keys/index.ts']);
    const uses = callSites[0]?.text.match(/deps\.ceremony\(/g) ?? [];
    expect(uses).toHaveLength(1);
  });

  it('keeps the new key out of the --json envelope', () => {
    // `--json` output is piped into logs and pasted into issues. `08` SD-04's "printed once" means
    // printed to the terminal, not serialised — so `rotate-recovery`'s envelope carries the slot
    // ids and not `result.printed`.
    const source = readFileSync(join(SRC, 'commands/keys/index.ts'), 'utf8');
    const rotateRecovery = source.slice(
      source.indexOf(`.command('rotate-recovery')`),
      source.indexOf(`.command('recover')`),
    );
    expect(rotateRecovery).toContain('printer.envelope(');
    expect(rotateRecovery, 'the printed key reached the --json envelope').not.toMatch(
      /envelope\([^)]*printed/s,
    );
  });
});
