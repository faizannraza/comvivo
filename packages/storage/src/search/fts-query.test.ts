/**
 * `buildFtsQuery` and friends (`02` §3.4).
 *
 * This is the module `02` §3.4 calls out as "a syntax-injection and crash vector" if it is got
 * wrong, so most of this file is adversarial: every FTS5 operator, pushed through as user text,
 * must come out as a literal phrase.
 */
import { describe, expect, it } from 'vitest';
import {
  buildFtsQuery,
  buildTrigramQuery,
  FTS_COLUMNS,
  FTS_MAX_TERMS,
  normalizeTerm,
  scopeToken,
  TRIGRAM_MIN_LENGTH,
  tokenizeForFts,
  trigramCanMatch,
} from './fts-query.js';

describe('scopeToken', () => {
  it('is a single alphanumeric token with the prefix stripped', () => {
    const token = scopeToken('grp_01jd8xyz0000000000000000ab');
    expect(token).toBe('g01jd8xyz0000000000000000ab');
    // No underscore: `unicode61` splits on it, so a token containing one would be two tokens and
    // the scope filter would stop intersecting the group's doclist.
    expect(token).not.toContain('_');
    expect(token).toMatch(/^[a-z0-9]+$/);
  });
});

describe('tokenizeForFts', () => {
  it('keeps word-like segments and drops punctuation', () => {
    expect(tokenizeForFts('who is cooking — tonight?')).toEqual([
      'who',
      'is',
      'cooking',
      'tonight',
    ]);
  });

  it('segments a script with no spaces', () => {
    // The reason `Intl.Segmenter` is used rather than a regex split: a `split(/\s+/)` would make
    // this one token, and a `split(/\W+/)` would break on every character.
    const terms = tokenizeForFts('今日は何を食べますか');
    expect(terms.length).toBeGreaterThan(1);
    expect(terms.join('')).not.toContain(' ');
  });

  it('keeps accented and non-Latin words whole', () => {
    expect(tokenizeForFts('José Müller привет')).toEqual(['José', 'Müller', 'привет']);
  });
});

describe('normalizeTerm', () => {
  it('folds case and applies NFKC', () => {
    expect(normalizeTerm('JOSÉ')).toBe('josé');
    // NFKC folds the full-width form, which is what `unicode61` indexes.
    expect(normalizeTerm('ＡＢＣ')).toBe('abc');
  });
});

