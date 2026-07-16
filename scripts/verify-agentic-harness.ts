/**
 * Verification harness:
 * 1) All tools smoke
 * 2) Multi-model one-turn response
 * 3) Judge stability — same fixed transcript scored N times
 *
 *   bun run scripts/verify-agentic-harness.ts
 */

import { config } from "dotenv";
import { resolve } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  ensureDefaultFixtures,
  createSandbox,
  closeSandbox,
  resolveSandboxPath,
} from "../src/agentic/sandbox";
import { createAgenticTools } from "../src/agentic/tools";
import { createFinanceAgent } from "../src/agentic/agent";
import { scoreStepQuality, scoreRubric, JUDGE_MODEL_ID } from "../src/agentic/judge";
import type { LedgerRow, ToolCallRecord, TurnTrace } from "../src/agentic/types";
import { existsSync } from "node:fs";

config({ path: resolve(import.meta.dirname, "../.env") });

const MODELS = [
  process.env.EVAL_MODEL?.trim() || process.env.STUDIO_MODEL?.trim() || "local-model",
];

const JUDGE_REPEATS = 5;

/** The subset of a tool result this harness actually inspects. */
type ToolOutcome = { ok?: boolean; error?: string; refused?: boolean };

/**
 * Narrow an unknown tool result down to the fields this harness checks.
 *
 * Why this exists: in @mastra/core 1.50.1 a tool's execute signature is
 *   `execute?: (inputData: TSchemaIn, context: TContext) => Promise<TSchemaOut | ValidationError | void>`
 * and `createTool` binds `TSchemaOut = InferSchema<TOutputSchema>`. The execute function's own
 * return type is not a type parameter, so it is never inferred from the implementation. Our tools
 * in src/agentic/tools/index.ts declare no `outputSchema`, so `TOutputSchema` falls back to
 * `undefined` and `InferSchema<undefined>` resolves to `unknown` — erasing the concrete
 * `{ ok, error, refused, ... }` object each tool really returns. Adding an `outputSchema` there
 * would fix the types but would also switch on Mastra's runtime output validation, so the erasure
 * is narrowed back here instead: one runtime-checked boundary rather than 11 call-site casts.
 */
function readToolOutcome(out: unknown): ToolOutcome {
  if (typeof out !== "object" || out === null) return {};
  // Safe after the object check above: reading unknown keys off a non-null object.
  const rec = out as Record<string, unknown>;
  return {
    ok: typeof rec.ok === "boolean" ? rec.ok : undefined,
    error: typeof rec.error === "string" ? rec.error : undefined,
    refused: typeof rec.refused === "boolean" ? rec.refused : undefined,
  };
}

async function testTools() {
  console.log("\n=== 1) TOOL SMOKE ===");
  await ensureDefaultFixtures();
  const sandbox = await createSandbox("verify-tools", {
    seedFiles: [
      { from: "csv/mutasi.csv", to: "in/mutasi.csv" },
      { from: "pdf/rekening.pdf", to: "in/rekening.pdf" },
    ],
  });
  const tools = createAgenticTools(sandbox);
  const ctx = { toolCallId: "v", messages: [], suspend: async () => {} } as never;
  const rows: Array<{ tool: string; ok: boolean; note: string }> = [];

  // Tool execute() is typed Promise<unknown> by Mastra (see readToolOutcome); the loop below
  // narrows each result once via readToolOutcome rather than asserting a shape per case.
  const cases: Array<[string, () => Promise<unknown>]> = [
    [
      "list_inbox",
      () => tools.list_inbox.execute!({}, ctx),
    ],
    [
      "firecrawl_search_refuse_nota",
      async () => {
        const out = readToolOutcome(
          await tools.firecrawl_search.execute!({ query: "cari nota Indomaret", limit: 1 }, ctx),
        );
        // Pass if tool correctly refuses receipt-hunting
        return { ok: out.ok === false && out.refused === true, error: out.error };
      },
    ],
    [
      "firecrawl_search_ok_info",
      () => tools.firecrawl_search.execute!({ query: "biaya admin transfer BCA 2026", limit: 1 }, ctx),
    ],
    ["firecrawl_scrape", () => tools.firecrawl_scrape.execute!({ url: "https://example.com" }, ctx)],
    [
      "sqlite_exec",
      () =>
        tools.sqlite_exec.execute!(
          {
            sql: "INSERT INTO ledger (type,jumlah,deskripsi,source) VALUES ('pengeluaran',50000,'bensin','test')",
          },
          ctx,
        ),
    ],
    ["sqlite_query", () => tools.sqlite_query.execute!({ sql: "SELECT COUNT(*) as n FROM ledger" }, ctx)],
    ["ledger_summary", () => tools.ledger_summary.execute!({}, ctx)],
    ["csv_read", () => tools.csv_read.execute!({ path: "in/mutasi.csv" }, ctx)],
    [
      "csv_write",
      () =>
        tools.csv_write.execute!(
          {
            path: "out/v.csv",
            headers: ["type", "jumlah"],
            rows: [{ type: "pengeluaran", jumlah: 50000 }],
          },
          ctx,
        ),
    ],
    ["pdf_read", () => tools.pdf_read.execute!({ path: "in/rekening.pdf" }, ctx)],
    [
      "pdf_write",
      () =>
        tools.pdf_write.execute!(
          { path: "out/v.pdf", title: "V", lines: ["ok"] },
          ctx,
        ),
    ],
    [
      "receipt_ocr",
      () =>
        tools.receipt_ocr.execute!(
          {
            imageUrl: "in/nota-indomaret.png",
          },
          ctx,
        ),
    ],
  ];

  for (const [name, fn] of cases) {
    try {
      const out = await fn();
      // `out` is kept raw for the String(...) fallback below so the note text is unchanged.
      const outcome = readToolOutcome(out);
      const ok = outcome.ok !== false;
      rows.push({ tool: name, ok, note: ok ? "pass" : String(outcome.error ?? out) });
      console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${outcome.error}`}`);
    } catch (e) {
      rows.push({ tool: name, ok: false, note: String(e) });
      console.log(`  FAIL ${name} — ${e}`);
    }
  }

  const filesOk =
    existsSync(resolveSandboxPath(sandbox, "out/v.csv")) &&
    existsSync(resolveSandboxPath(sandbox, "out/v.pdf"));
  closeSandbox(sandbox);
  return { rows, filesOk, pass: rows.filter((r) => r.ok).length, total: rows.length };
}

