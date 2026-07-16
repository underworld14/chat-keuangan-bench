/**
 * eval-agentic-hard-20.ts — Multi-turn agentic finance bench (local OpenAI-compatible).
 *
 * Suites:
 *   --suite hard      (20 classic)
 *   --suite hardplus  (8 multi-tenant / contamination / auditor / analysis)
 *   --suite all       (default: 28)
 *
 *   bun run scripts/eval-agentic-hard-20.ts --model qwen2.5-7b-instruct --suite hardplus
 *   bun run scripts/eval-agentic-hard-20.ts --dry-run --suite all
 *   bun run scripts/eval-agentic-hard-20.ts --model local-model --concurrency 1 --skip-judge
 */

import { runAgenticSuite, writeAgenticReport } from "../src/agentic/runner";
import type { AgenticSampling } from "../src/agentic/agent";
import {
  applyLlmConfigOverrides,
  getLlmConfig,
} from "../src/core/llm-client";

const SAMPLING_PRESETS: Record<string, AgenticSampling> = {
  det0: { temperature: 0 },
  mild: { temperature: 0.3, top_p: 0.9 },
};

function parseArgs(argv: string[]) {
  let model = process.env.EVAL_MODEL?.trim() || "local-model";
  let limit: number | undefined;
  let dryRun = false;
  let skipJudge = false;
  let suite: "hard" | "hardplus" | "all" = "all";
  let concurrency = 4;
  let samplingPreset: string | undefined;
  let baseUrl: string | undefined;
  let apiKey: string | undefined;
  const ids: string[] = [];

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model" && argv[i + 1]) model = argv[++i]!;
    else if (a === "--limit" && argv[i + 1]) limit = Number(argv[++i]);
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--skip-judge") skipJudge = true;
    else if (a === "--base-url" && argv[i + 1]) baseUrl = argv[++i]!;
    else if (a === "--api-key" && argv[i + 1]) apiKey = argv[++i]!;
    else if (a === "--concurrency" && argv[i + 1]) concurrency = Number(argv[++i]);
    else if (a === "--sampling" && argv[i + 1]) samplingPreset = argv[++i]!;
    else if (a === "--suite" && argv[i + 1]) {
      const v = argv[++i]!;
      if (v === "hard" || v === "hardplus" || v === "all") suite = v;
    } else if (a === "--ids" && argv[i + 1]) {
      ids.push(
        ...argv[++i]!
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
  }

  let sampling: AgenticSampling | undefined;
  if (samplingPreset) {
    sampling = SAMPLING_PRESETS[samplingPreset];
    if (!sampling) {
      throw new Error(
        `Unknown --sampling ${samplingPreset}. Use: ${Object.keys(SAMPLING_PRESETS).join(", ")}`,
      );
    }
  }

  return {
    model,
    limit,
    dryRun,
    skipJudge,
    ids,
    suite,
    concurrency,
    sampling,
    samplingPreset,
    baseUrl,
    apiKey,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  applyLlmConfigOverrides({ baseUrl: args.baseUrl, apiKey: args.apiKey });

  console.log(`Base URL: ${getLlmConfig().baseURL}`);

  const { results, summary } = await runAgenticSuite({
    modelId: args.model,
    limit: args.limit,
    ids: args.ids.length ? args.ids : undefined,
    suite: args.suite,
    skipJudge: args.skipJudge,
    dryRun: args.dryRun,
    concurrency: args.concurrency,
    sampling: args.sampling,
  });

  if (args.dryRun) return;

  const enriched = {
    ...summary,
    samplingPreset: args.samplingPreset ?? "det0",
  };
  const { jsonPath, mdPath } = writeAgenticReport(results, enriched);
  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(enriched, null, 2));
  console.log(`\nJSON: ${jsonPath}`);
  console.log(`MD:   ${mdPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
