/**
 * generate-sft-parse.ts — build a ChatML SFT corpus for a small Indonesian finance-chat parser.
 *
 * Spec-first: a seeded RNG draws the answer key from an authored taxonomy, the teacher only
 * writes prose, and a BLIND parse (which never sees the spec) must rediscover the answer.
 * The teacher therefore cannot author its own answer key, and the agreement check is free.
 *
 * Generation is two-stage batched: one LLM call writes N texts, another blinds-labels them.
 * Default `--provider openai` (@ai-sdk/openai chat + structuredOutputs), `--batch-size 5`,
 * `--concurrency 5`. Benches stay on openai-compatible / LM Studio and are unaffected.
 *
 *   bun run generate:sft-parse -- --model <teacher-id> --count 200 --base-url … --api-key …
 *   bun run generate:sft-parse -- --dry-run --count 45
 *   bun run generate:sft-parse -- --provider openai-compatible   # LM Studio teacher
 */

import { config } from "dotenv";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import {
  SYSTEM_PROMPT,
  parseMessage,
  parseMessagesBatch,
} from "../src/core/eval-core.ts";
import {
  buildTaxonomy,
  taxonomyStats,
  type Cell,
} from "../src/core/parse-taxonomy.ts";
import {
  assertNoLeak,
  maxSimilarity,
  LeakError,
} from "../src/core/parse-leakguard.ts";
import {
  applyLlmConfigOverrides,
  chatCompletion,
  getLlmConfig,
  listModels,
  LLM_PROVIDER_KINDS,
  THINKING_MODES,
  thinkingMismatch,
  type LlmProviderKind,
  type ThinkingMode,
} from "../src/core/llm-client.ts";
import { tokenizeAmounts } from "../src/core/rupiah.ts";
import { RejectError, validateRow } from "./lib/sft-validate.ts";
import {
  buildTextPrompt,
  cellToSpec,
  excusedByConstruction,
  expectedTextAmounts,
  traceableByConstruction,
  type RowSpec,
} from "./lib/sft-spec.ts";
import {
  batchTextResponseSchema,
  buildBatchTextPrompt,
  claimBatchFromPlan,
  labelBatchMaxTokens,
  salvageLabelBatch,
  salvageTextBatch,
  textBatchMaxTokens,
  type MappedFail,
} from "./lib/sft-batch.ts";
import {
  RawSink,
  RejectSink,
  gitProvenance,
  toRejectRow,
  sha256,
  writeRun,
  type RawRow,
  type SystemPromptMode,
} from "./lib/sft-io.ts";

config({ path: resolve(import.meta.dirname, "../.env") });

const TEXT_TIMEOUT_MS = 60_000;
const LABEL_TIMEOUT_MS = 90_000;
const MAX_TRANSPORT_RETRIES = 3;
const MAX_CELL_REROLLS = 3;

class UsageError extends Error {}

