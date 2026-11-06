/**
 * The keyring file: `data/keys/keyring.json` (`08` §3.7.4, `02` §3.6.1).
 *
 * This file is the single point of failure for a host's entire dataset. It holds the root data key
 * for each generation, wrapped once per unlock slot — the master key, the printed recovery key, and
 * optionally a passphrase. Lose every slot and `08` §3.7.8 is explicit: *all encrypted data is
 * unrecoverable, by design*. Corrupt the file and the outcome is the same.
 *
 * Everything here follows from that:
 *
 *  - **It is validated with zod on the way in**, not trusted. A keyring that parsed loosely would
 *    let a truncated or half-written file look openable, and the failure would surface as "wrong
 *    key" — sending a host hunting for a key problem they do not have.
 *  - **Writes are atomic and keep the previous file.** `keyring.json.tmp` → fsync → rename →
 *    fsync the directory, with the old file preserved as `keyring.json.prev` until the next
 *    successful boot (`08` §3.7.4). A `rename` is atomic within a filesystem, so a crash leaves
 *    either the old file or the new one, never a mixture.
 *  - **Every slot's wrap is bound by AAD** to the instance, the generation, the slot id and the
 *    slot kind, so a slot cannot be moved between generations, between instances, or relabelled.
 *  - **File I/O is a parameter.** `sec.keys.*` has to prove crash-resume, which means failing a
 *    write between the fsync and the rename. That is not reachable without a seam.
 */

import { BRAND, type InstanceId, idSchema, z } from '@comvivo/shared';
import {
  AAD,
  KEYRING_FORMAT,
  sealedLength,
  UnwrapFailed,
  unwrap,
  WRAP_KEY_BYTES,
  wrap,
} from '@comvivo/shared/crypto';

/** What a slot unlocks with (`08` §3.7.2). */
export const SLOT_KINDS = ['master', 'recovery', 'passphrase'] as const;
export type SlotKind = (typeof SLOT_KINDS)[number];

/** A generation's lifecycle (`08` §3.7.7's `rotate-data`). */
export const GENERATION_STATUSES = ['active', 'retired'] as const;
export type GenerationStatus = (typeof GENERATION_STATUSES)[number];

/**
 * Every wrap in a keyring seals a 256-bit key, so its length is known exactly.
 *
 * Both users of `wrapSchema` wrap 32 bytes: a slot wraps the root data key, and `static.blobId`
 * wraps the blob-id key. `nonce(12) ‖ ciphertext(32) ‖ tag(16)` is 60 bytes, which is 20 groups of
 * three and therefore exactly 80 unpadded base64url characters.
 */
const SEALED_BYTES = sealedLength(WRAP_KEY_BYTES);

/**
 * A sealed value, validated for shape rather than only for presence.
 *
 * This was `z.string().min(1)`, and the looseness had a real cost: **`Buffer.from(s, 'base64url')`
 * never throws** — it silently drops characters outside the alphabet, so `'!!!!'` decodes to zero
 * bytes and `'ab~cd'` to three. A damaged `sealed` field therefore reached `unwrap`, failed as
 * `UnwrapFailed` like any wrong key, and the host was told "the key does not match this keyring…
 * recover with your recovery key" when the true answer was "this file is damaged, restore
 * `keyring.json.prev`". That is the exact misdiagnosis `parseKeyring`'s format check exists to
 * avoid, and it sends a host down a destructive path they may not even be able to walk.
 *
 * `unwrap` cannot make this distinction itself — it reports every failure identically on purpose,
 * because a caller that could tell "wrong key" from "wrong AAD" would have an oracle. Here there
 * is no such concern: the keyring is a local, host-owned file, and "your keyring is damaged" is
 * not a secret. So the check belongs at the boundary, which is also where `CLAUDE.md` §2 puts it.
 */
const sealedSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/, 'a sealed value is unpadded base64url')
  .refine((value) => Buffer.from(value, 'base64url').length === SEALED_BYTES, {
    message: `a sealed value decodes to ${String(SEALED_BYTES)} bytes (nonce ‖ 32-byte key ‖ tag)`,
  });

/**
 * An AES-256-GCM wrap, as it appears in the file.
 *
 * `alg` is recorded even though there is one value today, because a keyring written now has to be
 * readable by a build that supports two.
 */
const wrapSchema = z.object({
  alg: z.literal('A256GCM'),
  /** `nonce ‖ ciphertext ‖ tag`, base64url. One field, so a half-written row cannot exist. */
  sealed: sealedSchema,
});
export type StoredWrap = z.infer<typeof wrapSchema>;

