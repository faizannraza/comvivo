/**
 * The Batches API (`05` §3.5.3.7; `M2-T8`).
 *
 * `consolidate` runs nightly through Batches at half the price. Three rules shape this module, and
 * each one is a mistake somebody has already made somewhere:
 *
 * 1. **Results arrive in any order, keyed by `custom_id`.** Reading them positionally works in
 *    every test with one request and fails the first night with two.
 * 2. **`fallbacks` is rejected on Batches.** The refusal fallback is a synchronous feature; sending
 *    it here is a 400 for the whole batch, not for one item.
 * 3. **A batch is not a transaction.** Each item succeeds, errors, is canceled or expires on its
 *    own, and `05` §3.5.3.7 gives each outcome a different disposition: an `invalid_request` error
 *    is dropped and traced (it will never succeed), anything else is resubmitted once in the next
 *    window.
 *
 * ## Privacy
 *
 * `models.anthropic.useBatches: false` turns this off, because results are **retained by the
 * provider** for 29 days. A host who does not want a night's consolidation sitting on somebody
 * else's disk can say so, and `05` §3.5.3.7 makes that a first-class setting rather than a
 * workaround.
 */
import type Anthropic from '@anthropic-ai/sdk';
import type {
  BatchHandle,
  BatchItemFailure,
  BatchResultItem,
  BatchStatus,
  StructuredRequest,
} from '@comvivo/core';
import type { RouteBinding } from '../registry/resolve.js';
import { usageIterations } from './response.js';
import { buildStructuredRequest, readStructured, structuredResultOf } from './structured.js';

type Beta = Anthropic.AnthropicBeta;
type IndividualResponse = Anthropic.Beta.Messages.BetaMessageBatchIndividualResponse;

/** `05` §3.5.3.7: `<jobId>:<n>`, at most 64 characters of `[A-Za-z0-9_-]`. */
export const CUSTOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** A batch ends within 24 hours; results stay available for 29 days. */
export const BATCH_MAX_HOURS = 24;
export const BATCH_RESULTS_RETENTION_DAYS = 29;

/** After this long without ending, `05` §3.5.3.7 cancels and runs the work synchronously. */
export const BATCH_TIMEOUT_HOURS = 20;

export function customIdFor(jobId: string, index: number): string {
  const id = `${jobId}:${String(index)}`.replaceAll(':', '_');
  if (!CUSTOM_ID_PATTERN.test(id)) {
    throw new Error(
      `"${id}" is not a usable batch custom_id: ${String(CUSTOM_ID_PATTERN)}. The job id is too ` +
        'long or carries a character the Batches API refuses.',
    );
  }
  return id;
}

export interface BatchDeps {
  readonly client: Anthropic;
  readonly bindingFor: (route: StructuredRequest<unknown>['route']) => RouteBinding;
  readonly availableBetas: readonly Beta[];
}

export type BatchRequest = StructuredRequest<unknown> & { readonly customId: string };

/**
 * Submit a batch.
 *
 * Every item is built through the **same** `buildStructuredRequest` a synchronous call uses, minus
 * `fallbacks` — which that builder already drops, because the structured routes run on a model that
 * does not offer the fallback. One builder means a batched consolidation and a synchronous one
 * cannot drift apart.
 */
export async function submitBatch(
  deps: BatchDeps,
  requests: readonly BatchRequest[],
  signal: AbortSignal,
): Promise<BatchHandle> {
  if (requests.length === 0) throw new Error('submitBatch needs at least one request');
  const seen = new Set<string>();
  for (const request of requests) {
    if (!CUSTOM_ID_PATTERN.test(request.customId)) {
      throw new Error(
        `custom_id "${request.customId}" does not match ${String(CUSTOM_ID_PATTERN)}`,
      );
    }
    if (seen.has(request.customId)) {
      // Duplicates would make the results unkeyable, which is the one thing this id is for.
      throw new Error(`custom_id "${request.customId}" appears twice in one batch`);
    }
    seen.add(request.customId);
  }

  const batch = await deps.client.beta.messages.batches.create(
    {
      requests: requests.map((request) => {
        const binding = deps.bindingFor(request.route);
        const { params } = buildStructuredRequest(request, {
          binding,
          availableBetas: deps.availableBetas,
        });
        const { betas: _betas, fallbacks: _fallbacks, ...itemParams } = params;
        return { custom_id: request.customId, params: itemParams };
      }),
      ...(deps.availableBetas.length === 0 ? {} : { betas: [...deps.availableBetas] }),
    },
    { signal },
  );

  return {
    provider: 'anthropic',
    batchId: batch.id,
    customIds: requests.map((request) => request.customId),
    submittedAt: batch.created_at,
  };
}

