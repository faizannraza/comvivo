/**
 * The OpenAI adapter's lens and subject for the shared contract suite (`M2-T14`).
 *
 * The Responses API's `input` is a **flat item array**, so the lens walks items rather than
 * messages: a tool result is its own top-level `function_call_output` and a replayed assistant
 * turn is a run of `reasoning`/`function_call`/`message` items with no wrapper. That is why
 * `01` §2.1's "single user message" rule is asserted here as contiguity — see
 * `adapter-contract.ts`.
 */
import { SystemClock } from '@comvivo/shared';
import { silentLogger } from '@comvivo/shared/testing';
import OpenAI from 'openai';
import type {
  ContractSubject,
  ToolResultRun,
  WireLens,
  WireTool,
} from '../../testing/adapter-contract.js';
import { FORBIDDEN_SAMPLING_KEYS } from '../../testing/adapter-contract.js';
import { startFakeProviderServer } from '../../testing/index.js';
import type { OpenAiAdapterDeps } from '../adapter.js';
import { runChat } from '../adapter.js';
import { OPENAI_MODEL, openaiBinding, openaiTurnRequest } from './fixtures.js';

function inputItems(body: Readonly<Record<string, unknown>>): readonly Record<string, unknown>[] {
  const input = body['input'];
  if (!Array.isArray(input)) return [];
  return input.filter(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
  );
}

export const openaiLens: WireLens = {
  forbiddenKeysPresent: (body) => FORBIDDEN_SAMPLING_KEYS.filter((key) => body[key] !== undefined),
  toolsOf: (body): readonly WireTool[] => {
    const tools = body['tools'];
    if (!Array.isArray(tools)) return [];
    return tools.flatMap((raw): readonly WireTool[] => {
      if (typeof raw !== 'object' || raw === null) return [];
      const tool = raw as Record<string, unknown>;
      if (tool['type'] !== 'function') return [];
      const name = tool['name'];
      if (typeof name !== 'string') return [];
      const schema = tool['parameters'];
      return [
        {
          name,
          schema:
            typeof schema === 'object' && schema !== null
              ? (schema as Record<string, unknown>)
              : undefined,
          strict: tool['strict'] === true,
        },
      ];
    });
  },
  toolChoiceOf: (body) => {
    const choice = body['tool_choice'];
    return typeof choice === 'string' ? choice : choice === undefined ? undefined : 'forced';
  },
  lastRoleOf: (body) => {
    const items = inputItems(body);
    const last = items.at(-1);
    if (last === undefined) return undefined;
    // Only a message item carries a role; a `function_call_output` has none, and that is the
    // normal final item in a tool loop.
    const role = last['role'];
    return typeof role === 'string' ? role : undefined;
  },
  toolResultRunsOf: (body): readonly ToolResultRun[] => {
    const runs: ToolResultRun[] = [];
    let current: string[] = [];
    for (const item of inputItems(body)) {
      if (item['type'] === 'function_call_output') {
        const id = item['call_id'];
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
    // Every item that is neither a user/developer message nor a tool result: the reasoning items
    // and function calls the provider produced and we replayed.
    return inputItems(body).filter((item) => {
      const role = item['role'];
      if (role === 'user' || role === 'developer' || role === 'system') return false;
      return item['type'] !== 'function_call_output';
    });
  },
};

export function openaiSubject(): ContractSubject {
  const makeDeps = (baseUrl: string): OpenAiAdapterDeps => ({
    bindingFor: () => openaiBinding({ maxRetries: 0, attemptTimeoutMs: 5_000 }),
    clock: new SystemClock(),
    logger: silentLogger,
    client: new OpenAI({ apiKey: 'sk-not-a-real-key', baseURL: baseUrl, maxRetries: 0 }),
  });

  return {
    provider: 'openai',
    lens: openaiLens,
    hasToolChoice: true,
    hasCacheWriteTtls: true,
    tool: (name = 'get_forecast') => ({
      name,
      description: 'Return a short weather summary for one city.',
      inputSchema: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
        additionalProperties: false,
      },
    }),
    run: async ({ request, replies }) => {
      const server = await startFakeProviderServer({ defaultModel: OPENAI_MODEL });
      try {
        server.script(...replies.map((reply) => ({ kind: 'reply' as const, ...reply })));
        const result = await runChat(
          makeDeps(server.openaiBaseUrl),
          openaiTurnRequest(request),
          AbortSignal.timeout(5_000),
        );
        return { result, captured: server.requests() };
      } finally {
        await server.close();
      }
    },
    rawRun: async (body) => {
      const server = await startFakeProviderServer({ defaultModel: OPENAI_MODEL });
      try {
        // A `raw` turn: the stored bytes go back unchanged, which is the whole point.
        server.script({ kind: 'raw', body });
        return await runChat(
          makeDeps(server.openaiBaseUrl),
          openaiTurnRequest(),
          AbortSignal.timeout(5_000),
        );
      } finally {
        await server.close();
      }
    },
    runFaulty: async (fault) => {
      const server = await startFakeProviderServer({ defaultModel: OPENAI_MODEL });
      try {
        server.script(fault);
        try {
          await runChat(
            makeDeps(server.openaiBaseUrl),
            openaiTurnRequest(),
            AbortSignal.timeout(5_000),
          );
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
