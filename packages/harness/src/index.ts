import { readFileSync, writeFileSync } from "node:fs";
import { measure, table } from "./report";
import { scenarios } from "./scenarios";

// Runs the plan's scenarios against the extension's real sync code on a
// simulated network and prints a drift table. `--write <file>` also puts it
// in that file, between the results markers.

const SEEDS = [1, 2, 3, 4, 5];
const DURATION_MS = 10 * 60_000;
const START = "<!-- results:start -->";
const END = "<!-- results:end -->";

const reports = scenarios.map((s) => measure(s, SEEDS, DURATION_MS));
const lines = [table(reports)];
for (const r of reports) {
  if (r.stallRecoveryMs.length === 0) continue;
  const each = r.stallRecoveryMs
    .map((ms) =>
      Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : "never",
    )
    .join(", ");
  lines.push(
    "",
    `${r.scenario.name}, back in sync after the stall ended: ${each}.`,
  );
}
const out = lines.join("\n");
console.log(out);

const at = process.argv.indexOf("--write");
if (at !== -1) {
  const file = process.argv[at + 1];
  if (!file) throw new Error("--write needs a file name");
  const doc = readFileSync(file, "utf8");
  const from = doc.indexOf(START);
  const to = doc.indexOf(END);
  if (from === -1 || to < from)
    throw new Error(`${file} needs ${START} and ${END} markers`);
  writeFileSync(
    file,
    doc.slice(0, from + START.length) + "\n\n" + out + "\n\n" + doc.slice(to),
  );
  console.log(`wrote ${file}`);
}