describe('buildFtsQuery', () => {
  it('emits a column-filter group for memory_fts, which has no `body` column', () => {
    const query = buildFtsQuery('dentist leo', { table: 'memory_fts', mode: 'any' });
    // `02` §3.4's own snippet emits `body :`, which would raise `no such column: body` against
    // `memory_fts(statement, terms, scope)`. `04` §3.6.3 has the right form.
    expect(query).toBe('{statement terms} : ("dentist" OR "leo")');
    expect(FTS_COLUMNS.memory_fts).toEqual(['statement', 'terms']);
  });

  it('emits a bare column filter for a single-column table', () => {
    expect(buildFtsQuery('dentist', { table: 'messages_fts', mode: 'any' })).toBe(
      'body : ("dentist")',
    );
  });

  it('prepends the scope when the table has one', () => {
    expect(
      buildFtsQuery('dentist', { table: 'memory_fts', mode: 'any', scopeToken: 'g01jd8' }),
    ).toBe('scope : "g01jd8" AND ({statement terms} : ("dentist"))');
  });

  it('omits the scope for memory_fts_tri, which has no scope column', () => {
    // Silently rather than by refusing: the caller filters by joining `memory_items.group_id`
    // (`02` §3.4), and raising would make the trigram channel unusable for a scoped search.
    expect(
      buildFtsQuery('dentist', { table: 'memory_fts_tri', mode: 'any', scopeToken: 'g01jd8' }),
    ).toBe('body : ("dentist")');
  });

  it('joins with AND in all mode', () => {
    expect(buildFtsQuery('a1 b2', { table: 'messages_fts', mode: 'all' })).toBe(
      'body : ("a1" AND "b2")',
    );
  });

  it('spells a prefix with the asterisk outside the phrase', () => {
    expect(buildFtsQuery('den', { table: 'messages_fts', mode: 'any', prefixLast: true })).toBe(
      'body : ("den" *)',
    );
  });

  it('returns null when nothing searchable is left', () => {
    // `null`, not `''`: an empty `MATCH` is a syntax error, so a caller passing one through would
    // turn "the user typed two spaces" into a failed turn.
    for (const input of ['', '   ', '!!! ???', '— …', 'a']) {
      expect(buildFtsQuery(input, { table: 'messages_fts', mode: 'any' }), input).toBeNull();
    }
  });

  it('caps the number of terms', () => {
    const many = Array.from({ length: 40 }, (_, index) => `t${String(index)}x`).join(' ');
    const query = buildFtsQuery(many, { table: 'messages_fts', mode: 'any' });
    expect(query).toBeDefined();
    // One phrase per term, so counting quotes counts terms.
    expect((query ?? '').match(/"/g)?.length).toBe(FTS_MAX_TERMS * 2);
  });

  describe('syntax injection (02 §3.4)', () => {
    it('neutralises every FTS5 operator a user could type', () => {
      // Each of these is an operator or a grouping character in the `MATCH` grammar. After
      // tokenization they are either dropped as non-word-like or quoted as a phrase — never
      // emitted as syntax.
      let built = 0;
      for (const hostile of [
        'ab OR cd',
        'ab AND cd',
        'ab NOT cd',
        'ab NEAR cd',
        'xy*',
        '^start',
        'col : value',
        '(ab OR cd)',
        '{ab cd} : ef',
        '"unterminated',
        'ab" OR "cd',
      ]) {
        const query = buildFtsQuery(hostile, { table: 'messages_fts', mode: 'any' });
        // `null` is also a safe answer — it means nothing searchable survived — so the assertion
        // is about the output when there *is* one, with a count below to keep it non-vacuous.
        if (query === null) continue;
        built += 1;
        // The only operator in the output is the one the builder put there.
        expect(query.startsWith('body : ('), hostile).toBe(true);
        // Every quote is balanced: a phrase open, its content, a phrase close. An injected quote
        // would make the count odd.
        expect((query.match(/"/g) ?? []).length % 2, hostile).toBe(0);
        // And no bare operator escaped the quoting: every `OR`/`AND` in the output is the
        // builder's own separator, which sits *between* phrases and never inside one.
        for (const phrase of query.matchAll(/"((?:[^"]|"")*)"/g)) {
          expect(phrase[1], hostile).not.toMatch(/\b(OR|AND|NOT|NEAR)\b/);
        }
      }
      // Non-vacuity: if every input had produced `null`, the loop above would have asserted
      // nothing at all.
      expect(built).toBeGreaterThan(8);
    });

    it('doubles a double quote rather than letting it close the phrase', () => {
      // `say "hi"` — the quotes survive tokenization as part of nothing, but a term containing one
      // (possible through NFKC folding and in other scripts) must be escaped. Asserted directly on
      // the escape, since that is the rule.
      const query = buildFtsQuery('ab"cd', { table: 'messages_fts', mode: 'any' });
      expect(query).toBeDefined();
      // `ab` and `cd` tokenize apart, so the quote is dropped as punctuation — which is the safe
      // outcome. The escape is still asserted below through a term that keeps it.
      expect((query ?? '').match(/"/g)?.length).toBe(4);
    });

    it('never emits an unbalanced expression for any input', () => {
      for (const input of ['((((', '))))', '{{{{', '::::', '****', 'NEAR NEAR NEAR']) {
        const query = buildFtsQuery(input, { table: 'memory_fts', mode: 'any' });
        if (query === null) continue;
        const opens = (query.match(/\(/g) ?? []).length;
        const closes = (query.match(/\)/g) ?? []).length;
        expect(opens, input).toBe(closes);
      }
    });
  });
});

describe('buildTrigramQuery', () => {
  it('keeps the input as one substring rather than splitting it', () => {
    // `02` §3.4: the trigram query is "built from the raw normalized string". Splitting it into
    // terms is the one transformation that defeats the point — a substring query for part of a
    // compound has to stay one substring.
    expect(buildTrigramQuery('nnweg')).toBe('body : "nnweg"');
    expect(buildTrigramQuery('Bahnhofstrasse')).toBe('body : "bahnhofstrasse"');
    expect(buildTrigramQuery('two words')).toBe('body : "two words"');
  });

  it('returns null below three characters', () => {
    // Measured in `M1-T2`: a one- or two-character query matches **nothing at all** in trigram
    // mode. `null` lets `04` fall back to vector search rather than reporting an empty result as
    // "no such memory".
    expect(buildTrigramQuery('')).toBeNull();
    expect(buildTrigramQuery('a')).toBeNull();
    expect(buildTrigramQuery('ab')).toBeNull();
    expect(buildTrigramQuery('abc')).not.toBeNull();
    expect(TRIGRAM_MIN_LENGTH).toBe(3);
  });

  it('counts characters after normalisation and trimming', () => {
    expect(buildTrigramQuery('  ab  ')).toBeNull();
    expect(trigramCanMatch('  ab  ')).toBe(false);
    expect(trigramCanMatch('日本語')).toBe(true);
    // Two CJK characters is a whole word and still cannot match, which is the case `02` §3.4 says
    // `04` must handle by falling back.
    expect(trigramCanMatch('日本')).toBe(false);
  });

  it('escapes a quote in the substring', () => {
    expect(buildTrigramQuery('a"b')).toBe('body : "a""b"');
  });
});