function intArg(name: string, raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(
      `--${name} expects a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

function floatArg(
  name: string,
  raw: string | undefined,
  min: number,
  max: number,
): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new UsageError(
      `--${name} expects a number in [${min}, ${max}], got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

export type Args = {
  model: string;
  count: number;
  seed: number;
  outRoot: string;
  stamp: string;
  dryRun: boolean;
  selfTest: boolean;
  resume: boolean;
  overwrite: boolean;
  baseUrl?: string;
  apiKey?: string;
  textTemperature: number;
  concurrency: number;
  /** How many rows to pack into one text/label LLM call. Default 5. */
  batchSize: number;
  /**
   * AI SDK provider. Default `openai` (structuredOutputs for cloud teachers).
   * Escape hatch `openai-compatible` for LM Studio teachers.
   */
  provider: LlmProviderKind;
  thinking: ThinkingMode;
  attemptMultiplier: number;
  systemPromptMode: SystemPromptMode | "mix";
  minSuccessRate: number;
};

export function parseArgs(argv: string[]): Args {
  const a: Args = {
    model: process.env.EVAL_MODEL?.trim() || "local-model",
    count: 200,
    seed: 42,
    outRoot: resolve(import.meta.dirname, "../data/sft"),
    stamp: "",
    dryRun: false,
    selfTest: false,
    resume: false,
    overwrite: false,
    // Slightly lower than 0.9: high temp was a major source of bijection (repeated/missing amounts).
    textTemperature: 0.7,
    // Cloud gateways usually tolerate several parallel batch workers; lower for LM Studio.
    concurrency: 5,
    batchSize: 5,
    // Cloud teachers need real structuredOutputs; benches keep openai-compatible for LM Studio.
    provider: "openai",
    // `auto` and not `off`: the teacher's reasoning is often what makes a hard row well-formed,
    // and defaulting to off would silently change what every existing seed generates.
    thinking: "auto",
    attemptMultiplier: 3,
    systemPromptMode: "mix",
    minSuccessRate: 0.8,
  };

  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--model" && v) {
      a.model = v;
      i++;
    } else if (k === "--count" && v) {
      a.count = intArg("count", v);
      i++;
    } else if (k === "--seed" && v) {
      a.seed = intArg("seed", v);
      i++;
    } else if (k === "--out" && v) {
      a.outRoot = resolve(v);
      i++;
    } else if (k === "--stamp" && v) {
      a.stamp = v;
      i++;
    } else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--self-test") a.selfTest = true;
    else if (k === "--resume") a.resume = true;
    else if (k === "--overwrite") a.overwrite = true;
    else if (k === "--base-url" && v) {
      a.baseUrl = v;
      i++;
    } else if (k === "--api-key" && v) {
      a.apiKey = v;
      i++;
    } else if (k === "--temperature" && v) {
      a.textTemperature = floatArg("temperature", v, 0, 2);
      i++;
    } else if (k === "--concurrency" && v) {
      a.concurrency = intArg("concurrency", v);
      i++;
    } else if (k === "--batch-size" && v) {
      a.batchSize = intArg("batch-size", v);
      i++;
    } else if (k === "--provider" && v) {
      if (!LLM_PROVIDER_KINDS.includes(v as LlmProviderKind)) {
        throw new UsageError(
          `--provider must be openai|openai-compatible, got ${JSON.stringify(v)}`,
        );
      }
      a.provider = v as LlmProviderKind;
      i++;
    } else if (k === "--thinking" && v) {
      if (!THINKING_MODES.includes(v as ThinkingMode)) {
        throw new UsageError(
          `--thinking must be on|off|auto, got ${JSON.stringify(v)}`,
        );
      }
      a.thinking = v as ThinkingMode;
      i++;
    } else if (k === "--attempt-multiplier" && v) {
      a.attemptMultiplier = intArg("attempt-multiplier", v);
      i++;
    } else if (k === "--min-success-rate" && v) {
      a.minSuccessRate = floatArg("min-success-rate", v, 0, 1);
      i++;
    } else if (k === "--system-prompt-mode" && v) {
      if (!["full", "short", "none", "mix"].includes(v)) {
        throw new UsageError(
          `--system-prompt-mode must be full|short|none|mix, got ${JSON.stringify(v)}`,
        );
      }
      a.systemPromptMode = v as Args["systemPromptMode"];
      i++;
    } else if (k?.startsWith("--")) {
      throw new UsageError(`unknown flag ${k}`);
    }
  }
  return a;
}

