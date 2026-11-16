/**
 * Writing a fixture (`06` §3.25; `M3-T9`).
 *
 * `06` §3.25 describes recording as `pnpm --filter @comvivo/channel-<id> record`, running the real
 * adapter against a test bot with `COMVIVO_RECORD_FIXTURES=1`. That splits in two, and the split is
 * the point:
 *
 * - **Capturing** needs a live bot and a live chat, which is owner-blocked (`H-3`) and lives in the
 *   adapter that knows what a payload looks like (`M3-T32`).
 * - **Writing** is this file: take a captured payload, put it through the redactor, stamp the
 *   manifest, serialise it the way the linter expects to read it. No bot required, so it is tested
 *   rather than described.
 *
 * An adapter's `record` script is therefore a loop that captures and calls {@link writeFixture},
 * and the thing that must not drift — what gets redacted and how it is marked — is here, once.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { REDACTOR_VERSION, redact } from './redact.js';

export interface RecordOptions {
  /** `fixtures/channels/<id>`. */
  readonly dir: string;
  /** `inbound/forwarded-anonymous.json`, relative to `dir`. */
  readonly path: string;
  /** The platform API version this came from — Bot API 9.4, Discord v10. */
  readonly platformVersion: string;
  /** The payload as the platform sent it. Redacted before it is written. */
  readonly raw: unknown;
  /** The envelope or event it must normalise to. Redacted too: it carries the same ids. */
  readonly expect: unknown;
  /** The per-repo salt. Never written to the file. */
  readonly salt: string;
  /** An ISO instant. Injected so a recording is reproducible. */
  readonly recordedAt: string;
  readonly note?: string;
}

/**
 * Build a recorded fixture.
 *
 * `raw` and `expect` are redacted **in one call** rather than two, which is not an optimisation: the
 * ids in the expectation are the ids in the payload, and two calls with the same salt happen to
 * agree only because the mapping is deterministic. Redacting the pair together says so.
 *
 * Pure, so a test can assert the manifest and the remapping without a filesystem.
 */
export function buildFixture(options: RecordOptions): unknown {
  const { value, replaced, saltId } = redact(
    { raw: options.raw, expect: options.expect },
    options.salt,
  );
  const pair = value as { raw: unknown; expect: unknown };
  return {
    meta: {
      platformVersion: options.platformVersion,
      recordedAt: options.recordedAt,
      source: 'recorded',
      redaction: { version: REDACTOR_VERSION, at: options.recordedAt, saltId, replaced },
      ...(options.note === undefined ? {} : { note: options.note }),
    },
    raw: pair.raw,
    expect: pair.expect,
  };
}

/**
 * Write one.
 *
 * Two spaces and a trailing newline, because `fixtures:lint` reports a **line number** and that is
 * only useful if the file has one value per line. A minified fixture would put every finding on
 * line 1.
 */
export async function writeFixture(options: RecordOptions): Promise<string> {
  const full = join(options.dir, options.path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, `${JSON.stringify(buildFixture(options), null, 2)}\n`, 'utf8');
  return full;
}