async function testModels() {
  console.log("\n=== 2) MODEL RESPONSE (1 turn each) ===");
  const prompt = "catat beli kopi 18rb tadi. tulis ke ledger pakai sqlite_exec.";
  const rows: Array<{
    model: string;
    ok: boolean;
    textLen: number;
    toolCalls: number;
    ledgerRows: number;
    ms: number;
    error: string | null;
  }> = [];

  for (const modelId of MODELS) {
    const t0 = Date.now();
    try {
      const sandbox = await createSandbox(`verify-model-${modelId.replace(/\//g, "-")}`);
      const { agent } = createFinanceAgent({ modelId, sandbox });
      const gen = await agent.generate(prompt, {
        maxSteps: 6,
        memory: {
          thread: `t-${modelId.replace(/\//g, "-")}`,
          resource: "verify",
        },
      });
      const text =
        typeof (gen as { text?: string }).text === "string"
          ? (gen as { text: string }).text
          : JSON.stringify(gen).slice(0, 500);
      const ledger = sandbox.db.all<{ id: number }>("SELECT id FROM ledger");
      const toolCalls = sandbox.toolLog.length;
      const ok = text.length > 0;
      rows.push({
        model: modelId,
        ok,
        textLen: text.length,
        toolCalls,
        ledgerRows: ledger.length,
        ms: Date.now() - t0,
        error: null,
      });
      console.log(
        `  ${ok ? "PASS" : "FAIL"} ${modelId} text=${text.length} tools=${toolCalls} ledger=${ledger.length} ${Date.now() - t0}ms`,
      );
      console.log(`         reply: ${text.replace(/\n/g, " ").slice(0, 120)}`);
      closeSandbox(sandbox);
    } catch (e) {
      rows.push({
        model: modelId,
        ok: false,
        textLen: 0,
        toolCalls: 0,
        ledgerRows: 0,
        ms: Date.now() - t0,
        error: e instanceof Error ? e.message : String(e),
      });
      console.log(`  FAIL ${modelId} — ${e instanceof Error ? e.message : e}`);
    }
  }
  return rows;
}