/** The scrypt parameters a passphrase slot was created with (`08` §3.7.4). */
const scryptKdfSchema = z.object({
  alg: z.literal('scrypt'),
  N: z.number().int().positive(),
  r: z.number().int().positive(),
  p: z.number().int().positive(),
  /** base64url. */
  salt: z.string().min(1),
});

/** The recovery slot's own HKDF derivation (`08` §3.7.6). */
const hkdfKdfSchema = z.object({
  alg: z.literal('hkdf-sha256'),
  info: z.string().min(1),
});

const slotSchema = z.object({
  /** Stable within a generation, e.g. `mk2`, `rk1`, `pp1`. Part of the wrap's AAD. */
  id: z.string().regex(/^[a-z][a-z0-9]{0,15}$/, 'a slot id is 1–16 lowercase alphanumerics'),
  kind: z.enum(SLOT_KINDS),
  kdf: z.union([scryptKdfSchema, hkdfKdfSchema]).optional(),
  wrap: wrapSchema,
});
export type KeyringSlot = z.infer<typeof slotSchema>;

const generationSchema = z.object({
  gen: z.number().int().positive(),
  status: z.enum(GENERATION_STATUSES),
  createdAt: z.string().min(1),
  slots: z.array(slotSchema).min(1, 'a generation with no slots is unopenable'),
});
export type KeyringGeneration = z.infer<typeof generationSchema>;

/** The static blob-id key: random, wrapped by the current RDK, stable across generations (D14). */
const staticKeySchema = z.object({
  gen: z.number().int().positive(),
  wrap: wrapSchema,
});

export const keyringSchema = z
  .object({
    format: z.literal(KEYRING_FORMAT),
    instanceId: idSchema('inst'),
    /** The generation new data is written under. */
    current: z.number().int().positive(),
    /**
     * How many wraps this keyring's KEKs have performed (`08` §3.7.1).
     *
     * AES-256-GCM with a random 96-bit nonce is safe well below 2^32 wraps per key;
     * `comvivo doctor` advises `rotate-data` at 2^30. Counting is the only way to know,
     * because a nonce collision is silent.
     */
    wrapCount: z.number().int().nonnegative(),
    generations: z.array(generationSchema).min(1),
    static: z.object({ blobId: staticKeySchema }),
  })
  .superRefine((keyring, context) => {
    const gens = keyring.generations.map((generation) => generation.gen);
    if (new Set(gens).size !== gens.length) {
      context.addIssue({ code: 'custom', message: 'two generations share a number' });
    }
    if (!gens.includes(keyring.current)) {
      // A `current` pointing at a generation that is not in the file means no key can be derived
      // for new data. Caught here rather than at first use, where it would look like corruption.
      context.addIssue({
        code: 'custom',
        message: `current is generation ${String(keyring.current)}, which is not in the file`,
      });
    }
    for (const generation of keyring.generations) {
      const ids = generation.slots.map((slot) => slot.id);
      if (new Set(ids).size !== ids.length) {
        context.addIssue({
          code: 'custom',
          message: `generation ${String(generation.gen)} has two slots with the same id`,
        });
      }
      if (!generation.slots.some((slot) => slot.kind === 'recovery')) {
        // `08` §3.7.8: the recovery key is the only route back when the master key is lost. A
        // generation without one is a generation whose data dies with the key file, which is
        // exactly the outcome the recovery ceremony exists to prevent.
        context.addIssue({
          code: 'custom',
          message: `generation ${String(generation.gen)} has no recovery slot`,
        });
      }
    }
    if (!keyring.generations.some((generation) => generation.gen === keyring.static.blobId.gen)) {
      context.addIssue({
        code: 'custom',
        message: 'the static blob-id key is wrapped under a generation that is not in the file',
      });
    }
  });

export type Keyring = z.infer<typeof keyringSchema>;

/** Why a keyring could not be used. Never carries key material. */
export type KeyringErrorCode =
  | 'KEYRING_MISSING'
  | 'KEYRING_MALFORMED'
  | 'KEYRING_UNSUPPORTED_FORMAT'
  | 'KEYRING_NO_MATCHING_SLOT'
  | 'KEYRING_GENERATION_MISSING'
  | 'KEYRING_LAST_RECOVERY_SLOT';

export class KeyringError extends Error {
  readonly code: KeyringErrorCode;
  /** What a host should do. `08` §3.7.5 exits 78 with a doctor hint, and this is the hint. */
  readonly hint: string;

  constructor(
    code: KeyringErrorCode,
    message: string,
    hint: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'KeyringError';
    this.code = code;
    this.hint = hint;
  }
}

