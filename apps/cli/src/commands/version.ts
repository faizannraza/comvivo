/**
 * `comvivo version` (`09` §3.11.3; `M3-T13`).
 *
 * Separate from commander's `--version`, and both exist on purpose. `--version` prints the string
 * and nothing else, which is what a packaging script wants. This prints the string **plus the
 * runtime it is on**, which is what a bug report wants — and `--json` makes it machine-readable,
 * so `comvivo doctor --bundle` and an issue template can both use it.
 */
import { Command } from '@commander-js/extra-typings';
import { copy } from '../copy.js';
import type { CommandDeps } from '../deps.js';

export function versionCommand(deps: CommandDeps, version: string): Command {
  return new Command('version')
    .description(copy('version.description'))
    .helpGroup('Advanced')
    .action(() => {
      const printer = deps.printer();
      const data = {
        version,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
      };
      printer.envelope({ ok: true, data });
      printer.line(copy('version.line', { version }));
      printer.detail(
        copy('version.runtime', {
          node: data.node,
          platform: data.platform,
          arch: data.arch,
        }),
      );
    });
}
