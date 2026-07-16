/**
 * Rupiah-Pro public scoreboard (v1) — offline rescore, no agent/judge re-runs.
 *
 * Public formula (per scenario):
 *   score = 100 × (det/40)² × (ifBench/100)
 *
 * Headline suite: 14 discriminative scenarios (models still separate).
 * Raw run traces still store legacy components (det/rub/step/if) for audit.
 *
 *   bun run score:rupiah-pro
 *   bun run score:rupiah-pro -- --suite all
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

export const BENCH_NAME = "Rupiah-Pro";
export const BENCH_VERSION = "1.0.0";

type SuiteResult = {
  summary: {
    modelId: string;
    avgScore?: number;
    scenarioCount?: number;
    errors?: number;
    [k: string]: unknown;
  };
  results: Array<{
    scenarioId: string;
    tier?: string;
    totalScore: number;
    deterministic: { score: number; passed?: number; total?: number } | number;
    rubricScore: number;
    stepScore: number;
    ifBench: { score: number } | number;
    error?: string | null;
    ms?: number;
  }>;
};

/** Discover local agentic suite JSON traces (newest first per modelId). */
function discoverSuiteReports(): Array<{ label: string; path: string }> {
  const dir = resolve(import.meta.dirname, "../docs/results/agentic");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith("-agentic-suite.json"))
    .map((f) => join(dir, f))
    .sort()
    .reverse();
  const byModel = new Map<string, string>();
  for (const path of files) {
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as SuiteResult;
      const modelId = data.summary?.modelId;
      if (!modelId || byModel.has(modelId)) continue;
      byModel.set(modelId, path);
    } catch {
      /* skip malformed */
    }
  }
  return [...byModel.entries()].map(([label, path]) => ({ label, path }));
}

/** Public v1 headline set — scenarios that still separate models. */
export const DISCRIMINATIVE_IDS = [
  "h-weekend-voice-mess",
  "h-patungan-then-koreksi-share",
  "h-dobel-bensin-frustasi",
  "h-slang-plus-titik-bleed",
  "h-daily-export-pdf-pack",
  "h-slang-gopek-meja-bleed",
  "h-patungan-3way-tip-trap",
  "h-batal-then-pilih-satu-nota",
  "h-td-kemarin-koreksi-slang",
  "h-spike-void-then-real",
  "hp-switch-org-midchat",
  "hp-contaminated-refund-plus-mutasi",
  "hp-auditor-pdf-csv-nota",
  "hp-double-post-rage-dedupe",
] as const;

export const CULLED_EASY_IDS = [
  "h-mutasi-bca-selective",
  "h-pdf-rekening-admin-warung",
  "h-spbu-ocr-export-verify",
  "h-export-out-only-pdf-net-trap",
  "h-refund-chargeback-slang-mix",
  "hp-frustration-mom-spend",
  "hp-sekolah-vs-yayasan-reclass",
  "h-indomaret-ocr-pipeline",
  "h-dedupe-same-amount-beda-hari",
  "hp-yayasan-import-filter-org-hint",
  "h-reconcile-mutasi-vs-nota-indomaret",
  "h-conflict-ambigu-then-export",
  "h-voice-qty-juta-cancel-chain",
  "hp-contaminated-qty-rage-fix",
] as const;

function detScore(r: SuiteResult["results"][number]): number {
  if (typeof r.deterministic === "number") return r.deterministic;
  return r.deterministic.score;
}

function ifScore(r: SuiteResult["results"][number]): number {
  if (typeof r.ifBench === "number") return r.ifBench;
  return r.ifBench.score;
}

/** Rupiah-Pro public v1 per-scenario score 0–100 */
export function scoreRupiahPro(r: SuiteResult["results"][number]): number {
  const d = detScore(r) / 40;
  const ib = ifScore(r) / 100;
  return Math.round(100 * d * d * ib * 10) / 10;
}

/** @deprecated alias */
export const scoreV2 = scoreRupiahPro;

function parseArgs(argv: string[]) {
  let suite: "discriminative" | "all" = "discriminative";
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--suite" && argv[i + 1]) {
      const v = argv[++i]!;
      if (v === "all" || v === "discriminative") suite = v;
    }
  }
  return { suite };
}

