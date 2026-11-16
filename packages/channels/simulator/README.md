# `@comvivo/channel-simulator`

A chat platform that only exists in memory, and a real `ChannelAdapter` over it. Three audiences,
one object: the simulation harness in [`11`](../../../docs/plan/11-quality-evals-observability.md)
runs a simulated month of a family group through it in seconds, the in-browser demo in
[`13`](../../../docs/plan/13-docs-launch-community.md) *is* it with no server at all, and every
conformance case in [`06` §3.25](../../../docs/plan/06-channels.md) runs against it on every profile
it offers.

[`06` §3.21.7](../../../docs/plan/06-channels.md) is the authoritative contract.

```ts
const clock = new VirtualClock('2026-11-16T09:00:00Z');
const { adapter, control } = createSimulator({
  profile: 'telegram',
  clock,
  timers: clock,
  seed: 42,
  truncationNotice: await copy.render('channels.truncated'),
});
await adapter.start(context);
await control.user('ana', 'Ana').says('family', '@Comvivo what is on today?');
expect(control.transcript('family').at(-1)?.rich).toContain('<b>');
```

## What is here

| Module | What |
|---|---|
| `wire.ts` | The platform's update stream and its zod schemas |
| `platform.ts` | Chats, members, messages, polls, reactions, the delivery ledger, the fault queue |
| `adapter.ts` | A `ChannelAdapter` over it, using the real profile and the real renderer |
| `control.ts` | What a scenario writes against: members, verbs, faults, the transcript |
| `record.ts` | A JSONL recording, and the replay that feeds its inbound half back |

## Determinism is the product

Nothing here reads the wall clock, `Math.random` or `process`; the clock, the timers and the ids are
injected, and `comvivo/simulator-purity` in `eslint.config.ts` enforces it rather than trusting it —
`06` §3.21.7 asks for that rule by name. Two runs of one scenario produce identical ledgers, which
is what lets `11` §3.6's chaos oracles gate duplicates at **zero** rather than at "usually none".

Two refusals follow from the same commitment, and both fail loudly at construction or at `start`
rather than quietly later:

- **A profile whose renderer does not exist yet.** `discord-md`, `slack-mrkdwn` and `matrix-html`
  arrive with their adapters in M8, so `createSimulator` refuses `discord`, `slack` and `matrix`.
  Falling back to `plain` would make a scenario show a test something no member would see, which is
  the one thing a simulator must never do. `SIMULATOR_PROFILES` is the live list.
- **A clock that is not the one the platform was built with.** Two clocks in a deterministic run
  drift, and the symptom is a scenario that fails once in forty runs rather than an error anybody
  can read.

## The real renderer, not a description of it

`send` goes through the SDK's own `splitAndRender`, so the payload in the ledger is the HTML string
Telegram would have received, the `bodyRanges` Signal would have, or the AST the web client would.
A scenario asserting what a member saw is reading the real thing. The same holds for the splits, the
button limits and the choice fallbacks: none of it is re-implemented here.

## Faults

Every one of [`06` §3.15](../../../docs/plan/06-channels.md)'s thirteen error kinds is reachable,
because the engine selects its recovery on the kind and a kind nothing can produce is a recovery
nothing has run. Three send-idempotency classes (`11` §3.6 S10) are derived from
`deliveryVerification` rather than declared separately, so they cannot disagree with the profile:

| Class | Profile | A repeat of the same `idempotencyKey` |
|---|---|---|
| `native` | `web`, `ideal` | answers with the first message, always |
| `dedupe-window` | `slack` | answers with the first message for five minutes |
| `none` | `telegram`, `signal` | creates a second message |

`failNext('ambiguous', { ambiguous: true })` is the hard case: the effect lands and the caller is
told it failed. On a `none` platform the retry is a duplicate nobody can prevent, and the receipt
says so — which is what `06` §3.13's "at most one `possibleDuplicate` part" is about.

## Boundaries

This package may import `@comvivo/channel-sdk`, `@comvivo/core`, `@comvivo/shared` and `zod` as a
**peer** — an adapter and the engine must agree on one zod instance for a schema to be comparable.
No `node:*`, enforced by dependency-cruiser (`01` §14 A11) as well as by the lint rule above.

It deliberately does **not** reuse the conformance kit's reference fake, which is a smaller object
of the same shape. The kit lives behind `@comvivo/channel-sdk/testing`, and
`testing-subpath-only-from-tests` keeps that out of production code; the SDK cannot depend on this
package without a cycle. Sharing would mean putting product code behind a test subpath or inverting
the dependency, and `CLAUDE.md` §2 says to fix the design rather than weaken the rule. They are also
different objects: the kit's fake exists to prove that 24 cases are tests rather than sentences,
and this one is a product surface.

## License

Apache-2.0. See [`LICENSE`](../../../LICENSE).
