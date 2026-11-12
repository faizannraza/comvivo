/**
 * `comvivo/no-secret-equality` — `08` §3.7.13's ban on comparing a secret with `===`.
 *
 * > `secureEqual(a, b)` = `timingSafeEqual(sha256(a), sha256(b))`. Lint bans `===`/`!==` on
 * > identifiers matching `/token|secret|code|hash|mac/i` outside `shared/crypto`.
 *
 * A `===` on a token leaks, through timing, where the two strings first differ. That is a real
 * attack on a secret an attacker can present repeatedly — a session cookie, a pairing code, the
 * CLI control token — and the fix is one import away, which is exactly why the easy wrong thing
 * should be a build failure.
 *
 * ## Why this is a rule and not a `no-restricted-syntax` selector
 *
 * Two reasons, both learned from this repository.
 *
 * ESLint flat config **replaces** a rule's options rather than merging them, so every block that
 * sets `no-restricted-syntax` has to restate every selector that applies to its paths — four
 * blocks already, and this ban has an exemption of its own, which would have doubled them to
 * eight. A rule with its own id composes instead of colliding.
 *
 * And the pattern needs judgement a selector cannot express. `/code/i` as written matches
 * `error.code === 'ENOENT'`, which is an errno, and `exitCode === 0`, which is a number. Measured
 * on this tree: 26 comparisons match the spec's regex and 23 of them are errno or exit codes. A
 * security rule that fires 23 times on correct code is a rule people disable — the one thing it
 * must not be. So the pattern here is the spec's intent, narrowed to names that can only be
 * secrets, and `08` §3.7.13 records the narrowing.
 */
import type { Rule } from 'eslint';

/**
 * Name words that always mean a secret or a value derived from one.
 *
 * Matched against **words**, not substrings: `machineId` is not a MAC and `hashtag` is not a hash.
 * Splitting on camelCase and underscores is what makes that distinction, rather than a regex with
 * lookarounds nobody can read.
 */
export const SECRET_WORDS: readonly string[] = [
  'token',
  'secret',
  'passphrase',
  'digest',
  'hash',
  'hmac',
  'mac',
  'otp',
];

/**
 * `code` and `key` are secrets only when something qualifies them.
 *
 * The pairing code, the claim code and the link code are secrets. An errno, an exit code, a status
 * code and a country code are not, and they are the overwhelming majority of `code` comparisons in
 * any codebase. The same is true of `key` twice over: measured on this tree, every `key ===` is a
 * map key, a column key, a partition key or a config key, and a *cryptographic* key is a `Buffer`
 * that `===` would not usefully compare anyway. So a bare `code` or `key` is allowed and an
 * adjacent qualifier makes it a finding — `dataKey`, `recoveryCode`, `masterKey`.
 */
export const QUALIFIERS: readonly string[] = [
  'claim',
  'pair',
  'pairing',
  'link',
  'invite',
  'csrf',
  'auth',
  'otp',
  'totp',
  'recovery',
  'magic',
  'access',
  'refresh',
  'session',
  'unlock',
  'host',
  'group',
  'master',
  'root',
  'data',
  'vault',
  'private',
  'signing',
  'blob',
  'backup',
  'dek',
  'kek',
  'api',
];

/** The words that are a secret only when qualified. */
export const QUALIFIED_WORDS: readonly string[] = ['code', 'key'];

/** Split an identifier into lowercase words: `sessionDigest` → `['session', 'digest']`. */
export function words(name: string): readonly string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => (part === '' ? [] : [part.toLowerCase()]));
}

/** Does this identifier name a secret, by the rule above? */
export function namesASecret(name: string): boolean {
  const parts = words(name);
  if (parts.some((part) => SECRET_WORDS.includes(part))) return true;
  return parts.some(
    (part, index) =>
      QUALIFIED_WORDS.includes(part) && index > 0 && QUALIFIERS.includes(parts[index - 1] ?? ''),
  );
}

const MESSAGE =
  'Comparing {{name}} with {{operator}} leaks, through timing, where the two values first ' +
  'differ (08 §3.7.13). Use `secureEqual` — or `secureEqualDigest` against a stored digest — ' +
  'from `@comvivo/shared/crypto`.';

/** The expression's name, if it has one a reader would recognise. */
function nameOf(node: unknown): string | undefined {
  const expression = node as {
    type?: string;
    name?: string;
    property?: { type?: string; name?: string };
  };
  if (expression.type === 'Identifier') return expression.name;
  if (expression.type === 'MemberExpression' && expression.property?.type === 'Identifier') {
    return expression.property.name;
  }
  if (expression.type === 'PrivateIdentifier') return expression.name;
  return undefined;
}

/**
 * `=== undefined`, `!== null` and `=== ''` are presence checks, not comparisons of a value.
 *
 * There is no secret on the other side of any of them, and `secureEqual(token, '')` is a strange
 * way to ask whether a string is empty. The empty string is the **only** literal allowed: a
 * comparison against any other — `token === 'let-me-in'` — is a hard-coded secret, which is the
 * worst case this rule exists for rather than an exemption from it.
 *
 * Added after the rule's first run reported `mac === ''` in the magic-link verifier. The
 * alternative was spelling it `mac.length === 0`, which satisfies the rule without the rule
 * understanding why — and teaches the next person to rename their way out of a security check.
 */
function isPresenceCheck(node: unknown): boolean {
  const side = node as { type?: string; name?: string; value?: unknown; raw?: string };
  if (side.type === 'Identifier' && side.name === 'undefined') return true;
  if (side.type !== 'Literal') return false;
  return side.raw === 'null' || side.value === '';
}

export const noSecretEquality: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require a constant-time comparison for secrets (08 §3.7.13). Presence checks against ' +
        'undefined or null are allowed, because there is no secret on the other side.',
    },
    schema: [],
    messages: { insecure: MESSAGE },
  },
  create(context) {
    return {
      BinaryExpression(node): void {
        if (!['===', '!==', '==', '!='].includes(node.operator)) return;
        // A presence check has nothing to compare in constant time: `timingSafeEqual(x, undefined)`
        // is not a stronger version of `x === undefined`, it is a type error.
        if (isPresenceCheck(node.left) || isPresenceCheck(node.right)) return;
        for (const side of [node.left, node.right]) {
          const name = nameOf(side);
          if (name === undefined || !namesASecret(name)) continue;
          context.report({
            node,
            messageId: 'insecure',
            data: { name, operator: node.operator },
          });
          return;
        }
      },
    };
  },
};

/** The plugin `eslint.config.ts` registers. One rule today; the namespace is the point. */
export const comvivoPlugin = {
  rules: { 'no-secret-equality': noSecretEquality },
};
