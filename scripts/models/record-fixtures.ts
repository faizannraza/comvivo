/**
 * Capture the four providers' wire bodies into `fixtures/providers/**` (`11` §3.1.9; `M2-T14`).
 *
 * ## What these fixtures are, and what they are not
 *
 * They are **the exact bytes each provider's renderer produces** for a small set of named cases,
 * captured from `FakeProviderServer`'s renderers and committed. `11` §3.1.9 says they "replay
 * captured bodies through the same `raw` turn", which is what `fixtures.contract.test.ts` does: it
 * serves a stored body back to the real adapter over a real socket and asserts the adapter reads
 * it the way it did when the body was recorded.
 *
 * So their value is a **regression lock on the wire format**. If a renderer changes shape — a field
 * renamed, a nesting level added — the adapter either stops reading it (the replay fails) or reads
 * it differently (the assertion fails). Without them a renderer and an adapter can drift together,
 * agreeing with each other while agreeing with no real provider.
 *
 * They are **not** recordings of live traffic. `05` §3.5.7's `RecordingGateway` does that, writes
 * to `fixtures/model/<provider>/`, and scrubs member data on the way. These contain no member data
 * at all, because every reply is written out in this file.
 *
 * Run with `pnpm fixtures:providers`. The output is deterministic — the ids and timestamps are
 * fixed and the JSON is canonical — so a re-run on an unchanged tree produces no diff, and a diff
 * is a real change to the wire format.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
// By relative path, like everything else under `scripts/`: no script imports a workspace package
// by name, and adding the two to the root manifest would put workspace packages in the root
// dependency graph for the first time just to run a generator.
import {
  anthropicStream,
  type FakeReply,
  googleGenerateContent,
  openaiCompletion,
  openaiResponse,
  type SseEvent,
  type WireIds,
} from '../../packages/models/src/testing/index.js';
import { canonicalJson } from '../../packages/shared/src/index.js';

/** The cases, chosen so each exercises a shape an adapter reads differently. */
const CASES: readonly { readonly name: string; readonly reply: FakeReply }[] = [
  { name: 'plain-text', reply: { text: 'Six people said yes.' } },
  {
    name: 'tool-call',
    reply: { toolCalls: [{ id: 'call_1', name: 'get_forecast', input: { q: 'Lisbon' } }] },
  },
  {
    name: 'parallel-tool-calls',
    reply: {
      toolCalls: [
        { id: 'call_1', name: 'get_forecast', input: { q: 'Lisbon' } },
        { id: 'call_2', name: 'get_forecast', input: { q: 'Porto' } },
      ],
    },
  },
  { name: 'thinking-then-text', reply: { thinking: 'weighing it up', text: 'Yes.' } },
  { name: 'max-tokens', reply: { text: 'I was about to', stopReason: 'max_tokens' } },
  { name: 'refusal', reply: { stopReason: 'refusal', refusal: { category: 'general_harms' } } },
  {
    name: 'usage-with-cache',
    reply: {
      text: 'ok',
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        cacheReadInputTokens: 900,
        cacheWrite5mInputTokens: 60,
        cacheWrite1hInputTokens: 20,
        reasoningTokens: 25,
      },
    },
  },
];

/** Fixed, so a re-run on an unchanged tree produces no diff. */
const IDS: WireIds = { messageId: 'fixture_1', created: 1_767_225_600 };

/**
 * One renderer per provider, producing **the bytes that provider's adapter actually reads**.
 *
 * Anthropic's is the **event sequence**, not a final message: its adapter calls
 * `messages.stream()`, so a stored JSON body is not something its SDK can parse. Replaying the
 * events is the faithful fixture there and the stronger one — it exercises stream reassembly,
 * which is where most of that adapter's reading code lives.
 */
const RENDERERS: readonly {
  readonly provider: string;
  readonly model: string;
  readonly render: (
    reply: FakeReply,
    ids: WireIds,
    model: string,
  ) => Record<string, unknown> | readonly SseEvent[];
}[] = [
  { provider: 'anthropic', model: 'claude-opus-5-5', render: anthropicStream },
  { provider: 'openai', model: 'gpt-6.1-sol', render: openaiResponse },
  { provider: 'google', model: 'gemini-3.8-flash', render: googleGenerateContent },
  { provider: 'openai-compatible', model: 'gemma4:12b', render: openaiCompletion },
];

async function main(): Promise<void> {
  const root = join(process.cwd(), 'fixtures', 'providers');
  let written = 0;
  for (const renderer of RENDERERS) {
    for (const entry of CASES) {
      const body = renderer.render(entry.reply, IDS, renderer.model);
      const path = join(root, renderer.provider, `${entry.name}.json`);
      await mkdir(dirname(path), { recursive: true });
      // Canonical key order, then pretty-printed. Both halves matter: canonical ordering is what
      // makes "no diff on a re-run" a real signal rather than a coincidence of insertion order,
      // and two-space indentation is what makes a fixture diff reviewable — these files exist to
      // be read when a wire format changes, and a reviewer cannot read one long line.
      const ordered: unknown = JSON.parse(canonicalJson(body as never));
      await writeFile(path, `${JSON.stringify(ordered, undefined, 2)}\n`, 'utf8');
      written += 1;
    }
  }
  process.stdout.write(
    `fixtures: wrote ${String(written)} provider bodies under fixtures/providers/\n`,
  );
}

await main();
