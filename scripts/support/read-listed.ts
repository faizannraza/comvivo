/**
 * Read a file a *listing* said exists, distinguishing the benign race from everything else.
 *
 * Three scanners — `names/check.ts`, `hygiene/check.ts` and `security/literal-secrets.ts` — list
 * the tree with `git ls-files` and then read each path, and all three used to swallow every read
 * failure with the comment *deleted between listing and reading*. That race is real: `git ls-files`
 * and the read are two moments, and a file can vanish between them.
 *
 * But `catch {}` does not catch only that. A permissions error, a directory where a file was
 * expected, a path too long — each became "this file is clean", and `names/check.ts` went on to
 * print how many files it had checked, counting the ones it had not. For a secret scanner that is
 * the wrong way round: an unreadable file is the one worth asking about.
 *
 * So: `ENOENT` is the race and is reported as `missing`; anything else is a `failed` with its code,
 * and each caller turns that into a finding — `literal-secrets.ts` with a test of its own
 * (`scanFiles`, in `literal-secrets.test.ts`), the other two with three lines each that this
 * module's own tests make trustworthy. `read-listed.test.ts` covers all three outcomes, because
 * `scripts/**` is outside the coverage thresholds and would otherwise have nothing proving them.
 * Found by the M1 exit gate's reviewers.
 */
import { readFileSync } from 'node:fs';

export type ListedRead =
  | { readonly kind: 'text'; readonly text: string }
  /** Gone between the listing and the read — the race, and not a problem. */
  | { readonly kind: 'missing' }
  /** Anything else: present and unreadable, which means unchecked. */
  | { readonly kind: 'failed'; readonly reason: string };

export function readListed(path: string): ListedRead {
  try {
    return { kind: 'text', text: readFileSync(path, 'utf8') };
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'failed', reason: code ?? (cause instanceof Error ? cause.name : 'unknown') };
  }
}
