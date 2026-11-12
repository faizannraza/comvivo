/**
 * Reads that skip the eligible-label filter (`02` §3.7.1, `01` §14 A11).
 *
 * ## Why this is a separate module and a separate entry point
 *
 * `02` §3.7.1 says labeled reads "are explicitly named `…Unfiltered` and import-restricted to
 * `engine/tools-executor`, `engine/retention` and `storage` internals (dependency-cruiser rule)".
 * Dependency-cruiser restricts **module imports**, not method calls — so an `…Unfiltered` method
 * sitting on `MessageReader` beside the filtered ones is a restriction the rule cannot express, and
 * `unfiltered-reads-restricted-callers` would pass while guarding nothing. The rule's own path
 * pattern says where these belong: `packages/core/src/ports/storage/unfiltered`.
 *
 * For the same reason this module is **not re-exported from the package root**. A barrel that
 * re-exported it would itself be an unrestricted importer, and every consumer of `@comvivo/core`
 * would inherit the edge — the guard would be satisfied by one file and defeated for all of them.
 * It is `@comvivo/core/unfiltered`, which is the one case in this package where a narrow entry
 * point pays for itself: it is what makes the restriction real.
 *
 * ## What callers are promising
 *
 * That they have already decided authority by another route, or that they are not an audience at
 * all. The tool executor has applied the requester's authority (`I3`); the retention sweep deletes
 * rows it must not read; an export is the host taking their own data, which is outside the IFC
 * model. Anything else importing this is a labeled read with the label check removed — `I1` deleted
 * in one import, which is what the rule's comment says.
 */
import type { Message } from '../../domain/message.js';
import type { MessageWindow } from './repos/messages.js';

/**
 * Message reads with no eligibility filter.
 *
 * Deliberately **not** extended from `MessageReader`: inheriting it would mean a caller holding
 * this interface could also perform the filtered reads, and the point of the split is that a module
 * which needs unfiltered access asks for exactly that and nothing more.
 */
export interface MessageReaderUnfiltered {
  /**
   * Every message in a window, regardless of label.
   *
   * Same ordering contract as the filtered `window`: the most recent `limit`, oldest first, paged
   * on `rid`. Keeping the contracts identical is what lets retention and export reuse a caller's
   * paging logic without a second set of assumptions.
   */
  windowUnfiltered(window: MessageWindow): readonly Message[];
}
