/**
 * `@comvivo/tools`
 *
 * Built-in tools: calendar, reminders, tasks and chores, lists, polls, plans, decisions, memory, catch-up, settings and the constitution. Tools receive repositories through ToolContext ports and never import storage.
 *
 * Scaffolded by M0-T1. The implementation lands in this package's own milestone; see
 * `docs/plan/14-milestones.md`.
 */

// --- The authoritative built-in catalogue (05 §3.6.7; M2-T17) ---------------------------------
export {
  BUILTIN_BLOCKS,
  BUILTIN_TOOL_ORDER,
  type BuiltinBlock,
  builtinIndex,
  isBuiltinToolName,
  OPTIONAL_BUILTIN_TOOLS,
} from './catalog.js';
