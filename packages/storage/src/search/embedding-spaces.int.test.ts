/**
 * `EmbeddingSpaceManager` (`M1-T18`; `02` §3.5, `04` §3.8.6).
 *
 * The lifecycle states are not interchangeable, and each transition guards something a retrieval
 * path depends on — so the refusals matter as much as the successes. Promoting a `building` space
 * would hide every memory it has not backfilled from vector search, *silently*, because an empty
 * KNN result is indistinguishable from "nothing similar".
 */
import { StorageError } from '@comvivo/shared';
import { describe, expect, it } from 'vitest';
import { withRepos } from '../repos/testing/harness.js';
import { slugFor } from './embedding-spaces.js';

describe('slugFor', () => {
  it('folds a provider and model into a table-safe slug', () => {
    expect(slugFor('local', 'multilingual-e5-small')).toBe('local_multilingual_e5_small');
    expect(slugFor('ollama', 'bge-m3')).toBe('ollama_bge_m3');
  });

  it('collapses runs, so two spellings of the same model agree', () => {
    // The reason runs are collapsed rather than mapped one-to-one: `bge-m3` and `bge/m3` would
    // otherwise produce different slugs for the same model, and a host who changed the spelling of
    // their configuration would trigger a full re-embed of 50 000 items for nothing.
    expect(slugFor('x', 'bge-m3')).toBe(slugFor('x', 'bge/m3'));
    expect(slugFor('x', 'a---b')).toBe('x_a_b');
  });

  it('never leaves a leading or trailing underscore', () => {
    // A slug is interpolated into `CREATE VIRTUAL TABLE`, and `vec_memory_x_` is legal but ugly in
    // every log line and error message it appears in for the life of the instance.
    expect(slugFor('-x-', '-y-')).toBe('x_y');
    expect(slugFor('x', 'y...')).toBe('x_y');
  });

  it('refuses a name with nothing to encode', () => {
    expect(() => slugFor('', '...')).toThrow(StorageError);
    expect(() => slugFor('...', '---')).toThrow(/at least one letter or digit/);
  });

  it('truncates to the 40 characters 02 §3.3.4 allows', () => {
    const slug = slugFor('provider', 'a'.repeat(100));
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug).toMatch(/^[a-z0-9_]+$/);
  });
});

