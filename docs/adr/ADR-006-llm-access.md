# ADR-006 — LLM access

- **Status:** Accepted
- **Date:** 2026-11-01
- **Deciders:** project owner (delegated to Claude Code, autonomous mode)
- **Supersedes / Amended by:** amended by §14 **A3** (budgets per preset), **A13** (prompt-caching layers: catalog hash, per-turn system message), **A19** (transcription via the `whisper-cli` subprocess)

## Context

Village's model usage is not "call an LLM and print the answer". The engine depends on provider-specific behaviour in four places:

- **Cost.** A family group sends hundreds of messages a day and every turn carries a large cached prefix. Prompt caching is the difference between roughly $67/month and an unusable bill (`01` §2.1, `05` §8). The measured-cost table is the reason budgets became per-preset (A3).
- **Correctness.** Routing, extraction, declassification and the disclosure-guard judge all need **schema-constrained output**, not best-effort JSON. A malformed declassification is a privacy bug, not a formatting bug.
- **Safety.** Opus 5.5 can refuse; the engine must see `stop_reason: "refusal"` and fall back deterministically, which is why the server-side refusal fallback beta is enabled.
- **Scale economics.** Nightly consolidation is latency-insensitive and large, so it belongs on the Batches API at half price.

At the same time the project promises provider neutrality and a local-only mode, so none of that may leak into the engine. And Anthropic's API has a set of hard rules (no `temperature`/`top_p`/`top_k`, no assistant prefill, no forced `tool_choice`, no `thinking: disabled` on Opus 5.5) that must be enforced structurally rather than remembered.

## Decision

**Own the port. Use native SDKs behind it. No framework.**

`@village/core/ports/model` defines a provider-neutral `ModelGateway` (`01` §7.5) with `run`, `structured`, `embed`, optional `countTokens` and optional `submitBatch`, plus `routeInfo` exposing a `ModelFeatureSet`. `ModelTurnRequest` carries layered system blocks with cache hints, content parts including **opaque provider blocks that must round-trip unchanged** (thinking), the tool catalog, an effort hint and a max-output cap. Adapters map to the native API and back.

| Provider | Adapter |
|---|---|
| **Anthropic** (default and reference) | official **`@anthropic-ai/sdk`** |
| OpenAI | **`openai`** (Responses API) |
| Google | **`@google/genai`** |
| Local OpenAI-compatible servers (Ollama, LM Studio, llama.cpp, vLLM) | **`openai`** with `baseURL` |

### Routes and defaults (the **Best** preset)

| Route | Default model | Settings |
|---|---|---|
| `chat` | `claude-opus-5-5` | Adaptive thinking (cannot be disabled). `output_config.effort` always set explicitly: `low` for simple Q&A, `medium` for planning or multi-tool turns, chosen by the router. Server-side refusal fallback on. Prompt caching on |
| `route` | `claude-haiku-5-5` | Structured output, effort `low` |
| `extract` | `claude-haiku-5-5` | Structured output, effort `low`, batched |
| `declassify` | `claude-haiku-5-5` | Structured output against a **closed** constraint schema, effort `low` |
| `guard` | `claude-haiku-5-5` | Structured output, effort `low`; only when deterministic checks are inconclusive |
| `consolidate` | `claude-sonnet-5-5` | **Message Batches API** (50% cost), effort `medium` |
| `embed` | local transformers.js | see ADR-007 |
| `transcribe` | local whisper, or the configured API | **A19**: the `whisper.cpp` `whisper-cli` **subprocess** plus a static decode-only FFmpeg in the image |

**Presets:** Best (above); Balanced (`chat` = `claude-sonnet-5-5`); Economy (all text routes = `claude-haiku-5-5`); Local (an Ollama model for all routes, structured output via JSON-schema mode); Custom (mix providers per route). **A3** sets per-preset budget defaults — Best $75/mo ($4/day), Balanced $40/mo ($2/day), Economy $5/mo ($0.30/day), Local $0 — and the init wizard shows the estimated monthly cost per preset before the host chooses.

### Non-negotiable API rules (enforced by the adapter contract suite, `M2-T14`)

