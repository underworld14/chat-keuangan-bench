/**
 * generate-rupiah-pro-charts.ts — score + latency SVG charts from local leaderboard.
 *
 *   bun run scripts/generate-rupiah-pro-charts.ts
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { shortModelName } from "../src/core/model-roster.ts";
import { PALETTE, barChartSvg, chartEmbedMd } from "./lib/chart-svg.ts";

type LeaderboardPayload = {
  generatedAt?: string;
  version?: string;
  leaderboard: Array<{
    rank: number;
    modelId: string;
    score: number;
    sourcePath: string;
  }>;
};

type SuiteResult = {
  results: Array<{ ms?: number; error?: string | null }>;
};

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function suiteMeanMs(sourcePath: string): number {
  if (!existsSync(sourcePath)) return 0;
  const data = loadJson<SuiteResult>(sourcePath);
  const ms = data.results.filter((r) => !r.error).map((r) => r.ms ?? 0);
  if (!ms.length) return 0;
  return ms.reduce((a, b) => a + b, 0) / ms.length;
}

function main() {
  const root = resolve(import.meta.dirname, "..");
  const lbPath = resolve(root, "docs/results/agentic/rupiah-pro-leaderboard-latest.json");
  const outDir = resolve(root, "docs/charts/rupiah-pro");
  mkdirSync(outDir, { recursive: true });

  if (!existsSync(lbPath)) {
    console.warn(`Missing ${lbPath} — run bun run score:rupiah-pro after local agentic evals.`);
    writeFileSync(
      resolve(outDir, "README.md"),
      `# Rupiah-Pro charts\n\nNo leaderboard yet. Run local \`eval:agentic\` then \`score:rupiah-pro\`.\n`,
    );
    return;
  }

  const lb = loadJson<LeaderboardPayload>(lbPath);
  const rows = lb.leaderboard.map((r) => ({
    modelId: r.modelId,
    score: r.score,
    meanMs: suiteMeanMs(r.sourcePath),
  }));

  if (!rows.length) {
    console.warn("Leaderboard empty — nothing to chart.");
    return;
  }

  const byScore = [...rows].sort((a, b) => b.score - a.score);
  const byLatency = [...rows].sort((a, b) => a.meanMs - b.meanMs);

  const scoreChart = barChartSvg({
    title: "Rupiah-Pro public score (v1)",
    unit: "100 × (det/40)² × (ifBench/100) · higher is better",
    rows: byScore.map((r, i) => ({
      label: shortModelName(r.modelId),
      value: r.score,
      display: r.score.toFixed(1),
      color: PALETTE[i % PALETTE.length]!,
    })),
    maxValue: 100,
  });

  const latencyChart = barChartSvg({
    title: "Mean scenario latency",
    unit: "Milliseconds — lower is better · from local suite traces",
    rows: byLatency.map((r, i) => ({
      label: shortModelName(r.modelId),
      value: Math.max(r.meanMs, 1),
      display: r.meanMs > 0 ? `${Math.round(r.meanMs / 1000)}s` : "—",
      color: PALETTE[i % PALETTE.length]!,
    })),
  });

  writeFileSync(resolve(outDir, "score.svg"), scoreChart);
  writeFileSync(resolve(outDir, "latency.svg"), latencyChart);

  const generatedAt = new Date().toISOString();
  writeFileSync(
    resolve(outDir, "README.md"),
    [
      `# Rupiah-Pro charts`,
      ``,
      `Generated: ${generatedAt}`,
      ``,
      `Local OpenAI-compatible runs only (no cloud cost axis).`,
      ``,
      ...chartEmbedMd("./score.svg", "Public score"),
      ...chartEmbedMd("./latency.svg", "Mean scenario latency"),
      `## Table`,
      ``,
      `| Model | Score | Mean latency |`,
      `|-------|------:|-------------:|`,
      ...byScore.map(
        (r) =>
          `| \`${shortModelName(r.modelId)}\` | ${r.score} | ${r.meanMs > 0 ? `${Math.round(r.meanMs / 1000)}s` : "—"} |`,
      ),
      ``,
    ].join("\n"),
  );

  console.log(`Rupiah-Pro charts → ${outDir}/`);
}

main();
