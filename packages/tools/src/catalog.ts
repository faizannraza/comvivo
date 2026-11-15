/**
 * The authoritative built-in tool catalog: names and order (`05` §3.6.7; `M2-T17`).
 *
 * ## Why the order is a specification and not a style choice
 *
 * The tool catalogue sits at **breakpoint 1** of the prompt cache, together with the charter
 * (`05` §3.4.8). Every group with the same enabled set shares that cache entry, which on most
 * instances is every group. A prompt cache is a **byte-prefix** match: reorder two tools and every
 * group on the host pays to write the whole layer again, on the next turn and on every turn until
 * somebody notices the bill. Nothing fails, nothing logs, the answers are identical — the cost just
 * roughly doubles on the largest layer in the prompt.
 *
 * So the order lives here, once, as data: `05` §3.6.7's table, rows top to bottom and tools left to
 * right within a row. Not alphabetical, because the table is grouped by the document that owns each
 * block and a reader checking a block against its owning document should find it contiguous.
 * `catalog.test.ts` parses that table out of `docs/plan/05-agent-runtime.md` and fails if the two
 * disagree, so the spec and the constant cannot drift.
 *
 * ## What is here now, and what is not
 *
 * `BUILTIN_TOOL_ORDER` is complete: all 62 names, plus the optional `web_search`. The **definitions**
 * are not — they land with the milestones that own them (`M4` memory, `M6`–`M7` coordination), and
 * `BUILTIN_TOOLS` below holds the ones that exist today. That split is deliberate rather than a
 * shortcut: the order is what the cache depends on and it is knowable now, while a definition
 * depends on repositories that do not exist yet. `M7-T36` freezes the list.
 */

/** One block of `05` §3.6.7's table, with the document that owns its tools. */
export interface BuiltinBlock {
  /** The row number in `05` §3.6.7, so a failure message can name it. */
  readonly row: number;
  /** The owning document and section, verbatim from the table. */
  readonly owner: string;
  /** Tool names in table order. Never sorted. */
  readonly tools: readonly string[];
}

/**
 * `05` §3.6.7's table, transcribed.
 *
 * Blocks 1–12 are the shipped built-ins. Block 13 is instance-level and off by default, which is
 * why it is excluded from `BUILTIN_TOOL_ORDER` and reachable through `OPTIONAL_BUILTIN_TOOLS`.
 */
export const BUILTIN_BLOCKS: readonly BuiltinBlock[] = Object.freeze([
  Object.freeze({
    row: 1,
    owner: 'Memory (04 §3.9.7)',
    tools: Object.freeze([
      'memory_recall',
      'memory_remember',
      'memory_forget',
      'memory_correct',
      'memory_pin',
      'memory_about',
    ]),
  }),
  Object.freeze({
    row: 2,
    owner: 'Calendar (07 §4.1 #1–9)',
    tools: Object.freeze([
      'calendar_search_events',
      'calendar_check_availability',
      'calendar_create_event',
      'calendar_update_event',
      'calendar_cancel_event',
      'calendar_rsvp',
      'calendar_subscribe_ics',
      'calendar_manage_subscription',
      'calendar_feed_link',
    ]),
  }),
  Object.freeze({
    row: 3,
    owner: 'Reminders (07 §4.1 #10–12)',
    tools: Object.freeze(['reminder_create', 'reminder_list', 'reminder_update']),
  }),
  Object.freeze({
    row: 4,
    owner: 'Tasks and chores (07 §4.1 #13–22)',
    tools: Object.freeze([
      'task_create',
      'task_list',
      'task_update',
      'task_assign',
      'task_respond_assignment',
      'task_complete',
      'chore_rotation_upsert',
      'chore_swap',
      'chore_swap_respond',
      'chores_load_view',
    ]),
  }),
  Object.freeze({
    row: 5,
    owner: 'Lists (07 §4.1 #23–26)',
    tools: Object.freeze(['list_add_items', 'list_view', 'list_update_items', 'list_manage']),
  }),
  Object.freeze({
    row: 6,
    owner: 'Polls (07 §4.1 #27–30)',
    tools: Object.freeze(['poll_create', 'poll_vote', 'poll_manage', 'poll_results']),
  }),
  Object.freeze({
    row: 7,
    owner: 'Plans (07 §4.1 #31–33)',
    tools: Object.freeze(['plan_create', 'plan_update', 'plan_view']),
  }),
  Object.freeze({
    row: 8,
    owner: 'Decisions (07 §4.1 #34–36)',
    tools: Object.freeze(['decision_record', 'decision_search', 'decision_update']),
  }),
  Object.freeze({
    row: 9,
    owner: 'Catch-up, agenda, proactivity (07 §4.1 #37–42)',
    tools: Object.freeze([
      'catchup_generate',
      'catchup_mark_read',
      'agenda_view',
      'coordination_prefs_update',
      'proactivity_feedback',
      'proactivity_explain',
    ]),
  }),
  Object.freeze({
    row: 10,
    owner: 'Governance and privacy (03 §3.3.13)',
    tools: Object.freeze([
      'constitution_show',
      'constitution_propose_amendment',
      'proposal_vote',
      'proposal_withdraw',
      'relay_to_group',
      'my_constraints',
      'constraint_revoke',
      'privacy_info',
    ]),
  }),
  Object.freeze({
    row: 11,
    owner: 'Runtime (05, defined below)',
    tools: Object.freeze(['group_settings_view', 'group_settings_update', 'member_list']),
  }),
  Object.freeze({
    row: 12,
    owner: 'Skills and extensions (10 §3.10.3, §3.3.5)',
    tools: Object.freeze(['use_skill', 'read_skill_file', 'extensions_enable']),
  }),
  Object.freeze({
    row: 13,
    owner: 'Optional, instance-level (off by default)',
    tools: Object.freeze(['web_search']),
  }),
]);

/** The row number of the optional, instance-level block. */
const OPTIONAL_ROW = 13;

/**
 * Every shipped built-in, in catalogue order.
 *
 * 62 names. `05` §3.6.7 states that count, and `catalog.test.ts` asserts it — a transcription that
 * dropped a tool would otherwise look exactly like a tool that has not been written yet.
 */
export const BUILTIN_TOOL_ORDER: readonly string[] = Object.freeze(
  BUILTIN_BLOCKS.filter((block) => block.row !== OPTIONAL_ROW).flatMap((block) => [...block.tools]),
);

/**
 * Built-ins a host can switch on at instance level, off by default.
 *
 * `web_search` is a **client** tool with a pluggable backend rather than the Anthropic server tool,
 * so its results carry the `untrusted` label and go through the same IFC fencing as anything else a
 * stranger wrote (`05` §3.6.7). A server-side search would return text straight into the model's
 * context with no label on it.
 */
export const OPTIONAL_BUILTIN_TOOLS: readonly string[] = Object.freeze(
  BUILTIN_BLOCKS.filter((block) => block.row === OPTIONAL_ROW).flatMap((block) => [...block.tools]),
);

/** Position in the catalogue, or `undefined` for a name that is not a built-in. */
export function builtinIndex(name: string): number | undefined {
  const index = BUILTIN_TOOL_ORDER.indexOf(name);
  return index === -1 ? undefined : index;
}

/** Whether a name is a shipped or optional built-in. Built-in names never contain `__`. */
export function isBuiltinToolName(name: string): boolean {
  return BUILTIN_TOOL_ORDER.includes(name) || OPTIONAL_BUILTIN_TOOLS.includes(name);
}
