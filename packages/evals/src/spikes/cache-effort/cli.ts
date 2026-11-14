/**
 * `pnpm --filter @comvivo/evals spike:cache-effort` — SP-4/SP-5's offline simulation (`M2-T20`).
 *
 * Exits 0 whatever it finds: this is a measurement, not a gate. A spike that failed CI because an
 * arm won would make the next person pick the arm that keeps CI green.
 */
import { render, runSpike } from './report.js';

async function main(): Promise<void> {
  process.stdout.write(render(await runSpike()));
}

await main();
