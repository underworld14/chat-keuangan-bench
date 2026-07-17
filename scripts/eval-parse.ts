/**
 * eval-parse.ts — Run Parse base (28) then hard-25 sequentially per model.
 *
 *   bun run eval:parse -- --model <lm-studio-id>
 *   bun run eval:parse -- --model <id> --label my-run
 *   bun run eval:parse -- --models a,b
 *   bun run eval:parse -- --model <id> --score
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";

interface CliArgs {
  models: string[];
  label: string;
  score: boolean;
  baseUrl?: string;
  apiKey?: string;
  help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let model = process.env.EVAL_MODEL?.trim() || "";
  let models: string[] = [];
  let label = "eval-parse";
  let score = false;
  let baseUrl: string | undefined;
  let apiKey: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--model" && argv[i + 1]) model = argv[++i]!;
    else if (a === "--models" && argv[i + 1]) {
      models = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    } else if (a === "--label" && argv[i + 1]) label = argv[++i]!;
    else if (a === "--score") score = true;
    else if (a === "--base-url" && argv[i + 1]) baseUrl = argv[++i]!;
    else if (a === "--api-key" && argv[i + 1]) apiKey = argv[++i]!;
  }

  if (!models.length && model) models = [model];

  return { models, label, score, baseUrl, apiKey, help };
}

function runBun(scriptArgs: string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("bun", ["run", ...scriptArgs], {
      cwd: resolve(import.meta.dirname, ".."),
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise(code ?? 1));
  });
}

function forwardFlags(args: CliArgs): string[] {
  const out: string[] = [];
  if (args.baseUrl) out.push("--base-url", args.baseUrl);
  if (args.apiKey) out.push("--api-key", args.apiKey);
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`Usage:
  bun run eval:parse -- --model <lm-studio-id>
  bun run eval:parse -- --model <id> --label my-run
  bun run eval:parse -- --models a,b
  bun run eval:parse -- --model <id> --score

Runs base (28) then Parse-25 hard per model, sequentially.
Pass --score to refresh the Parse leaderboard + charts afterward.`);
    return;
  }

  if (!args.models.length) {
    console.error(
      "Pass --model <lm-studio-id> or --models a,b (or set EVAL_MODEL).",
    );
    process.exit(1);
  }

  const fwd = forwardFlags(args);
  console.log(`\n=== eval:parse — ${args.models.length} model(s) ===`);
  console.log(`Order per model: base (28) → hard-25\n`);

  for (const modelId of args.models) {
    console.log(`\n${"#".repeat(72)}`);
    console.log(`# MODEL: ${modelId}`);
    console.log(`${"#".repeat(72)}\n`);

    console.log(`--- [${modelId}] suite base ---`);
    const baseCode = await runBun([
      "src/core/eval-core.ts",
      "--model",
      modelId,
      "--suite",
      "base",
      ...fwd,
    ]);
    if (baseCode !== 0) {
      console.error(
        `\nBase suite failed for ${modelId} (exit ${baseCode}) — skipping hard-25.`,
      );
      process.exit(baseCode);
    }

    console.log(`\n--- [${modelId}] Parse-25 hard ---`);
    const hardCode = await runBun([
      "scripts/eval-hard-25-single.ts",
      "--model",
      modelId,
      "--label",
      args.label,
      ...fwd,
    ]);
    if (hardCode !== 0) {
      console.error(`\nHard-25 failed for ${modelId} (exit ${hardCode}).`);
      process.exit(hardCode);
    }

    console.log(`\n✓ [${modelId}] base + hard complete (label=${args.label})`);
  }

  if (args.score) {
    console.log(`\n--- score:parse ---`);
    const scoreCode = await runBun(["scripts/score-parse.ts"]);
    if (scoreCode !== 0) process.exit(scoreCode);
    const reportCode = await runBun(["scripts/generate-parse-charts.ts"]);
    if (reportCode !== 0) process.exit(reportCode);
  }

  console.log(`\n=== eval:parse done ===`);
  if (!args.score) {
    console.log(`Refresh the board with: bun run score:parse`);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
