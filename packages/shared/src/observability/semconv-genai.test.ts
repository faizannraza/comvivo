import { describe, expect, it } from 'vitest';
import { BRAND } from '../brand.js';
import { FORBIDDEN_ATTRIBUTE_FAMILIES, isForbiddenAttribute } from './attributes.js';
import {
  ATTR,
  agentSpanName,
  anthropicInputTokens,
  embeddingsSpanName,
  GENAI,
  GENAI_OPERATION,
  GENAI_OPT_IN_CONTENT_ATTRIBUTES,
  GENAI_PROVIDER,
  GENAI_SEMCONV,
  inferenceSpanName,
  jobSpanName,
  SPAN,
  SPAN_NS,
  toolSpanName,
} from './semconv-genai.js';

describe('the pin', () => {
  it('names a full commit SHA, so the pin is checkable', () => {
    expect(GENAI_SEMCONV.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(GENAI_SEMCONV.repo).toBe('open-telemetry/semantic-conventions-genai');
  });

  it('records when it was verified, because Development-status conventions move', () => {
    expect(GENAI_SEMCONV.verified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(GENAI_SEMCONV.status).toBe('development');
  });
});

describe('GENAI attribute names', () => {
  it('are all under the gen_ai namespace', () => {
    for (const [key, value] of Object.entries(GENAI)) {
      expect(value, `${key} is not a gen_ai attribute`).toMatch(/^gen_ai\./);
    }
  });

  it('contains no attribute that carries content', () => {
    // The point of the whole file: nothing importable from here can leak a prompt.
    for (const [key, value] of Object.entries(GENAI)) {
      expect(isForbiddenAttribute(value), `GENAI.${key} = ${value} is a content attribute`).toBe(
        false,
      );
    }
  });

  it('has no duplicate values', () => {
    const values = Object.values(GENAI);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('the opt-in content attributes', () => {
  it('are every one covered by a forbidden family', () => {
    // This is the check that keeps the denylist honest. The registry's opt-in set grew from 6 to
    // 15 attributes in two days; if it grows again into a family we do not cover, this fails and
    // the upgrade PR has to decide what to do rather than shipping an emittable content attribute.
    for (const name of GENAI_OPT_IN_CONTENT_ATTRIBUTES) {
      expect(isForbiddenAttribute(name), `${name} is not covered by any forbidden family`).toBe(
        true,
      );
    }
  });

  it('includes the _ref variants, which carry content by reference', () => {
    // A URL pointing at the prompt is the prompt, as far as `01` §11.7 is concerned: whoever reads
    // the trace can follow it.
    for (const name of [
      'gen_ai.input.messages_ref',
      'gen_ai.output.messages_ref',
      'gen_ai.system_instructions_ref',
      'gen_ai.tool.definitions_ref',
    ]) {
      expect(GENAI_OPT_IN_CONTENT_ATTRIBUTES).toContain(name);
      expect(isForbiddenAttribute(name)).toBe(true);
    }
  });

  it('every family it declares actually covers something in the snapshot', () => {
    // The reverse direction: a family that covers nothing is either a typo or a leftover, and
    // either way it is a line of security code that does nothing.
    for (const family of FORBIDDEN_ATTRIBUTE_FAMILIES) {
      const covered = GENAI_OPT_IN_CONTENT_ATTRIBUTES.filter((name) => name.startsWith(family));
      expect(covered.length, `the family "${family}" covers no known attribute`).toBeGreaterThan(0);
    }
  });

  it('leaves the neighbouring non-content attributes emittable', () => {
    // The families are narrow on purpose. If these ever become forbidden, the denylist has gone
    // from protecting content to blocking observability.
    for (const name of [
      'gen_ai.output.type',
      'gen_ai.tool.call.id',
      'gen_ai.tool.name',
      'gen_ai.tool.type',
      'gen_ai.memory.record.count',
      'gen_ai.conversation.id',
    ]) {
      expect(isForbiddenAttribute(name), `${name} should be emittable`).toBe(false);
    }
  });
});

describe('anthropicInputTokens', () => {
  // The AC's named rule. Anthropic's `input_tokens` EXCLUDES cached tokens; the convention's
  // includes them, so the sum is normative:
  //   gen_ai.usage.input_tokens = input_tokens + cache_read + cache_creation
  it('sums the uncached, cache-read and cache-write counts', () => {
    expect(
      anthropicInputTokens({
        input_tokens: 100,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 25,
      }),
    ).toBe(175);
  });

  it('matches the worked example in the pinned anthropic.md', () => {
    // From the conventions' own table: input 100, cache_read 50, cache_write 25.
    const usage = {
      input_tokens: 100,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 25,
    };
    expect(anthropicInputTokens(usage)).toBe(
      usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
    );
  });

  it.each([
    ['both cache fields absent', { input_tokens: 100 }, 100],
    ['cache fields null', { input_tokens: 100, cache_read_input_tokens: null }, 100],
    [
      'cache fields undefined',
      { input_tokens: 7, cache_read_input_tokens: undefined, cache_creation_input_tokens: 3 },
      10,
    ],
    ['a cold request', { input_tokens: 19_000, cache_creation_input_tokens: 0 }, 19_000],
    ['zero input', { input_tokens: 0, cache_read_input_tokens: 0 }, 0],
  ])('handles %s', (_label, usage, expected) => {
    expect(anthropicInputTokens(usage)).toBe(expected);
  });

  it('does not under-report a warm conversation', () => {
    // `11` §8 assumes roughly 60% cache reads after warm-up. Reading only Anthropic's
    // `input_tokens` would report 40% of the true input — wrong in the direction that looks
    // reassuring on a cost dashboard, which is the direction that matters.
    const total = 19_000;
    const cached = Math.round(total * 0.6);
    const usage = { input_tokens: total - cached, cache_read_input_tokens: cached };
    expect(anthropicInputTokens(usage)).toBe(total);
    expect(usage.input_tokens / total).toBeCloseTo(0.4, 2);
  });
});

describe('span names', () => {
  it('builds the convention shape {operation} {model}', () => {
    expect(inferenceSpanName(GENAI_OPERATION.CHAT, 'claude-opus-5-5')).toBe('chat claude-opus-5-5');
    expect(inferenceSpanName(GENAI_OPERATION.EMBEDDINGS, 'bge-small-en-v1.5')).toBe(
      'embeddings bge-small-en-v1.5',
    );
  });

  it('names the agent span after the brand', () => {
    expect(agentSpanName()).toBe(`invoke_agent ${BRAND.slug}`);
  });

  it('builds tool and embeddings span names', () => {
    expect(toolSpanName('remind')).toBe('execute_tool remind');
    expect(embeddingsSpanName('nomic-embed-text')).toBe('embeddings nomic-embed-text');
  });

  it('namespaces our own spans with the brand slug', () => {
    expect(SPAN_NS).toBe(`${BRAND.slug}.`);
    expect(SPAN.INGEST).toBe(`${BRAND.slug}.ingest`);
    expect(jobSpanName('digest.morning')).toBe(`${BRAND.slug}.job digest.morning`);
    for (const [key, value] of Object.entries(SPAN)) {
      expect(value, `SPAN.${key} is not brand-namespaced`).toMatch(new RegExp(`^${BRAND.slug}\\.`));
    }
  });

  it('carries no codename anywhere in the span or attribute names', () => {
    // The rename drill (`13` §3.A.6) has to be a one-command operation. A hard-coded prefix here
    // would survive it and show up in a host's trace view a year later.
    const all = [...Object.values(SPAN), ...Object.values(ATTR), SPAN_NS];
    for (const name of all) {
      for (const legacy of ['village', 'Village']) {
        expect(name.includes(legacy), `${name} contains the codename`).toBe(false);
      }
    }
  });
});

describe('our own attributes', () => {
  it('are all brand-namespaced and none carries content', () => {
    for (const [key, value] of Object.entries(ATTR)) {
      expect(value, `ATTR.${key}`).toMatch(new RegExp(`^${BRAND.slug}\\.`));
      expect(isForbiddenAttribute(value), `ATTR.${key} = ${value} is forbidden`).toBe(false);
    }
  });

  it('covers every attribute `11` §3.10.2 lists for our spans', () => {
    // Keyed off the spec table so a dropped attribute is caught here rather than in a trace view.
    const required = [
      'channel',
      'group.id',
      'ingest.outcome',
      'turn.id',
      'turn.trigger',
      'turn.disposition',
      'turn.status',
      'audience.size',
      'cost.micros',
      'context.items',
      'context.filtered_out',
      'context.constraints',
      'constraints.count',
      'constraints.rejected',
      'model.route',
      'model.effort',
      'embed.count',
      'policy.decision',
      'tool.effect',
      'guard.result',
      'guard.stage',
      'outbox.attempt',
      'outbox.outcome',
      'job.kind',
      'job.attempt',
      'job.lag_ms',
      'job.outcome',
    ];
    const emitted = new Set<string>(Object.values(ATTR));
    for (const suffix of required) {
      expect(emitted.has(`${SPAN_NS}${suffix}`), `missing attribute ${SPAN_NS}${suffix}`).toBe(
        true,
      );
    }
    expect(Object.values(ATTR)).toHaveLength(required.length);
  });
});

describe('provider names', () => {
  it('uses the well-known values for the three cloud providers', () => {
    expect(GENAI_PROVIDER.ANTHROPIC).toBe('anthropic');
    expect(GENAI_PROVIDER.OPENAI).toBe('openai');
    // Spelled with a dot, unlike the others — `@google/genai` maps to `gcp.gen_ai`.
    expect(GENAI_PROVIDER.GOOGLE).toBe('gcp.gen_ai');
  });

  it('uses snake_case custom values for local servers', () => {
    for (const name of [
      GENAI_PROVIDER.OLLAMA,
      GENAI_PROVIDER.LMSTUDIO,
      GENAI_PROVIDER.LLAMA_CPP,
      GENAI_PROVIDER.VLLM,
    ]) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
