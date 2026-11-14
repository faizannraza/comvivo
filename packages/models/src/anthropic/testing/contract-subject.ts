/**
 * The Anthropic adapter's lens and subject for the shared contract suite (`M2-T14`).
 *
 * The lens is the per-provider half of `11` §3.1.9's assertions: where in *this* wire format the
 * tools, the tool choice and the tool results live. Small and declarative on purpose — a lens with
 * logic in it is a lens that can be wrong in a way that makes a rule pass vacuously, which is why
 * `runAdapterContract` checks the lens before it checks the rules.
 */
import Anthropic from '@anthropic-ai/sdk';
import { SystemClock } from '@comvivo/shared';
import { silentLogger } from '@comvivo/shared/testing';
import type {
  ContractSubject,
  ToolResultRun,
  WireLens,
  WireTool,
} from '../../testing/adapter-contract.js';
import { FORBIDDEN_SAMPLING_KEYS } from '../../testing/adapter-contract.js';
import { type SseEvent, startFakeProviderServer } from '../../testing/index.js';
import type { AnthropicAdapterDeps } from '../adapter.js';
import { runChat } from '../adapter.js';
import { OPTIONAL_BETAS } from '../request.js';
import { bindingFor, OPUS, toolSpec, turnRequest } from './fixtures.js';

/** Content blocks of the last `user` message, which is where Anthropic nests tool results. */
function lastUserBlocks(
  body: Readonly<Record<string, unknown>>,
): readonly Record<string, unknown>[] {
  const messages = body['messages'];
  if (!Array.isArray(messages)) return [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as Record<string, unknown> | undefined;
    if (message?.['role'] !== 'user') continue;
    const content = message['content'];
    return Array.isArray(content)
      ? content.filter(
          (block): block is Record<string, unknown> => typeof block === 'object' && block !== null,
        )
      : [];
  }
  return [];
}

export const anthropicLens: WireLens = {
  forbiddenKeysPresent: (body) => FORBIDDEN_SAMPLING_KEYS.filter((key) => body[key] !== undefined),
  toolsOf: (body): readonly WireTool[] => {
    const tools = body['tools'];
    if (!Array.isArray(tools)) return [];
    return tools.flatMap((raw): readonly WireTool[] => {
      if (typeof raw !== 'object' || raw === null) return [];
      const tool = raw as Record<string, unknown>;
      const name = tool['name'];
      if (typeof name !== 'string') return [];
      const schema = tool['input_schema'];
      return [
        {
          name,
          schema:
            typeof schema === 'object' && schema !== null
              ? (schema as Record<string, unknown>)
              : undefined,
          // Anthropic's tool block has no `strict` field: strictness is implied by the schema
          // shape. `undefined` says "not applicable" rather than claiming `false`.
          strict: undefined,
        },
      ];
    });
  },
  toolChoiceOf: (body) => {
    const choice = body['tool_choice'];
    if (typeof choice !== 'object' || choice === null) return undefined;
    const type = (choice as Record<string, unknown>)['type'];
    return typeof type === 'string' ? type : undefined;
  },
  lastRoleOf: (body) => {
    const messages = body['messages'];
    if (!Array.isArray(messages)) return undefined;
    const last = messages.at(-1) as Record<string, unknown> | undefined;
    const role = last?.['role'];
    return typeof role === 'string' ? role : undefined;
  },
  toolResultRunsOf: (body): readonly ToolResultRun[] => {
    const runs: ToolResultRun[] = [];
    let current: string[] = [];
    for (const block of lastUserBlocks(body)) {
      if (block['type'] === 'tool_result') {
        const id = block['tool_use_id'];
        current.push(typeof id === 'string' ? id : '');
        continue;
      }
      if (current.length > 0) {
        runs.push({ count: current.length, callIds: current });
        current = [];
      }
    }
    if (current.length > 0) runs.push({ count: current.length, callIds: current });
    return runs;
  },
  replayedAssistantOf: (body) => {
    const messages = body['messages'];
    if (!Array.isArray(messages)) return [];
    // Typed through a narrow view before any member is read: `Array.isArray` gives `any[]`, and
    // reading `['role']` off that is how an `any` crosses into the lens.
    const rows = messages as readonly unknown[];
    const assistant = rows.filter(
      (message): message is Record<string, unknown> =>
        typeof message === 'object' &&
        message !== null &&
        (message as Record<string, unknown>)['role'] === 'assistant',
    );
    const content = assistant.at(-1)?.['content'];
    return Array.isArray(content) ? (content as readonly unknown[]) : [];
  },
};

/** The subject. Owns the harness; the shared suite owns the assertions. */
export function anthropicSubject(): ContractSubject {
  return {
    provider: 'anthropic',
    lens: anthropicLens,
    hasToolChoice: true,
    hasCacheWriteTtls: true,
    tool: (name = 'get_forecast') => ({ ...toolSpec(name), name }),
    run: async ({ request, replies }) => {
      const server = await startFakeProviderServer({ defaultModel: OPUS });
      try {
        server.script(...replies.map((reply) => ({ kind: 'reply' as const, ...reply })));
        const deps: AnthropicAdapterDeps = {
          bindingFor: () => bindingFor({ maxRetries: 0, attemptTimeoutMs: 5_000 }),
          availableBetas: Object.values(OPTIONAL_BETAS),
          clock: new SystemClock(),
          logger: silentLogger,
          client: new Anthropic({
            apiKey: 'sk-ant-not-a-real-key',
            baseURL: server.anthropicBaseUrl,
            maxRetries: 0,
          }),
        };
        const result = await runChat(deps, turnRequest(request), AbortSignal.timeout(5_000));
        return { result, captured: server.requests() };
      } finally {
        await server.close();
      }
    },
    rawRun: async (body) => {
      const server = await startFakeProviderServer({ defaultModel: OPUS });
      try {
        // `raw_sse` for this provider: the adapter streams, so its stored fixture is the event
        // sequence rather than a final message body, and the events go out verbatim.
        server.script(
          Array.isArray(body)
            ? { kind: 'raw_sse', events: body as readonly SseEvent[] }
            : { kind: 'raw', body },
        );
        const deps: AnthropicAdapterDeps = {
          bindingFor: () => bindingFor({ maxRetries: 0, attemptTimeoutMs: 5_000 }),
          availableBetas: [],
          clock: new SystemClock(),
          logger: silentLogger,
          client: new Anthropic({
            apiKey: 'sk-ant-not-a-real-key',
            baseURL: server.anthropicBaseUrl,
            maxRetries: 0,
          }),
        };
        return await runChat(deps, turnRequest(), AbortSignal.timeout(5_000));
      } finally {
        await server.close();
      }
    },
    runFaulty: async (fault) => {
      const server = await startFakeProviderServer({ defaultModel: OPUS });
      try {
        server.script(fault);
        const deps: AnthropicAdapterDeps = {
          bindingFor: () => bindingFor({ maxRetries: 0, attemptTimeoutMs: 5_000 }),
          availableBetas: [],
          clock: new SystemClock(),
          logger: silentLogger,
          client: new Anthropic({
            apiKey: 'sk-ant-not-a-real-key',
            baseURL: server.anthropicBaseUrl,
            maxRetries: 0,
          }),
        };
        try {
          await runChat(deps, turnRequest(), AbortSignal.timeout(5_000));
          throw new Error('the adapter did not reject');
        } catch (error) {
          return error;
        }
      } finally {
        await server.close();
      }
    },
  };
}
