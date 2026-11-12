/**
 * Message reads with no eligibility filter (`02` §3.7.1, `01` §14 A11).
 *
 * This file's **path** is the enforcement: `.dependency-cruiser.cjs`'s
 * `unfiltered-reads-restricted-callers` forbids any module outside
 * `engine/tools-executor`, `storage/src` and test-shaped files from importing
 * `packages/storage/src/repos/unfiltered/`. A method on `SqliteMessageRepository` would have been
 * reachable by every importer of that module, so the rule would have passed while guarding
 * nothing — the same shape as the guards the M1 review found passing for the wrong reason.
 *
 * The ordering contract is identical to the filtered `window`: the most recent `limit`, returned
 * oldest first, paged on `rid`. Same contract on purpose, so retention and export can reuse a
 * caller's paging logic without a second set of assumptions about what `limit` means.
 */
import type { Message, MessageWindow } from '@comvivo/core';
import type { MessageReaderUnfiltered } from '@comvivo/core/unfiltered';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { Db } from '../../db/drizzle.js';
import { messages } from '../../schema/index.js';
import { toMessage } from '../rows.js';

export class SqliteMessageReaderUnfiltered implements MessageReaderUnfiltered {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  windowUnfiltered(window: MessageWindow): readonly Message[] {
    const rows = this.#db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, window.conversationId),
          ...(window.beforeRid === undefined ? [] : [lt(messages.rid, window.beforeRid)]),
        ),
      )
      .orderBy(desc(messages.rid))
      .limit(window.limit)
      .all();
    return rows.reverse().map(toMessage);
  }
}