/** Deterministic RNG — Math.random would make a run impossible to reproduce from the manifest. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function pickSystemPromptMode(
  mode: Args["systemPromptMode"],
  rng: () => number,
): SystemPromptMode {
  if (mode !== "mix") return mode;
  // `full` dominates because parseMessage always sends the full prompt at eval and in prod —
  // training mostly on `none` would meet ~860 unseen tokens at inference. short/none are
  // regularization: they anchor behaviour in the user text rather than in copying the prompt.
  const r = rng();
  if (r < 0.8) return "full";
  if (r < 0.95) return "short";
  return "none";
}

type ErrClass = "fatal" | "retry" | "reject";

function classify(err: unknown): ErrClass {
  if (err instanceof RejectError || err instanceof LeakError) return "reject";
  const msg = err instanceof Error ? err.message : String(err);
  // A wrong model id fails identically on every row — stop in seconds, not 2000 rows later.
  if (/HTTP (400|401|403|404)\b/.test(msg)) return "fatal";
  if (/model.*not (found|loaded)/i.test(msg)) return "fatal";
  return "retry";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_TRANSPORT_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const cls = classify(err);
      if (cls === "fatal" || cls === "reject") throw err;
      if (attempt === MAX_TRANSPORT_RETRIES) break;
      await sleep(250 * 2 ** attempt + Math.floor(Math.random() * 100));
    }
  }
  throw new Error(
    `${label} failed after ${MAX_TRANSPORT_RETRIES} retries: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

async function genTextBatch(
  model: string,
  specs: readonly RowSpec[],
  temperature: number,
  thinking: ThinkingMode,
  provider: LlmProviderKind,
): Promise<{
  response: ReturnType<typeof batchTextResponseSchema.parse>;
  ms: number;
}> {
  const { system, user } = buildBatchTextPrompt(specs);
  const { content, ms } = await withRetry(
    () =>
      chatCompletion({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature,
        maxTokens: textBatchMaxTokens(specs.length),
        timeoutMs: Math.max(TEXT_TIMEOUT_MS, specs.length * 15_000),
        thinking,
        jsonObject: true,
        provider,
      }),
    "text generation batch",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new RejectError(
      "batch:text-json",
      `teacher returned non-JSON text batch: ${content.slice(0, 200)}`,
    );
  }
  const checked = batchTextResponseSchema.safeParse(parsed);
  if (!checked.success) {
    throw new RejectError(
      "batch:text-schema",
      `teacher text batch failed schema: ${checked.error.issues
        .slice(0, 3)
        .map((i) => i.message)
        .join("; ")}`,
    );
  }
  return { response: checked.data, ms };
}

/** The text must contain exactly the amounts the spec ordered — no more, no fewer. */
function guardSpecBijection(text: string, spec: RowSpec): void {
  const want = [...expectedTextAmounts(spec)].sort((a, b) => a - b);
  const got = [...tokenizeAmounts(text).map((a) => a.value)].sort(
    (a, b) => a - b,
  );
  if (want.length !== got.length || want.some((v, i) => v !== got[i])) {
    throw new RejectError(
      "text:bijection",
      `text amounts ${JSON.stringify(got)} != spec amounts ${JSON.stringify(want)}`,
    );
  }
}

type BatchAttemptResult = {
  rows: RawRow[];
  fails: Array<{ spec: RowSpec; fail: MappedFail; text: string | null }>;
  textMs: number;
  labelMs: number;
  textRequests: number;
  labelRequests: number;
};

/**
 * Two-stage batch: (1) generate N texts from specs, (2) blind-label the surviving texts.
 * Partial salvage: valid items proceed; missing/invalid ids are returned as fails for reroll.
 */