/**
 * Parse and validate a keyring document.
 *
 * Takes the text rather than a path, so the same function validates a file on disk, a keyring
 * snapshot inside a `VBK1` backup header (`08` §3.7.11), and a fixture.
 */
export function parseKeyring(text: string): Keyring {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new KeyringError(
      'KEYRING_MALFORMED',
      'the keyring is not valid JSON',
      'Restore `keyring.json.prev`, or recover with your recovery key: ' +
        `\`${BRAND.cliName} keys recover\`.`,
      { cause },
    );
  }

  // The format check comes first and on its own, because "this file is from a newer Comvivo" needs
  // a different answer from "this file is damaged" — the first is an upgrade problem and the
  // second is a restore problem, and telling a host the wrong one wastes the worst hour of their
  // year.
  const format = (json as { format?: unknown }).format;
  if (typeof format === 'string' && format !== KEYRING_FORMAT) {
    throw new KeyringError(
      'KEYRING_UNSUPPORTED_FORMAT',
      `the keyring says format "${format}", and this build understands "${KEYRING_FORMAT}"`,
      `This keyring was written by a different version of ${BRAND.displayName}. Upgrade rather ` +
        'than downgrade — an older build cannot read a newer keyring.',
    );
  }

  const parsed = keyringSchema.safeParse(json);
  if (!parsed.success) {
    throw new KeyringError(
      'KEYRING_MALFORMED',
      `the keyring is not valid: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
      'Restore `keyring.json.prev`, or recover with your recovery key: ' +
        `\`${BRAND.cliName} keys recover\`.`,
    );
  }
  return parsed.data;
}

/** Serialise a keyring for writing. Two-space JSON, so a host can read and diff it. */
export function serialiseKeyring(keyring: Keyring): string {
  return `${JSON.stringify(keyring, null, 2)}\n`;
}

/** The generation marked `current`. */
export function currentGeneration(keyring: Keyring): KeyringGeneration {
  const generation = keyring.generations.find((candidate) => candidate.gen === keyring.current);
  if (generation === undefined) {
    // `keyringSchema` already refuses this, so reaching here means the keyring was constructed in
    // memory without validation.
    throw new KeyringError(
      'KEYRING_GENERATION_MISSING',
      `generation ${String(keyring.current)} is marked current but is not present`,
      `This is a bug. Report it with the output of \`${BRAND.cliName} doctor\`.`,
    );
  }
  return generation;
}

/** A specific generation, or a typed error. */
export function generationFor(keyring: Keyring, gen: number): KeyringGeneration {
  const generation = keyring.generations.find((candidate) => candidate.gen === gen);
  if (generation === undefined) {
    throw new KeyringError(
      'KEYRING_GENERATION_MISSING',
      `generation ${String(gen)} is not in the keyring`,
      'If you are restoring an old backup, keep the retired generations: ' +
        `\`${BRAND.cliName} keys purge-retired\` removes them permanently.`,
    );
  }
  return generation;
}

/**
 * Wrap a root data key into a new slot.
 *
 * `slotKey` is whatever the unlock source produced — the master key itself, or a key derived from
 * the recovery key or a passphrase. This function does not care which; the `kind` is what records
 * it, and the AAD is what stops a `master` wrap being presented as a `recovery` one.
 */
export function sealSlot(options: {
  readonly instanceId: InstanceId;
  readonly gen: number;
  readonly id: string;
  readonly kind: SlotKind;
  readonly slotKey: Uint8Array;
  readonly rootDataKey: Uint8Array;
  readonly kdf?: KeyringSlot['kdf'];
}): KeyringSlot {
  const { instanceId, gen, id, kind, slotKey, rootDataKey, kdf } = options;
  const sealed = wrap(slotKey, rootDataKey, AAD.keyringSlot(instanceId, gen, id, kind));
  return {
    id,
    kind,
    ...(kdf === undefined ? {} : { kdf }),
    wrap: { alg: 'A256GCM', sealed: sealed.toString('base64url') },
  };
}

/**
 * Unwrap a root data key from a slot.
 *
 * Returns `undefined` rather than throwing when the key does not match, because trying slots in
 * turn is the normal unlock path (`08` §3.7.5 step 2) and a throw per miss would make the happy
 * path exceptional. A *malformed* slot still throws: that is corruption, not a wrong key.
 */
