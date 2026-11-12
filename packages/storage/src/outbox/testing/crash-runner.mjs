/**
 * A child process that runs the outbox dispatcher and optionally kills itself part-way
 * (`02` §9.3's `outbox.crash.test`).
 *
 * Committed here rather than generated into a temp directory, for the reason
 * `migrate/testing/crash-runner.mjs` records: a script written to `os.tmpdir()` cannot resolve
 * `better-sqlite3-multiple-ciphers` at all, because node searches upward for `node_modules` and a
 * temp directory has none. That failed as `ERR_MODULE_NOT_FOUND`, which looks like a crash rather
 * than the kill the test is arranging.
 *
 * Usage: `crash-runner.mjs <dbPath> <journalPath> <killAt> <sends>`.
 *
 * `killAt` is one of `02` §9.3's injection points — `enqueue`, `claim`, `send`, `receipt`,
 * `recover` — or `none` to run to completion. The kill is a `SIGKILL` to its own pid: no
 * unwinding, no `close()`, nothing flushed that was not already committed, which is the shape of
 * an OOM kill or a power loss.
 *
 * The **journal** is the fake platform. Every delivery appends a line and is `fsync`ed before the
 * process can be killed, so the file is the platform's own record of what it received — which is
 * the only way a test can tell a lost send from a duplicated one.
 */
import { appendFileSync, closeSync, fsyncSync, openSync } from 'node:fs';
import process from 'node:process';
import { SystemClock, TypeIdGenerator } from '@comvivo/shared';
import { SeededRng } from '@comvivo/shared/testing';
import Database from 'better-sqlite3-multiple-ciphers';
import { Temporal } from 'temporal-polyfill';
import { makeDb } from '../../db/drizzle.js';
import { SqliteStore } from '../../db/tx.js';
import { migrate } from '../../migrate/runner.js';
import { fileMigrationSource } from '../../migrate/source.js';
import { makeRepositories } from '../../repos/index.js';
import { DEFAULT_LEASE_MS } from '../repository.js';

const [dbPath, journalPath, killAt, sendsArg, migrationsDir] = process.argv.slice(2);
if (dbPath === undefined || journalPath === undefined || migrationsDir === undefined) {
  process.stderr.write(
    'usage: crash-runner.mjs <dbPath> <journalPath> <killAt> <sends> <migrationsDir>\n',
  );
  process.exit(2);
}
const sends = Number(sendsArg ?? '4');
const point = killAt ?? 'none';

/**
 * 26 Crockford base32 characters each, starting with a digit 0–7.
 *
 * A TypeID suffix holds 130 bits where a UUID has 128, so `unwrapId` requires the leading
 * character to be `0`–`7` — the harness's `suffix()` starts every fixture id with `01j` for the
 * same reason, and a suffix that merely had the right *length* was refused here first.
 */
const SUFFIX = `01jcrash`.padEnd(26, '0');
const GROUP = `grp_${SUFFIX}`;
const PERSON = `prs_${SUFFIX}`;
const MEMBER = `mbr_${SUFFIX}`;
const CONVERSATION = `cnv_${SUFFIX}`;
const T0 = Temporal.Instant.from('2026-11-08T12:00:00Z');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
migrate(db, fileMigrationSource(migrationsDir), { appVersion: 'outbox-crash-test' });

const silent = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  content: () => {},
  child: () => silent,
};
const drizzle = makeDb(db);
const ids = new TypeIdGenerator(new SystemClock());
const rng = new SeededRng(11);
const repos = makeRepositories({ db: drizzle, connection: db, ids, rng });
const store = new SqliteStore({
  db,
  clock: new SystemClock(),
  logger: silent,
  ids,
  rng,
  repositories: repos,
});

/** The fake platform's record. `fsync` before returning, so a kill cannot lose the line. */
function deliver(key) {
  appendFileSync(journalPath, `${key}\n`);
  const handle = openSync(journalPath, 'r+');
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  // A platform with native idempotency (`06` §3.13: Discord, Matrix, Slack): the same key always
  // gets the same message id, so a re-send is recognisable rather than a second message.
  return `plat-${key}`;
}