function load(path: string): SuiteResult {
  return JSON.parse(readFileSync(resolve(path), "utf8")) as SuiteResult;
}

function main() {
  const { suite } = parseArgs(process.argv);
  const outDir = resolve(import.meta.dirname, "../docs/results/agentic");
  mkdirSync(outDir, { recursive: true });

  const idFilter =
    suite === "discriminative"
      ? new Set<string>(DISCRIMINATIVE_IDS)
      : null;

  const models: Array<{
    modelId: string;
    sourcePath: string;
    n: number;
    errorsSkipped: number;
    avgLegacy: number;
    avg: number;
    min: number;
    max: number;
    below60: number;
    below80: number;
    perfect100: number;
    perScenario: Array<{
      scenarioId: string;
      tier?: string;
      legacy: number;
      score: number;
      det: number;
      rub: number;
      step: number;
      ifBench: number;
    }>;
  }> = [];

  const reports = discoverSuiteReports();
  if (!reports.length) {
    console.warn(
      "No *-agentic-suite.json found under docs/results/agentic. Run eval:agentic first.",
    );
  }

  for (const rep of reports) {
    if (!existsSync(resolve(rep.path))) {
      console.warn(`skip missing ${rep.path}`);
      continue;
    }
    const data = load(rep.path);
    const modelId = data.summary.modelId || rep.label;
    let rows = data.results.filter((r) => !r.error);
    const errorsSkipped = data.results.length - rows.length;
    if (idFilter) rows = rows.filter((r) => idFilter.has(r.scenarioId));

    const perScenario = rows.map((r) => ({
      scenarioId: r.scenarioId,
      tier: r.tier,
      legacy: r.totalScore,
      score: scoreRupiahPro(r),
      det: detScore(r),
      rub: r.rubricScore,
      step: r.stepScore,
      ifBench: ifScore(r),
    }));

    const scores = perScenario.map((p) => p.score);
    const legacies = perScenario.map((p) => p.legacy);
    const avg = (xs: number[]) =>
      xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);

    models.push({
      modelId,
      sourcePath: resolve(rep.path),
      n: perScenario.length,
      errorsSkipped,
      avgLegacy: Math.round(avg(legacies) * 10) / 10,
      avg: Math.round(avg(scores) * 10) / 10,
      min: Math.min(...scores),
      max: Math.max(...scores),
      below60: scores.filter((s) => s < 60).length,
      below80: scores.filter((s) => s < 80).length,
      perfect100: scores.filter((s) => s >= 99.5).length,
      perScenario,
    });
  }

  models.sort((a, b) => b.avg - a.avg);

  if (models.length === 0) {
    console.log(
      `No local *-agentic-suite.json traces under docs/results/agentic — skip leaderboard write.`,
    );
    return;
  }

  const avgs = models.map((m) => m.avg);
  const spread = Math.max(...avgs) - Math.min(...avgs);

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const payload = {
    bench: BENCH_NAME,
    version: BENCH_VERSION,
    generatedAt: new Date().toISOString(),
    suite,
    formula: {
      perScenario: "100 * (det/40)^2 * (ifBench/100)",
      droppedFromPublicScore: ["rubric", "step"],
      rationale:
        "Public v1. Legacy raw runs used det40+rub25+step25+if10 and compressed models into ~89–98. Squared det + ifBench multiplier on discriminative scenarios opens ranking spread without re-running agents.",
    },
    discriminativeIds: [...DISCRIMINATIVE_IDS],
    culledEasyIds: [...CULLED_EASY_IDS],
    spread,
    leaderboard: models.map((m, i) => ({
      rank: i + 1,
      modelId: m.modelId,
      score: m.avg,
      legacyRawAvg: m.avgLegacy,
      delta: Math.round((m.avg - m.avgLegacy) * 10) / 10,
      n: m.n,
      min: m.min,
      max: m.max,
      below60: m.below60,
      below80: m.below80,
      perfect100: m.perfect100,
      sourcePath: m.sourcePath,
    })),
    models,
  };

  const jsonPath = resolve(outDir, `${stamp}-rupiah-pro-leaderboard.json`);
  const mdPath = resolve(outDir, `${stamp}-rupiah-pro-leaderboard.md`);
  const latestJson = resolve(outDir, "rupiah-pro-leaderboard-latest.json");
  const latestMd = resolve(outDir, "rupiah-pro-leaderboard-latest.md");

  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  writeFileSync(latestJson, JSON.stringify(payload, null, 2));

  const md = [
    `# ${BENCH_NAME} Leaderboard (v${BENCH_VERSION})`,
    ``,
    `Generated: ${payload.generatedAt}`,
    ``,
    `Multi-turn Indonesian **pencatatan keuangan** agent bench — tools, ledger asserts, org isolation, OCR/mutasi/auditor flows.`,
    ``,
    `## Public score (v1)`,
    ``,
    `\`${payload.formula.perScenario}\``,
    ``,
    `- Headline suite: **${DISCRIMINATIVE_IDS.length} discriminative scenarios**`,
    `- Rubric + step collected at run time for audit, **not** in the public average`,
    `- Offline rescore from existing traces — no re-run required`,
    ``,
    `## Leaderboard`,
    ``,
    `| Rank | Model | ${BENCH_NAME} | Legacy raw* | Δ | n | min | <60 | <80 | =100 |`,
    `|-----:|-------|-------------:|------------:|--:|--:|----:|---:|---:|-----:|`,
    ...payload.leaderboard.map(
      (r) =>
        `| ${r.rank} | \`${r.modelId}\` | **${r.score}** | ${r.legacyRawAvg} | ${r.delta} | ${r.n} | ${r.min} | ${r.below60} | ${r.below80} | ${r.perfect100} |`,
    ),
    ``,
    `*Legacy raw* = old det40+rub25+step25+if10 average on the same ${suite === "discriminative" ? "14" : "all"} scenarios (audit only).`,
    ``,
    `**Spread (max−min):** ${spread.toFixed(1)} points.`,
    ``,
    `## Scenario set`,
    ``,
    ...DISCRIMINATIVE_IDS.map((id) => `- \`${id}\``),
    ``,
    `## Per-model detail`,
    ``,
  ];

  for (const m of models) {
    md.push(`### \`${m.modelId}\` — **${m.avg}**`, ``);
    md.push(
      `| Scenario | ${BENCH_NAME} | Legacy | Det/40 | IF |`,
      `|----------|-------------:|-------:|-------:|---:|`,
    );
    for (const p of [...m.perScenario].sort((a, b) => a.score - b.score)) {
      md.push(
        `| ${p.scenarioId} | ${p.score} | ${p.legacy} | ${p.det} | ${p.ifBench} |`,
      );
    }
    md.push(``);
  }

  writeFileSync(mdPath, md.join("\n"));
  writeFileSync(latestMd, md.join("\n"));

  // Keep old filenames as pointers for a transition period
  writeFileSync(
    resolve(outDir, "agentic-v2-leaderboard-latest.md"),
    [
      `# Moved → Rupiah-Pro`,
      ``,
      `This file was the temporary “agentic v2” scoreboard.`,
      `It is now **${BENCH_NAME} public v${BENCH_VERSION}**.`,
      ``,
      `See: [rupiah-pro-leaderboard-latest.md](./rupiah-pro-leaderboard-latest.md)`,
      ``,
    ].join("\n"),
  );

  console.log("═══════════════════════════════════════════════════");
  console.log(`${BENCH_NAME} v${BENCH_VERSION} — suite=${suite}`);
  console.log(`formula: ${payload.formula.perScenario}`);
  console.log(`spread: ${spread.toFixed(1)}`);
  console.log("───────────────────────────────────────────────────");
  for (const r of payload.leaderboard) {
    console.log(
      `  #${r.rank}  ${String(r.score).padStart(5)}  ${r.modelId}`,
    );
  }
  console.log("───────────────────────────────────────────────────");
  console.log(`JSON: ${jsonPath}`);
  console.log(`MD:   ${mdPath}`);
  console.log(`latest → ${latestMd}`);
  console.log("Done.");
}

main();