async function attemptBatch(
  args: Args,
  specs: readonly RowSpec[],
): Promise<BatchAttemptResult> {
  const byId = new Map(specs.map((s) => [s.planIndex, s]));
  const fails: BatchAttemptResult["fails"] = [];

  const { response: textResponse, ms: textMs } = await genTextBatch(
    args.model,
    specs,
    args.textTemperature,
    args.thinking,
    args.provider,
  );
  const salvagedTexts = salvageTextBatch(
    specs.map((s) => s.planIndex),
    textResponse,
  );
  for (const fail of salvagedTexts.fail) {
    const spec = byId.get(fail.id);
    if (spec) fails.push({ spec, fail, text: null });
  }

  const gatedTexts: Array<{ id: number; text: string; spec: RowSpec }> = [];
  for (const item of salvagedTexts.ok) {
    const spec = byId.get(item.id);
    if (!spec) continue;
    try {
      assertNoLeak(item.text);
      guardSpecBijection(item.text, spec);
      gatedTexts.push({ id: item.id, text: item.text, spec });
    } catch (err) {
      const phase =
        err instanceof RejectError
          ? err.phase
          : err instanceof LeakError
            ? "text:leak"
            : "text:bijection";
      const message = err instanceof Error ? err.message : String(err);
      fails.push({
        spec,
        fail: { id: item.id, phase, message },
        text: item.text,
      });
    }
  }

  if (gatedTexts.length === 0) {
    return {
      rows: [],
      fails,
      textMs,
      labelMs: 0,
      textRequests: 1,
      labelRequests: 0,
    };
  }

  const labelResult = await withRetry(
    () =>
      parseMessagesBatch(
        args.model,
        gatedTexts.map((t) => ({ id: t.id, text: t.text })),
        {
          noFallback: true,
          abortSignal: AbortSignal.timeout(
            Math.max(LABEL_TIMEOUT_MS, gatedTexts.length * 20_000),
          ),
          thinking: args.thinking,
          maxOutputTokens: labelBatchMaxTokens(gatedTexts.length),
          provider: args.provider,
        },
      ),
    "labeling batch",
  );
  if (labelResult.path !== "structured") {
    throw new RejectError(
      "label:plain-json",
      "label batch did not come from the structured path",
    );
  }

  const salvagedLabels = salvageLabelBatch(
    gatedTexts.map((t) => t.id),
    labelResult.parsed,
  );
  const textById = new Map(gatedTexts.map((t) => [t.id, t]));
  for (const fail of salvagedLabels.fail) {
    const gated = textById.get(fail.id);
    if (gated) fails.push({ spec: gated.spec, fail, text: gated.text });
  }

  const rows: RawRow[] = [];
  for (const item of salvagedLabels.ok) {
    const gated = textById.get(item.id);
    if (!gated) continue;
    try {
      const { traceTiers } = validateRow({
        text: gated.text,
        label: item.label,
        spec: gated.spec.expectation,
        shape: { allowDuplicateEntries: gated.spec.allowDuplicateEntries },
        excusedByConstruction: excusedByConstruction(gated.spec),
        traceableByConstruction: traceableByConstruction(gated.spec),
      });
      rows.push({
        planIndex: gated.spec.planIndex,
        cellId: gated.spec.cell.id,
        aspect: gated.spec.cell.aspect,
        tier: gated.spec.cell.tier,
        split: gated.spec.cell.split,
        text: gated.text,
        label: item.label,
        meta: {
          traceTiers,
          maxSimilarity: maxSimilarity(gated.text),
          systemPromptMode: pickSystemPromptMode(
            args.systemPromptMode,
            mulberry32(args.seed ^ gated.spec.planIndex),
          ),
          teacher: args.model,
          textMs,
          labelMs: labelResult.ms,
        },
      });
    } catch (err) {
      const phase = err instanceof RejectError ? err.phase : "label:validate";
      const message = err instanceof Error ? err.message : String(err);
      fails.push({
        spec: gated.spec,
        fail: { id: item.id, phase, message },
        text: gated.text,
      });
    }
  }

  return {
    rows,
    fails,
    textMs,
    labelMs: labelResult.ms,
    textRequests: 1,
    labelRequests: 1,
  };
}

/** Expand cells into a flat plan: one entry per row, deterministic, drawn before any worker runs. */
function drawPlan(
  cells: Cell[],
  count: number,
  multiplier: number,
  rng: () => number,
): RowSpec[] {
  const plan: RowSpec[] = [];
  for (const cell of cells) {
    for (let r = 0; r < cell.rows; r++)
      plan.push(cellToSpec(cell, plan.length));
  }
  // Shuffle so a partial run still covers the taxonomy broadly instead of the first aspects only.
  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = plan[i]!,
      b = plan[j]!;
    plan[i] = b;
    plan[j] = a;
  }
  return plan
    .slice(0, count * multiplier)
    .map((s, i) => ({ ...s, planIndex: i }));
}

