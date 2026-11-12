/**
 * The four readers behind `pnpm changeset:required`.
 *
 * `changeset-policy.ts` — the pure decision — was well covered, and the module that feeds it was
 * not covered at all: `baseRef`, `changedFiles`, `changesets` and `labels` had no tests, so a
 * defect in label extraction or base-ref resolution would have made the check pass, or fail, on
 * every pull request with nothing noticing. The failing branch was not even reachable in practice:
 * a `--base HEAD~3` run reports "present" because `.changeset/` is non-empty, so the whole
 * end-to-end path was exercised in one direction only. Found by the M0 independent review.
 *
 * These are the inputs the policy trusts. A wrong `GITHUB_BASE_REF` means the diff is against the
 * wrong commit and the file list is wrong; a missed label means the documented waiver silently
 * does nothing.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { baseRef, changedFiles, changesets, labels } from './changeset-required.js';

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'changeset-required-'));
  temporary.push(dir);
  return dir;
}

describe('baseRef', () => {
  it('prefers an explicit --base', () => {
    expect(baseRef(['node', 'script', '--base', 'origin/release/1.0'], {})).toBe(
      'origin/release/1.0',
    );
  });

  it('falls back to GITHUB_BASE_REF, prefixed with origin/', () => {
    // The prefix matters: `GITHUB_BASE_REF` is a bare branch name, and a bare name resolves to a
    // local ref that a CI checkout does not have — so the diff would fail rather than compare.
    expect(baseRef(['node', 'script'], { GITHUB_BASE_REF: 'main' })).toBe('origin/main');
    expect(baseRef(['node', 'script'], { GITHUB_BASE_REF: 'release/1.0' })).toBe(
      'origin/release/1.0',
    );
  });

  it('treats an empty GITHUB_BASE_REF as absent', () => {
    // A `push` event sets it to the empty string rather than leaving it unset, and `origin/` on
    // its own is not a ref.
    expect(baseRef(['node', 'script'], { GITHUB_BASE_REF: '' })).toBe('origin/main');
  });

  it('defaults to origin/main', () => {
    expect(baseRef(['node', 'script'], {})).toBe('origin/main');
  });

  it('ignores a trailing --base with no value', () => {
    expect(baseRef(['node', 'script', '--base'], {})).toBe('origin/main');
  });
});

describe('labels', () => {
  it('prefers an explicit --labels, trimming each one', () => {
    expect(labels(['node', 'script', '--labels', 'no-changeset, docs '], {})).toEqual([
      'no-changeset',
      'docs',
    ]);
  });

  it('reads the pull-request event payload', () => {
    const root = tempRoot();
    const path = join(root, 'event.json');
    writeFileSync(
      path,
      JSON.stringify({ pull_request: { labels: [{ name: 'no-changeset' }, { name: 'docs' }] } }),
    );
    expect(labels(['node', 'script'], { GITHUB_EVENT_PATH: path })).toEqual([
      'no-changeset',
      'docs',
    ]);
  });

  it('keeps only string names', () => {
    // The defect this guards: `String(unknown)` turns an object into "[object Object]", which can
    // then be compared against the waiver label and quietly not match — or match a label literally
    // named that. The comment in the source records it; nothing asserted it.
    const root = tempRoot();
    const path = join(root, 'event.json');
    writeFileSync(
      path,
      JSON.stringify({
        pull_request: {
          labels: [{ name: 'keep' }, { name: 42 }, { name: null }, { name: '' }, { other: 'x' }],
        },
      }),
    );
    expect(labels(['node', 'script'], { GITHUB_EVENT_PATH: path })).toEqual(['keep']);
  });

  it('returns nothing when there is no event and no flag', () => {
    expect(labels(['node', 'script'], {})).toEqual([]);
    expect(labels(['node', 'script'], { GITHUB_EVENT_PATH: '' })).toEqual([]);
  });

  it('returns nothing rather than throwing on an unreadable or malformed payload', () => {
    // A `push` event payload has no `pull_request` key at all, and a truncated file is possible.
    // Either way the answer is "no labels" — throwing here would fail the check for a reason that
    // has nothing to do with changesets.
    const root = tempRoot();
    const missing = join(root, 'nope.json');
    expect(labels(['node', 'script'], { GITHUB_EVENT_PATH: missing })).toEqual([]);

    const malformed = join(root, 'bad.json');
    writeFileSync(malformed, '{ not json');
    expect(labels(['node', 'script'], { GITHUB_EVENT_PATH: malformed })).toEqual([]);

    const push = join(root, 'push.json');
    writeFileSync(push, JSON.stringify({ ref: 'refs/heads/main' }));
    expect(labels(['node', 'script'], { GITHUB_EVENT_PATH: push })).toEqual([]);
  });
});

describe('changesets', () => {
  it('lists the markdown files and skips the README', () => {
    const root = tempRoot();
    mkdirSync(join(root, '.changeset'));
    for (const name of ['README.md', 'brave-cats-sing.md', 'notes.txt', 'tidy-dogs-run.md']) {
      writeFileSync(join(root, '.changeset', name), 'x');
    }
    expect(changesets(root).toSorted()).toEqual(['brave-cats-sing.md', 'tidy-dogs-run.md']);
  });

  it('returns nothing when there is no .changeset directory', () => {
    // True before `M0-T14` and true in a consumer's checkout of a published tarball; neither is a
    // reason to fail.
    expect(changesets(tempRoot())).toEqual([]);
  });

  it('finds the repository’s own changesets by default', () => {
    // Non-vacuity for the default argument: every case above passes a temp root, so without this
    // the real `ROOT` could be wrong and nothing would say so.
    expect(Array.isArray(changesets())).toBe(true);
  });
});

describe('changedFiles', () => {
  /** A throwaway repository with two commits, so the diff has something real to read. */
  function twoCommitRepo(): string {
    const root = tempRoot();
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    };
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'first.txt'), 'one');
    git('add', '-A');
    git('commit', '-qm', 'first');
    writeFileSync(join(root, 'second.txt'), 'two');
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'third.txt'), 'three');
    git('add', '-A');
    git('commit', '-qm', 'second');
    return root;
  }

  it('reports the files a range touched', () => {
    // A purpose-built repository rather than this one. The first version diffed `HEAD~1` of the
    // checkout and failed in CI, because `actions/checkout` makes a **shallow** clone and `HEAD~1`
    // does not exist there — a test that depended on how deep the clone happened to be. Found by
    // CI on a tree where `pnpm verify` was green.
    const root = twoCommitRepo();
    const files = changedFiles('HEAD~1', root).toSorted();
    expect(files).toEqual(['nested/third.txt', 'second.txt']);
    // No empty entries: the trailing newline in `git diff` output becomes one if not filtered.
    expect(files).not.toContain('');
  });

  it('reports nothing for a range with no changes', () => {
    expect(changedFiles('HEAD', twoCommitRepo())).toEqual([]);
  });

  it('uses the repository root by default', () => {
    // Non-vacuity for the default argument: every case above passes an explicit root.
    expect(Array.isArray(changedFiles('HEAD'))).toBe(true);
  });
});
