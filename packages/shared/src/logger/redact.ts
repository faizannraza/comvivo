/**
 * pino redaction paths — defence in depth beneath the closed field type.
 *
 * `11` §3.10.1 and `08` §3.10 layer 1. The type in `fields.ts` is what actually stops content being
 * logged; this catches the cases the type cannot see: a value that arrived as `unknown` and was
 * widened, an object a third-party serialiser attached, a field pino itself adds.
 *
 * `remove: true` rather than a placeholder: an absent field cannot be accidentally un-redacted by a
 * downstream log shipper that only understands its own placeholder convention.
 *
 * **Redact paths are static code, never user input** (`11` §3.10.1, citing the pino advisory): a
 * path built from a request would let an attacker choose what is *not* redacted.
 */

/**
 * Paths pino removes before writing a line.
 *
 * Both the camelCase and snake_case spellings appear because provider SDKs use both, and a path
 * that does not match is a path that does nothing.
 *
 * Each name is listed **twice**: bare for the top level and `*.`-prefixed for one level down.
 * pino's `*` matches exactly one segment, so `*.text` does not match a root-level `text` — which
 * is the most likely shape of the mistake this layer exists to catch. Depth beyond that is handled
 * by `stripForbiddenFields` in the logger, which walks the whole object; this list is the pino
 * layer, not the only one.
 */
export const REDACT_PATHS: readonly string[] = [
  // --- Top level ---------------------------------------------------------------------------------
  'text',
  'content',
  'prompt',
  'messages',
  'richText',
  'rich_text',
  'raw',
  'body',
  'args',
  'input',
  'output',
  'token',
  'accessToken',
  'apiKey',
  'api_key',
  'password',
  'passphrase',
  'secret',
  'key',
  'authorization',
  'cookie',
  'displayName',
  'memberName',
  'phone',
  'email',

  // --- Credentials (08 §3.10 layer 1) -----------------------------------------------------------
  '*.token',
  '*.accessToken',
  '*.access_token',
  '*.refreshToken',
  '*.refresh_token',
  '*.apiKey',
  '*.api_key',
  '*.password',
  '*.passphrase',
  '*.secret',
  '*.key',
  '*.privateKey',
  '*.private_key',
  '*.authorization',
  '*.cookie',
  'headers',
  'headers.*',
  'req.headers',
  'res.headers',

  // --- Content (11 §3.10.1) ---------------------------------------------------------------------
  '*.text',
  '*.content',
  '*.prompt',
  '*.messages',
  '*.richText',
  '*.rich_text',
  '*.raw',
  '*.body',
  '*.args',
  '*.input',
  '*.output',

  // --- Configuration subtrees that hold credentials ---------------------------------------------
  'config.channels',
  'config.channels.*',
  'config.email.imap',
  'config.email.imap.*',
  'config.models',
  'config.models.*',
  'config.security',
  'config.security.*',

  // --- Personal data -----------------------------------------------------------------------------
  // A display name in a log is personal data about someone who never agreed to appear in the
  // host's terminal.
  '*.displayName',
  '*.display_name',
  '*.memberName',
  '*.phone',
  '*.email',
];

/**
 * The pino `redact` option.
 *
 * No `censor`: with `remove: true` the field is deleted outright, and a placeholder would only
 * invite a downstream log shipper to recognise and "helpfully" restore it.
 */
export function redactOptions(): { paths: string[]; remove: true } {
  return { paths: [...REDACT_PATHS], remove: true };
}
