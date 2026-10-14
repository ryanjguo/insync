import { IN_SYNC_MS, runScenario, type Disruption } from "./run";
import type { Scenario } from "./scenarios";
import { percentile } from "./stats";

export interface ScenarioReport {
  scenario: Scenario;
  runs: number;
  /** Drift while settled (outside the catch-up after a play, seek or stall), ms. */
  p50: number;
  p95: number;
  max: number;
  /** p95 over every sample, catch-ups included, ms. */
  p95All: number;
  /** Share of all samples within 100 ms, 0-1. */
  within: number;
  /** Convergence after seeks, ms. */
  seekConvergeP50: number;
  seekConvergeMax: number;
  /** Seeks the room never converged after before the next one. */
  seeksUnconverged: number;
  seeks: number;
  /** Time from the end of a stall until the room was back in sync, ms (NaN: never). */
  stallRecoveryMs: number[];
}

/** Run a scenario with several seeds and pool the results. */
export function measure(
  scenario: Scenario,
  seeds: number[],
  durationMs: number,
): ScenarioReport {
  const drift: number[] = [];
  const settled: number[] = [];
  const disruptions: Disruption[] = [];
  for (const seed of seeds) {
    const r = runScenario(scenario, { seed, durationMs });
    drift.push(...r.drift);
    settled.push(...r.settledDrift);
    disruptions.push(...r.disruptions);
  }
  const seeks = disruptions.filter((d) => d.kind === "seek");
  const converged = seeks.flatMap((d) =>
    d.convergeMs === null ? [] : [d.convergeMs],
  );
  return {
    scenario,
    runs: seeds.length,
    p50: percentile(settled, 50),
    p95: percentile(settled, 95),
    max: settled.reduce((a, b) => Math.max(a, b), -Infinity),
    p95All: percentile(drift, 95),
    within: drift.filter((d) => d < IN_SYNC_MS).length / drift.length,
    seekConvergeP50: percentile(converged, 50),
    seekConvergeMax: converged.length > 0 ? Math.max(...converged) : NaN,
    seeksUnconverged: seeks.length - converged.length,
    seeks: seeks.length,
    stallRecoveryMs: disruptions
      .filter((d) => d.kind === "stall")
      .map((d) => (d.convergeMs ?? NaN) - (scenario.stall?.forMs ?? 0)),
  };
}

const ms = (v: number) => (Number.isFinite(v) ? `${Math.round(v)} ms` : "–");
const sec = (v: number) =>
  Number.isFinite(v) ? `${(v / 1000).toFixed(1)} s` : "–";

/** The results as a Markdown table. */
export function table(reports: ScenarioReport[]): string {
  const rows = reports.map((r) => {
    const unconverged =
      r.seeksUnconverged > 0
        ? ` (${r.seeksUnconverged} of ${r.seeks} never settled)`
        : "";
    return (
      `| ${r.scenario.name} | ${ms(r.p50)} | ${ms(r.p95)} | ${ms(r.max)} | ` +
      `${ms(r.p95All)} | ${(r.within * 100).toFixed(1)}% | ` +
      `${sec(r.seekConvergeP50)} / ${sec(r.seekConvergeMax)}${unconverged} |`
    );
  });
  return [
    "| Scenario | Drift p50 | Drift p95 | Drift max | p95 incl. catch-up | Time within 100 ms | Converge after seek (median / max) |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}
