/**
 * Secret values that cannot be printed by accident.
 *
 * `08` §3.10 (S2). The resolution of secrets from the environment lives in
 * `@comvivo/shared` → `config/secrets.ts`; this is the type that carries one once it is loaded.
 */
export { isSecretString, REDACTED, SecretString, secret } from './secret-string.js';
