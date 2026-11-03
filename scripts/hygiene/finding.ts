/**
 * The shared shape of a static-check finding, and how one is printed.
 *
 * Every hygiene check reports the same structure so the `static` CI job can print them uniformly
 * and so each one is forced to answer the same question: what should the author do instead. A check
 * that only says "no" is a check somebody disables.
 */
export interface Finding {
  readonly file: string;
  readonly line: number;
  /** The rule's id, e.g. `no-only`. Stable, because people put them in commit messages. */
  readonly rule: string;
  readonly message: string;
  /** The offending source line, trimmed. */
  readonly source: string;
}

export interface Rule {
  readonly id: string;
  /** One line, in the imperative: what the rule requires. */
  readonly summary: string;
  /** Why it exists. Printed on failure, because the reason is what makes a rule stick. */
  readonly rationale: string;
}

/** Group findings by rule and print them with the rule's rationale. */
export function report(
  label: string,
  rules: readonly Rule[],
  findings: readonly Finding[],
): string {
  if (findings.length === 0) return `${label}: clean.\n`;

  const byRule = new Map<string, Finding[]>();
  for (const finding of findings) {
    const list = byRule.get(finding.rule) ?? [];
    list.push(finding);
    byRule.set(finding.rule, list);
  }

  const lines: string[] = [
    `${label}: ${String(findings.length)} problem(s) in ${String(byRule.size)} rule(s).`,
    '',
  ];
  for (const [id, group] of byRule) {
    const rule = rules.find((candidate) => candidate.id === id);
    lines.push(`${id} — ${rule?.summary ?? ''}`);
    for (const finding of group) {
      lines.push(`  ${finding.file}:${String(finding.line)}  ${finding.message}`);
      lines.push(`    │ ${finding.source}`);
    }
    if (rule !== undefined) lines.push(`  why: ${rule.rationale}`);
    lines.push('');
  }
  return lines.join('\n');
}
