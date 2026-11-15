/**
 * `comvivo keys …` (`09` §3.11.3; `08` §3.7.6–§3.7.8; `M3-T13`).
 *
 * Thin by design. Every one of these is "find the keyring, get the key this operation needs, call
 * the `M1-T6` function, print the result" — the mechanics, the crash-safety and the ordering are
 * `packages/storage/src/crypto/key-ops.ts`'s, under its own tests, and a CLI that re-implemented
 * any of it would be a second place for a key operation to go wrong.
 *
 * ## `08` SD-04, in code rather than in a comment
 *
 * **No command prints an existing recovery key.** There is no `keys show-recovery`, and the only
 * place a recovery key reaches stdout is `rotate-recovery`, which prints a key that did not exist a
 * moment ago. `keys.sd04.test.ts` asserts it over the whole command tree rather than over this
 * file, because the rule is about the product and not about one module.
 *
 * ## Which rotations are here, and which are M9's
 *
 * `14` M3-T13 writes `rotate-*`, and two of the four rotations cannot be wired yet:
 *
 *  - **`rotate-data`** needs `RotateDataPorts` — `08` §3.7.7 step 2's maintenance mode (actors
 *    paused, outbox held), `PRAGMA rekey` on a live database, and the resumable blob-DEK rewrap.
 *    Maintenance mode arrives with the composition root (`M3-T15`) and the blob rewrap with its
 *    own batch job.
 *  - **`rotate-sessions`** needs a `SessionEpochStore`, which is a settings write, which needs the
 *    database open — so it is an online operation through the Control API (`09` D-04) and the
 *    Control API is `M3-T14`'s successor work.
 *
 * `09` §3.11.3's own milestone column already says **M9** for the `keys rotate-*` row, so this is
 * the two documents agreeing rather than a gap: the library landed at `M1-T6`, the eight commands
 * that need only the keyring land here, and the two that need a running server land with it.
 * Recorded in `STATUS.md` → Plan changes.
 */
import { Command } from '@commander-js/extra-typings';
import { withZeroedAsync } from '@comvivo/shared/crypto';
import {
  addPassphrase,
  KeyringError,
  purgeRetired,
  recover,
  removeKeySlot,
  rotateMaster,
  rotateRecovery,
  status,
  verifyRecovery,
  WRAP_COUNT_ADVISORY,
} from '@comvivo/storage/crypto';
import { copy } from '../../copy.js';
import type { CommandDeps } from '../../deps.js';
import { CLI_EXIT, CliError } from '../../exit-codes.js';
import { openKeyring, openMasterKey, readPassphrase, readRecoveryKey } from '../../keys/open.js';

/** Turn a `KeyringError` into a `CliError` with `09` §3.11.2's code for it. */
function fromKeyring(cause: unknown): never {
  if (cause instanceof KeyringError) {
    // Every `KeyringError` is a data-integrity or wrong-key condition, which `09` §3.11.2 puts at
    // 9 — not 1. The difference matters to a script: 9 says "the key or the file is wrong", and 1
    // says "this is a bug, send the log".
    throw new CliError(CLI_EXIT.integrity, cause.code, cause.message, {
      hint: cause.hint,
      cause,
    });
  }
  throw cause;
}