/** Poll a batch. `ended` is the only terminal state; the counts go straight into the trace. */
export async function pollBatch(
  deps: BatchDeps,
  handle: BatchHandle,
  signal: AbortSignal,
): Promise<BatchStatus> {
  const batch = await deps.client.beta.messages.batches.retrieve(handle.batchId, undefined, {
    signal,
  });
  return {
    state: batch.processing_status,
    counts: {
      succeeded: batch.request_counts.succeeded,
      errored: batch.request_counts.errored,
      canceled: batch.request_counts.canceled,
      expired: batch.request_counts.expired,
      processing: batch.request_counts.processing,
    },
  };
}

/** The error type a 400-class batch failure carries. */
function failureOf(response: IndividualResponse): BatchItemFailure | undefined {
  const result = response.result;
  switch (result.type) {
    case 'succeeded':
      return undefined;
    case 'canceled':
      return { kind: 'canceled' };
    case 'expired':
      return { kind: 'retryable', detail: 'expired' };
    case 'errored': {
      const type = result.error.error.type;
      return type === 'invalid_request_error'
        ? { kind: 'invalid_request', detail: type }
        : { kind: 'retryable', detail: type };
    }
  }
}

/**
 * Stream a batch's results, keyed by `custom_id`.
 *
 * An async iterable rather than an array: a nightly consolidation can hold thousands of items, and
 * the SDK already streams them as JSONL. Materialising the lot to key them would hold a whole
 * night's output in memory for no reason.
 *
 * A `custom_id` that was submitted and does not come back is **not** silently dropped — the caller
 * compares against `handle.customIds` and resubmits. That comparison is the caller's because only
 * the caller knows what the job still needs.
 */
export async function* batchResults(
  deps: BatchDeps,
  handle: BatchHandle,
  schemaFor: (customId: string) => StructuredRequest<unknown> | undefined,
  signal: AbortSignal,
): AsyncGenerator<BatchResultItem> {
  const stream = await deps.client.beta.messages.batches.results(handle.batchId, undefined, {
    signal,
  });
  for await (const response of stream) {
    const failure = failureOf(response);
    if (failure !== undefined || response.result.type !== 'succeeded') {
      // The port's members are optional, not required-and-undefined: under
      // `exactOptionalPropertyTypes` those are different types, and the absent key is what a
      // trace serialises.
      yield { customId: response.custom_id, ...(failure === undefined ? {} : { failure }) };
      continue;
    }
    const request = schemaFor(response.custom_id);
    if (request === undefined) {
      // A result for something we did not submit, or for a job whose state is gone. Reported as a
      // failure rather than thrown: one unexpected id must not abandon the rest of the night.
      yield {
        customId: response.custom_id,
        failure: { kind: 'invalid_request', detail: 'no pending request for this custom_id' },
      };
      continue;
    }
    const message = response.result.message;
    const attempt = readStructured(message, request.schema);
    const binding = deps.bindingFor(request.route);
    // `batch: true` on every iteration, which is what `M2-T3`'s 50% multiplier reads.
    const usage = usageIterations(message, binding.model, { batch: true });
    yield { customId: response.custom_id, result: structuredResultOf(attempt, usage, message) };
  }
}

/** Cancel a batch that has run past `BATCH_TIMEOUT_HOURS`. */
export async function cancelBatch(
  deps: BatchDeps,
  handle: BatchHandle,
  signal: AbortSignal,
): Promise<BatchStatus> {
  const batch = await deps.client.beta.messages.batches.cancel(handle.batchId, undefined, {
    signal,
  });
  return {
    state: batch.processing_status,
    counts: {
      succeeded: batch.request_counts.succeeded,
      errored: batch.request_counts.errored,
      canceled: batch.request_counts.canceled,
      expired: batch.request_counts.expired,
      processing: batch.request_counts.processing,
    },
  };
}

/**
 * Delete a batch's stored results.
 *
 * The privacy half of `models.anthropic.useBatches`: a host who batches but does not want results
 * sitting on a provider's disk for 29 days can have the job delete them once it has read them.
 */
export async function deleteBatch(
  deps: BatchDeps,
  handle: BatchHandle,
  signal: AbortSignal,
): Promise<void> {
  await deps.client.beta.messages.batches.delete(handle.batchId, undefined, { signal });
}
