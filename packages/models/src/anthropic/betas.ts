/**
 * Beta probing with bisect (`05` §3.5.3.9; `M2-T8`).
 *
 * Every beta this adapter uses is **optional**. A key whose organisation is not enrolled in one
 * gets a 400 whose message names the header — and `05` §3.5.3.9 is explicit that the adapter must
 * not string-match that message. So at boot (and again in `comvivo doctor`) a minimal real request
 * goes out with every intended beta; if it is refused, the probe retries with none, and then
 * **bisects** to find which header the organisation does not have.
 *
 * Every host-facing string here is built from `BRAND` rather than written out, so a product rename
 * stays one command (`13` §3.A.6) — the brand guard refuses the literal.
 *
 * ## Why a real request and not a `max_tokens: 0` pre-warm
 *
 * A pre-warm has its own documented rejected combinations, so a 400 from one is ambiguous: it could
 * mean the beta is unavailable or that the pre-warm itself was invalid. `05` §3.5.3.9 chose a real
 * request for exactly that reason — `max_tokens: 64`, effort `low`, "Reply OK". It costs a fraction
 * of a cent per model and the answer is unambiguous.
 *
 * ## A group test, not a search for "the" rejected header
 *
 * `05` §3.5.3.9 says the probe "bisects to find the rejected header", singular. Measured at
 * `M2-T8`, that framing does not survive: an organisation can lack **several** betas, each one
 * degrading a different feature, and `doctor` has to list them all. So this is a group test that
 * finds *every* unavailable beta — at most `2n` requests, and typically far fewer because an
 * accepted half is discarded whole.
 *
 * It also distinguishes a case a linear scan cannot: two headers that are each fine alone and
 * refused together. That is a **conflict**, not an unavailability, and the adapter cannot tell
 * which one to drop — so it reports both rather than guessing and disabling a beta the host is
 * paying for.
 *
 * At five betas this is about as many requests as probing one at a time. The reason to prefer it is
 * not speed: it is that the result is complete and that the conflict case is named.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { BadRequestError } from '@anthropic-ai/sdk';
import { BRAND } from '@comvivo/shared';

type Beta = Anthropic.AnthropicBeta;

/** `05` §3.5.3.9's probe request: small, cheap and unambiguous. */
export const PROBE_REQUEST = {
  maxTokens: 64,
  effort: 'low',
  prompt: 'Reply OK',
} as const;

export interface ProbeResult {
  readonly model: string;
  /** The betas this key may use, in the order they were requested. */
  readonly available: readonly Beta[];
  /** The betas the organisation is not enrolled in. */
  readonly unavailable: readonly Beta[];
  /** How many requests the probe made. Reported so a slow boot has an explanation. */
  readonly requests: number;
}

export interface ProbeDeps {
  readonly client: Anthropic;
  /** A warning per unavailable beta (`05` §3.5.3.9: disabled for the process, logged at `warn`). */
  readonly onUnavailable?: (beta: Beta, model: string) => void;
}

/**
 * Probe one model.
 *
 * Returns the usable subset rather than throwing: an unavailable beta **degrades** the adapter
 * (no `fallbacks`, no `clear_at`, no `block_binding`) and must never stop it from starting. A host
 * on a key without the fallback beta still gets a working product; `doctor` tells them what they
 * are missing.
 *
 * A failure that is *not* a 400 — an auth error, a network failure, an overload — is rethrown. The
 * probe is not a connectivity check, and swallowing a 401 here would turn "your key is wrong" into
 * "no betas available" at boot.
 */
export async function probeBetas(
  deps: ProbeDeps,
  model: string,
  wanted: readonly Beta[],
  signal: AbortSignal,
): Promise<ProbeResult> {
  if (wanted.length === 0) {
    return { model, available: [], unavailable: [], requests: 0 };
  }

  const counter = { requests: 0 };
  if (await accepts(deps, model, wanted, signal, counter)) {
    return { model, available: [...wanted], unavailable: [], requests: counter.requests };
  }

  // The whole set was refused. Confirm the baseline works before blaming the headers: if a request
  // with **no** betas is also refused, the problem is the request or the model, not enrolment, and
  // reporting five unavailable betas would send the host looking in the wrong place.
  if (!(await accepts(deps, model, [], signal, counter))) {
    throw new Error(
      `the beta probe for "${model}" was refused even with no beta headers. The model id or the ` +
        `request itself is the problem, not beta enrolment — run \`${BRAND.cliName} doctor --models\`.`,
    );
  }

  const unavailable = await bisect(deps, model, wanted, signal, counter);
  const bad = new Set(unavailable);
  for (const beta of unavailable) deps.onUnavailable?.(beta, model);
  return {
    model,
    available: wanted.filter((beta) => !bad.has(beta)),
    unavailable,
    requests: counter.requests,
  };
}

/**
 * The bisect.
 *
 * A set that is accepted contains no bad beta, so it is discarded whole — that is where the saving
 * comes from. A singleton that is refused is a bad beta. Anything else splits in half.
 */
async function bisect(
  deps: ProbeDeps,
  model: string,
  candidates: readonly Beta[],
  signal: AbortSignal,
  counter: { requests: number },
): Promise<readonly Beta[]> {
  if (candidates.length === 0) return [];
  // A singleton reached from a refused set **is** the culprit: the caller only recurses into a half
  // it has already seen refused, and the conflict case is handled below rather than here. Probing
  // it again would be two more requests per missing beta for an answer already known.
  if (candidates.length === 1) return [...candidates];
  const middle = Math.floor(candidates.length / 2);
  const left = candidates.slice(0, middle);
  const right = candidates.slice(middle);

  const leftOk = await accepts(deps, model, left, signal, counter);
  const rightOk = await accepts(deps, model, right, signal, counter);
  if (leftOk && rightOk) {
    // Each half is fine alone but the whole set was refused: the headers conflict rather than being
    // unavailable. Both halves are reported, because the adapter cannot tell which to drop and a
    // wrong guess would disable a beta the host is paying for.
    return [...candidates];
  }
  const fromLeft = leftOk ? [] : await bisect(deps, model, left, signal, counter);
  const fromRight = rightOk ? [] : await bisect(deps, model, right, signal, counter);
  return [...fromLeft, ...fromRight];
}

/** One probe request. `true` if the API accepted the header set. */
async function accepts(
  deps: ProbeDeps,
  model: string,
  betas: readonly Beta[],
  signal: AbortSignal,
  counter: { requests: number },
): Promise<boolean> {
  counter.requests += 1;
  try {
    await deps.client.beta.messages.create(
      {
        model,
        max_tokens: PROBE_REQUEST.maxTokens,
        messages: [{ role: 'user', content: [{ type: 'text', text: PROBE_REQUEST.prompt }] }],
        output_config: { effort: PROBE_REQUEST.effort },
        ...(betas.length === 0 ? {} : { betas: [...betas] }),
      },
      { signal },
    );
    return true;
  } catch (error) {
    // Only a 400 means "not enrolled". Everything else is a real failure and belongs to the caller.
    if (error instanceof BadRequestError) return false;
    throw error;
  }
}