- Never send `temperature`, `top_p` or `top_k`.
- Never use assistant prefill.
- Never use forced `tool_choice` (`any` or `tool`); use `auto` with `strict: true` tools, or structured outputs via `output_config.format` / `messages.parse()`.
- Never send `thinking: {type:"disabled"}` or `budget_tokens` to Opus 5.5; control cost with `effort`, always set explicitly.
- Always check `stop_reason` (`refusal`, `max_tokens`, `tool_use`, `pause_turn`) **before** reading content.
- Tool-use loops append `response.content` **unchanged**, thinking blocks included. Village builds a **fresh request per turn** from stored state, so history is never edited across turns.
- Return all parallel `tool_result` blocks in **one** user message; errors use `is_error: true`.
- Parse tool inputs as JSON objects; never string-match a serialized input.
- Use typed SDK errors and honour `retry-after`.
- Cache effectiveness is **verified in tests** via `usage.cache_read_input_tokens`.
- Before writing or changing any code that calls Claude, load the bundled `claude-api` skill and re-verify these facts (`CLAUDE.md` §3).

### Prompt layering, as amended by A13

Fixed order `tools → system → messages`, at most four cache breakpoints (`01` §6.3):

1. **Global layer** — behaviour charter plus the full, deterministically ordered tool catalog. **A13:** this layer is keyed by a **catalog hash** over built-ins plus the group's enabled extension tools in stable order.
2. **Group layer** — constitution charter, compiled policy summary, group profile, group story (IFC-filtered).
3. **Turn layer** — not cached: audience, requester, channel capabilities, current time, retrieved memories and constraints, the recent window with `untrusted` content fenced, then the trigger.

**A13** also moves requester capabilities, audience and time out of the charter into a **per-turn mid-conversation system message**, so the charter stays fully cacheable.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Vercel AI SDK** | A lowest-common-denominator abstraction. The features we build on — Anthropic prompt-cache breakpoints with measurable `cache_read_input_tokens`, adaptive thinking with `effort`, server-side refusal fallback, the Batches API, `count_tokens`, and round-tripping opaque thinking blocks unchanged — are exactly what a cross-provider layer flattens away. We would end up fighting it in the hot path. |
| **LangChain** | Same loss of provider-specific power, plus a large dependency surface and an opinionated agent loop. Village's loop is not generic: **every** tool call passes through the policy engine and every outbound message passes the disclosure guard. We cannot delegate the loop to a framework and still guarantee that. Explicitly ruled out in `15` §5. |

## Consequences

**Good**
- Provider-specific power is available where it pays (caching, effort, Batches, structured outputs) without leaking into the engine.
- A thin port makes `FakeModelGateway`, `ScriptedModel`, `CassetteModel` and adversarial fakes trivial, which is how the per-PR leak guarantee is produced without spending API budget (`15` §3 R-14).
- Local-only and Hybrid modes are a configuration of the same port, not a separate code path.
- The adapter contract suite can assert the §2.1 rules on **every captured request**, so an API rule cannot be forgotten in one adapter.

**Bad / accepted costs**
- Four adapters to maintain, each with its own error taxonomy, streaming shape and tool-call encoding.
- Provider API drift is a standing risk (`15` §3 R-8): betas are probed at startup with graceful fallback, and the adapter contract tests are the early warning.
- Every new provider feature we want has to be modelled in `ModelFeatureSet` first, which slows down opportunistic use of a new beta.
- Cost remains the top product risk (`15` §3 R-2) even with caching; the budget guard must degrade gracefully (economy model → pause proactivity → admin-only notice).

**Follow-ups**
- `M2-T1`–`M2-T3` — canonical port types, capability registry and presets, price tables and the cost calculator.
- `M2-T6`, `M2-T8` — the Anthropic adapter `run()`, then `structured()`, `countTokens()`, Batches and the beta probe (load the `claude-api` skill first).
- `M2-T7`, `M2-T10` — `FakeModelGateway` and the wire-level `FakeProviderServer`.
- `M2-T11`–`M2-T13` — OpenAI, OpenAI-compatible local, and Google adapters.
- `M2-T14` — the adapter contract suite that asserts every `01` §2.1 rule.
- `M2-T16` — egress manifest, Hybrid and Local-only modes.
- `M2-T19`, `M2-T20` — live smoke and budget guard v0; SP-4/SP-5 (cache plan, TTL, effort strategy) — see ADR-023.
- `M13-T14`, `M13-T25` — final cache TTL and effort strategy; published cost per preset, which feeds A3 and owner decision D-1.

## References
- `docs/plan/01-architecture.md` §2 ADR-006, §2.1, §6.3, §7.5, §14 A3, A13, A19
- `docs/plan/05-agent-runtime.md` §2, §3.4 (prompt layering and caching), §8 (performance and cost)
- `docs/plan/15-risks-and-open-questions.md` §1 D-1, D-4; §3 R-2, R-8, R-14; §4 SP-4; §5
- `CLAUDE.md` §3 (Anthropic / model API rules)
