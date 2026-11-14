/**
 * The local adapter's lens and subject for the shared contract suite (`M2-T14`).
 *
 * The one subject whose answer to a rule is **"the field must be absent"** rather than "the field
 * must hold one of two values": `05` §3.5.6 omits `tool_choice` because Ollama does not support it,
 * so `hasToolChoice` is `false` and the shared rule asserts absence. Same rule, different
 * expression — which is exactly why the rule lives in one place and the expression in four.
 *
 * Run at **L1**, the native-tools level, because that is the level whose wire shape `01` §2.1's
 * rules are about. The envelope levels send no `tools` at all and are covered by
 * `local.test.ts` and the adapter's own contract test.
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
import type { LocalAdapterDeps } from '../adapter.js';
import { runChat } from '../adapter.js';
import { LOCAL_MODEL, localBinding, localTurnRequest } from './fixtures.js';

function messages(body: Readonly<Record<string, unknown>>): readonly Record<string, unknown>[] {
  const raw = body['messages'];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
  );
}

export const localLens: WireLens = {
  forbiddenKeysPresent: (body) => FORBIDDEN_SAMPLING_KEYS.filter((key) => body[key] !== undefined),
  toolsOf: (body): readonly WireTool[] => {
    const tools = body['tools'];
    if (!Array.isArray(tools)) return [];
    return tools.flatMap((raw): readonly WireTool[] => {
      if (typeof raw !== 'object' || raw === null) return [];
      const tool = raw as Record<string, unknown>;
      // Chat Completions nests the declaration under `function`, unlike the Responses API's flat
      // shape — one of the two places a lens copied between them would silently find nothing.
      const fn = tool['function'];
      if (typeof fn !== 'object' || fn === null) return [];
      const declaration = fn as Record<string, unknown>;
      const name = declaration['name'];
      if (typeof name !== 'string') return [];
      const schema = declaration['parameters'];
      return [
        {
          name,
          schema:
            typeof schema === 'object' && schema !== null
              ? (schema as Record<string, unknown>)
              : undefined,
          strict: declaration['strict'] === true,
        },
      ];
    });
  },
  toolChoiceOf: (body) => {
    const choice = body['tool_choice'];
    return typeof choice === 'string' ? choice : choice === undefined ? undefined : 'forced';
  },
  lastRoleOf: (body) => {
    const last = messages(body).at(-1);
    const role = last?.['role'];
    return typeof role === 'string' ? role : undefined;
  },
  toolResultRunsOf: (body): readonly ToolResultRun[] => {
    // Each result is its own `role: 'tool'` message here — the format requires it — so a run is a
    // consecutive stretch of them. This is the shape `01` §2.1's "single user message" wording
    // cannot describe, and the reason the shared rule asserts contiguity.
    const runs: ToolResultRun[] = [];
    let current: string[] = [];
    for (const message of messages(body)) {
      if (message['role'] === 'tool') {
        const id = message['tool_call_id'];
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
    const assistant = messages(body).filter((message) => message['role'] === 'assistant');
    const last = assistant.at(-1);
    return last === undefined ? [] : [last];
  },
};

export function localSubject(): ContractSubject {
  const makeDeps = (baseUrl: string): LocalAdapterDeps => ({
    bindingFor: () => localBinding({ maxRetries: 0, attemptTimeoutMs: 5_000 }),
    clock: new SystemClock(),
    logger: silentLogger,
    baseUrl,
    serverKind: 'ollama',
    // L1: the level whose wire shape `01` §2.1's rules describe.
    level: 'L1',
    reasoningEffortAccepted: false,
    client: new OpenAI({ apiKey: 'local', baseURL: baseUrl, maxRetries: 0 }),
  });

  return {
    provider: 'openai-compatible',
    lens: localLens,
    // `05` §3.5.6 omits it for Ollama's sake, so the rule becomes "must be absent".
    hasToolChoice: false,
    // A KV prefix cache is not billed, and a local model is not billed at all.
    hasCacheWriteTtls: false,
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
      const server = await startFakeProviderServer({ defaultModel: LOCAL_MODEL });
      try {
        server.script(...replies.map((reply) => ({ kind: 'reply' as const, ...reply })));
        const result = await runChat(
          makeDeps(server.openaiBaseUrl),
          localTurnRequest(request),
          AbortSignal.timeout(5_000),
        );
        return { result, captured: server.requests() };
      } finally {
        await server.close();
      }
    },
    rawRun: async (body) => {
      const server = await startFakeProviderServer({ defaultModel: LOCAL_MODEL });
      try {
        // A `raw` turn: the stored bytes go back unchanged, which is the whole point.
        server.script({ kind: 'raw', body });
        return await runChat(
          makeDeps(server.openaiBaseUrl),
          localTurnRequest(),
          AbortSignal.timeout(5_000),
        );
      } finally {
        await server.close();
      }
    },
    runFaulty: async (fault) => {
      const server = await startFakeProviderServer({ defaultModel: LOCAL_MODEL });
      try {
        server.script(fault);
        try {
          await runChat(
            makeDeps(server.openaiBaseUrl),
            localTurnRequest(),
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
