/**
 * `@comvivo/shared`
 *
 * Cross-cutting primitives: branded ids, typed errors, Result helpers, zod utilities, the
 * redacting logger, the config loader, the BRAND constant, and the Clock/IdGenerator/Rng ports.
 *
 * Scaffolded by M0-T1. The rest lands in M0-T6 through M0-T9; see
 * `docs/plan/14-milestones.md`.
 */

export { BRAND, type Brand, envVar, legacyEnvVars } from './brand.js';