export function openSlot(options: {
  readonly instanceId: InstanceId;
  readonly gen: number;
  readonly slot: KeyringSlot;
  readonly slotKey: Uint8Array;
}): Buffer | undefined {
  const { instanceId, gen, slot, slotKey } = options;

  // `sealedSchema` guarantees this for anything that came through `parseKeyring`, but a keyring
  // under construction has not been through it — `comvivo keys rotate-master` builds one in memory
  // before writing it. Checked rather than assumed, because the whole point of the schema change
  // above is that a malformed wrap must be reported as damage and not as a wrong key.
  const sealed = Buffer.from(slot.wrap.sealed, 'base64url');
  if (sealed.length !== SEALED_BYTES) {
    throw new KeyringError(
      'KEYRING_MALFORMED',
      `slot ${slot.id} holds ${String(sealed.length)} bytes, and a wrap is ${String(SEALED_BYTES)}`,
      'This keyring is damaged, not unlocked by the wrong key. Restore `keyring.json.prev`, or ' +
        'recover with your recovery key.',
    );
  }
  try {
    return unwrap(slotKey, sealed, AAD.keyringSlot(instanceId, gen, slot.id, slot.kind));
  } catch (error) {
    if (error instanceof UnwrapFailed) return undefined;
    throw error;
  }
}

/**
 * Remove a slot, refusing to remove the last recovery slot in any generation.
 *
 * `M1-T5`'s acceptance criterion, and the reason is `08` §3.7.8: with the master key gone, the
 * recovery key is the only route back. A `remove-slot` that could take the last one away is a
 * command that destroys a host's data while reporting success — the most expensive possible kind
 * of helpful.
 *
 * Checked per generation rather than globally, because a retired generation still holds data in
 * old backups, and a backup with no openable slot is a backup that cannot be restored.
 */
export function removeSlot(keyring: Keyring, gen: number, slotId: string): Keyring {
  const generation = generationFor(keyring, gen);
  const slot = generation.slots.find((candidate) => candidate.id === slotId);
  if (slot === undefined) {
    throw new KeyringError(
      'KEYRING_NO_MATCHING_SLOT',
      `generation ${String(gen)} has no slot "${slotId}"`,
      `Run \`${BRAND.cliName} keys status\` to list the slots.`,
    );
  }

  const remainingRecovery = generation.slots.filter(
    (candidate) => candidate.kind === 'recovery' && candidate.id !== slotId,
  );
  if (slot.kind === 'recovery' && remainingRecovery.length === 0) {
    throw new KeyringError(
      'KEYRING_LAST_RECOVERY_SLOT',
      `slot "${slotId}" is the only recovery slot in generation ${String(gen)}`,
      `Add a new recovery key first (\`${BRAND.cliName} keys rotate-recovery\`), then remove this one. ` +
        'Without a recovery slot, losing the master key would make this data unrecoverable.',
    );
  }

  if (generation.slots.length === 1) {
    throw new KeyringError(
      'KEYRING_LAST_RECOVERY_SLOT',
      `slot "${slotId}" is the only slot in generation ${String(gen)}`,
      'A generation with no slots cannot be opened by anything. Add another slot first.',
    );
  }

  return {
    ...keyring,
    generations: keyring.generations.map((candidate) =>
      candidate.gen === gen
        ? { ...candidate, slots: candidate.slots.filter((s) => s.id !== slotId) }
        : candidate,
    ),
  };
}

/** Add or replace a slot in a generation, keeping slot ids unique. */
export function putSlot(keyring: Keyring, gen: number, slot: KeyringSlot): Keyring {
  generationFor(keyring, gen);
  return {
    ...keyring,
    generations: keyring.generations.map((candidate) =>
      candidate.gen === gen
        ? {
            ...candidate,
            slots: [...candidate.slots.filter((s) => s.id !== slot.id), slot].sort((a, b) =>
              a.id.localeCompare(b.id, 'en'),
            ),
          }
        : candidate,
    ),
  };
}

/** Allocate an unused slot id for a kind, e.g. `mk1`, `mk2`. */
export function nextSlotId(generation: KeyringGeneration, kind: SlotKind): string {
  const prefix = { master: 'mk', recovery: 'rk', passphrase: 'pp' }[kind];
  const used = new Set(generation.slots.map((slot) => slot.id));
  for (let n = 1; n < 1_000; n += 1) {
    const candidate = `${prefix}${String(n)}`;
    if (!used.has(candidate)) return candidate;
  }
  // 999 slots of one kind in one generation is not a situation to paper over.
  throw new KeyringError(
    'KEYRING_MALFORMED',
    `generation ${String(generation.gen)} already has 999 ${kind} slots`,
    `Remove the slots you no longer use: \`${BRAND.cliName} keys remove-slot\`.`,
  );
}
