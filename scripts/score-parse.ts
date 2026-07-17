/**
 * Parse public scoreboard (v1) — offline merge of base + hard-25 run artifacts.
 *
 *   bun run score:parse
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  PARSE_BENCH_NAME,
  PARSE_BENCH_VERSION,
  discoverParseRuns,
  mergeParseLeaderboard,
} from "./lib/parse-scorecard.ts";

function main() {
  const root = resolve(import.meta.dirname, "..");
  const runsDir = resolve(root, "docs/results/runs");
  const outDir = resolve(root, "docs/results/parse");
  mkdirSync(outDir, { recursive: true });

  const { base, hard } = discoverParseRuns(runsDir);
  const leaderboard = mergeParseLeaderboard(base, hard);

  if (!leaderboard.length) {
    console.log(
      `No parse-base / parse-hard-25 artifacts under docs/results/runs — skip leaderboard write.`,
    );
    console.log(`Run: bun run eval:parse -- --model <lm-studio-id>`);
    return;
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const generatedAt = new Date().toISOString();
  const payload = {
    bench: PARSE_BENCH_NAME,
    version: PARSE_BENCH_VERSION,
    generatedAt,
    ranking: "hardStrict desc → hardComposite desc → basePass desc → latency asc",
    metrics: {
      base: "strict pass / 28 everyday scenarios",
      hardStrict: "strict pass / 25 Parse-25 scenarios",
      hardComposite: "mean quality composite 0–100 from hard-25 harness",
    },
    leaderboard,
  };

  const jsonPath = resolve(outDir, `${stamp}-parse-leaderboard.json`);
  const mdPath = resolve(outDir, `${stamp}-parse-leaderboard.md`);
  const latestJson = resolve(outDir, "parse-leaderboard-latest.json");
  const latestMd = resolve(outDir, "parse-leaderboard-latest.md");

  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  writeFileSync(latestJson, JSON.stringify(payload, null, 2));

  const fmt = (n: number | null, digits = 0) =>
    n == null ? "—" : digits ? n.toFixed(digits) : String(n);
  const frac = (pass: number | null, total: number | null) =>
    pass == null || total == null ? "—" : `${pass}/${total}`;

  const md = [
    `# ${PARSE_BENCH_NAME} Leaderboard (v${PARSE_BENCH_VERSION})`,
    ``,
    `Generated: ${generatedAt}`,
    ``,
    `Single-turn Indonesian finance-chat parse — **base (28)** + **Parse-25 hard**.`,
    `Metrics are separate columns (not blended into one score).`,
    ``,
    `Ranking: \`${payload.ranking}\``,
    ``,
    `## Leaderboard`,
    ``,
    `| Rank | Model | Base | Hard strict | Hard composite | Base ms | Hard ms |`,
    `|-----:|-------|-----:|------------:|---------------:|--------:|--------:|`,
    ...leaderboard.map(
      (r) =>
        `| ${r.rank} | \`${r.modelId}\` | ${frac(r.basePass, r.baseTotal)} | ${frac(r.hardStrict, r.hardTotal)} | ${fmt(r.hardComposite, 1)} | ${fmt(r.baseMeanMs != null ? Math.round(r.baseMeanMs) : null)} | ${fmt(r.hardMeanMs != null ? Math.round(r.hardMeanMs) : null)} |`,
    ),
    ``,
    `## Sources`,
    ``,
    ...leaderboard.map((r) => {
      const parts = [`### \`${r.modelId}\``];
      if (r.baseSourcePath) parts.push(`- Base: \`${r.baseSourcePath}\``);
      if (r.hardSourcePath) parts.push(`- Hard: \`${r.hardSourcePath}\``);
      parts.push("");
      return parts.join("\n");
    }),
  ];

  writeFileSync(mdPath, md.join("\n"));
  writeFileSync(latestMd, md.join("\n"));

  // Placeholder README if missing
  const readme = resolve(outDir, "README.md");
  if (!existsSync(readme)) {
    writeFileSync(
      readme,
      [
        `# Parse leaderboard`,
        ``,
        `Offline board from local \`docs/results/runs/\` artifacts.`,
        ``,
        `\`\`\`bash`,
        `bun run eval:parse -- --model <lm-studio-id>`,
        `bun run score:parse`,
        `\`\`\``,
        ``,
        `Latest: [parse-leaderboard-latest.md](./parse-leaderboard-latest.md)`,
        ``,
      ].join("\n"),
    );
  }

  console.log("═══════════════════════════════════════════════════");
  console.log(`${PARSE_BENCH_NAME} v${PARSE_BENCH_VERSION}`);
  console.log(`ranking: ${payload.ranking}`);
  console.log("───────────────────────────────────────────────────");
  for (const r of leaderboard) {
    console.log(
      `  #${r.rank}  base=${frac(r.basePass, r.baseTotal).padEnd(6)}  hard=${frac(r.hardStrict, r.hardTotal).padEnd(6)}  composite=${fmt(r.hardComposite, 1).padStart(5)}  ${r.modelId}`,
    );
  }
  console.log("───────────────────────────────────────────────────");
  console.log(`JSON: ${jsonPath}`);
  console.log(`MD:   ${mdPath}`);
  console.log(`latest → ${latestMd}`);
}

main();