async function selfTest(): Promise<void> {
  const { HARD_SCENARIOS } = await import("./eval-hard-25.ts");
  const { traceAmount, unexcusedAtoms } = await import("../src/core/rupiah.ts");
  let direct = 0,
    total = 0,
    falseReject = 0;

  for (const s of HARD_SCENARIOS) {
    const atoms = tokenizeAmounts(s.text);
    for (const e of s.expectEntries) {
      total++;
      if (traceAmount(e.jumlah, atoms).tier === "direct") direct++;
      else console.log(`  MISS ${s.id}: ${e.jumlah}`);
    }
    const unexcused = unexcusedAtoms(
      s.text,
      atoms,
      new Set(s.expectEntries.map((e) => e.jumlah)),
    );
    if (unexcused.length > 0) {
      falseReject++;
      console.log(
        `  FALSE REJECT ${s.id}: ${unexcused.map((u) => u.atom.raw).join(", ")}`,
      );
    }
  }

  console.log(
    `\nself-test over ${HARD_SCENARIOS.length} hand-authored scenarios:`,
  );
  console.log(`  forward trace : ${direct}/${total} direct`);
  console.log(`  reverse gate  : ${falseReject} false rejects`);
  const ok = direct === total && falseReject === 0;
  console.log(
    ok
      ? "\nPASS — validators are safe as hard gates."
      : "\nFAIL — validators would gut the corpus.",
  );
  if (!ok) process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  applyLlmConfigOverrides({
    baseUrl: args.baseUrl,
    apiKey: args.apiKey,
    provider: args.provider,
  });
  // ai@6 + @ai-sdk/openai@2 emits noisy "specificationVersion compatibility mode" warnings
  // on every call; they do not affect correctness. Keep temperature warnings gone by omitting
  // temp on the openai labeling path (see parseMessage).
  (globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS = false;

  if (args.selfTest) return selfTest();

  const cells = buildTaxonomy(args.seed);
  const stats = taxonomyStats(cells);
  const rng = mulberry32(args.seed);
  const plan = drawPlan(cells, args.count, args.attemptMultiplier, rng);
  const llm = getLlmConfig(args.provider);

  console.log(`SFT generate — teacher=${args.model}`);
  console.log(`Provider: ${args.provider} · Base URL: ${llm.baseURL}`);
  console.log(
    `Taxonomy: ${cells.length} cells · plan ${plan.length} attempts for ${args.count} accepted rows`,
  );
  console.log(
    `Seed: ${args.seed} · concurrency ${args.concurrency} · batch-size ${args.batchSize} · system-prompt ${args.systemPromptMode} · thinking ${args.thinking}\n`,
  );

  if (args.dryRun) {
    console.log("Realized marginals:");
    console.log(JSON.stringify(stats, null, 2).slice(0, 2400));
    const preview = plan.slice(0, Math.min(args.count, plan.length));
    const batches: number[] = [];
    for (let i = 0; i < preview.length; i += args.batchSize) {
      batches.push(Math.min(args.batchSize, preview.length - i));
    }
    console.log(
      `\nBatch plan preview (first ${preview.length} of ${args.count} target rows): ${batches.join("+")} = ${preview.length}`,
    );
    console.log("\nSample plan entries:");
    for (const s of plan.slice(0, 8)) {
      const { user } = buildTextPrompt(s);
      console.log(
        `\n[${s.planIndex}] ${s.cell.aspect} (${s.cell.split}) — expects ${JSON.stringify(s.expectation.alternatives[0]?.map((e) => `${e.direction}:${e.amount}`))}`,
      );
      console.log(
        user
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n"),
      );
    }
    return;
  }

  const stamp =
    args.stamp || new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const outDir = resolve(args.outRoot, stamp);
  const rawPath = resolve(outDir, "raw.jsonl");
  const rejectsPath = resolve(outDir, "rejects.jsonl");

  // Preflight — nothing is written until the teacher is proven reachable and capable.
  // The old generator truncated its output before the first call, so a dead server
  // destroyed the previous corpus.
  if (args.provider === "openai" && !llm.apiKey) {
    console.error(
      "FATAL: OPENAI_API_KEY is empty. Pass --api-key or set OPENAI_API_KEY.",
    );
    console.error("Nothing was written; any existing corpus is untouched.");
    process.exit(1);
  }

  let models: string[];
  try {
    models = await listModels({ timeoutMs: 10_000, provider: args.provider });
  } catch (err) {
    console.error(
      `FATAL: cannot reach the ${args.provider} server at ${llm.baseURL}`,
    );
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    console.error(
      args.provider === "openai"
        ? "\nPass --base-url / --api-key for your cloud gateway, or set OPENAI_BASE_URL / OPENAI_API_KEY."
        : "\nStart LM Studio → Developer → Server, or pass --base-url.",
    );
    console.error("Nothing was written; any existing corpus is untouched.");
    process.exit(1);
  }
  if (!models.includes(args.model)) {
    console.error(`FATAL: model ${JSON.stringify(args.model)} is not loaded.`);
    console.error(`Loaded: ${models.length ? models.join(", ") : "(none)"}`);
    process.exit(1);
  }
  const probe = await parseMessage(args.model, "beli kopi 5rb", {
    noFallback: true,
    abortSignal: AbortSignal.timeout(LABEL_TIMEOUT_MS),
    thinking: args.thinking,
    provider: args.provider,
  });
  if (probe.path !== "structured") {
    console.error(
      "FATAL: teacher cannot produce structured output; a coerced label would be minted as gold.",
    );
    process.exit(1);
  }
  // Preflight is the only place the toggle can be checked before the corpus is touched.
  // Not fatal: a reasoning teacher still mints valid labels, it just costs latency. The
  // manifest records what was OBSERVED, so a run is never mislabelled by an ignored flag.
  const mismatch = thinkingMismatch(args.thinking, probe.thinkingObserved);
  if (mismatch) console.warn(`WARNING: ${mismatch}\n`);
  console.log(
    `Preflight OK (provider=${args.provider} · structured output in ${probe.ms}ms · thinking requested=${args.thinking} observed=${probe.thinkingObserved})\n`,
  );

  // Truncation happens only here — after preflight proved the teacher reachable and capable,
  // so a dead server can never destroy a prior corpus. Without the unlink, --overwrite merely
  // bypassed the guard while RawSink still loaded the old rows, so the run appended (or
  // no-opped at "Accepted 5/5") and then published a manifest attesting to a corpus it had
  // not generated.
  if (args.overwrite && existsSync(rawPath)) {
    rmSync(rawPath);
    console.log(`--overwrite: cleared ${rawPath}`);
  }
  const raw = new RawSink(rawPath);
  if (raw.count > 0 && !args.resume) {
    console.error(
      `FATAL: ${rawPath} already has ${raw.count} rows. Pass --resume to extend it, or --overwrite to replace it.`,
    );
    process.exit(1);
  }
  const rejects = new RejectSink(rejectsPath);
  const done = args.resume ? raw.donePlanIndexes : new Set<number>();

  const seenTexts = new Set(raw.all.map((r) => r.text.toLowerCase()));
  const rerolls = new Map<string, number>();
  const rejectsByPhase: Record<string, number> = {};
  let cursor = 0;
  let accepted = raw.count;
  let inFlight = 0;
  let textRequestCount = 0;
  let labelRequestCount = 0;
  let aborted: Error | null = null;
  const t0 = Date.now();

  /** Claim up to batchSize specs without exceeding remaining accepted slots. Sync — no await. */
  function claimBatch(): RowSpec[] | "wait" | null {
    const result = claimBatchFromPlan(
      {
        aborted: aborted !== null,
        accepted,
        count: args.count,
        inFlight,
        batchSize: args.batchSize,
        cursor,
        done,
      },
      plan,
    );
    if (result.kind === "done") return null;
    if (result.kind === "wait") return "wait";
    cursor = result.nextCursor;
    inFlight += result.reserved;
    return result.items;
  }

  function recordReject(
    spec: RowSpec,
    err: unknown,
    text: string | null,
  ): void {
    const record = toRejectRow(
      { planIndex: spec.planIndex, cellId: spec.cell.id },
      err,
      text,
    );
    rejectsByPhase[record.phase] = (rejectsByPhase[record.phase] ?? 0) + 1;
    rejects.write(record);
    const n = (rerolls.get(spec.cell.id) ?? 0) + 1;
    rerolls.set(spec.cell.id, n);
    if (n <= MAX_CELL_REROLLS) plan.push({ ...spec, planIndex: plan.length });
  }

  // Index-cursor worker pool; each worker claims a batch and may partially salvage it.
  async function worker(): Promise<void> {
    for (;;) {
      const claimed = claimBatch();
      if (claimed === "wait") {
        await sleep(50);
        continue;
      }
      if (!claimed) return;
      const batch = claimed;

      try {
        const result = await attemptBatch(args, batch);
        textRequestCount += result.textRequests;
        labelRequestCount += result.labelRequests;

        for (const { spec, fail, text } of result.fails) {
          recordReject(spec, new RejectError(fail.phase, fail.message), text);
        }

        for (const row of result.rows) {
          if (accepted >= args.count) break;
          const key = row.text.toLowerCase();
          if (seenTexts.has(key)) {
            rejectsByPhase.dedup = (rejectsByPhase.dedup ?? 0) + 1;
            rejects.write({
              planIndex: row.planIndex,
              cellId: row.cellId,
              phase: "dedup",
              message: "duplicate text",
              text: row.text,
            });
            const n = (rerolls.get(row.cellId) ?? 0) + 1;
            rerolls.set(row.cellId, n);
            const spec = batch.find((s) => s.planIndex === row.planIndex);
            if (spec && n <= MAX_CELL_REROLLS)
              plan.push({ ...spec, planIndex: plan.length });
            continue;
          }
          seenTexts.add(key);
          raw.append(row);
          accepted++;
          const rate = accepted / ((Date.now() - t0) / 60_000);
          process.stdout.write(
            `  [${accepted}/${args.count}] ${row.aspect.padEnd(28)} ${rate.toFixed(1)}/min  ${row.text.slice(0, 44)}\n`,
          );
        }
      } catch (err) {
        const cls = classify(err);
        if (cls === "fatal") {
          aborted = err instanceof Error ? err : new Error(String(err));
          return;
        }
        // Whole-batch transport/schema failure: reject every claimed spec so cells can reroll.
        for (const spec of batch) {
          recordReject(spec, err, null);
        }
      } finally {
        inFlight -= batch.length;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(args.concurrency, plan.length) }, () =>
      worker(),
    ),
  );

  if (aborted) {
    console.error(`\nFATAL: ${(aborted as Error).message}`);
    console.error(
      "Run aborted — every row would fail identically. raw.jsonl is intact.",
    );
    process.exit(1);
  }

  const rows = raw.all;
  const attempts =
    accepted + Object.values(rejectsByPhase).reduce((a, b) => a + b, 0);
  const successRate = attempts > 0 ? accepted / attempts : 0;

  const perCellAccept: Record<string, number> = {};
  for (const c of cells) {
    const got = rows.filter((r) => r.cellId === c.id).length;
    const rj = rerolls.get(c.id) ?? 0;
    if (got + rj > 0)
      perCellAccept[c.id] = Number((got / (got + rj)).toFixed(3));
  }
  const weakCells = Object.entries(perCellAccept)
    .filter(([, v]) => v < 0.9)
    .sort((a, b) => a[1] - b[1]);

  const sims = rows.map((r) => r.meta.maxSimilarity).sort((a, b) => a - b);
  const pct = (p: number) =>
    sims.length
      ? Number((sims[Math.floor(sims.length * p)] ?? 0).toFixed(3))
      : 0;
  const traceHist: Record<string, number> = {};
  for (const r of rows)
    for (const t of r.meta.traceTiers) traceHist[t] = (traceHist[t] ?? 0) + 1;
  const modeHist: Record<string, number> = {};
  for (const r of rows)
    modeHist[r.meta.systemPromptMode] =
      (modeHist[r.meta.systemPromptMode] ?? 0) + 1;

  // Realized, not planned. taxonomyStats() describes all 339 cells regardless of what was
  // sampled or accepted, so a --count 100 pilot would otherwise publish a manifest claiming
  // 2034 rows at the target class balance while the real corpus looked nothing like it —
  // and the Phase-4 pilot gate exists precisely to catch that.
  const realizedAspect: Record<string, number> = {};
  const realizedTier: Record<string, number> = {};
  const realizedSplit: Record<string, number> = {};
  let entriesTotal = 0;
  let entriesMasuk = 0;
  let nonTxRows = 0;
  const realizedDateHint: Record<string, number> = {};
  for (const r of rows) {
    realizedAspect[r.aspect] = (realizedAspect[r.aspect] ?? 0) + 1;
    realizedTier[r.tier] = (realizedTier[r.tier] ?? 0) + 1;
    realizedSplit[r.split] = (realizedSplit[r.split] ?? 0) + 1;
    if (r.label.bukan_transaksi) nonTxRows++;
    for (const e of r.label.entries) {
      entriesTotal++;
      if (e.type === "pemasukan") entriesMasuk++;
      const h = e.tanggal_hint ?? "null";
      realizedDateHint[h] = (realizedDateHint[h] ?? 0) + 1;
    }
  }
  // An aspect that yielded nothing is invisible in per-cell rates but fatal to coverage.
  const zeroYieldAspects = [...new Set(cells.map((c) => c.aspect))].filter(
    (a) => !realizedAspect[a],
  );

  const { gitSha, dirty } = gitProvenance();
  const manifest = {
    bench: "chat-keuangan-sft-parse",
    // 1.2.0: default provider=openai (@ai-sdk/openai chat + structuredOutputs) for SFT.
    version: "1.2.0",
    generatedAt: new Date().toISOString(),
    teacher: args.model,
    provider: args.provider,
    baseURL: getLlmConfig(args.provider).baseURL,
    seed: args.seed,
    textTemperature: args.textTemperature,
    labelTemperature: 0,
    batchSize: args.batchSize,
    concurrency: args.concurrency,
    llmRequests: {
      textBatches: textRequestCount,
      labelBatches: labelRequestCount,
      total: textRequestCount + labelRequestCount,
    },
    // Requested vs observed, like systemPromptMode below: LM Studio documents no API toggle
    // for reasoning, so the flag is an ask the server may ignore. Only `observed` is evidence.
    thinkingRequested: args.thinking,
    thinkingObserved: probe.thinkingObserved,
    gitSha,
    dirty,
    systemPromptSha256: sha256(SYSTEM_PROMPT),
    systemPromptChars: SYSTEM_PROMPT.length,
    systemPromptModeRequested: args.systemPromptMode,
    systemPromptModeRealized: modeHist,
    taxonomy: { cells: cells.length, plannedStats: stats },
    realized: {
      rows: rows.length,
      byAspect: realizedAspect,
      byTier: realizedTier,
      bySplit: realizedSplit,
      zeroYieldAspects,
      nonTransactionRowShare: rows.length
        ? Number((nonTxRows / rows.length).toFixed(3))
        : 0,
      entryLevelPemasukanShare: entriesTotal
        ? Number((entriesMasuk / entriesTotal).toFixed(3))
        : 0,
      dateHint: realizedDateHint,
    },
    counts: { accepted, attempts, successRate: Number(successRate.toFixed(3)) },
    rejectsByPhase,
    perCellAcceptRate: perCellAccept,
    weakCells: weakCells.slice(0, 20).map(([id, v]) => ({ id, acceptRate: v })),
    traceTierHistogram: traceHist,
    maxSimilarityVsScoredCorpus: {
      p50: pct(0.5),
      p95: pct(0.95),
      max: sims[sims.length - 1] ?? 0,
    },
    mlxCommand: `mlx_lm.lora --train --data ${outDir} --mask-prompt --model Qwen/Qwen3-1.7B --batch-size 4 --num-layers -1`,
  };

  const publishDir = resolve(import.meta.dirname, "../docs/results/sft");
  const { counts } = writeRun({
    outDir,
    rows,
    fullSystemPrompt: SYSTEM_PROMPT,
    manifest,
    publishDir,
    stamp,
  });

  console.log(`\n${"=".repeat(64)}`);
  console.log(
    `Accepted ${accepted}/${args.count} · success rate ${(successRate * 100).toFixed(1)}%`,
  );
  console.log(
    `LLM requests: text=${textRequestCount} label=${labelRequestCount} total=${textRequestCount + labelRequestCount} · batch-size ${args.batchSize} · concurrency ${args.concurrency}`,
  );
  console.log(
    `Splits: train=${counts.train} valid=${counts.valid} test=${counts.test}`,
  );
  console.log(`Rejects by phase: ${JSON.stringify(rejectsByPhase)}`);
  console.log(`Trace tiers: ${JSON.stringify(traceHist)}`);
  console.log(
    `Realized entry-level pemasukan: ${((entriesMasuk / Math.max(entriesTotal, 1)) * 100).toFixed(1)}% (target 23%, hard-25 baseline 8.9%)`,
  );
  console.log(
    `Realized non-transaction rows: ${((nonTxRows / Math.max(rows.length, 1)) * 100).toFixed(1)}% (target ~5%)`,
  );
  if (zeroYieldAspects.length > 0) {
    console.error(
      `\n${zeroYieldAspects.length} aspects yielded ZERO rows — the student will be blind to them:`,
    );
    for (const a of zeroYieldAspects) console.error(`  ${a}`);
  }
  console.log(
    `Max similarity vs scored corpus: p50=${pct(0.5)} p95=${pct(0.95)} max=${sims[sims.length - 1] ?? 0}`,
  );
  if (weakCells.length > 0) {
    console.log(
      `\n${weakCells.length} cells accepted below 90% — the teacher is weak there; hand-label or drop:`,
    );
    for (const [id, v] of weakCells.slice(0, 10))
      console.log(`  ${(v * 100).toFixed(0)}%  ${id}`);
  }
  console.log(`\nCorpus: ${outDir}`);
  console.log(`Train with:\n  ${manifest.mlxCommand}`);

  if (accepted < args.count) {
    console.error(
      `\nShortfall: wanted ${args.count}, got ${accepted}. Plan exhausted.`,
    );
    process.exit(1);
  }
  if (successRate < args.minSuccessRate) {
    console.error(
      `\nSuccess rate ${(successRate * 100).toFixed(1)}% is below --min-success-rate ${args.minSuccessRate}.`,
    );
    process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    if (e instanceof UsageError) {
      console.error(`usage: ${e.message}`);
      process.exit(1);
    }
    console.error(e);
    process.exit(1);
  });
}
