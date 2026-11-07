/**
 * The `release-small` seed profile for database snapshots (`02` §3.12.6).
 *
 * Lives in the storage package rather than in `scripts/`, because it is knowledge about *this*
 * schema and because the seeder needs the package's own dependencies — `sqlite-vec` and the
 * driver are dependencies of `@comvivo/storage`, not of the repository root, so a script in
 * `scripts/` cannot resolve them. (Measured, after writing it there first.)
 *
 * Deliberately small and deliberately *representative* rather than exhaustive. The point of a
 * snapshot is to have rows in the tables a migration is most likely to rebuild — a group, a
 * member, a labeled message, a memory with its FTS rows — so that a rebuild which drops children
 * or forgets to recreate a trigger fails the upgrade test. A fixture covering all 78 tables would
 * be a maintenance burden nobody keeps current, and an out-of-date fixture is worse than a small
 * one because it is trusted.
 *
 * The data is **synthetic** (`11` §3.1.8). A snapshot is a committed artefact, so there is no path
 * by which a real group's content could reach it.
 */

/** A fixed instant, so two runs of the same release produce the same bytes. */
export const SEED_NOW_MS = 1_767_225_600_000;

/** The same instant as SQL text, so the statements below interpolate a string. */
const NOW = String(SEED_NOW_MS);

/** Fixed ids for the same reason. */
export const SEED_GROUP_ID = 'grp_01jsnap0000000000000000001';

export const SEED_STATEMENTS: readonly string[] = [
  `INSERT INTO persons (id, display_name, display_name_source, created_at, updated_at)
   VALUES ('prs_01jsnap0000000000000000001', 'Snapshot Person', 'platform', ${NOW}, ${NOW})`,
  `INSERT INTO groups (id, name, archetype, history_visibility, timezone, locale, week_start,
     status, membership_epoch, extensions_version, created_at, updated_at, version)
   VALUES ('${SEED_GROUP_ID}', 'Snapshot Group', 'family', 'since_join', 'UTC', 'en',
     1, 'active', 0, 0, ${NOW}, ${NOW}, 1)`,
  `INSERT INTO members (id, group_id, person_id, role, age_band, handle, status, consent,
     joined_at, created_at, updated_at, version)
   VALUES ('mbr_01jsnap0000000000000000001', '${SEED_GROUP_ID}',
     'prs_01jsnap0000000000000000001', 'admin', 'adult', 'm1', 'active', 'memory_on',
     ${NOW}, ${NOW}, ${NOW}, 1)`,
  `INSERT INTO conversations (id, group_id, channel, platform_chat_id, kind, "primary", bound_at,
     created_at, updated_at)
   VALUES ('cnv_01jsnap0000000000000000001', '${SEED_GROUP_ID}', 'simulator',
     'snapshot-chat', 'group', 1, ${NOW}, ${NOW}, ${NOW})`,
  `INSERT INTO reader_sets (group_id, kind, canonical_key, member_count, created_at)
   VALUES ('${SEED_GROUP_ID}', 'group', 'g:snapshot', 0, ${NOW})`,
  `INSERT INTO labels (group_id, reader_set_id, owner_member_id, co_owner_member_ids, sensitivity,
     influence, untrusted, canonical_key, created_at)
   VALUES ('${SEED_GROUP_ID}',
     (SELECT id FROM reader_sets WHERE canonical_key = 'g:snapshot'), NULL, '[]', 'normal', 'none',
     0, 'l:snapshot', ${NOW})`,
  `INSERT INTO messages (id, group_id, conversation_id, kind, text, untrusted, label_id, sent_at,
     received_at, delivered_late, truncated, edit_count)
   VALUES ('msg_01jsnap0000000000000000001', '${SEED_GROUP_ID}',
     'cnv_01jsnap0000000000000000001', 'member', 'Snapshot message about rhubarb', 0,
     (SELECT id FROM labels WHERE canonical_key = 'l:snapshot'), ${NOW}, ${NOW},
     0, 0, 0)`,
  `INSERT INTO memory_items (id, group_id, kind, content, statement, search_terms, language,
     fingerprint, label_id, provenance, confidence, status, valid_from, contradicts, links,
     retrieval_state, pinned, portable, embedding_state, created_at, updated_at, version)
   VALUES ('mem_01jsnap0000000000000000001', '${SEED_GROUP_ID}', 'note',
     '{"kind":"note","noteType":"general","title":null,"body":"Snapshot note","derivedFrom":[],"sections":null}',
     'Snapshot note about rhubarb', '["rhubarb"]', 'en', x'00',
     (SELECT id FROM labels WHERE canonical_key = 'l:snapshot'),
     '{"source":"explicit","sourceMessageIds":[],"windowKey":null,"extractor":null,"assertion":"explicit","assertedBy":"system","rawConfidence":null,"calibration":null,"confirmedBy":[],"derivedFrom":[],"turnId":null}',
     1, 'active', ${NOW}, '[]', '[]', 0, 0, 0, 'pending', ${NOW}, ${NOW}, 1)`,
];