function die() {
  process.kill(process.pid, 'SIGKILL');
}

const label = {
  groupId: GROUP,
  readers: { kind: 'group', groupId: GROUP },
  owner: 'group',
  coOwners: [],
  sensitivity: 'normal',
  influence: 'none',
  untrusted: false,
};

/** Seed once; a resumed run finds it already there. */
function seed() {
  store.write((uow) => {
    if (repos.groups.byId(GROUP) !== undefined) return;
    repos.groups.create(uow, { id: GROUP, name: 'Crash', archetype: 'family', timezone: 'UTC' });
    repos.persons.create(uow, { id: PERSON, displayName: 'A' });
    repos.members.add(uow, {
      id: MEMBER,
      groupId: GROUP,
      personId: PERSON,
      role: 'admin',
      status: 'active',
      joinedAt: T0,
    });
    repos.conversations.create(uow, {
      id: CONVERSATION,
      groupId: GROUP,
      channel: 'simulator',
      platformChatId: 'chat-crash',
      kind: 'group',
      boundAt: T0,
    });
  });
}

/** Enqueue the run's sends, idempotently: a resumed run re-enqueues and gets `duplicate`. */
function enqueueAll() {
  store.write((uow) => {
    for (let index = 0; index < sends; index += 1) {
      repos.outbox.enqueue(uow, {
        id: `obx_${`01jcrash${index.toString(32)}`.padEnd(26, '0')}`,
        groupId: GROUP,
        conversationId: CONVERSATION,
        idempotencyKey: `trn:crash:${String(index)}`,
        messageClass: 'reply',
        payload: { text: `part ${String(index)}` },
        contentHash: Buffer.alloc(32, index + 1),
        audienceReaderSetId: 1,
        guardRef: 'grd-crash',
        manifestLabelIds: [],
        nextAttemptAt: T0,
      });
    }
  });
}

seed();
// `audienceReaderSetId: 1` needs a reader set to exist, which interning the label creates.
store.write((uow) => repos.labels.intern(uow, label));

enqueueAll();
if (point === 'enqueue') die();

let guard = 0;
for (;;) {
  guard += 1;
  if (guard > 200) break;
  const now = Temporal.Instant.fromEpochMilliseconds(Date.now());
  const claimed = store.write((uow) => {
    // **Boot** recovery on the first pass: no `before`, so every `sending` row left by the
    // incarnation that died comes back immediately. A time comparison cannot express "that lease
    // belongs to a process that no longer exists", because `outbox_messages` has no `lease_owner`
    // — and a boot that waited for the leases to expire would sit on a queue of replies for 30
    // seconds after every restart. Later passes sweep by lease, as a running process does.
    repos.outbox.recoverSending(uow, guard === 1 ? { now } : { now, before: now });
    if (point === 'recover' && guard === 2) die();
    return repos.outbox.claim(uow, { now, leaseMs: DEFAULT_LEASE_MS, limit: 2 });
  });
  if (claimed.length === 0) break;
  if (point === 'claim') die();

  for (const row of claimed) {
    // The platform takes it. A kill here is the worst case: delivered, and no record of it.
    const platformMessageId = deliver(row.idempotencyKey);
    if (point === 'send') die();
    store.write((uow) =>
      repos.outbox.markSent(
        uow,
        row.id,
        row.attempts,
        { platformMessageId, at: now },
        {
          message: {
            id: `msg_${`01jcrash${row.seq.toString(32)}`.padEnd(26, '0')}`,
            groupId: GROUP,
            conversationId: CONVERSATION,
            kind: 'assistant',
            text: `part ${String(row.seq)}`,
            sentAt: now,
            receivedAt: now,
          },
          label,
        },
      ),
    );
    if (point === 'receipt') die();
  }
}

db.close();
