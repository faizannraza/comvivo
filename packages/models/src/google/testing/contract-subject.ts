/**
 * The Google adapter's lens and subject for the shared contract suite (`M2-T14`).
 *
 * Two shapes that make this lens different from the other three:
 *
 *  - **Tools nest twice**: `tools[0].functionDeclarations[]`, and a declaration's schema is
 *    `parametersJsonSchema`. A lens that read `tools[].parameters` would find nothing and make the
 *    strict-tools rule pass vacuously, which is the case `assertLensIsHonest` exists for.
 *  - **There is no `strict` field at all.** Strictness is the schema's own shape here, so the lens
 *    reports `undefined` — "not applicable" — and the shared rule still requires
 *    `additionalProperties: false`, which is the half this format can carry.
 *
 * The SDK also moves `config` into the REST body at a different nesting than the TypeScript
 * surface suggests, which is why the sampling-key check walks the body **and** its
 * `generationConfig` rather than only the top level.
 */
import { SystemClock } from '@comvivo/shared';
import { silentLogger } from '@comvivo/shared/testing';
import { GoogleGenAI } from '@google/genai';
import type {
  ContractSubject,
  ToolResultRun,
  WireLens,
  WireTool,
} from '../../testing/adapter-contract.js';
import { FORBIDDEN_SAMPLING_KEYS } from '../../testing/adapter-contract.js';
import { startFakeProviderServer } from '../../testing/index.js';
import type { GoogleAdapterDeps } from '../adapter.js';
import { runChat } from '../adapter.js';
import { GOOGLE_MODEL, googleBinding, googleTurnRequest } from './fixtures.js';

function contents(body: Readonly<Record<string, unknown>>): readonly Record<string, unknown>[] {
  const raw = body['contents'];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
  );
}

function partsOf(content: Record<string, unknown> | undefined): readonly Record<string, unknown>[] {
  const parts = content?.['parts'];
  if (!Array.isArray(parts)) return [];
  return parts.filter(
    (part): part is Record<string, unknown> => typeof part === 'object' && part !== null,
  );
}

export const googleLens: WireLens = {
  forbiddenKeysPresent: (body) => {
    // The SDK flattens most of `config` into the body and keeps the sampler fields under
    // `generationConfig`. Both are checked, because a field in either place is a field on the wire.
    const generation = body['generationConfig'];
    const nested =
      typeof generation === 'object' && generation !== null
        ? (generation as Record<string, unknown>)
        : {};
    return FORBIDDEN_SAMPLING_KEYS.filter(
      (key) => body[key] !== undefined || nested[key] !== undefined,
    );
  },
  toolsOf: (body): readonly WireTool[] => {
    const tools = body['tools'];
    if (!Array.isArray(tools)) return [];
    return tools.flatMap((raw): readonly WireTool[] => {
      if (typeof raw !== 'object' || raw === null) return [];
      const declarations = (raw as Record<string, unknown>)['functionDeclarations'];
      if (!Array.isArray(declarations)) return [];
      return declarations.flatMap((entry): readonly WireTool[] => {
        if (typeof entry !== 'object' || entry === null) return [];
        const declaration = entry as Record<string, unknown>;
        const name = declaration['name'];
        if (typeof name !== 'string') return [];
        const schema = declaration['parametersJsonSchema'] ?? declaration['parameters'];
        return [
          {
            name,
            schema:
              typeof schema === 'object' && schema !== null
                ? (schema as Record<string, unknown>)
                : undefined,
            // No `strict` field in this format. Reporting `false` would fail a rule the provider
            // cannot express; `undefined` says so honestly.
            strict: undefined,
          },
        ];
      });
    });
  },
  toolChoiceOf: (body) => {
    const config = body['toolConfig'];
    if (typeof config !== 'object' || config === null) return undefined;
    const calling = (config as Record<string, unknown>)['functionCallingConfig'];
    if (typeof calling !== 'object' || calling === null) return undefined;
    const mode = (calling as Record<string, unknown>)['mode'];
    if (typeof mode !== 'string') return undefined;
    // `AUTO`/`NONE` lower-cased, so the shared rule can compare one vocabulary across four
    // providers rather than carrying a per-provider spelling.
    return mode.toLowerCase();
  },
  lastRoleOf: (body) => {
    const last = contents(body).at(-1);
    const role = last?.['role'];
    // Gemini's assistant role is `model`, normalised so the shared prefill rule reads one word.
    if (role === 'model') return 'assistant';
    return typeof role === 'string' ? role : undefined;
  },
  toolResultRunsOf: (body): readonly ToolResultRun[] => {
    const runs: ToolResultRun[] = [];
    for (const content of contents(body)) {
      let current: string[] = [];
      for (const part of partsOf(content)) {
        const response = part['functionResponse'];
        if (typeof response === 'object' && response !== null) {
          const id = (response as Record<string, unknown>)['id'];
          current.push(typeof id === 'string' ? id : '');
          continue;
        }
        if (current.length > 0) {
          runs.push({ count: current.length, callIds: current });
          current = [];
        }
      }
      if (current.length > 0) runs.push({ count: current.length, callIds: current });
    }
    return runs;
  },
  replayedAssistantOf: (body) => {
    const model = contents(body).filter((content) => content['role'] === 'model');
    return [...partsOf(model.at(-1))];
  },
};

export function googleSubject(): ContractSubject {
  const makeDeps = (url: string): GoogleAdapterDeps => ({
    bindingFor: () => googleBinding({ maxRetries: 0, attemptTimeoutMs: 5_000 }),
    clock: new SystemClock(),
    logger: silentLogger,
    client: new GoogleGenAI({ apiKey: 'not-a-real-key', httpOptions: { baseUrl: url } }),
  });

  return {
    provider: 'google',
    lens: googleLens,
    hasToolChoice: true,
    // Implicit caching with no billed write category (`05` §3.5.5, measured at `M2-T13`).
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
      const server = await startFakeProviderServer({ defaultModel: GOOGLE_MODEL });
      try {
        server.script(...replies.map((reply) => ({ kind: 'reply' as const, ...reply })));
        const result = await runChat(
          makeDeps(server.url),
          googleTurnRequest(request),
          AbortSignal.timeout(5_000),
        );
        return { result, captured: server.requests() };
      } finally {
        await server.close();
      }
    },
    rawRun: async (body) => {
      const server = await startFakeProviderServer({ defaultModel: GOOGLE_MODEL });
      try {
        // A `raw` turn: the stored bytes go back unchanged, which is the whole point.
        server.script({ kind: 'raw', body });
        return await runChat(makeDeps(server.url), googleTurnRequest(), AbortSignal.timeout(5_000));
      } finally {
        await server.close();
      }
    },
    runFaulty: async (fault) => {
      const server = await startFakeProviderServer({ defaultModel: GOOGLE_MODEL });
      try {
        server.script(fault);
        try {
          await runChat(makeDeps(server.url), googleTurnRequest(), AbortSignal.timeout(5_000));
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