describe('EmbeddingSpaceManager', () => {
  it('makes the first space active immediately, with nothing to backfill', () => {
    withRepos((world) => {
      expect(world.repos.embeddingSpaces.activeSpace()).toBeUndefined();
      const space = world.store.write((uow) =>
        world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'first', dims: 8 }),
      );
      // `active`, not `building`: a fresh instance has nothing to backfill, so `building` would be
      // a state with no work in it — and a space that stayed there would answer every KNN with
      // nothing while retrieval waited for a migration that could never finish.
      expect(space.status).toBe('active');
      expect(space.activatedAt).toBeDefined();
      expect(space.tableName).toBe('vec_memory_test_first');
      expect(world.repos.embeddingSpaces.activeSpace()?.id).toBe(space.id);
    });
  });

  it('is idempotent, because configuration loading runs on every boot', () => {
    withRepos((world) => {
      const first = world.store.write((uow) =>
        world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'first', dims: 8 }),
      );
      const again = world.store.write((uow) =>
        world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'first', dims: 8 }),
      );
      expect(again.id).toBe(first.id);
      expect(world.repos.embeddingSpaces.list()).toHaveLength(1);
    });
  });

  it('starts a second model as building, keeping retrieval on the first', () => {
    withRepos((world) => {
      const first = world.store.write((uow) =>
        world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'first', dims: 8 }),
      );
      const second = world.store.write((uow) =>
        world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'second', dims: 16 }),
      );
      // `04` §3.8.6: "During `building`, retrieval uses the old space."
      expect(second.status).toBe('building');
      expect(second.activatedAt).toBeUndefined();
      expect(world.repos.embeddingSpaces.activeSpace()?.id).toBe(first.id);
    });
  });

  it('refuses a dimension change for a model it already knows (04 F17)', () => {
    withRepos((world) => {
      world.store.write((uow) =>
        world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'first', dims: 8 }),
      );
      let caught: unknown;
      try {
        world.store.write((uow) =>
          world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'first', dims: 16 }),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StorageError);
      const error = caught as StorageError;
      // The refusal belongs here rather than at the write: the symptom at the write is a vec0
      // error about a vector length, which says nothing about the configuration that caused it.
      expect(error.message).toContain('8 dimensions');
      expect(error.hint).toContain('re-embed migration');
    });
  });

  it('refuses to promote a building space', () => {
    withRepos((world) => {
      world.store.write((uow) =>
        world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'first', dims: 8 }),
      );
      const second = world.store.write((uow) =>
        world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'second', dims: 8 }),
      );
      let caught: unknown;
      try {
        world.store.write((uow) => world.repos.embeddingSpaces.activate(uow, second.id));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StorageError);
      expect((caught as StorageError).message).toContain('building, not ready');
      expect((caught as StorageError).hint).toContain('100% coverage');
    });
  });

  it('switches atomically: the incumbent retires and the new one takes over', () => {
    withRepos((world) => {
      const first = world.store.write((uow) =>
        world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'first', dims: 8 }),
      );
      const second = world.store.write((uow) =>
        world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'second', dims: 8 }),
      );
      world.store.write((uow) => world.repos.embeddingSpaces.setStatus(uow, second.id, 'ready'));
      const promoted = world.store.write((uow) =>
        world.repos.embeddingSpaces.activate(uow, second.id),
      );
      expect(promoted.status).toBe('active');
      expect(promoted.activatedAt).toBeDefined();
      // Exactly one active, which `embedding_spaces_one_active_uq` enforces per statement — so the
      // retirement has to happen before the promotion, and this is the assertion that the order is
      // right rather than lucky.
      expect(
        world.repos.embeddingSpaces.list().filter((space) => space.status === 'active'),
      ).toHaveLength(1);
      expect(world.repos.embeddingSpaces.byModel('test', 'first')?.status).toBe('retired');
      expect(world.repos.embeddingSpaces.byModel('test', 'first')?.retiredAt).toBeDefined();
      void first;
    });
  });

  it('is idempotent about promoting the space that is already active', () => {
    withRepos((world) => {
      const first = world.store.write((uow) =>
        world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'first', dims: 8 }),
      );
      const again = world.store.write((uow) => world.repos.embeddingSpaces.activate(uow, first.id));
      expect(again.status).toBe('active');
      expect(
        world.repos.embeddingSpaces.list().filter((space) => space.status === 'active'),
      ).toHaveLength(1);
    });
  });

  it('raises for a space that does not exist', () => {
    withRepos((world) => {
      expect(() =>
        world.store.write((uow) =>
          world.repos.embeddingSpaces.activate(uow, 'emb_01jnxpe00000000000000000zz' as never),
        ),
      ).toThrow(StorageError);
    });
  });

  it('records a resumable backfill cursor', () => {
    withRepos((world) => {
      const space = world.store.write((uow) =>
        world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'first', dims: 8 }),
      );
      expect(space.backfillCursorRid).toBe(0);
      world.store.write((uow) =>
        world.repos.embeddingSpaces.setBackfillCursor(uow, space.id, 4_096),
      );
      // `04` §3.8.6's "resumable cursor": a 50k-item backfill runs during quiet hours and is
      // preemptible, so where it got to has to survive being stopped.
      expect(world.repos.embeddingSpaces.byModel('test', 'first')?.backfillCursorRid).toBe(4_096);
    });
  });

  it('marks a space failed, leaving the old one active', () => {
    withRepos((world) => {
      const first = world.store.write((uow) =>
        world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'first', dims: 8 }),
      );
      const second = world.store.write((uow) =>
        world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'second', dims: 8 }),
      );
      const failed = world.store.write((uow) =>
        world.repos.embeddingSpaces.setStatus(uow, second.id, 'failed'),
      );
      expect(failed.status).toBe('failed');
      // `04` §3.8.6: "`building` → `failed`: model load/contract error → doctor; old space stays
      // active." A failed migration must not take retrieval down with it.
      expect(world.repos.embeddingSpaces.activeSpace()?.id).toBe(first.id);
    });
  });

  describe('drop', () => {
    it('drops a retired space and its table', () => {
      withRepos((world) => {
        const first = world.store.write((uow) =>
          world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'first', dims: 8 }),
        );
        const second = world.store.write((uow) =>
          world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'second', dims: 8 }),
        );
        world.store.write((uow) => {
          world.repos.embeddingSpaces.setStatus(uow, second.id, 'ready');
          world.repos.embeddingSpaces.activate(uow, second.id);
        });
        const tableExists = () =>
          world.db
            .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'vec_memory_test_first'")
            .get() as { n: number };
        expect(tableExists().n).toBe(1);

        world.store.write((uow) => world.repos.embeddingSpaces.drop(uow, first.id));
        expect(tableExists().n).toBe(0);
        expect(world.repos.embeddingSpaces.byModel('test', 'first')).toBeUndefined();
      });
    });

    it('refuses to drop an active space', () => {
      withRepos((world) => {
        const first = world.store.write((uow) =>
          world.repos.embeddingSpaces.ensure(uow, { provider: 'test', model: 'first', dims: 8 }),
        );
        let caught: unknown;
        try {
          world.store.write((uow) => world.repos.embeddingSpaces.drop(uow, first.id));
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(StorageError);
        // The seven-day delay before dropping is what makes a wrong switch reversible (`04`
        // §3.8.6), and that only holds if nothing can drop a space early.
        expect((caught as StorageError).hint).toContain('reversible');
      });
    });

    it('is a no-op for a space that is already gone', () => {
      withRepos((world) => {
        expect(() =>
          world.store.write((uow) =>
            world.repos.embeddingSpaces.drop(uow, 'emb_01jnxpe00000000000000000zz' as never),
          ),
        ).not.toThrow();
      });
    });
  });
});
