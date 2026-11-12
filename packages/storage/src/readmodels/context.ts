/**
 * `ContextReadModel` (`02` §3.7.3, `04` §3.6.3).
 *
 * ## What this is for
 *
 * `02` §3.7.3 marks it `// engine/context only`: the one read surface a context build uses, so the
 * builder asks for *what it needs for a turn* rather than assembling it from eight repositories and
 * getting the eligibility argument right eight times. Every method takes the **same**
 * `EligibleLabelSet`, computed once per turn by `04` §3.6.3's cache.
 *
 * ## It is a façade, not a second set of queries
 *
 * Every method here delegates to the repository that owns the aggregate. That is deliberate: a
 * read model with its own SQL would be a second place where an eligibility filter could be
 * forgotten, and `labels.eligibility-equivalence.property` would then be proving it about the
 * wrong code. What this layer adds is **shape** — the pair of one-off events and live series that
 * `07` has to merge, a group snapshot and its labels together, nothing more.
 *
 * ## What `02` §3.7.3 lists and this does not have yet
 *
 * `openProposals` is governance (`M1-T20`) and `searchEntities` needs `entity_fts` with the
 * coordination tables synced into it (`M1-T21`'s trigger work and `M7`'s entity resolution). They
 * are **absent rather than stubbed**: `CLAUDE.md` §8 rules out a method that throws, and an
 * interface that declared them would make every consumer's type-check pass against something that
 * cannot answer. They arrive with the milestones that build what they read.
 */
import type {
  Decision,
  EligibleLabelSet,
  Event,
  GroupSnapshot,
  Label,
  List,
  ListItem,
  Message,
  Plan,
  Poll,
  Task,
} from '@comvivo/core';
import type { ConversationId, GroupId, LabelId, MemberId } from '@comvivo/shared';
import type { Temporal } from 'temporal-polyfill';
import type { LabelStore } from '../ifc/label-store.js';
import type { SqliteCalendarRepository } from '../repos/calendar.js';
import type {
  SqliteDecisionRepository,
  SqlitePlanRepository,
  SqlitePollRepository,
} from '../repos/coordination.js';
import type { SqliteGroupRepository } from '../repos/groups.js';
import type { SqliteListRepository } from '../repos/lists.js';
import type { SqliteMessageRepository } from '../repos/messages.js';
import type { SqliteTaskRepository } from '../repos/tasks.js';

/**
 * What the read model reads through.
 *
 * Named one by one rather than taking the whole `Repositories` set, for the reason
 * `SqliteMemberRepository` takes `Pick<GroupRepository, 'bumpMembershipEpoch'>`: the dependency is
 * then visible in the constructor and reviewable. Taking the set would also have meant
 * constructing this *inside* `makeRepositories` with a cast over a half-built object, which is a
 * lie that happens to work only because nothing here reads the missing field.
 */
export interface ContextSources {
  readonly groups: Pick<SqliteGroupRepository, 'snapshot'>;
  readonly labels: Pick<LabelStore, 'groupLabels'>;
  readonly messages: Pick<SqliteMessageRepository, 'window'>;
  readonly calendar: Pick<SqliteCalendarRepository, 'upcomingOneOff' | 'activeSeries'>;
  readonly tasks: Pick<SqliteTaskRepository, 'openByDue' | 'byAssignee'>;
  readonly lists: Pick<SqliteListRepository, 'active' | 'itemsOf'>;
  readonly polls: Pick<SqlitePollRepository, 'open'>;
  readonly plans: Pick<SqlitePlanRepository, 'byStatus'>;
  readonly decisions: Pick<SqliteDecisionRepository, 'log'>;
}

/** What `02` §3.7.3's `recentMessages` returns, with the label resolved rather than its id. */
export interface MessageView {
  readonly id: Message['id'];
  readonly rid: number;
  readonly senderMemberId: MemberId | undefined;
  readonly kind: Message['kind'];
  readonly text: string;
  readonly untrusted: boolean;
  /**
   * The **resolved** label, not its id.
   *
   * `02` §3.7.3 spells it `label: Label`, and the reason is `04` §3.6.3's defence in depth: the
   * context builder re-checks every item with `ifc.canRead(label, audience, snapshot)` after
   * hydration and fails closed. It cannot do that with an integer.
   */
  readonly label: Label;
  readonly sentAt: Temporal.Instant;
  readonly replyToMessageId: Message['replyToMessageId'];
}

/** The two halves of a calendar window `07` has to merge (`02` §3.3.10 Q-CTX-6 / 6b). */
export interface CalendarWindow {
  /** One-off events inside the window, by start time. */
  readonly oneOff: readonly Event[];
  /**
   * Recurring series still live at the window's start, **unexpanded**.
   *
   * Storage does not expand an `rrule`: expansion needs the group's zone, the tzdata version and
   * the exception dates reasoned about together, which is `07`'s. Handing back the series rather
   * than occurrences is what keeps that decision in one place.
   */
  readonly series: readonly Event[];
}

/** A list and the items `07` will render under it. */
export interface ListView {
  readonly list: List;
  readonly items: readonly ListItem[];
}

