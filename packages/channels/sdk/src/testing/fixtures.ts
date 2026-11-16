/**
 * The fixture file shape, and where fixtures come from (`06` §3.25; `M3-T9`).
 *
 * A fixture is a real platform payload and the envelope it must normalise to. That pairing is the
 * only honest way to test an adapter: the payloads are written by Telegram, Discord and Slack, they
 * change without notice, and no amount of reading a specification produces the shape a forwarded
 * message from a channel with a hidden sender actually has. `06` §3.25's answer is to record them
 * and keep them.
 *
 * ## Why the store is a port, and why the kit ships no filesystem one
 *
 * `06` §3.25 types the harness's `fixtures` as a directory path, and reading a directory is the
 * point of C01 — a fixture added without an `expect` has to fail the kit rather than be skipped. So
 * the harness takes a {@link FixtureStore}, and the **caller** supplies it.
 *
 * That is not indirection for its own sake. The kit is a published entry point that third-party
 * channel plugins run (`06` §3.25's last line), and a published test kit should not assume Node:
 * `FixtureStore` is twelve lines over whatever the host environment provides, and for a Vite-based
 * plugin that is `import.meta.glob` rather than `readdir`. A Node implementation inside the kit
 * would be the wrong default as well as an unportable one. This repository's lives at
 * `test/support/fixture-store.ts`, where `node:*` is allowed; the simulator (`M3-T11`) feeds the
 * same cases from memory with {@link memoryFixtureStore}.
 *
 * It also kept a guard intact rather than weakened. Biome's `noNodejsModules` covers all of
 * `packages/channels/sdk/**` with no `/testing/` exemption, while dependency-cruiser's equivalent
 * exempts every `/testing/` directory — so the first draft put a `node:fs` store here and had to
 * either widen Biome's rule or change the design (`CLAUDE.md` §2). The design was better.
 */
import { z } from 'zod';

/** `06` §3.25's four fixture families. */
export const FIXTURE_KINDS = ['inbound', 'outbound', 'errors', 'probe'] as const;
export type FixtureKind = (typeof FIXTURE_KINDS)[number];

/**
 * What the redactor did, and the marker `fixtures:lint` requires on a recorded file.
 *
 * `06` §3.25: CI "fails on token, phone and email patterns **and on any `source:'recorded'` file
 * without redaction markers**". A recorded payload that reached the repository unredacted is a
 * member's name, chat id and message text in a public git history, and the failure mode is silent —
 * so the absence of a marker is treated as the unsafe case rather than as "probably fine".
 *
 * `saltId` is the **HMAC of the salt**, never the salt: it proves two fixtures were remapped with
 * the same salt (so ids are consistent across files) without putting the salt in the tree.
 */
export const RedactionSchema = z.strictObject({
  /** The redactor's own version, so a fixture redacted by an older rule set is visible. */
  version: z.int().min(1),
  /** When it ran. */
  at: z.iso.datetime({ offset: true }),
  /** A digest of the salt, so consistency is checkable and the salt is not in the repository. */
  saltId: z.string().regex(/^[0-9a-f]{16}$/),
  /** How many values each rule replaced. A rule that fired zero times on a recording is a flag. */
  replaced: z.record(z.string(), z.int().min(0)),
});
export type Redaction = z.infer<typeof RedactionSchema>;

export const FixtureMetaSchema = z.strictObject({
  /** The platform API version the payload came from — Bot API 9.4, Discord v10, Slack's date. */
  platformVersion: z.string().min(1).max(64),
  recordedAt: z.iso.datetime({ offset: true }),
  source: z.enum(['recorded', 'synthetic']),
  /** Required for `recorded`, refused for `synthetic`. */
  redaction: RedactionSchema.optional(),
  /** One line on what this fixture is for, so a corpus of 200 files stays readable. */
  note: z.string().max(500).optional(),
});

/**
 * One fixture.
 *
 * `raw`, `ast` and `request`/`response` are the three input shapes `06` §3.25 lists, one per
 * family: an inbound payload, an outbound AST, and an error exchange. `expect` is what the adapter
 * must produce. Deliberately `unknown` — the kit validates it against the **zod schemas** (C01), and
 * a second type here would be a third place for the envelope shape to live.
 */
export const FixtureSchema = z
  .strictObject({
    meta: FixtureMetaSchema,
    raw: z.unknown().optional(),
    ast: z.unknown().optional(),
    request: z.unknown().optional(),
    response: z.unknown().optional(),
    expect: z.unknown(),
  })
  .refine(
    (fixture) => (fixture.meta.source === 'recorded') === (fixture.meta.redaction !== undefined),
    {
      message:
        'a recorded fixture needs a `meta.redaction` marker, and a synthetic one must not claim ' +
        'to have been redacted (06 §3.25)',
    },
  )
  .refine(
    (fixture) =>
      fixture.raw !== undefined || fixture.ast !== undefined || fixture.request !== undefined,
    { message: 'a fixture needs one of `raw`, `ast` or `request` (06 §3.25)' },
  );
export type Fixture = z.infer<typeof FixtureSchema>;

/** A fixture and where it came from, so a failure names a file rather than an index. */
export interface LoadedFixture {
  /** `inbound/forwarded-anonymous.json`, relative to the channel's fixture directory. */
  readonly path: string;
  readonly kind: FixtureKind;
  readonly fixture: Fixture;
}

/**
 * Where fixtures come from.
 *
 * Two methods, because C01 needs to iterate and the rest need to fetch by name. `list` returns
 * paths relative to the channel's directory, sorted, so a failing run is reproducible.
 */
export interface FixtureStore {
  list(kind: FixtureKind): Promise<readonly string[]>;
  read(path: string): Promise<unknown>;
}

/**
 * Parse and locate, with the file in the message.
 *
 * A zod error on a fixture is the common case while a corpus is being written, and "expected string
 * at meta.recordedAt" with no filename is the kind of failure that takes ten minutes to place in a
 * directory of two hundred.
 */
export function parseFixture(path: string, kind: FixtureKind, value: unknown): LoadedFixture {
  const parsed = FixtureSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(
      `${path} is not a valid fixture: ${parsed.error.issues.map(issueLine).join('; ')}`,
    );
  }
  return { path, kind, fixture: parsed.data };
}

function issueLine(issue: { path: readonly PropertyKey[]; message: string }): string {
  const at = issue.path.map(String).join('.');
  return at.length === 0 ? issue.message : `${at}: ${issue.message}`;
}

/** Every fixture of one kind, parsed, in path order. */
export async function loadFixtures(
  store: FixtureStore,
  kind: FixtureKind,
): Promise<readonly LoadedFixture[]> {
  const paths = await store.list(kind);
  const out: LoadedFixture[] = [];
  for (const path of paths) out.push(parseFixture(path, kind, await store.read(path)));
  return out;
}

/** An in-memory store, for the kit's own tests and for the simulator (`M3-T11`). */
export function memoryFixtureStore(files: Readonly<Record<string, unknown>>): FixtureStore {
  return {
    list: (kind) =>
      Promise.resolve(
        Object.keys(files)
          .filter((path) => path.startsWith(`${kind}/`))
          .toSorted(),
      ),
    read: (path) => {
      if (!(path in files)) return Promise.reject(new Error(`no such fixture: ${path}`));
      return Promise.resolve(files[path]);
    },
  };
}
