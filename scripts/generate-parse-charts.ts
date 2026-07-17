/**
 * generate-parse-charts.ts — bar charts from Parse leaderboard.
 *
 *   bun run scripts/generate-parse-charts.ts
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { shortModelName } from "../src/core/model-roster.ts";
import { PALETTE, barChartSvg, chartEmbedMd } from "./lib/chart-svg.ts";
import type { ParseLeaderboardRow } from "./lib/parse-scorecard.ts";

type LeaderboardPayload = {
  generatedAt?: string;
  version?: string;
  leaderboard: ParseLeaderboardRow[];
};

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function main() {
  const root = resolve(import.meta.dirname, "..");
  const lbPath = resolve(root, "docs/results/parse/parse-leaderboard-latest.json");
  const outDir = resolve(root, "docs/charts/parse");
  mkdirSync(outDir, { recursive: true });

  if (!existsSync(lbPath)) {
    console.warn(`Missing ${lbPath} — run bun run score:parse after eval:parse.`);
    writeFileSync(
      resolve(outDir, "README.md"),
      `# Parse charts\n\nNo leaderboard yet. Run \`bun run eval:parse\` then \`bun run score:parse\`.\n`,
    );
    return;
  }

  const lb = loadJson<LeaderboardPayload>(lbPath);
  const rows = lb.leaderboard;
  if (!rows.length) {
    console.warn("Leaderboard empty — nothing to chart.");
    return;
  }

  const withBase = rows.filter((r) => r.basePass != null);
  const withHard = rows.filter((r) => r.hardStrict != null);
  const withComposite = rows.filter((r) => r.hardComposite != null);
  const withHardLat = rows.filter((r) => r.hardMeanMs != null && r.hardMeanMs > 0);

  const baseChart = barChartSvg({
    title: "Parse base — strict pass",
    unit: "Pass / 28 everyday scenarios · higher is better",
    rows: [...withBase]
      .sort((a, b) => (b.basePass ?? 0) - (a.basePass ?? 0))
      .map((r, i) => ({
        label: shortModelName(r.modelId),
        value: r.basePass ?? 0,
        display: `${r.basePass}/${r.baseTotal}`,
        color: PALETTE[i % PALETTE.length]!,
      })),
    maxValue: 28,
  });

  const hardStrictChart = barChartSvg({
    title: "Parse-25 — strict pass",
    unit: "Pass / 25 adversarial scenarios · higher is better",
    rows: [...withHard]
      .sort((a, b) => (b.hardStrict ?? 0) - (a.hardStrict ?? 0))
      .map((r, i) => ({
        label: shortModelName(r.modelId),
        value: r.hardStrict ?? 0,
        display: `${r.hardStrict}/${r.hardTotal}`,
        color: PALETTE[i % PALETTE.length]!,
      })),
    maxValue: 25,
  });

  const hardCompositeChart = barChartSvg({
    title: "Parse-25 — mean composite",
    unit: "Quality composite 0–100 · higher is better",
    rows: [...withComposite]
      .sort((a, b) => (b.hardComposite ?? 0) - (a.hardComposite ?? 0))
      .map((r, i) => ({
        label: shortModelName(r.modelId),
        value: r.hardComposite ?? 0,
        display: (r.hardComposite ?? 0).toFixed(1),
        color: PALETTE[i % PALETTE.length]!,
      })),
    maxValue: 100,
  });

  const hardLatencyChart = barChartSvg({
    title: "Parse-25 — mean latency",
    unit: "Milliseconds — lower is better",
    rows: [...withHardLat]
      .sort((a, b) => (a.hardMeanMs ?? 0) - (b.hardMeanMs ?? 0))
      .map((r, i) => ({
        label: shortModelName(r.modelId),
        value: Math.max(r.hardMeanMs ?? 1, 1),
        display:
          (r.hardMeanMs ?? 0) >= 1000
            ? `${((r.hardMeanMs ?? 0) / 1000).toFixed(1)}s`
            : `${Math.round(r.hardMeanMs ?? 0)}ms`,
        color: PALETTE[i % PALETTE.length]!,
      })),
  });

  if (withBase.length) writeFileSync(resolve(outDir, "base-pass.svg"), baseChart);
  if (withHard.length) writeFileSync(resolve(outDir, "hard-strict.svg"), hardStrictChart);
  if (withComposite.length) {
    writeFileSync(resolve(outDir, "hard-composite.svg"), hardCompositeChart);
  }
  if (withHardLat.length) writeFileSync(resolve(outDir, "hard-latency.svg"), hardLatencyChart);

  const generatedAt = new Date().toISOString();
  const embed: string[] = [];
  if (withBase.length) embed.push(...chartEmbedMd("./base-pass.svg", "Base strict pass"));
  if (withHard.length) embed.push(...chartEmbedMd("./hard-strict.svg", "Hard-25 strict pass"));
  if (withComposite.length) {
    embed.push(...chartEmbedMd("./hard-composite.svg", "Hard-25 mean composite"));
  }
  if (withHardLat.length) {
    embed.push(...chartEmbedMd("./hard-latency.svg", "Hard-25 mean latency"));
  }

  writeFileSync(
    resolve(outDir, "README.md"),
    [
      `# Parse charts`,
      ``,
      `Generated: ${generatedAt}`,
      ``,
      `Local OpenAI-compatible runs only. Board: \`docs/results/parse/parse-leaderboard-latest.md\`.`,
      ``,
      ...embed,
      `## Table`,
      ``,
      `| Model | Base | Hard strict | Hard composite | Hard latency |`,
      `|-------|-----:|------------:|---------------:|-------------:|`,
      ...rows.map((r) => {
        const base =
          r.basePass != null && r.baseTotal != null ? `${r.basePass}/${r.baseTotal}` : "—";
        const hard =
          r.hardStrict != null && r.hardTotal != null
            ? `${r.hardStrict}/${r.hardTotal}`
            : "—";
        const comp = r.hardComposite != null ? r.hardComposite.toFixed(1) : "—";
        const lat =
          r.hardMeanMs != null && r.hardMeanMs > 0
            ? r.hardMeanMs >= 1000
              ? `${(r.hardMeanMs / 1000).toFixed(1)}s`
              : `${Math.round(r.hardMeanMs)}ms`
            : "—";
        return `| \`${shortModelName(r.modelId)}\` | ${base} | ${hard} | ${comp} | ${lat} |`;
      }),
      ``,
    ].join("\n"),
  );

  console.log(`Parse charts → ${outDir}/`);
}

main();
