/**
 * Printing, in the two shapes `09` §3.11.2 requires (`M3-T13`).
 *
 * | Stream | What goes there |
 * |---|---|
 * | **stdout** | the answer — human output, or exactly one JSON document under `--json` |
 * | **stderr** | progress, warnings, prompts |
 *
 * That split is the one thing in this module that other code depends on, and it is why there is a
 * module at all rather than `console.log` at each call site. A warning on stdout breaks
 * `comvivo keys status --json | jq`, and a script that worked yesterday starts failing on a line
 * that was only meant to be read by a person.
 *
 * ## `--json` prints exactly one document
 *
 * `{ ok, data?, error?: { code, message, hint } }`. One document, so a caller can `JSON.parse` the
 * whole of stdout without framing — which means a command cannot print JSON progressively, and the
 * printer enforces that by refusing a second write rather than by asking callers to remember.
 */
import { BRAND } from '@comvivo/shared';
import pc from 'picocolors';

/** `09` §3.11.2's `--json` envelope. */
export interface JsonEnvelope {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly hint?: string;
  };
}

/** The two writable streams, injected so a test reads strings instead of capturing a process. */
export interface Streams {
  readonly out: { write(chunk: string): void };
  readonly err: { write(chunk: string): void };
}

export interface PrinterOptions {
  readonly streams: Streams;
  /** `--json`: one document on stdout, no prompts, no spinners, no colour. */
  readonly json: boolean;
  /**
   * Whether to colour human output.
   *
   * Decided by the caller rather than here, because `09` §3.11.1 honours `NO_COLOR` **and**
   * `FORCE_COLOR`, and both are environment questions. `picocolors` already reads them; passing
   * the answer in keeps this module testable without touching `process.env`.
   */
  readonly colour: boolean;
  /**
   * Unicode symbols, or the ASCII fallback.
   *
   * `09` §3.11.1 names clack's `unicode` check. A Windows console in a legacy code page prints
   * `✔` as mojibake, and a tick that renders as garbage is worse than `OK`.
   */
  readonly unicode: boolean;
}

/** One row of the symbol set. */
interface Symbols {
  readonly ok: string;
  readonly warn: string;
  readonly fail: string;
  readonly info: string;
  readonly arrow: string;
}

/** The symbol set, with `09` §3.11.1's ASCII fallback. */
const SYMBOLS: Readonly<Record<'unicode' | 'ascii', Symbols>> = {
  unicode: { ok: '✔', warn: '▲', fail: '✖', info: '•', arrow: '→' },
  ascii: { ok: 'OK', warn: '!', fail: 'X', info: '-', arrow: '->' },
};

export class Printer {
  readonly #streams: Streams;
  readonly #json: boolean;
  readonly #colour: boolean;
  readonly #symbols: Symbols;
  #envelopeWritten = false;

  constructor(options: PrinterOptions) {
    this.#streams = options.streams;
    this.#json = options.json;
    this.#colour = options.colour;
    this.#symbols = options.unicode ? SYMBOLS.unicode : SYMBOLS.ascii;
  }

  get json(): boolean {
    return this.#json;
  }

  /** The answer. Suppressed under `--json`, where `envelope` is the only thing on stdout. */
  line(text: string): void {
    if (this.#json) return;
    this.#streams.out.write(`${text}\n`);
  }

  /** A labelled success line: `✔ Keys are healthy`. */
  ok(text: string): void {
    this.line(`${this.#paint(this.#symbols.ok, 'green')} ${text}`);
  }

  /** A failure line on **stdout**, because it is the command's answer rather than a warning. */
  fail(text: string): void {
    this.line(`${this.#paint(this.#symbols.fail, 'red')} ${text}`);
  }

  /** A detail line, indented under its heading. */
  detail(text: string): void {
    this.line(`  ${this.#paint(this.#symbols.info, 'dim')} ${text}`);
  }

  /** Progress and warnings, to **stderr**, so `--json` output stays parseable. */
  note(text: string): void {
    this.#streams.err.write(`${text}\n`);
  }

  warn(text: string): void {
    this.#streams.err.write(`${this.#paint(this.#symbols.warn, 'yellow')} ${text}\n`);
  }

  /**
   * The `--json` document. At most one, per `09` §3.11.2.
   *
   * Throws on a second call rather than printing a second document. A caller that framed its
   * output as two objects would produce stdout that `JSON.parse` rejects — and it would do it only
   * on the path that printed twice, which is the path nobody tried.
   */
  envelope(body: JsonEnvelope): void {
    if (!this.#json) return;
    if (this.#envelopeWritten) {
      throw new Error('a --json run printed two envelopes; 09 §3.11.2 allows exactly one');
    }
    this.#envelopeWritten = true;
    this.#streams.out.write(`${JSON.stringify(body)}\n`);
  }

  /**
   * An error, in whichever shape this run is using.
   *
   * Human output puts it on **stderr** with its hint — unlike `fail`, which is an answer the
   * command computed. A failure that stops the command is not the answer; it is the reason there
   * is none.
   */
  error(error: { readonly code: string; readonly message: string; readonly hint?: string }): void {
    if (this.#json) {
      this.envelope({
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.hint === undefined ? {} : { hint: error.hint }),
        },
      });
      return;
    }
    this.#streams.err.write(`${this.#paint(this.#symbols.fail, 'red')} ${error.message}\n`);
    if (error.hint !== undefined) {
      this.#streams.err.write(`  ${this.#symbols.arrow} ${error.hint}\n`);
    }
  }

  /**
   * `09` §3.11.2's cancel path.
   *
   * Takes the message rather than defaulting to one: the sentence is `copy/en.json`'s
   * `error.cancelled`, and a default here would be a second copy of it — which is the drift
   * `copy.test.ts` refuses.
   */
  cancelled(message: string): void {
    this.#streams.err.write(`${message}\n`);
  }

  #paint(text: string, colour: 'green' | 'red' | 'yellow' | 'dim'): string {
    if (!this.#colour) return text;
    switch (colour) {
      case 'green':
        return pc.green(text);
      case 'red':
        return pc.red(text);
      case 'yellow':
        return pc.yellow(text);
      case 'dim':
        return pc.dim(text);
    }
  }
}

/**
 * Whether this run may prompt (`09` §3.11.2).
 *
 * Four conditions, and all four have to be false for a prompt to be allowed: no TTY on stdin,
 * `--non-interactive`, `CI=true`, or `--json`. Written as one function because the cost of
 * getting it wrong is a command that hangs forever waiting for input in a CI job — which is a
 * failure that looks like a timeout and takes an afternoon to attribute.
 */
export function canPrompt(options: {
  readonly isTty: boolean;
  readonly nonInteractive: boolean;
  readonly ci: boolean;
  readonly json: boolean;
}): boolean {
  return options.isTty && !options.nonInteractive && !options.ci && !options.json;
}

/** `09` §3.11.2's version-skew warning, which names the CLI to run instead. */
export function versionSkewWarning(cli: string, server: string): string {
  return (
    `This CLI is ${cli}; the server is ${server}. ` +
    `Use npx ${BRAND.npmCliPackage}@${server} to match it.`
  );
}
