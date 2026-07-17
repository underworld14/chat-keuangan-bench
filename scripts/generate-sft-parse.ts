/**
 * generate-sft-parse.ts — build a ChatML SFT corpus for a small Indonesian finance-chat parser.
 *
 * Spec-first: a seeded RNG draws the answer key from an authored taxonomy, the teacher only
 * writes prose, and a BLIND parse (which never sees the spec) must rediscover the answer.
 * The teacher therefore cannot author its own answer key, and the agreement check is free.
 *
 *   bun run generate:sft-parse -- --model <teacher-id> --count 200
 *   bun run generate:sft-parse -- --dry-run --count 20      # plan + coverage, no LLM calls
 *   bun run generate:sft-parse -- --self-test               # validators vs hand-authored gold
 */

import { config } from "dotenv";
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { SYSTEM_PROMPT, parseMessage } from "../src/core/eval-core.ts";
import { buildTaxonomy, taxonomyStats, type Cell } from "../src/core/parse-taxonomy.ts";
import { assertNoLeak, maxSimilarity, LeakError } from "../src/core/parse-leakguard.ts";
import { applyLlmConfigOverrides, chatCompletion, getLlmConfig, listModels } from "../src/core/llm-client.ts";
import { tokenizeAmounts } from "../src/core/rupiah.ts";
import { RejectError, validateRow } from "./lib/sft-validate.ts";
import {
  buildTextPrompt,
  cellToSpec,
  excusedByConstruction,
  expectedTextAmounts,
  type RowSpec,
} from "./lib/sft-spec.ts";
import {
  RawSink,
  RejectSink,
  gitProvenance,
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
    throw new UsageError(`--${name} expects a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function floatArg(name: string, raw: string | undefined, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new UsageError(`--${name} expects a number in [${min}, ${max}], got ${JSON.stringify(raw)}`);
  }
  return n;
}

type Args = {
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
  attemptMultiplier: number;
  systemPromptMode: SystemPromptMode | "mix";
  minSuccessRate: number;
};

function parseArgs(argv: string[]): Args {
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
    textTemperature: 0.9,
    concurrency: 4,
    attemptMultiplier: 3,
    systemPromptMode: "mix",
    minSuccessRate: 0.8,
  };

  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--model" && v) { a.model = v; i++; }
    else if (k === "--count" && v) { a.count = intArg("count", v); i++; }
    else if (k === "--seed" && v) { a.seed = intArg("seed", v); i++; }
    else if (k === "--out" && v) { a.outRoot = resolve(v); i++; }
    else if (k === "--stamp" && v) { a.stamp = v; i++; }
    else if (k === "--dry-run") a.dryRun = true;
    else if (k === "--self-test") a.selfTest = true;
    else if (k === "--resume") a.resume = true;
    else if (k === "--overwrite") a.overwrite = true;
    else if (k === "--base-url" && v) { a.baseUrl = v; i++; }
    else if (k === "--api-key" && v) { a.apiKey = v; i++; }
    else if (k === "--temperature" && v) { a.textTemperature = floatArg("temperature", v, 0, 2); i++; }
    else if (k === "--concurrency" && v) { a.concurrency = intArg("concurrency", v); i++; }
    else if (k === "--attempt-multiplier" && v) { a.attemptMultiplier = intArg("attempt-multiplier", v); i++; }
    else if (k === "--min-success-rate" && v) { a.minSuccessRate = floatArg("min-success-rate", v, 0, 1); i++; }
    else if (k === "--system-prompt-mode" && v) {
      if (!["full", "short", "none", "mix"].includes(v)) {
        throw new UsageError(`--system-prompt-mode must be full|short|none|mix, got ${JSON.stringify(v)}`);
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

function pickSystemPromptMode(mode: Args["systemPromptMode"], rng: () => number): SystemPromptMode {
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
  throw new Error(`${label} failed after ${MAX_TRANSPORT_RETRIES} retries: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

async function genText(model: string, spec: RowSpec, temperature: number): Promise<{ text: string; ms: number }> {
  const { system, user } = buildTextPrompt(spec);
  const { content, ms } = await withRetry(
    () =>
      chatCompletion({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature,
        // hard-25 texts average 58 chars, max 87 — 256 tokens is generous.
        maxTokens: 256,
        timeoutMs: TEXT_TIMEOUT_MS,
      }),
    "text generation",
  );
  const text = content.trim().replace(/^["'`]+|["'`]+$/g, "").split("\n")[0]?.trim() ?? "";
  return { text, ms };
}

/** The text must contain exactly the amounts the spec ordered — no more, no fewer. */
function guardSpecBijection(text: string, spec: RowSpec): void {
  const want = [...expectedTextAmounts(spec)].sort((a, b) => a - b);
  const got = [...tokenizeAmounts(text).map((a) => a.value)].sort((a, b) => a - b);
  if (want.length !== got.length || want.some((v, i) => v !== got[i])) {
    throw new RejectError(
      "text:bijection",
      `text amounts ${JSON.stringify(got)} != spec amounts ${JSON.stringify(want)}`,
    );
  }
}

async function attemptRow(args: Args, spec: RowSpec): Promise<RawRow> {
  const { text, ms: textMs } = await genText(args.model, spec, args.textTemperature);
  if (text.length < 3) throw new RejectError("text:bijection", "teacher returned an empty message");

  assertNoLeak(text);
  guardSpecBijection(text, spec);

  // Blind: the label call sees only the text — never the spec, never the cell.
  const { parsed, path, ms: labelMs } = await withRetry(
    () => parseMessage(args.model, text, { noFallback: true, abortSignal: AbortSignal.timeout(LABEL_TIMEOUT_MS) }),
    "labeling",
  );
  // noFallback should make this unreachable; belt-and-braces, because the plain-json path
  // runs parseFinanceJson, whose coercers mint schema-valid WRONG labels.
  if (path !== "structured") throw new RejectError("label:plain-json", "label did not come from the structured path");

  const { traceTiers } = validateRow({
    text,
    label: parsed,
    spec: spec.expectation,
    shape: { allowDuplicateEntries: spec.allowDuplicateEntries },
    excusedByConstruction: excusedByConstruction(spec),
  });

  return {
    planIndex: spec.planIndex,
    cellId: spec.cell.id,
    aspect: spec.cell.aspect,
    tier: spec.cell.tier,
    split: spec.cell.split,
    text,
    label: parsed,
    meta: {
      traceTiers,
      maxSimilarity: maxSimilarity(text),
      // Derived from the row's own seed, never the shared plan RNG: workers finish out of
      // order, so a shared generator would hand out modes in completion order and the same
      // seed would stop reproducing the same corpus.
      systemPromptMode: pickSystemPromptMode(args.systemPromptMode, mulberry32(args.seed ^ spec.planIndex)),
      teacher: args.model,
      textMs,
      labelMs,
    },
  };
}

/** Expand cells into a flat plan: one entry per row, deterministic, drawn before any worker runs. */
function drawPlan(cells: Cell[], count: number, multiplier: number, rng: () => number): RowSpec[] {
  const plan: RowSpec[] = [];
  for (const cell of cells) {
    for (let r = 0; r < cell.rows; r++) plan.push(cellToSpec(cell, plan.length));
  }
  // Shuffle so a partial run still covers the taxonomy broadly instead of the first aspects only.
  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = plan[i]!, b = plan[j]!;
    plan[i] = b; plan[j] = a;
  }
  return plan.slice(0, count * multiplier).map((s, i) => ({ ...s, planIndex: i }));
}

async function selfTest(): Promise<void> {
  const { HARD_SCENARIOS } = await import("./eval-hard-25.ts");
  const { traceAmount, unexcusedAtoms } = await import("../src/core/rupiah.ts");
  let direct = 0, total = 0, falseReject = 0;

  for (const s of HARD_SCENARIOS) {
    const atoms = tokenizeAmounts(s.text);
    for (const e of s.expectEntries) {
      total++;
      if (traceAmount(e.jumlah, atoms).tier === "direct") direct++;
      else console.log(`  MISS ${s.id}: ${e.jumlah}`);
    }
    const unexcused = unexcusedAtoms(s.text, atoms, new Set(s.expectEntries.map((e) => e.jumlah)));
    if (unexcused.length > 0) {
      falseReject++;
      console.log(`  FALSE REJECT ${s.id}: ${unexcused.map((u) => u.atom.raw).join(", ")}`);
    }
  }

  console.log(`\nself-test over ${HARD_SCENARIOS.length} hand-authored scenarios:`);
  console.log(`  forward trace : ${direct}/${total} direct`);
  console.log(`  reverse gate  : ${falseReject} false rejects`);
  const ok = direct === total && falseReject === 0;
  console.log(ok ? "\nPASS — validators are safe as hard gates." : "\nFAIL — validators would gut the corpus.");
  if (!ok) process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  applyLlmConfigOverrides({ baseUrl: args.baseUrl, apiKey: args.apiKey });

  if (args.selfTest) return selfTest();

  const cells = buildTaxonomy(args.seed);
  const stats = taxonomyStats(cells);
  const rng = mulberry32(args.seed);
  const plan = drawPlan(cells, args.count, args.attemptMultiplier, rng);

  console.log(`SFT generate — teacher=${args.model}`);
  console.log(`Base URL: ${getLlmConfig().baseURL}`);
  console.log(`Taxonomy: ${cells.length} cells · plan ${plan.length} attempts for ${args.count} accepted rows`);
  console.log(`Seed: ${args.seed} · concurrency ${args.concurrency} · system-prompt ${args.systemPromptMode}\n`);

  if (args.dryRun) {
    console.log("Realized marginals:");
    console.log(JSON.stringify(stats, null, 2).slice(0, 2400));
    console.log("\nSample plan entries:");
    for (const s of plan.slice(0, 8)) {
      const { user } = buildTextPrompt(s);
      console.log(`\n[${s.planIndex}] ${s.cell.aspect} (${s.cell.split}) — expects ${JSON.stringify(s.expectation.alternatives[0]?.map((e) => `${e.direction}:${e.amount}`))}`);
      console.log(user.split("\n").map((l) => `    ${l}`).join("\n"));
    }
    return;
  }

  const stamp = args.stamp || new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const outDir = resolve(args.outRoot, stamp);
  const rawPath = resolve(outDir, "raw.jsonl");
  const rejectsPath = resolve(outDir, "rejects.jsonl");

  // Preflight — nothing is written until the teacher is proven reachable and capable.
  // The old generator truncated its output before the first call, so a dead server
  // destroyed the previous corpus.
  let models: string[];
  try {
    models = await listModels({ timeoutMs: 10_000 });
  } catch (err) {
    console.error(`FATAL: cannot reach the OpenAI-compatible server at ${getLlmConfig().baseURL}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    console.error("\nStart LM Studio → Developer → Server, or pass --base-url.");
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
  });
  if (probe.path !== "structured") {
    console.error("FATAL: teacher cannot produce structured output; a coerced label would be minted as gold.");
    process.exit(1);
  }
  console.log(`Preflight OK (structured output in ${probe.ms}ms)\n`);

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
    console.error(`FATAL: ${rawPath} already has ${raw.count} rows. Pass --resume to extend it, or --overwrite to replace it.`);
    process.exit(1);
  }
  const rejects = new RejectSink(rejectsPath);
  const done = args.resume ? raw.donePlanIndexes : new Set<number>();

  const seenTexts = new Set(raw.all.map((r) => r.text.toLowerCase()));
  const rerolls = new Map<string, number>();
  const rejectsByPhase: Record<string, number> = {};
  let cursor = 0;
  let accepted = raw.count;
  let aborted: Error | null = null;
  const t0 = Date.now();

  // Index-cursor worker pool, mirroring src/agentic/runner.ts.
  async function worker(): Promise<void> {
    for (;;) {
      if (aborted || accepted >= args.count) return;
      const idx = cursor++;
      if (idx >= plan.length) return;
      const spec = plan[idx]!;
      if (done.has(spec.planIndex)) continue;

      try {
        const row = await attemptRow(args, spec);
        const key = row.text.toLowerCase();
        if (seenTexts.has(key)) {
          rejectsByPhase.dedup = (rejectsByPhase.dedup ?? 0) + 1;
          rejects.write({ planIndex: spec.planIndex, cellId: spec.cell.id, phase: "dedup", message: "duplicate text", text: row.text });
          continue;
        }
        seenTexts.add(key);
        raw.append(row);
        accepted++;
        const rate = accepted / ((Date.now() - t0) / 60_000);
        process.stdout.write(`  [${accepted}/${args.count}] ${spec.cell.aspect.padEnd(28)} ${rate.toFixed(1)}/min  ${row.text.slice(0, 44)}\n`);
      } catch (err) {
        const cls = classify(err);
        if (cls === "fatal") {
          aborted = err instanceof Error ? err : new Error(String(err));
          return;
        }
        const phase: string = err instanceof RejectError ? err.phase : err instanceof LeakError ? "text:leak" : "transport";
        rejectsByPhase[phase] = (rejectsByPhase[phase] ?? 0) + 1;
        rejects.write({
          planIndex: spec.planIndex,
          cellId: spec.cell.id,
          phase,
          message: err instanceof Error ? err.message : String(err),
          issues: err instanceof RejectError ? err.issues : undefined,
        });
        // Re-roll the cell rather than burning the slot: burning it lets systematically hard
        // cells (slang, qty×unit) vanish silently, shipping a student blind to exactly those.
        const n = (rerolls.get(spec.cell.id) ?? 0) + 1;
        rerolls.set(spec.cell.id, n);
        if (n <= MAX_CELL_REROLLS) plan.push({ ...spec, planIndex: plan.length });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(args.concurrency, plan.length) }, () => worker()));

  if (aborted) {
    console.error(`\nFATAL: ${(aborted as Error).message}`);
    console.error("Run aborted — every row would fail identically. raw.jsonl is intact.");
    process.exit(1);
  }

  const rows = raw.all;
  const attempts = accepted + Object.values(rejectsByPhase).reduce((a, b) => a + b, 0);
  const successRate = attempts > 0 ? accepted / attempts : 0;

  const perCellAccept: Record<string, number> = {};
  for (const c of cells) {
    const got = rows.filter((r) => r.cellId === c.id).length;
    const rj = rerolls.get(c.id) ?? 0;
    if (got + rj > 0) perCellAccept[c.id] = Number((got / (got + rj)).toFixed(3));
  }
  const weakCells = Object.entries(perCellAccept).filter(([, v]) => v < 0.9).sort((a, b) => a[1] - b[1]);

  const sims = rows.map((r) => r.meta.maxSimilarity).sort((a, b) => a - b);
  const pct = (p: number) => (sims.length ? Number((sims[Math.floor(sims.length * p)] ?? 0).toFixed(3)) : 0);
  const traceHist: Record<string, number> = {};
  for (const r of rows) for (const t of r.meta.traceTiers) traceHist[t] = (traceHist[t] ?? 0) + 1;
  const modeHist: Record<string, number> = {};
  for (const r of rows) modeHist[r.meta.systemPromptMode] = (modeHist[r.meta.systemPromptMode] ?? 0) + 1;

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
  const zeroYieldAspects = [...new Set(cells.map((c) => c.aspect))].filter((a) => !realizedAspect[a]);

  const { gitSha, dirty } = gitProvenance();
  const manifest = {
    bench: "chat-keuangan-sft-parse",
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    teacher: args.model,
    baseURL: getLlmConfig().baseURL,
    seed: args.seed,
    textTemperature: args.textTemperature,
    labelTemperature: 0,
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
      nonTransactionRowShare: rows.length ? Number((nonTxRows / rows.length).toFixed(3)) : 0,
      entryLevelPemasukanShare: entriesTotal ? Number((entriesMasuk / entriesTotal).toFixed(3)) : 0,
      dateHint: realizedDateHint,
    },
    counts: { accepted, attempts, successRate: Number(successRate.toFixed(3)) },
    rejectsByPhase,
    perCellAcceptRate: perCellAccept,
    weakCells: weakCells.slice(0, 20).map(([id, v]) => ({ id, acceptRate: v })),
    traceTierHistogram: traceHist,
    maxSimilarityVsScoredCorpus: { p50: pct(0.5), p95: pct(0.95), max: sims[sims.length - 1] ?? 0 },
    mlxCommand: `mlx_lm.lora --train --data ${outDir} --mask-prompt --model Qwen/Qwen3-1.7B --batch-size 4 --num-layers -1`,
  };

  const publishDir = resolve(import.meta.dirname, "../docs/results/sft");
  const { counts } = writeRun({ outDir, rows, fullSystemPrompt: SYSTEM_PROMPT, manifest, publishDir, stamp });

  console.log(`\n${"=".repeat(64)}`);
  console.log(`Accepted ${accepted}/${args.count} · success rate ${(successRate * 100).toFixed(1)}%`);
  console.log(`Splits: train=${counts.train} valid=${counts.valid} test=${counts.test}`);
  console.log(`Rejects by phase: ${JSON.stringify(rejectsByPhase)}`);
  console.log(`Trace tiers: ${JSON.stringify(traceHist)}`);
  console.log(`Realized entry-level pemasukan: ${((entriesMasuk / Math.max(entriesTotal, 1)) * 100).toFixed(1)}% (target 23%, hard-25 baseline 8.9%)`);
  console.log(`Realized non-transaction rows: ${((nonTxRows / Math.max(rows.length, 1)) * 100).toFixed(1)}% (target ~12%)`);
  if (zeroYieldAspects.length > 0) {
    console.error(`\n${zeroYieldAspects.length} aspects yielded ZERO rows — the student will be blind to them:`);
    for (const a of zeroYieldAspects) console.error(`  ${a}`);
  }
  console.log(`Max similarity vs scored corpus: p50=${pct(0.5)} p95=${pct(0.95)} max=${sims[sims.length - 1] ?? 0}`);
  if (weakCells.length > 0) {
    console.log(`\n${weakCells.length} cells accepted below 90% — the teacher is weak there; hand-label or drop:`);
    for (const [id, v] of weakCells.slice(0, 10)) console.log(`  ${(v * 100).toFixed(0)}%  ${id}`);
  }
  console.log(`\nCorpus: ${outDir}`);
  console.log(`Train with:\n  ${manifest.mlxCommand}`);

  if (accepted < args.count) {
    console.error(`\nShortfall: wanted ${args.count}, got ${accepted}. Plan exhausted.`);
    process.exit(1);
  }
  if (successRate < args.minSuccessRate) {
    console.error(`\nSuccess rate ${(successRate * 100).toFixed(1)}% is below --min-success-rate ${args.minSuccessRate}.`);
    process.exit(1);
  }
}

main().catch((e) => {
  if (e instanceof UsageError) {
    console.error(`usage: ${e.message}`);
    process.exit(1);
  }
  console.error(e);
  process.exit(1);
});
