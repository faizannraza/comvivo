/**
 * Configuration → retention windows (`02` §3.13.1, `08` §3.16.2).
 *
 * One function, and its only job is to be the **single** place a spine key becomes a number the
 * sweep uses. `02` §3.13.1's table names the key beside each default, so the mapping is mechanical —
 * which is exactly why it should exist once rather than be read at each call site: a sweep that
 * reached into `config.privacy` itself would be a sweep whose windows a test could not supply, and
 * every retention test would then need a whole `Config`.
 *
 * `messages` is deliberately absent. Its window is stamped into `retention_until` at insert, from
 * the **sender's** consent and the group's constitution (`02` §3.13.1) — so one group can keep
 * messages for 90 days while another keeps them for 7, and the sweep compares a column rather than
 * consulting a setting. Shortening a group's retention is a *recompute* job (`03`), not something
 * the sweep notices.
 */
import type { RetentionWindows } from '@comvivo/core';
import type { Config } from '@comvivo/shared';
import { MEMORY_OPS_RETENTION_DAYS } from './rules.js';

/**
 * Read the windows out of a loaded configuration.
 *
 * `traces.retentionDays` drives **two** of them, which `02` §3.13.1 states as "Turns + effects |
 * 30 days after completion | follows traces". A turn whose trace is gone cannot be explained — the
 * trace is the manifest of what the turn read and decided — so a separate turn window would only
 * ever be able to make the pair inconsistent in one of two useless ways: turns without traces
 * (unexplainable) or traces without turns (dangling).
 */
export function retentionWindowsFrom(config: Config): RetentionWindows {
  return {
    traceDays: config.traces.retentionDays,
    usageDays: config.privacy.usageRetentionDays,
    jobSucceededDays: config.jobs.retainSucceededDays,
    jobDeadDays: config.jobs.retainDeadDays,
    outboxDays: config.outbox.retainDays,
    outboxDeadDays: config.outbox.retainDeadDays,
    memoryOpsDays: MEMORY_OPS_RETENTION_DAYS,
    auditDays: config.privacy.auditRetentionDays,
  };
}
