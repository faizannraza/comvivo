# `@comvivo/channel-sdk`

The channel adapter contract: capability model, inbound and outbound envelopes, the rich-text AST
and its per-platform renderers, interaction tokens, and the adapter conformance test kit.

[`docs/plan/06-channels.md`](../../../docs/plan/06-channels.md) §4.1 is the authoritative contract
(`01` §14 **A26**) and this package is its implementation.

## What is here

| Module | What | Task |
|---|---|---|
| `contract.ts` | `ChannelAdapter`, `AdapterContext`, the envelopes, `ChannelCapabilities` | `M3-T2` |
| `schemas.ts` | zod for the five shapes that cross a trust boundary | `M3-T2` |
| `profiles.ts` | The seven capability profiles of `06` §3.2 | `M3-T2` |
| `errors.ts` | `ChannelError` and the retryability taxonomy | `M3-T2` |
| `richtext/parse.ts` | Model markdown → the `RichText` AST, with degradation | `M3-T3` |
| `richtext/render/` | `plain`, `telegram-html`, `web-md`, and measurement | `M3-T4` |
| `richtext/split.ts` | Splitting at the platform's limit, on grapheme boundaries | `M3-T5` |
| `interactions/token.ts` | The opaque 25-byte button token, its hash and comparison | `M3-T6` |
| `interactions/registry.ts` | Which `action.kind`s a build knows, and their param schemas | `M3-T6` |
| `interactions/buttons.ts` | `06` §3.7's button limits and label truncation | `M3-T6` |
| `interactions/fallback.ts` | The same choice as reactions or numbered text | `M3-T6` |
| `interactions/choice-parser.ts` | Reading an answer that arrived as a reaction or text | `M3-T6` |
| `reactions.ts` | The 14 canonical reaction keys, per platform | `M3-T6` |
| `ratelimit/bucket.ts` | One token bucket, refilling continuously from the injected `Clock` | `M3-T7` |
| `ratelimit/scheduler.ts` | The waiting order: priority, round-robin across chats, then FIFO | `M3-T7` |
| `ratelimit/limiter.ts` | Atomic multi-key acquire, with no starvation of interactive work | `M3-T7` |
| `retry.ts` | The backoff, the jitter and what to do after each `ChannelErrorKind` | `M3-T7` |

Still to land in M3: the typing manager (`M3-T8`) and the conformance kit behind the `./testing`
entry point (`M3-T9`). The `discord-md`,
`slack-mrkdwn` and `matrix-html` renderers arrive with their adapters in M8; `renderPart` refuses
them by name until then rather than falling back to `plain`.

## Boundaries

Dependency rules are enforced by dependency-cruiser in `pnpm verify`, not by convention.
This package may import: `@comvivo/core`, `@comvivo/shared`, and `zod` as a **peer** — an adapter
and the engine must agree on one zod instance for a schema to be comparable.

`comvivo/channel-sdk-purity` additionally bans `Date`, `process`, `fetch`, `Math.random`, the
timers and `Buffer`: every one has a replacement on the `AdapterContext` an adapter is handed.
The one deliberate exception is `@comvivo/shared/crypto`, which `interactions/token.ts` uses for
the CSPRNG — `08` §3.7.1 draws that line explicitly, because `AdapterContext.rng` is a *seedable*
PRNG for things that must be replayable and a seeded button token would be a guessable one.

Never weaken a rule to make an import work; fix the design.

## License

Apache-2.0. See [`LICENSE`](../../../LICENSE).
