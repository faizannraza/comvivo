/**
 * `countTokens()` (`05` §3.5.3.8; `M2-T8`).
 *
 * ## Why this is barely used
 *
 * One network call to count tokens is one network call on the turn's critical path, and the context
 * builder runs on every turn. So the hot path uses a **local estimator** (characters per token,
 * calibrated per model) and this endpoint only calibrates that estimator. `05` §3.5.3.8 names the
 * two callers: `comvivo doctor --models`, which calibrates on a **synthetic** corpus, and the
 * nightly CI prompt-budget tests.
 *
 * **Group data is never sent to `count_tokens` by default.** That is the sentence that matters: a
 * token count is not worth sending a family's messages to a provider for, and the estimator is
 * accurate enough for a budget check. `doctor` calibrates on text we wrote.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { ModelTurnRequest } from '@comvivo/core';
import type { RouteBinding } from '../registry/resolve.js';
import { buildChatRequest } from './request.js';

type Beta = Anthropic.AnthropicBeta;

/** The characters-per-token ratio a corpus implies, for the local estimator. */
export interface EstimatorCalibration {
  readonly model: string;
  readonly chars: number;
  readonly tokens: number;
  /** `chars / tokens`. The number the estimator multiplies by. */
  readonly charsPerToken: number;
}

export interface CountTokensDeps {
  readonly client: Anthropic;
  readonly bindingFor: (route: ModelTurnRequest['route']) => RouteBinding;
  readonly availableBetas: readonly Beta[];
}

/**
 * Count the tokens of a request as the provider would.
 *
 * Built through the **same** `buildChatRequest` the real call uses, so the count is of the request
 * that would actually be sent — a count of a differently-assembled prompt is a number that looks
 * authoritative and is not.
 *
 * `count_tokens` rejects the fields that have no meaning for a count, so `max_tokens`,
 * `output_config` and `fallbacks` are dropped here rather than at the call site.
 */
export async function countTokens(
  deps: CountTokensDeps,
  req: ModelTurnRequest,
  signal: AbortSignal,
): Promise<number> {
  const binding = deps.bindingFor(req.route);
  const built = buildChatRequest(req, { binding, availableBetas: deps.availableBetas });
  const {
    max_tokens: _maxTokens,
    output_config: _outputConfig,
    fallbacks: _fallbacks,
    thinking: _thinking,
    ...countable
  } = built.params;

  const counted = await deps.client.beta.messages.countTokens(
    {
      model: countable.model,
      messages: countable.messages,
      ...(countable.system === undefined ? {} : { system: countable.system }),
      ...(countable.tools === undefined ? {} : { tools: countable.tools }),
      ...(countable.tool_choice === undefined ? {} : { tool_choice: countable.tool_choice }),
      ...(countable.betas === undefined ? {} : { betas: countable.betas }),
    },
    { signal },
  );
  return counted.input_tokens;
}

/**
 * Calibrate the local estimator on a synthetic corpus.
 *
 * The corpus is the caller's, and `doctor` passes text this project wrote. One call per model, so a
 * calibration run costs a fraction of a cent — which is the point of calibrating rather than
 * counting on every turn.
 */
export async function calibrateEstimator(
  deps: CountTokensDeps,
  corpus: readonly string[],
  req: ModelTurnRequest,
  signal: AbortSignal,
): Promise<EstimatorCalibration> {
  const text = corpus.join('\n');
  const binding = deps.bindingFor(req.route);
  const tokens = await countTokens(
    deps,
    { ...req, messages: [{ role: 'user', content: [{ type: 'text', text }] }], system: [] },
    signal,
  );
  const chars = text.length;
  return {
    model: binding.model,
    chars,
    tokens,
    // Guarded: a provider that reported zero tokens for a non-empty corpus would otherwise produce
    // an infinite ratio and an estimator that reports every prompt as free.
    charsPerToken: tokens > 0 ? chars / tokens : 0,
  };
}
