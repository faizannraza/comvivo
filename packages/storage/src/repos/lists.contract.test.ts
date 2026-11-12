/**
 * `ListReader`/`ListRepository`, and the fractional-index arithmetic (`M1-T19`).
 *
 * Two things carry this file. **`midpoint`** is real arithmetic whose failure is a list that
 * renders in the wrong order — so it is tested directly, as a property over random insertions,
 * rather than only through a repository. And the **default list** is what makes "add milk" work
 * without asking which list: `lists_default_kind_uq` allows one per kind, so promoting one has to
 * demote the incumbent in the same transaction.
 */
import { expectWritten } from '@comvivo/core';
import { StorageError } from '@comvivo/shared';
import { fcConfig } from '@comvivo/shared/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { after, FIRST_POSITION, midpoint } from './lists.js';
import {
  eligibleAll,
  eligibleNone,
  groupLabel,
  listId,
  listItemId,
  member,
  person,
  T0,
  withRepos,
} from './testing/harness.js';
import { analyze, expectIndexUsed } from './testing/query-plan.js';

/** An eligible set over every label in the database. */

describe('midpoint (fractional indices)', () => {
  it('returns something strictly between its neighbours', () => {
    // `FIRST_POSITION` is *derived* from this call, so the assertion is that it is mid-range —
    // inserts have to fit on either side of the first item.
    expect(midpoint(undefined, undefined)).toBe(FIRST_POSITION);
    expect(FIRST_POSITION > '5').toBe(true);
    expect(FIRST_POSITION < 'm').toBe(true);
    const between = midpoint('A', 'C');
    expect(between > 'A').toBe(true);
    expect(between < 'C').toBe(true);
  });

  it('subdivides when the neighbours are adjacent', () => {
    // `A` and `B` have no digit between them, so the result has to extend rather than pick a
    // midpoint — which is what keeps the strings short in the common case and growing only where
    // a gap has been used repeatedly.
    const between = midpoint('A', 'B');
    expect(between > 'A').toBe(true);
    expect(between < 'B').toBe(true);
    expect(between.length).toBeGreaterThan(1);
  });

  it('appends by incrementing, so a long list does not grow long positions', () => {
    // The reason `after` exists rather than `midpoint(last, undefined)`: midpoint against an open
    // upper end converges on the largest digit, so each append halves the remaining gap. Measured:
    // 400 appends that way produced a 66-character position and tripped the subdivision bound — on
    // a plain shopping list.
    let position = FIRST_POSITION;
    const seen = [position];
    for (let index = 0; index < 400; index += 1) {
      const next = after(position);
      expect(next > position, `${position} -> ${next}`).toBe(true);
      position = next;
      seen.push(position);
    }
    expect([...seen]).toEqual([...seen].toSorted());
    // Short, which is the whole point. Incrementing grows one character per 31 appends per level.
    expect(position.length).toBeLessThan(16);
  });

  it('handles both open ends', () => {
    expect(midpoint(undefined, 'B') < 'B').toBe(true);
    expect(midpoint('B', undefined) > 'B').toBe(true);
  });

  it('keeps a list ordered through arbitrary insertions', () => {
    // The property that matters: whatever order the inserts arrive in, the positions sort the way
    // the list looks. A failure here is a list that renders in the wrong order — which is visible
    // to every member and attributable to nothing.
    let inserted = 0;
    fc.assert(
      fc.property(fc.array(fc.nat({ max: 40 }), { minLength: 1, maxLength: 40 }), (insertAt) => {
        const positions: string[] = [];
        for (const rawIndex of insertAt) {
          const index = Math.min(rawIndex, positions.length);
          const left = index === 0 ? undefined : positions[index - 1];
          const right = index === positions.length ? undefined : positions[index];
          const position = midpoint(left, right);
          positions.splice(index, 0, position);
        }
        inserted += positions.length;
        // Sorted by construction, and sorted by a plain string comparison — which is what the
        // database does with `ORDER BY position`, knowing nothing about the scheme.
        expect([...positions]).toEqual([...positions].toSorted());
        // And every position is distinct, or two items would render in an arbitrary order.
        expect(new Set(positions).size).toBe(positions.length);
      }),
      fcConfig(),
    );
    expect(inserted).toBeGreaterThan(100);
  });
});