export interface ContextReadModel {
  /** Q-CTX-9. The pair `01` §7.2 caches eligibility against. */
  groupSnapshot(groupId: GroupId): GroupSnapshot | undefined;
  /** Q-IFC-2: every label of a group, for `04` §3.6.3's `eligibleFor`. */
  groupLabels(groupId: GroupId): ReadonlyMap<LabelId, Label>;
  /** Q-CTX-1: the last N messages of a conversation, oldest first. */
  recentMessages(query: {
    readonly conversationId: ConversationId;
    readonly limit: number;
    readonly beforeRid?: number | undefined;
    readonly eligible: EligibleLabelSet;
  }): readonly MessageView[];
  /** Q-CTX-6 and Q-CTX-6b together, because `07` needs both to answer "what is coming up". */
  upcomingEvents(query: {
    readonly groupId: GroupId;
    readonly from: Temporal.Instant;
    readonly to: Temporal.Instant;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): CalendarWindow;
  /** Q-CTX-7: open tasks, optionally one member's. */
  openTasks(query: {
    readonly groupId: GroupId;
    readonly assignee?: MemberId | undefined;
    readonly dueBefore?: Temporal.Instant | undefined;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly Task[];
  /** Q-COO-3: the group's active lists with their unchecked items. */
  activeLists(query: {
    readonly groupId: GroupId;
    readonly itemLimit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly ListView[];
  /** Q-COO-4: open polls, soonest deadline first. */
  openPolls(query: {
    readonly groupId: GroupId;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly Poll[];
  /** Plans still being worked on, with their steps available through the plan repository. */
  activePlans(query: {
    readonly groupId: GroupId;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly Plan[];
  /** Q-COO-5: the decision log, newest first. */
  recentDecisions(query: {
    readonly groupId: GroupId;
    readonly since?: Temporal.Instant | undefined;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly Decision[];
}

export class SqliteContextReadModel implements ContextReadModel {
  readonly #repos: ContextSources;

  constructor(repos: ContextSources) {
    this.#repos = repos;
  }

  groupSnapshot(groupId: GroupId): GroupSnapshot | undefined {
    return this.#repos.groups.snapshot(groupId);
  }

  groupLabels(groupId: GroupId): ReadonlyMap<LabelId, Label> {
    return this.#repos.labels.groupLabels(groupId);
  }

  /**
   * Q-CTX-1, with the label resolved per message.
   *
   * The labels come from the group's own map rather than one lookup per message: a window of 50
   * messages in a group with 200 labels is one read either way, and the per-message form would be
   * 50. A message whose label is missing from the map is **dropped** — it cannot be re-checked by
   * `04` §3.6.3's `canRead`, and `01` §7.2's rule is to fail closed.
   */
  recentMessages(query: {
    readonly conversationId: ConversationId;
    readonly limit: number;
    readonly beforeRid?: number | undefined;
    readonly eligible: EligibleLabelSet;
  }): readonly MessageView[] {
    const messages = this.#repos.messages.window(
      {
        conversationId: query.conversationId,
        limit: query.limit,
        ...(query.beforeRid === undefined ? {} : { beforeRid: query.beforeRid }),
      },
      query.eligible,
    );
    if (messages.length === 0) return [];
    const labels = this.#repos.labels.groupLabels(query.eligible.groupId);
    const views: MessageView[] = [];
    for (const message of messages) {
      const label = labels.get(message.labelId);
      // Fail closed: an item the builder cannot re-check is an item it must not use.
      if (label === undefined) continue;
      views.push({
        id: message.id,
        rid: message.rid,
        senderMemberId: message.senderMemberId,
        kind: message.kind,
        text: message.text,
        untrusted: message.untrusted,
        label,
        sentAt: message.sentAt,
        replyToMessageId: message.replyToMessageId,
      });
    }
    return views;
  }

  upcomingEvents(query: {
    readonly groupId: GroupId;
    readonly from: Temporal.Instant;
    readonly to: Temporal.Instant;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): CalendarWindow {
    return {
      oneOff: this.#repos.calendar.upcomingOneOff(query),
      series: this.#repos.calendar.activeSeries({
        groupId: query.groupId,
        at: query.from,
        limit: query.limit,
        eligible: query.eligible,
      }),
    };
  }

  openTasks(query: {
    readonly groupId: GroupId;
    readonly assignee?: MemberId | undefined;
    readonly dueBefore?: Temporal.Instant | undefined;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly Task[] {
    // Two different indexes, picked by whether an assignee was named — `tasks_assignee_idx` when
    // one was, `tasks_open_due_idx` when not. Choosing here rather than in the repository keeps
    // each repository method mapped to exactly one catalogued query.
    if (query.assignee !== undefined) {
      return this.#repos.tasks.byAssignee({
        groupId: query.groupId,
        assigneeMemberId: query.assignee,
        limit: query.limit,
        eligible: query.eligible,
      });
    }
    return this.#repos.tasks.openByDue({
      groupId: query.groupId,
      ...(query.dueBefore === undefined ? {} : { dueBefore: query.dueBefore }),
      limit: query.limit,
      eligible: query.eligible,
    });
  }

  activeLists(query: {
    readonly groupId: GroupId;
    readonly itemLimit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly ListView[] {
    const lists = this.#repos.lists.active(query.groupId, query.eligible);
    return lists.map((list) => ({
      list,
      items: this.#repos.lists.itemsOf({
        groupId: query.groupId,
        listId: list.id,
        limit: query.itemLimit,
        eligible: query.eligible,
      }),
    }));
  }

  openPolls(query: {
    readonly groupId: GroupId;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly Poll[] {
    return this.#repos.polls.open(query);
  }

  activePlans(query: {
    readonly groupId: GroupId;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly Plan[] {
    return this.#repos.plans.byStatus(query);
  }

  recentDecisions(query: {
    readonly groupId: GroupId;
    readonly since?: Temporal.Instant | undefined;
    readonly limit: number;
    readonly eligible: EligibleLabelSet;
  }): readonly Decision[] {
    return this.#repos.decisions.log(query);
  }
}
