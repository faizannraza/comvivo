/**
 * The single place the product's name lives.
 *
 * Everything user-visible that contains the name — package names, the CLI binary, the config file,
 * environment variables, the container image, URLs, the default bot persona — is derived from here.
 * `scripts/brand/check.ts` runs in `pnpm verify` and fails the build if the name appears as a
 * literal anywhere else under `packages/**` or `apps/**`, and `scripts/brand/rename.ts` rewrites
 * every surface the guard cannot cover. A weekly CI drill renames the whole tree to a throwaway
 * slug and runs the full verification, so a rename is always a one-command operation.
 *
 * That machinery is not theoretical: the name changed twice during M0 (see
 * `docs/adr/ADR-024-product-name.md`).
 *
 * This module must stay **pure** — no I/O, no `node:*` imports, no `process` — because
 * `@comvivo/core` imports it for the router's name-invocation defaults.
 *
 * Specification: `docs/plan/13-docs-launch-community.md` §4.1, §3.A.6; `docs/plan/01-architecture.md` §14 A2.
 */

/** Every name-bearing surface of the product. */
export interface Brand {
  /** The slug the brand guard searches for. Equal to `slug`. */
  readonly codename: string;
  /** Title case, for prose and the dashboard chrome. */
  readonly displayName: string;
  /** `[a-z0-9-]+`. The canonical machine-readable form. */
  readonly slug: string;
  /** The `bin` name users type. */
  readonly cliName: string;
  /** Resolved by `npx <pkg>@latest init`. The thin CLI package (`01` §14 A2). */
  readonly npmCliPackage: string;
  /** The workspace scope for every internal package. */
  readonly npmScope: `@${string}`;
  /** Prefix for the project's own environment variables. Platform tokens stay unprefixed. */
  readonly envPrefix: string;
  /** The non-secret, versioned config file a host keeps next to their compose file. */
  readonly configFileName: string;
  /** Directory name used when deriving a default data directory under a user's home. */
  readonly dataDirName: string;
  /** Container image, without a tag. */
  readonly containerImage: string;
  /** Default in-chat persona. Only a default: groups rename their own bot, and a later product rename never changes an existing group's bot name. */
  readonly botDefaultName: string;
  /** Default name-invocation aliases for the router. Kept deliberately small; the false-positive rate is measured in `M3-T22` and must stay at or below 0.1%. */
  readonly botDefaultAliases: readonly string[];
  readonly repo: { readonly owner: string; readonly name: string };
  readonly urls: {
    readonly site: string;
    readonly docs: string;
    readonly demo: string;
    /** Community home. `D-7`: GitHub Discussions is the guaranteed baseline; a chat space is additive. */
    readonly community: string;
    readonly security: string;
    readonly releaseManifest: string;
  };
  readonly emails: { readonly security: string; readonly conduct: string };
  /**
   * Names from before a rename. The config loader accepts these with a deprecation warning until
   * 1.1, so hosts who tried an earlier build are never stranded (`13` §3.A.6).
   */
  readonly legacy: {
    readonly envPrefixes: readonly string[];
    readonly configFileNames: readonly string[];
  };
}

/**
 * `comvivo` — *com* ("with", the Portuguese and Catalan form of Latin *cum*) + *vivo* ("I live"):
 * living together. It is the root of English *convivial*.
 *
 * The owner has not yet created the GitHub or npm organisations, so `repo.owner` and
 * `containerImage` point at the owner's personal namespace and `urls` point at GitHub Pages.
 * Both move in one edit once `STATUS.md` → H-6 is done.
 *
 * Annotated `: Brand` rather than `as const satisfies Brand` because `isolatedDeclarations`
 * requires an explicit type on an exported value. The annotation keeps excess-property checking,
 * so a typo in a field name is still a compile error.
 */
export const BRAND: Brand = {
  codename: 'comvivo',
  displayName: 'Comvivo',
  slug: 'comvivo',
  cliName: 'comvivo',
  npmCliPackage: 'comvivo',
  npmScope: '@comvivo',
  envPrefix: 'COMVIVO_',
  configFileName: 'comvivo.yaml',
  dataDirName: 'comvivo',
  containerImage: 'ghcr.io/faizannraza/comvivo',
  botDefaultName: 'Comvivo',
  botDefaultAliases: ['comvivo'],
  repo: { owner: 'faizannraza', name: 'comvivo' },
  urls: {
    site: 'https://faizannraza.github.io/comvivo',
    docs: 'https://faizannraza.github.io/comvivo/docs',
    demo: 'https://faizannraza.github.io/comvivo/demo',
    community: 'https://github.com/faizannraza/comvivo/discussions',
    security: 'https://github.com/faizannraza/comvivo/security/policy',
    releaseManifest: 'https://faizannraza.github.io/comvivo/release-manifest.json',
  },
  emails: { security: 'faizanraza766@gmail.com', conduct: 'faizanraza766@gmail.com' },
  legacy: { envPrefixes: ['VILLAGE_'], configFileNames: ['village.yaml'] },
};

/**
 * Build one of the project's own environment-variable names.
 *
 * @example envVar('DEBUG_CONTENT') // 'COMVIVO_DEBUG_CONTENT'
 */
export const envVar = (name: string): string => `${BRAND.envPrefix}${name}`;

/** Legacy spellings of an environment variable, oldest-supported first. Accepted with a deprecation warning until 1.1. */
export const legacyEnvVars = (name: string): readonly string[] =>
  BRAND.legacy.envPrefixes.map((prefix) => `${prefix}${name}`);