describe('ListRepository', () => {
  const list = (tag: string, groupId: Parameters<typeof member>[1], overrides = {}) => ({
    id: listId(tag),
    groupId,
    name: `list ${tag}`,
    ...overrides,
  });

  const item = (
    tag: string,
    groupId: Parameters<typeof member>[1],
    onList: ReturnType<typeof listId>,
    overrides = {},
  ) => ({
    id: listItemId(tag),
    listId: onList,
    groupId,
    text: `item ${tag}`,
    normalizedKey: `key-${tag}`,
    ...overrides,
  });

  it('creates a list with the schema defaults', () => {
    withRepos((world) => {
      const created = world.store.write((uow) =>
        expectWritten(
          world.repos.lists.create(uow, list('a1f', world.groupId), groupLabel(world.groupId)),
          'a list',
        ),
      );
      expect(created.kind).toBe('generic');
      expect(created.isDefault).toBe(false);
      expect(created.categoriesEnabled).toBe(true);
      expect(created.archivedAt).toBeUndefined();
    });
  });

  it('reports a name collision as a duplicate, case-insensitively', () => {
    withRepos((world) => {
      const first = world.store.write((uow) =>
        expectWritten(
          world.repos.lists.create(
            uow,
            list('b1f', world.groupId, { name: 'Groceries' }),
            groupLabel(world.groupId),
          ),
          'the first',
        ),
      );
      const again = world.store.write((uow) =>
        world.repos.lists.create(
          uow,
          list('b2f', world.groupId, { name: 'groceries' }),
          groupLabel(world.groupId),
        ),
      );
      // `lists_group_name_uq` is on `(group, lower(name))`, so "Groceries" and "groceries" are one
      // list — which is the routine case when two members create the same list at once.
      expect(again.kind).toBe('duplicate');
      if (again.kind !== 'duplicate') return;
      expect(again.existingId).toBe(first.id);
    });
  });

  describe('the default list', () => {
    it('allows one default per kind and demotes the incumbent', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        const first = world.store.write((uow) =>
          expectWritten(
            world.repos.lists.create(
              uow,
              list('c1f', world.groupId, { kind: 'grocery', isDefault: true }),
              label,
            ),
            'the first default',
          ),
        );
        expect(world.repos.lists.defaultFor(world.groupId, 'grocery', eligibleAll(world))?.id).toBe(
          first.id,
        );

        const second = world.store.write((uow) =>
          expectWritten(
            world.repos.lists.create(
              uow,
              list('c2f', world.groupId, { kind: 'grocery', isDefault: true }),
              label,
            ),
            'the second default',
          ),
        );
        // Exactly one, which `lists_default_kind_uq` enforces per statement — so the demotion has
        // to happen before the insert, and this asserts the order is right rather than lucky.
        expect(world.repos.lists.defaultFor(world.groupId, 'grocery', eligibleAll(world))?.id).toBe(
          second.id,
        );
        expect(
          world.repos.lists
            .active(world.groupId, eligibleAll(world))
            .filter((row) => row.isDefault),
        ).toHaveLength(1);
      });
    });

    it('keeps the defaults of different kinds apart', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        world.store.write((uow) => {
          world.repos.lists.create(
            uow,
            list('d1f', world.groupId, { kind: 'grocery', isDefault: true }),
            label,
          );
          world.repos.lists.create(
            uow,
            list('d2f', world.groupId, { kind: 'packing', isDefault: true }),
            label,
          );
        });
        // One per `(group, kind)`, not one per group: "add milk" and "add sunscreen" land on
        // different lists.
        expect(world.repos.lists.defaultFor(world.groupId, 'grocery', eligibleAll(world))?.id).toBe(
          listId('d1f'),
        );
        expect(world.repos.lists.defaultFor(world.groupId, 'packing', eligibleAll(world))?.id).toBe(
          listId('d2f'),
        );
      });
    });

    it('stops being the default when archived, and refuses to be promoted', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        const created = world.store.write((uow) =>
          expectWritten(
            world.repos.lists.create(
              uow,
              list('e1f', world.groupId, { kind: 'grocery', isDefault: true }),
              label,
            ),
            'a default list',
          ),
        );
        const archived = world.store.write((uow) =>
          expectWritten(
            world.repos.lists.archive(uow, world.groupId, created.id, created.version, T0),
            'an archive',
          ),
        );
        // A default nobody sees would make "add milk" resolve to a list that is not rendered.
        expect(archived.isDefault).toBe(false);
        expect(
          world.repos.lists.defaultFor(world.groupId, 'grocery', eligibleAll(world)),
        ).toBeUndefined();

        let caught: unknown;
        try {
          world.store.write((uow) =>
            world.repos.lists.setDefault(uow, world.groupId, archived.id, archived.version),
          );
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(StorageError);
        expect((caught as StorageError).message).toContain('archived');
      });
    });
  });

  describe('items', () => {
    it('appends in order and renders unchecked first', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        const who = world.store.write((uow) => {
          expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
          return expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'member')
            .id;
        });
        const onList = world.store.write((uow) =>
          expectWritten(world.repos.lists.create(uow, list('f1f', world.groupId), label), 'a list'),
        ).id;
        const added = world.store.write((uow) =>
          ['f1f', 'f2f', 'f3f'].map((tag) =>
            expectWritten(
              world.repos.lists.addItem(uow, item(tag, world.groupId, onList), label),
              `item ${tag}`,
            ),
          ),
        );
        // Appended, so the positions ascend in insertion order.
        expect(added.map((row) => row.position)).toEqual(
          [...added.map((row) => row.position)].toSorted(),
        );

        const middle = added[1];
        if (middle === undefined) throw new Error('fixture');
        world.store.write((uow) =>
          world.repos.lists.setChecked(uow, world.groupId, middle.id, middle.version, {
            checked: true,
            memberId: who,
            at: T0,
          }),
        );
        // Unchecked only, by default: a grocery list in a shop shows what is left.
        expect(
          world.repos.lists
            .itemsOf({
              groupId: world.groupId,
              listId: onList,
              limit: 10,
              eligible: eligibleAll(world),
            })
            .map((row) => row.id),
        ).toEqual([listItemId('f1f'), listItemId('f3f')]);
        // And with the checked ones, they come **after** — the index's own order.
        expect(
          world.repos.lists
            .itemsOf({
              groupId: world.groupId,
              listId: onList,
              includeChecked: true,
              limit: 10,
              eligible: eligibleAll(world),
            })
            .map((row) => row.id),
        ).toEqual([listItemId('f1f'), listItemId('f3f'), listItemId('f2f')]);
      });
    });

    it('clears the checker when an item is unchecked', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        const who = world.store.write((uow) => {
          expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
          return expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'member')
            .id;
        });
        const onList = world.store.write((uow) =>
          expectWritten(world.repos.lists.create(uow, list('g1f', world.groupId), label), 'a list'),
        ).id;
        const added = world.store.write((uow) =>
          expectWritten(
            world.repos.lists.addItem(uow, item('g1f', world.groupId, onList), label),
            'an item',
          ),
        );
        const checked = world.store.write((uow) =>
          expectWritten(
            world.repos.lists.setChecked(uow, world.groupId, added.id, added.version, {
              checked: true,
              memberId: who,
              at: T0,
            }),
            'a check',
          ),
        );
        expect(checked.checkedByMemberId).toBe(who);
        expect(checked.checkedAt).toBeDefined();

        const unchecked = world.store.write((uow) =>
          expectWritten(
            world.repos.lists.setChecked(uow, world.groupId, checked.id, checked.version, {
              checked: false,
              memberId: who,
              at: T0,
            }),
            'an uncheck',
          ),
        );
        // Both cleared: a stale `checkedBy` on an unchecked item would attribute a check that was
        // undone, and `07` renders "checked by Ana" from it.
        expect(unchecked.checkedByMemberId).toBeUndefined();
        expect(unchecked.checkedAt).toBeUndefined();
      });
    });

    it('finds an unchecked duplicate by key but not a checked one', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        const who = world.store.write((uow) => {
          expectWritten(world.repos.persons.create(uow, person('a')), 'person a');
          return expectWritten(world.repos.members.add(uow, member('a', world.groupId)), 'member')
            .id;
        });
        const onList = world.store.write((uow) =>
          expectWritten(world.repos.lists.create(uow, list('h1f', world.groupId), label), 'a list'),
        ).id;
        const added = world.store.write((uow) =>
          expectWritten(
            world.repos.lists.addItem(
              uow,
              item('h1f', world.groupId, onList, { normalizedKey: 'milk' }),
              label,
            ),
            'an item',
          ),
        );
        expect(world.repos.lists.itemByKey(world.groupId, onList, 'milk')?.id).toBe(added.id);

        world.store.write((uow) =>
          world.repos.lists.setChecked(uow, world.groupId, added.id, added.version, {
            checked: true,
            memberId: who,
            at: T0,
          }),
        );
        // A checked "milk" is last week's shopping. Refusing to add milk because it was bought
        // once would be the wrong answer.
        expect(world.repos.lists.itemByKey(world.groupId, onList, 'milk')).toBeUndefined();
      });
    });

    it('moves an item between its neighbours in one update', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        const onList = world.store.write((uow) =>
          expectWritten(world.repos.lists.create(uow, list('j1f', world.groupId), label), 'a list'),
        ).id;
        const added = world.store.write((uow) =>
          ['j1f', 'j2f', 'j3f'].map((tag) =>
            expectWritten(
              world.repos.lists.addItem(uow, item(tag, world.groupId, onList), label),
              `item ${tag}`,
            ),
          ),
        );
        const [first, second, third] = added;
        if (first === undefined || second === undefined || third === undefined) {
          throw new Error('fixture');
        }
        // Move the third above the first: one row update, computed from its new neighbours.
        world.store.write((uow) =>
          world.repos.lists.moveItem(
            uow,
            world.groupId,
            third.id,
            third.version,
            midpoint(undefined, first.position),
          ),
        );
        expect(
          world.repos.lists
            .itemsOf({
              groupId: world.groupId,
              listId: onList,
              limit: 10,
              eligible: eligibleAll(world),
            })
            .map((row) => row.id),
        ).toEqual([third.id, first.id, second.id]);
      });
    });

    it('really deletes an item, because a list is a working note', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        const onList = world.store.write((uow) =>
          expectWritten(world.repos.lists.create(uow, list('k1f', world.groupId), label), 'a list'),
        ).id;
        const added = world.store.write((uow) =>
          expectWritten(
            world.repos.lists.addItem(uow, item('k1f', world.groupId, onList), label),
            'an item',
          ),
        );
        expect(
          world.store.write((uow) => world.repos.lists.removeItem(uow, world.groupId, added.id))
            .kind,
        ).toBe('ok');
        // A real delete, unlike a message or a memory: a list item is a working note rather than a
        // record of what was said, so `02` §3.13's "keep the row" reasoning does not apply — and a
        // shopping list that accumulated tombstones would grow without bound.
        expect(
          world.db.prepare('SELECT count(*) AS n FROM list_items').get() as { n: number },
        ).toEqual({ n: 0 });
        expect(
          world.store.write((uow) => world.repos.lists.removeItem(uow, world.groupId, added.id))
            .kind,
        ).toBe('not_found');
      });
    });

    it('refuses to add to another group`s list', () => {
      withRepos((world) => {
        const elsewhere = world.store.write((uow) =>
          expectWritten(
            world.repos.lists.create(
              uow,
              list('m1f', world.otherGroupId, { groupId: world.otherGroupId }),
              groupLabel(world.otherGroupId),
            ),
            'a list elsewhere',
          ),
        ).id;
        // `list_items` has a `group_id`, but a caller naming its own group and another group's
        // list would still satisfy both foreign keys — the agreement between them is what has to
        // be checked.
        expect(
          world.store.write((uow) =>
            world.repos.lists.addItem(
              uow,
              item('m1f', world.groupId, elsewhere),
              groupLabel(world.groupId),
            ),
          ).kind,
        ).toBe('not_found');
      });
    });
  });

  it('returns nothing from every labeled read for an empty eligible set', () => {
    withRepos((world) => {
      const label = groupLabel(world.groupId);
      const onList = world.store.write((uow) =>
        expectWritten(
          world.repos.lists.create(uow, list('n1f', world.groupId, { isDefault: true }), label),
          'a list',
        ),
      ).id;
      world.store.write((uow) =>
        world.repos.lists.addItem(uow, item('n1f', world.groupId, onList), label),
      );
      const none = eligibleNone(world);
      expect(world.repos.lists.byId(world.groupId, onList, none)).toBeUndefined();
      expect(world.repos.lists.defaultFor(world.groupId, 'generic', none)).toBeUndefined();
      expect(world.repos.lists.active(world.groupId, none)).toEqual([]);
      expect(
        world.repos.lists.itemsOf({
          groupId: world.groupId,
          listId: onList,
          limit: 10,
          eligible: none,
        }),
      ).toEqual([]);
      // The rows are there, so none of the above is vacuous.
      expect(world.repos.lists.byId(world.groupId, onList, eligibleAll(world))).toBeDefined();
    });
  });

  describe('query plans (M1-T19 AC)', { tags: ['db'] }, () => {
    it('reaches Q-COO-3 and the key lookup through their indexes', () => {
      withRepos((world) => {
        const label = groupLabel(world.groupId);
        const onList = world.store.write((uow) =>
          expectWritten(world.repos.lists.create(uow, list('p1f', world.groupId), label), 'a list'),
        ).id;
        world.store.write((uow) => {
          for (let index = 0; index < 400; index += 1) {
            world.repos.lists.addItem(
              uow,
              item(`q${index.toString(16)}f`, world.groupId, onList, {
                normalizedKey: `key-${index.toString(16)}`,
                // A mix, so the planner has real statistics for the `checked` column.
                ...(index % 3 === 0 ? { position: undefined } : {}),
              }),
              label,
            );
          }
        });
        analyze(world.db);

        expectIndexUsed(
          world.db,
          `SELECT * FROM list_items
            WHERE group_id = ? AND list_id = ? AND checked = 0 AND label_id IN (?)
            ORDER BY checked ASC, position ASC LIMIT 50`,
          {
            table: 'list_items',
            index: 'list_items_list_idx',
            parameters: [world.groupId, onList, 1],
          },
        );
        expectIndexUsed(
          world.db,
          `SELECT * FROM list_items
            WHERE group_id = ? AND list_id = ? AND normalized_key = ? AND checked = 0
            ORDER BY position ASC`,
          {
            table: 'list_items',
            index: 'list_items_key_idx',
            parameters: [world.groupId, onList, 'key-1'],
          },
        );
      });
    });
  });
});
