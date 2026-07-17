/**
 * eval-hard-25-single.ts — Full hard-25 run for one local OpenAI-compatible model.
 *
 * Examples:
 *   bun run scripts/eval-hard-25-single.ts --model qwen2.5-7b-instruct --label local-smoke
 *   bun run scripts/eval-hard-25-single.ts --model gemma-2-9b --base-url http://127.0.0.1:1234/v1
 */

import { config } from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

config({ path: resolve(import.meta.dirname, "../.env") });

import {
  SYSTEM_PROMPT,
  parseFinanceJson,
  scoreExtraction,
  type ParsedFinance,
} from "../src/core/eval-core.ts";
import {
  applyLlmConfigOverrides,
  chatCompletion,
  getLlmConfig,
} from "../src/core/llm-client.ts";
import {
  HARD_SCENARIOS,
  analyzeQuality,
  type QualityAnalysis,
} from "./eval-hard-25.ts";

interface CliArgs {
  model: string;
  label: string;
  baseUrl?: string;
  apiKey?: string;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  let model = process.env.EVAL_MODEL?.trim() || "local-model";
  let label = "";
  let baseUrl: string | undefined;
  let apiKey: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model" && argv[i + 1]) model = argv[++i]!;
    else if (a === "--label" && argv[i + 1]) label = argv[++i]!;
    else if (a === "--base-url" && argv[i + 1]) baseUrl = argv[++i]!;
    else if (a === "--api-key" && argv[i + 1]) apiKey = argv[++i]!;
  }

  if (!label) {
    label = `${model.replace(/\//g, "-")}-local`;
  }

  return { model, label, baseUrl, apiKey };
}

function safeSlug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-").toLowerCase();
}

const COMPAT_TIMEOUT_MS = 120_000;

/**
 * Retryable here means "this server or model cannot do JSON object mode" — the plain-json
 * retry is a real second chance at the same scenario. A transport failure (404, auth,
 * connection refused) is not: retrying just doubles the wait, fails identically, and
 * discards the original error, which is the only thing that would tell you the model id
 * is wrong.
 */
function isJsonModeFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/HTTP (401|403|404)\b/.test(msg)) return false;
  if (/Unable to connect|ECONNREFUSED|fetch failed|timed out|aborted/i.test(msg)) return false;
  return true; // 400 rejecting response_format, or unparseable JSON from json_object mode
}

async function parseViaCompat(
  model: string,
  text: string,
): Promise<{ parsed: ParsedFinance; ms: number; usage: { prompt_tokens?: number; completion_tokens?: number } }> {
  const base = { model, temperature: 0, maxTokens: 2048, timeoutMs: COMPAT_TIMEOUT_MS };
  try {
    const { content, ms, usage } = await chatCompletion({
      ...base,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      jsonObject: true,
    });
    return { parsed: parseFinanceJson(content), ms, usage };
  } catch (err) {
    if (!isJsonModeFailure(err)) throw err;
    // Some local servers reject response_format, and json_object mode is not
    // grammar-constrained so it can still emit unparseable JSON. Both earn one plain retry,
    // mirroring parseMessage's structured -> plain-json fallback so the two runners grade alike.
    const { content, ms, usage } = await chatCompletion({
      ...base,
      messages: [
        {
          role: "system",
          content: `${SYSTEM_PROMPT}\n\nKembalikan HANYA JSON valid. Tanpa markdown fence.`,
        },
        { role: "user", content: text },
      ],
      jsonObject: false,
    });
    return { parsed: parseFinanceJson(content), ms, usage };
  }
}

async function main() {
  const args = parseArgs();
  applyLlmConfigOverrides({ baseUrl: args.baseUrl, apiKey: args.apiKey });
  const { model, label } = args;
  const { baseURL } = getLlmConfig();
  const runAt = new Date().toISOString();

  console.log(`Hard-25 eval — ${runAt}`);
  console.log(`Label: ${label}`);
  console.log(`Model: ${model}`);
  console.log(`Base URL: ${baseURL}`);
  console.log(`Scenarios: ${HARD_SCENARIOS.length}\n`);

  const results: Array<{
    scenarioId: string;
    strictPass: boolean;
    ms: number;
    promptTokens: number;
    completionTokens: number;
    issues: string[];
    error: string | null;
    quality: QualityAnalysis | null;
  }> = [];

  for (const scenario of HARD_SCENARIOS) {
    process.stdout.write(`  ${scenario.id} ... `);
    try {
      const { parsed, ms, usage } = await parseViaCompat(model, scenario.text);
      const scored = scoreExtraction(parsed, scenario);
      const quality = analyzeQuality(parsed, scenario);
      results.push({
        scenarioId: scenario.id,
        strictPass: scored.pass,
        ms,
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        issues: scored.issues,
        error: null,
        quality,
      });
      const icon = quality.strictPass ? "PASS" : quality.tier === "usable_with_edit" ? "EDIT" : "FAIL";
      console.log(
        `${icon} strict=${quality.strictPass} tier=${quality.tier} composite=${quality.compositeScore} (${ms}ms)`,
      );
      if (!quality.strictPass && quality.qualityNotes.length) {
        console.log(`         notes: ${quality.qualityNotes.slice(0, 2).join(" | ")}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`ERROR: ${msg}`);
      results.push({
        scenarioId: scenario.id,
        strictPass: false,
        ms: 0,
        promptTokens: 0,
        completionTokens: 0,
        issues: [],
        error: msg,
        quality: null,
      });
    }
  }

  const ok = results.filter((r) => r.strictPass && !r.error);
  const composites = results
    .filter((r) => r.quality)
    .map((r) => r.quality!.compositeScore);
  const meanComposite =
    composites.length > 0
      ? composites.reduce((a, b) => a + b, 0) / composites.length
      : 0;
  const avgMs =
    results.filter((r) => r.ms > 0).reduce((s, r) => s + r.ms, 0) /
    Math.max(results.filter((r) => r.ms > 0).length, 1);

  console.log(`\n${"=".repeat(72)}`);
  console.log(`Strict: ${ok.length}/${HARD_SCENARIOS.length}`);
  console.log(`Mean composite: ${meanComposite.toFixed(1)}`);
  console.log(`Avg latency: ${Math.round(avgMs)}ms`);
  console.log(`Errors: ${results.filter((r) => r.error).length}`);

  const outDir = resolve(import.meta.dirname, "../docs/results/runs");
  mkdirSync(outDir, { recursive: true });
  const slug = runAt.slice(0, 10);
  const jsonPath = resolve(
    outDir,
    `${slug}-parse-hard-25-${safeSlug(model)}-${safeSlug(label)}-results.json`,
  );
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        kind: "parse-hard-25",
        runAt,
        label,
        modelId: model,
        model,
        baseURL,
        strictPass: ok.length,
        totalScenarios: HARD_SCENARIOS.length,
        meanComposite,
        avgMs,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\nWrote ${jsonPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
