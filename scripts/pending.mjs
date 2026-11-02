#!/usr/bin/env node
/**
 * A root script that exists, is documented, and says exactly which task implements it.
 *
 * `CLAUDE.md` §4 requires every command in its table to exist from M0 onwards, and `14` §2 M0-T1
 * allows the ones whose subsystem has not been built yet to "exit 0 with a notice". This is that
 * notice. It is deliberately not a silent no-op: it names the command, the milestone task that
 * fills it in, and what to run in the meantime.
 *
 * This is NOT a production-path stub (`14` §0.2) — it is a developer convenience command whose
 * subsystem does not exist yet. Nothing in the running product can reach it.
 *
 * Usage: node scripts/pending.mjs <command> <task-id> <what it will do> [what to do instead]
 */
const [command, task, purpose, instead] = process.argv.slice(2);

if (!command || !task || !purpose) {
  console.error('usage: node scripts/pending.mjs <command> <task-id> <purpose> [alternative]');
  process.exit(2);
}

const lines = [
  '',
  `  ${command} is not implemented yet.`,
  '',
  `  What it will do:  ${purpose}`,
  `  Implemented by:   ${task}  (see docs/plan/14-milestones.md)`,
];
if (instead) lines.push('', `  For now:          ${instead}`);
lines.push('');
console.log(lines.join('\n'));
