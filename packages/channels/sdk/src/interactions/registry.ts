/**
 * The action-kind registry (`06` §3.7 "Action kinds"; `M3-T6`).
 *
 * A token resolves to a row, and the row carries `action: { kind, params }`. `06` §3.7: "Each
 * `action.kind` is registered by its owner with a deterministic handler; **the engine rejects
 * unknown kinds as expired**." This is the half of that sentence that can live in the SDK — the
 * kind's name and the shape of its params — because both are wire facts that outlive a process.
 * The handler itself is engine-side (`M3-T24`), where the authority to run it exists.
 *
 * ## Why unknown is "expired" rather than an error
 *
 * A row can name a kind this build does not have: the owner downgraded, a plugin was removed, a
 * feature flag closed. The row is real and the click is honest, so neither a crash nor a silent
 * drop is right. `06` §3.7 step 6's answer — "This button has expired" — is the only one that is
 * true from the member's side: the button no longer does anything, and why is not their problem.
 * {@link ActionResolution} therefore has one rejection channel, and the copy for it is the same
 * one an actually-expired token gets.
 *
 * ## Why the params are validated here and not only in the handler
 *
 * The params were written by a previous build. Validating them at resolve time is the boundary
 * `CLAUDE.md` §2 means by "validate every boundary with zod: … JSON columns" — the column is the
 * boundary, and the other side of it is the past. A handler that trusts a row it did not write is
 * trusting a schema that may have changed under it.
 *
 * ## Who registers what
 *
 * Nothing is pre-registered. The SDK cannot register `06`'s own kinds honestly either: the
 * template picker is `M4-T1`, the DM group picker and the link confirmation are engine flows, and
 * a registry seeded with kinds whose params nobody has designed yet would be four guesses that
 * read like a contract. `06` §3.7 lists the owners — `05` for `confirm` and the `cmd.*` kinds,
 * `07` for its entity actions, `06` for `setup.template`, `dm.group`, `link.confirm` and
 * `link.cancel` — and each registers at composition time, which is also where a duplicate
 * registration is a boot failure rather than a last-one-wins surprise.
 */
import type { z } from 'zod';

/**
 * A kind's name: lowercase dotted segments, `confirm` or `cmd.undo` or `plan.step.claim`.
 *
 * Checked rather than assumed because `action.kind` is not only a discriminator. It is a `TEXT`
 * column in `02`'s `interaction_tokens`, it appears in `11` §3.1.6's metric labels, and `06` §3.7
 * asks owners to "register under their own prefix" — which is only a namespace if the separator
 * means something. A kind with a space or a colon would make a metric label invalid and a prefix
 * query wrong.
 */
export const ACTION_KIND_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/;

/** Long enough for `proactive.feedback` twice over; short enough to be a safe label. */
export const ACTION_KIND_MAX_CHARS = 64;

/**
 * A kind and the shape of its params, declared once by its owner.
 *
 * The point of the pair is that the registration and the handler read the same declaration, so a
 * handler cannot drift from the schema that admitted its input. `05` declares
 * `actionKind('confirm', ConfirmParamsSchema)` once and uses the value in both places.
 */
export interface ActionKind<P> {
  readonly kind: string;
  readonly params: z.ZodType<P>;
}

/** Throw unless `kind` is a name {@link ACTION_KIND_PATTERN} accepts. */
function assertActionKind(kind: string): void {
  if (kind.length > ACTION_KIND_MAX_CHARS) {
    throw new RangeError(
      `an action kind is at most ${String(ACTION_KIND_MAX_CHARS)} characters, got ${String(kind.length)}`,
    );
  }
  if (!ACTION_KIND_PATTERN.test(kind)) {
    throw new TypeError(
      `"${kind}" is not a valid action kind: lowercase dotted segments only (06 §3.7)`,
    );
  }
}

/** Declare a kind. Throws on a name `ACTION_KIND_PATTERN` rejects, at module load. */
export function actionKind<P>(kind: string, params: z.ZodType<P>): ActionKind<P> {
  assertActionKind(kind);
  return { kind, params };
}

/** The `action` column of an `InteractionTokenRecord`, as it comes back out of the database. */
export interface StoredAction {
  readonly kind: string;
  readonly params: unknown;
}

/**
 * What the engine learns from a stored action.
 *
 * `params` is `unknown` on purpose. The registry proves the value is *the shape its owner
 * registered*; it cannot also prove which owner, because a registry holding fourteen kinds holds
 * fourteen different param types. The engine's handler table pairs each {@link ActionKind} with
 * its handler, and the type flows from that pairing — see `M3-T24`.
 */
export type ActionResolution =
  | { readonly ok: true; readonly kind: string; readonly params: unknown }
  | {
      readonly ok: false;
      readonly kind: string;
      readonly reason: 'unknown_kind' | 'invalid_params';
    };

/**
 * The kinds this build knows.
 *
 * An instance rather than a module-level map. Two reasons, and the second is the one that bites:
 * a test that registers `test.echo` must not leak it into the next test, and the conformance kit
 * (`M3-T9`) builds a registry per fake adapter. Module state would make both of those
 * order-dependent, which is how a suite comes to pass only in the order it was written.
 */
export class ActionKindRegistry {
  readonly #kinds = new Map<string, z.ZodType>();

  /**
   * Claim a kind. Throws if it is already claimed.
   *
   * A boot failure, deliberately. Two owners registering one kind means a click runs whichever
   * handler won a module-evaluation race — the clicker's authority applied to somebody else's
   * action. There is no safe way to pick, so the process does not start.
   */
  register<P>(declared: ActionKind<P>): this {
    // Checked here as well as in `actionKind`, because `ActionKind` is a plain interface: a caller
    // can write the object literal and skip the factory. The first version of this file checked
    // the name inside `resolve` instead, which was unfalsifiable — a malformed kind is not in the
    // map either, so the pattern check and the failed lookup gave the same answer and no test
    // could tell them apart. Here it has an observable effect, and it has it at boot.
    assertActionKind(declared.kind);
    if (this.#kinds.has(declared.kind)) {
      throw new TypeError(
        `the action kind "${declared.kind}" is already registered. Each kind has one owner (06 §3.7).`,
      );
    }
    this.#kinds.set(declared.kind, declared.params);
    return this;
  }

  /** Whether a kind is known. */
  has(kind: string): boolean {
    return this.#kinds.has(kind);
  }

  /** Every registered kind, sorted — for a boot log line and for `09`'s diagnostics. */
  kinds(): readonly string[] {
    return [...this.#kinds.keys()].toSorted();
  }

  /**
   * Resolve a stored action, or say why not.
   *
   * No shape check on the way in. Every kind in the map passed {@link assertActionKind} at
   * registration, so a malformed one from a tampered or corrupt row simply is not there — and a
   * second pattern test would be a guard whose removal no test could notice.
   */
  resolve(action: StoredAction): ActionResolution {
    const schema = this.#kinds.get(action.kind);
    if (schema === undefined) {
      return { ok: false, kind: action.kind, reason: 'unknown_kind' };
    }
    const parsed = schema.safeParse(action.params);
    return parsed.success
      ? { ok: true, kind: action.kind, params: parsed.data }
      : { ok: false, kind: action.kind, reason: 'invalid_params' };
  }
}
