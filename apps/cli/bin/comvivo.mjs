#!/usr/bin/env node
/**
 * The `comvivo` entry point (`09` §3.11.1; `M3-T13`).
 *
 * **Nothing above the version check may be newer than the oldest runtime that can reach it, and
 * nothing above it may be an import.** That is the whole reason this file is not TypeScript and
 * not part of the build: a host on Node 18 who runs `npx comvivo` must get a sentence telling them
 * which version to install, and a `SyntaxError` with a stack trace instead is the one outcome that
 * leaves them with nothing to do. The thing most likely to be out of date is the runtime, so the
 * check that catches it cannot depend on it.
 *
 * In practice that means **ES2019** above the check: `var`, `function`, `parseInt`, string
 * concatenation. Optional chaining and `??` are ES2020 (Node 14) and would in fact parse on every
 * runtime that can load an `.mjs` at all, which is why they appear **below** the dynamic import —
 * and why the earlier version of this note, which banned them outright, was stricter than the
 * reason for it. Top-level `await` is the one to keep out either way: it is ES2022, and a module
 * that uses it is re-parsed in a mode older Node refuses.
 *
 * `09` §3.11.1 sets the floor at 22.12 for the CLI, which is lower than the **server**'s
 * (≥ 24.11, with Node 26 LTS primary, `01` §14 A1). The two differ deliberately: a host whose Node
 * is too old for the server should still be able to run `comvivo doctor` and be told so.
 *
 * Checked by `shim.test.ts`, which parses this file and asserts both halves of the rule.
 */

var MINIMUM = [22, 12];
var parts = process.versions.node.split('.');
var major = parseInt(parts[0], 10);
var minor = parseInt(parts[1], 10);

if (major < MINIMUM[0] || (major === MINIMUM[0] && minor < MINIMUM[1])) {
  process.stderr.write(
    'Comvivo needs Node.js ' +
      MINIMUM.join('.') +
      ' or newer (you have ' +
      process.versions.node +
      ').\n' +
      'Install it from https://nodejs.org or use Docker:\n' +
      '  https://faizannraza.github.io/comvivo/docs/install/docker\n',
  );
  // 78 — `12` §4.2's "configuration": a human has to change something before another start can
  // work. Not 2: this is not a usage error, and an orchestrator that retried it would loop.
  process.exit(78);
}

// `createRequire` rather than a bare `require`: this file is `.mjs`, so there is no CJS `require`
// in scope — and `import … with { type: 'json' }` is the other option, which is syntax Node 18
// cannot parse, which is the one thing this file exists to avoid. The import is below the version
// check, so it never runs on a runtime too old for it.
Promise.all([import('../dist/main.js'), import('node:module'), import('picocolors')])
  .then((loaded) => {
    var module = loaded[0];
    var pkg = loaded[1].createRequire(import.meta.url)('../package.json');
    return module.run({
      argv: process.argv.slice(2),
      environment: { env: process.env, cwd: process.cwd(), isTty: Boolean(process.stdin.isTTY) },
      streams: { out: process.stdout, err: process.stderr },
      input: process.stdin,
      version: pkg.version,
      colour: loaded[2].default.isColorSupported,
      // `09` §3.11.1's ASCII fallback. A Windows console in a legacy code page renders `✔` as
      // mojibake, and the `WT_SESSION`/`TERM_PROGRAM` pair is what clack's own check reads.
      unicode:
        process.platform !== 'win32' ||
        Boolean(process.env.WT_SESSION) ||
        process.env.TERM_PROGRAM === 'vscode',
    });
  })
  .then((code) => {
    // `exitCode` rather than `exit`: `process.exit` truncates a pending write, which for a
    // `--json` run on a pipe means half a document. Setting the code lets Node drain first.
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${String(error?.stack ?? error)}\n`);
    process.exitCode = 1;
  });
