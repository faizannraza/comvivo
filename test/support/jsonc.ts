/**
 * Parse a commented tsconfig.
 *
 * `tsconfig.base.json`, `tsconfig.paths.json` and their siblings are JSONC: TypeScript accepts
 * comments and trailing commas, `JSON.parse` does not. Three test helpers needed to read them and
 * each had grown its own stripper, which is one stripper too many — the subtle part is not the
 * block comments but the `[^:"]` guard on the line-comment pattern, without which the `//` in
 * `"$schema": "https://json.schemastore.org/tsconfig"` truncates the line and the parse fails.
 */

/** Strip comments and trailing commas so a jsonc file can be parsed as JSON. */
export function parseJsonc(source: string): unknown {
  const withoutBlocks = source.replaceAll(/\/\*[\s\S]*?\*\//g, '');
  // `(^|[^:"])` keeps a `//` that follows a colon or a quote, i.e. the one inside a URL.
  const withoutLines = withoutBlocks.replaceAll(/(^|[^:"])\/\/.*$/gm, '$1');
  return JSON.parse(withoutLines.replaceAll(/,(\s*[}\]])/g, '$1'));
}