export function keysCommand(deps: CommandDeps): Command {
  const keys = new Command('keys').description(copy('keys.description')).helpGroup('Security');

  keys
    .command('status')
    .description(copy('keys.status.description'))
    .action(async () => {
      // No key at all. `08` §3.7.8's first question is "what have you still got?", and this is the
      // command that answers it — so it must work on a host whose master key is gone.
      const context = deps.context();
      const { keyring, keysDir } = await openKeyring(context);
      const report = status(keyring);
      const printer = deps.printer();
      printer.envelope({ ok: true, data: { ...report, keysDir, store: deps.keyStore(context) } });
      printer.line(copy('keys.status.instance', { instanceId: report.instanceId }));
      printer.detail(copy('keys.status.store', { store: deps.keyStore(context) }));
      printer.detail(copy('keys.status.dir', { dir: keysDir }));
      printer.detail(copy('keys.status.current', { gen: String(report.current) }));
      for (const generation of report.generations) {
        const slots = generation.slots.map((slot) => `${slot.kind}:${slot.id}`).join(', ');
        printer.detail(
          `gen ${String(generation.gen)} (${generation.status}${generation.isCurrent ? ', current' : ''}): ${slots}`,
        );
      }
      printer.detail(
        copy('keys.status.passphrase', { yesNo: report.hasPassphrase ? 'yes' : 'no' }),
      );
      printer.detail(copy('keys.status.recoverySlots', { count: String(report.recoverySlots) }));
      if (report.shouldRotateData) {
        // `08` §3.7.1's advisory threshold. A warning rather than a failure, and on stderr,
        // because the data is fine today — what is approaching is a nonce-reuse bound.
        printer.warn(
          copy('keys.status.rotateAdvisory', {
            wraps: String(report.wrapCount),
            advisory: String(WRAP_COUNT_ADVISORY),
          }),
        );
      }
    });

  keys
    .command('verify-recovery')
    .description(copy('keys.verify.description'))
    .option('--recovery-key-file <path>', copy('keys.verify.option.file'))
    .option('--gen <n>', copy('keys.verify.option.gen'))
    .action(async (options) => {
      const context = deps.context();
      const { keyring } = await openKeyring(context);
      const typed = await readRecoveryKey({
        file: options.recoveryKeyFile,
        stdin: () => deps.readSecretLine(),
        canPrompt: deps.canPrompt(),
      });
      const gen = options.gen === undefined ? undefined : Number.parseInt(options.gen, 10);
      if (gen !== undefined && !Number.isInteger(gen)) {
        throw new CliError(CLI_EXIT.usage, 'BAD_GENERATION', copy('error.badGeneration'));
      }
      const result = verifyRecovery({ keyring, typed, ...(gen === undefined ? {} : { gen }) });
      const printer = deps.printer();
      printer.envelope({ ok: result.ok, data: result });
      if (result.ok) {
        printer.ok(
          copy('keys.verify.ok', {
            gen: String(result.gen),
            slotId: String(result.slotId),
          }),
        );
        return;
      }
      // **Not** an exception. The command did its job: it checked, and the answer is no. `09`
      // §3.11.3 gives this row exit 9, which is what a script reads; the sentence is what a host
      // reads, and `verifyRecovery` distinguishes a typo from the wrong key.
      printer.fail(result.reason ?? copy('keys.verify.fail'));
      if (result.hint !== undefined) printer.note(`  ${result.hint}`);
      deps.setExitCode(CLI_EXIT.integrity);
    });

  keys
    .command('rotate-master')
    .description(copy('keys.rotateMaster.description'))
    .option('--insecure-permissions', copy('option.insecurePermissions'))
    .action(async (options) => {
      const context = deps.context();
      const { store, keyring } = await openKeyring(context);
      await deps.confirm(copy('keys.rotateMaster.confirm'), copy('keys.rotateMaster.consequence'));
      const current = await openMasterKey(context, {
        env: deps.env,
        ...(options.insecurePermissions === true ? { insecurePermissions: true } : {}),
        ...(await passphraseFor(deps)),
      });
      const result = await withZeroedAsync(current, async (key) =>
        rotateMaster({
          store,
          keyring,
          currentMasterKey: key,
          storeKey: (next) => deps.storeMasterKey(context, next),
        }).catch(fromKeyring),
      );
      const printer = deps.printer();
      printer.envelope({ ok: true, data: { added: result.slotIds, removed: result.removed } });
      printer.ok(copy('keys.rotateMaster.ok'));
      printer.detail(
        copy('keys.rotateMaster.added', { slots: result.slotIds.map((s) => s.added).join(', ') }),
      );
      printer.detail(
        copy('keys.rotateMaster.removed', {
          slots: result.removed.map((s) => s.slotId).join(', '),
        }),
      );
    });

  keys
    .command('rotate-recovery')
    .description(copy('keys.rotateRecovery.description'))
    .option('--recovery-key-out <path>', copy('keys.rotateRecovery.option.out'))
    .option('--insecure-permissions', copy('option.insecurePermissions'))
    .action(async (options) => {
      const context = deps.context();
      // Before anything, and before a key is minted: a run that cannot confirm the ceremony and
      // was given nowhere to write the key has no way to finish, and finding that out *after*
      // generating one means `08` §3.7.6's "printed once" key was printed to a stream nobody
      // read. Refused here rather than from inside the ceremony, because `rotateRecovery` wraps a
      // ceremony failure as a `KeyringError` — exit 9, data integrity — which would send a host
      // looking at their keyring for what is a missing input.
      if (
        !deps.canPrompt() &&
        (options.recoveryKeyOut === undefined || options.recoveryKeyOut === '')
      ) {
        throw new CliError(CLI_EXIT.config, 'MISSING_INPUT', copy('ceremony.nonInteractive'), {
          hint: copy('ceremony.nonInteractive.hint'),
        });
      }
      const { store, keyring } = await openKeyring(context);
      await deps.confirm(
        copy('keys.rotateRecovery.confirm'),
        copy('keys.rotateRecovery.consequence'),
      );
      const master = await openMasterKey(context, {
        env: deps.env,
        ...(options.insecurePermissions === true ? { insecurePermissions: true } : {}),
        ...(await passphraseFor(deps)),
      });
      const result = await withZeroedAsync(master, async (key) =>
        rotateRecovery({
          store,
          keyring,
          currentSlotKey: key,
          // `08` §3.7.6's ceremony. The printed key goes through `deps.ceremony`, which is the
          // only path in this package that writes a recovery key anywhere — and it returns
          // whether the host confirmed, so a `rotate-recovery` nobody acknowledged does not
          // replace the slot.
          ceremony: (printed) => deps.ceremony(printed, options.recoveryKeyOut),
        }).catch(fromKeyring),
      );
      const printer = deps.printer();
      // The new key is **not** in the envelope. `--json` output is logged, piped and pasted into
      // issues; `08` SD-04's "printed once" means printed, not serialised.
      printer.envelope({ ok: true, data: { added: result.added, removed: result.removed } });
      printer.ok(copy('keys.rotateRecovery.ok'));
      printer.note(copy('keys.rotateRecovery.rewrap'));
    });

  keys
    .command('recover')
    .description(copy('keys.recover.description'))
    .option('--recovery-key-file <path>', copy('keys.verify.option.file'))
    .action(async (options) => {
      const context = deps.context();
      const { store, keyring } = await openKeyring(context);
      // No master key here, deliberately: this is the command for the host who has lost it.
      const typed = await readRecoveryKey({
        file: options.recoveryKeyFile,
        stdin: () => deps.readSecretLine(),
        canPrompt: deps.canPrompt(),
      });
      const result = await recover({
        store,
        keyring,
        typed,
        storeKey: (next) => deps.storeMasterKey(context, next),
      }).catch(fromKeyring);
      const printer = deps.printer();
      printer.envelope({ ok: true, data: result });
      printer.ok(copy('keys.recover.ok', { gen: String(result.gen) }));
      printer.detail(copy('keys.recover.via', { slotId: result.viaSlotId }));
      printer.detail(copy('keys.recover.added', { slotId: result.addedSlotId }));
      printer.note(copy('keys.recover.unchanged'));
    });

  keys
    .command('add-passphrase')
    .description(copy('keys.addPassphrase.description'))
    .option('--insecure-permissions', copy('option.insecurePermissions'))
    .action(async (options) => {
      const context = deps.context();
      const { store, keyring } = await openKeyring(context);
      const passphrase = await deps.readNewPassphrase();
      const master = await openMasterKey(context, {
        env: deps.env,
        ...(options.insecurePermissions === true ? { insecurePermissions: true } : {}),
        ...(await passphraseFor(deps)),
      });
      const next = await withZeroedAsync(master, async (key) =>
        addPassphrase({ store, keyring, currentSlotKey: key, passphrase }).catch(fromKeyring),
      );
      const printer = deps.printer();
      printer.envelope({ ok: true, data: { current: next.keyring.current, slotId: next.slotId } });
      printer.ok(copy('keys.addPassphrase.ok', { slotId: next.slotId }));
      printer.note(copy('keys.addPassphrase.unattended'));
    });

  keys
    .command('remove-slot')
    .argument('<slotId>', copy('keys.removeSlot.argument'))
    .description(copy('keys.removeSlot.description'))
    .requiredOption('--gen <n>', copy('keys.removeSlot.option.gen'))
    .action(async (slotId, options) => {
      const context = deps.context();
      const { store, keyring } = await openKeyring(context);
      const gen = Number.parseInt(options.gen, 10);
      if (!Number.isInteger(gen)) {
        throw new CliError(CLI_EXIT.usage, 'BAD_GENERATION', copy('error.badGeneration'));
      }
      await deps.confirm(
        copy('keys.removeSlot.confirm', { slotId, gen: String(gen) }),
        copy('keys.removeSlot.consequence'),
      );
      const next = await removeKeySlot({ store, keyring, gen, slotId }).catch(fromKeyring);
      const printer = deps.printer();
      printer.envelope({ ok: true, data: { current: next.current } });
      printer.ok(copy('keys.removeSlot.ok', { slotId, gen: String(gen) }));
    });

  keys
    .command('purge-retired')
    .description(copy('keys.purge.description'))
    .option('--blobs-rewrapped', copy('keys.purge.option.blobs'))
    .action(async (options) => {
      const context = deps.context();
      const { store, keyring } = await openKeyring(context);
      const report = status(keyring);
      if (report.retainedGenerations === 0) {
        const printer = deps.printer();
        printer.envelope({ ok: true, data: { purged: [] } });
        printer.ok(copy('keys.purge.none'));
        return;
      }
      await deps.confirm(
        copy('keys.purge.confirm', { count: String(report.retainedGenerations) }),
        copy('keys.purge.consequence'),
      );
      const result = await purgeRetired({
        store,
        keyring,
        blobsRewrapped: options.blobsRewrapped === true,
      }).catch(fromKeyring);
      const printer = deps.printer();
      printer.envelope({ ok: true, data: { purged: result.purged } });
      printer.ok(copy('keys.purge.ok', { gens: result.purged.map(String).join(', ') }));
    });

  return keys;
}

/** `08` §3.7.3's passphrase store, when that is how this host unlocks. */
async function passphraseFor(
  deps: CommandDeps,
): Promise<{ readonly passphrase?: string; readonly passphraseSalt?: Uint8Array }> {
  const passphrase = await readPassphrase(deps.env);
  return passphrase === undefined ? {} : { passphrase };
}