/** Fixed golden transcript — identical input for all judge repeats. */
function goldenJudgeInput(): {
  scenarioId: string;
  judgeFocus: string;
  turns: TurnTrace[];
  ledger: LedgerRow[];
  toolLog: ToolCallRecord[];
} {
  const turns: TurnTrace[] = [
    {
      turnIndex: 0,
      user: "ojek ke stasiun... 20rb... eh bukan, 35rb... iya 35rb deh tadi pagi. catat",
      assistantText:
        "Oke, saya catat pengeluaran ojek Rp 35.000 (pakai angka terakhir setelah koreksi).",
      toolCalls: [
        {
          toolName: "sqlite_exec",
          args: {
            sql: "INSERT INTO ledger (type,jumlah,deskripsi,tanggal_hint) VALUES ('pengeluaran',35000,'ojek','hari_ini')",
          },
          result: { ok: true, changes: 1 },
          turnIndex: 0,
        },
      ],
      ms: 1000,
    },
  ];
  // Must mirror the row the sqlite_exec INSERT above actually produces, since the real suite
  // feeds the judge `SELECT * FROM ledger` rows (asserts.ts readLedger). Verified against the
  // live schema in sandbox.ts: the INSERT names neither org_id nor tanggal, so org_id takes its
  // column default 'personal' (TEXT NOT NULL DEFAULT 'personal') and tanggal stays NULL.
  const ledger: LedgerRow[] = [
    {
      id: 1,
      org_id: "personal",
      type: "pengeluaran",
      jumlah: 35000,
      deskripsi: "ojek",
      tanggal_hint: "hari_ini",
      tanggal: null,
      vendor: null,
      source: null,
      ambigu: 0,
      catatan: null,
      created_at: "2026-07-09",
    },
  ];
  const toolLog: ToolCallRecord[] = turns[0]!.toolCalls;
  return {
    scenarioId: "mt-voice-correction-chain",
    judgeFocus: "Last corrected number wins.",
    turns,
    ledger,
    toolLog,
  };
}

async function testJudgeStability() {
  console.log(`\n=== 3) JUDGE STABILITY (${JUDGE_REPEATS}× same transcript) ===`);
  console.log(`  Judge: ${JUDGE_MODEL_ID}`);
  const golden = goldenJudgeInput();
  const stepScores: number[] = [];
  const rubricScores: number[] = [];
  const flagSets: string[] = [];
  const errors: string[] = [];

  for (let i = 1; i <= JUDGE_REPEATS; i++) {
    process.stdout.write(`  run ${i}/${JUDGE_REPEATS} ... `);
    try {
      const [step, rubric] = await Promise.all([
        scoreStepQuality(golden),
        scoreRubric({
          criteria: [
            { id: "final", description: "Only final corrected amount 35000 posted", required: true },
            { id: "no20", description: "20000 must not appear as posted amount", required: true },
          ],
          ...golden,
        }),
      ]);
      stepScores.push(step.score);
      rubricScores.push(rubric.score);
      const flagKey = step.flags
        ? [
            step.flags.tool_selection,
            step.flags.tool_order,
            step.flags.no_hallucinated_amounts,
            step.flags.money_direction_correct,
            step.flags.confirm_on_ambiguity,
            step.flags.no_premature_post,
            step.flags.indonesian_ux_ok,
          ].join("")
        : "null";
      flagSets.push(flagKey);
      console.log(`step=${step.score} rub=${rubric.score} flags=${flagKey}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(msg);
      console.log(`ERROR ${msg.slice(0, 100)}`);
    }
  }

  const uniqStep = [...new Set(stepScores)];
  const uniqRub = [...new Set(rubricScores)];
  const uniqFlags = [...new Set(flagSets)];
  const stepRange =
    stepScores.length > 0 ? Math.max(...stepScores) - Math.min(...stepScores) : -1;
  const rubRange =
    rubricScores.length > 0 ? Math.max(...rubricScores) - Math.min(...rubricScores) : -1;

  const stable =
    errors.length === 0 &&
    uniqStep.length === 1 &&
    uniqRub.length === 1 &&
    uniqFlags.length === 1;

  console.log(
    `  unique step scores: [${uniqStep.join(", ")}] range=${stepRange}`,
  );
  console.log(
    `  unique rubric scores: [${uniqRub.join(", ")}] range=${rubRange}`,
  );
  console.log(`  unique flag patterns: ${uniqFlags.length} → ${uniqFlags.join(" | ")}`);
  console.log(`  verdict: ${stable ? "STABLE" : "UNSTABLE / AMBIGUOUS"}`);

  return {
    stepScores,
    rubricScores,
    flagSets,
    uniqStep,
    uniqRub,
    uniqFlags,
    stepRange,
    rubRange,
    stable,
    errors,
  };
}

async function main() {
  const tools = await testTools();
  const models = await testModels();
  const judge = await testJudgeStability();

  const outDir = resolve(import.meta.dirname, "../docs/results/agentic");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const path = resolve(outDir, `${stamp}-harness-verify.json`);
  const payload = {
    at: new Date().toISOString(),
    tools,
    models,
    judge,
  };
  writeFileSync(path, JSON.stringify(payload, null, 2));

  console.log("\n=== VERDICT ===");
  console.log(`Tools:  ${tools.pass}/${tools.total} pass (filesOk=${tools.filesOk})`);
  console.log(
    `Models: ${models.filter((m) => m.ok).length}/${models.length} responded`,
  );
  console.log(
    `Judge:  ${judge.stable ? "STABLE" : "UNSTABLE"} (step range ${judge.stepRange}, rub range ${judge.rubRange})`,
  );
  console.log(`Report: ${path}`);

  if (tools.pass < tools.total || models.some((m) => !m.ok) || !judge.stable) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
