/**
 * A filesystem-backed fixture store for the conformance kit (`06` §3.25; `M3-T9`).
 *
 * It sits in `tools/fixtures/` rather than inside `@comvivo/channel-sdk/testing`, and the reason is
 * the one worth recording: the kit is a **published** entry point that third-party channel plugins
 * run (`06` §3.25's last line), and a published test kit should not assume Node. `FixtureStore` is
 * a dozen lines over whatever the host environment provides, and for a Vite-based plugin that is
 * `import.meta.glob` rather than `readdir` — so a Node implementation inside the kit would be the
 * wrong default as well as an unportable one.
 *
 * It also kept a guard intact. Biome's `noNodejsModules` covers all of `packages/channels/sdk/**`
 * with no `/testing/` exemption, while dependency-cruiser's equivalent exempts every `/testing/`
 * directory. The first draft put this inside the kit and had to either widen Biome's rule or change
 * the design (`CLAUDE.md` §2: "Never weaken a rule to make an import work; fix the design").
 *
 * The return type is declared **structurally** rather than imported from the SDK, because `tools/`
 * belongs to the root package and has no workspace dependencies — and the shape is two methods, so
 * the import would buy nothing but a coupling.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** `@comvivo/channel-sdk/testing`'s `FixtureStore`, structurally. */
export interface FixtureStoreLike {
  list(kind: string): Promise<readonly string[]>;
  read(path: string): Promise<unknown>;
}

/**
 * Read fixtures from `<dir>/<kind>/*.json`.
 *
 * `06` §3.25's layout is `fixtures/channels/<id>/{inbound,outbound,errors,probe}/*.json`, so each
 * family is one directory read rather than a recursive walk: a nested directory under `inbound/` is
 * a layout nobody agreed to, and including it silently is how a corpus grows a second convention.
 *
 * A missing family directory is **empty, not an error** — a channel with no native polls has no
 * `probe/` directory to write, and the alternative is every adapter shipping four directories so
 * that one of them can be empty.
 */
export function nodeFixtureStore(dir: string): FixtureStoreLike {
  return {
    list: async (kind: string) => {
      let entries: string[];
      try {
        entries = await readdir(join(dir, kind));
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
      return entries
        .filter((name) => name.endsWith('.json'))
        .toSorted()
        .map((name) => `${kind}/${name}`);
    },
    read: async (path: string) => {
      const text = await readFile(join(dir, path), 'utf8');
      try {
        return JSON.parse(text) as unknown;
      } catch (error) {
        // Named, because `Unexpected token } in JSON at position 412` with no filename is the least
        // useful message a corpus of two hundred files can produce.
        throw new TypeError(
          `${path} is not valid JSON: ${error instanceof Error ? error.message : 'unknown'}`,
        );
      }
    },
  };
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
