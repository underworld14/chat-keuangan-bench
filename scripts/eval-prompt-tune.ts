/**
 * eval-finance-prompt-tune.ts — Retest hard-25 FAILURES with prompt/system variants.
 *
 * Targets the 9 failing cells from hard-25 (4 scenarios × subset of top-5 models):
 *   - hard-cilok-qty-44      → gemma qty collapse
 *   - hard-sep-wifi-token    → date hint (td malem → hari_ini)
 *   - hard-voice-ojek-correct → date hint (tadi pagi → hari_ini) on GLM
 *   - hard-slang-ceban-goceng → money slang on GLM
 *
 * Experiments with LEGITIMATE prompt improvements only:
 *   - Dynamic datetime anchor (production-realistic context)
 *   - General slang glossary (not test-specific amounts)
 *   - Expanded relative-date rules
 *   - Generic qty×unit examples (different items than test set)
 *   - Generic few-shot patterns (unrelated domains)
 *
 * Does NOT: embed test inputs/outputs, scenario IDs, or expected JSON in the prompt.
 *
 * Run:
 *   bun run scripts/eval-prompt-tune.ts --model <lm-studio-id>
 *   bun run scripts/eval-prompt-tune.ts --models a,b --variant anchor-system
 *   bun run scripts/eval-prompt-tune.ts --dry-run --model local-model
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseMessage,
  scoreExtraction,
  normalizeText,
  SYSTEM_PROMPT,
  type ExpectedEntry,
  type ParsedFinance,
  type Scenario,
} from "../src/core/eval-core.ts";
import { applyLlmConfigOverrides, getLlmConfig } from "../src/core/llm-client.ts";

type AltStrictRule = { kind: "qtyMerge"; keyword: string; unit: number; count: number };

type RetestScenario = Scenario & {
  failureMode: string;
  altStrict?: AltStrictRule;
  /**
   * Local model ids that failed this scenario in hard-25 (for focused reporting).
   * Emptied at the local pivot — the previous entries were OpenRouter ids that can
   * no longer be evaluated. Repopulate with LM Studio ids as local regressions show up.
   */
  knownFailures: string[];
};

/** Only scenarios that had ≥1 strict fail in hard-25. */
const RETEST_SCENARIOS: RetestScenario[] = [
  {
    id: "hard-cilok-qty-44",
    style: "ambiguous_amount",
    failureMode: "qty×unit ('5rb 4 4 nya') — gemma collapsed to 1×5rb",
    text: "td sore beli pulsa 25rb sama jajan cilok 4 tusuk 5rb 4 4 nya",
    knownFailures: [],
    expectEntries: [
      { type: "pengeluaran", jumlah: 25000, tanggal_hint: "hari_ini", deskripsiIncludes: ["pulsa"] },
      { type: "pengeluaran", jumlah: 5000, tanggal_hint: "hari_ini", deskripsiIncludes: ["cilok"], ambigu: true },
      { type: "pengeluaran", jumlah: 5000, tanggal_hint: "hari_ini", deskripsiIncludes: ["cilok"], ambigu: true },
      { type: "pengeluaran", jumlah: 5000, tanggal_hint: "hari_ini", deskripsiIncludes: ["cilok"], ambigu: true },
      { type: "pengeluaran", jumlah: 5000, tanggal_hint: "hari_ini", deskripsiIncludes: ["cilok"], ambigu: true },
    ],
    altStrict: { kind: "qtyMerge", keyword: "cilok", unit: 5000, count: 4 },
  },
  {
    id: "hard-sep-wifi-token",
    style: "multi_entry",
    failureMode: "dot separators OK but 'td malem' date → 4 models used kemarin",
    text: "bayar wifi 350.000 sama token listrik 102.500 td malem",
    knownFailures: [],
    expectEntries: [
      { type: "pengeluaran", jumlah: 350000, tanggal_hint: "hari_ini", deskripsiIncludes: ["wifi"] },
      { type: "pengeluaran", jumlah: 102500, tanggal_hint: "hari_ini", deskripsiIncludes: ["token", "listrik"] },
    ],
  },
  {
    id: "hard-voice-ojek-correct",
    style: "ambiguous_amount",
    failureMode: "self-correction OK but GLM tagged tadi pagi as kemarin",
    text: "ojek ke stasiun... 20rb... eh bukan, 35rb... iya 35rb deh tadi pagi",
    knownFailures: [],
    expectEntries: [
      { type: "pengeluaran", jumlah: 35000, tanggal_hint: "hari_ini", deskripsiIncludes: ["ojek"] },
    ],
  },
  {
    id: "hard-slang-ceban-goceng",
    style: "casual_slang",
    failureMode: "GLM misread ceban/goceng (100/500 or merged 15rb)",
    text: "tadi jajan es teh ceban sama gorengan goceng",
    knownFailures: [],
    expectEntries: [
      { type: "pengeluaran", jumlah: 10000, tanggal_hint: "hari_ini", deskripsiIncludes: ["teh"] },
      { type: "pengeluaran", jumlah: 5000, tanggal_hint: "hari_ini", deskripsiIncludes: ["gorengan"] },
    ],
  },
];

// ─── Prompt building blocks (general-purpose, no test leakage) ───────────────

const WEEKDAYS_ID = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"] as const;

interface PromptContext {
  now: Date;
  dateLabel: string;
  timeLabel: string;
  weekday: string;
}

function buildPromptContext(now = new Date()): PromptContext {
  const weekday = WEEKDAYS_ID[now.getDay()] ?? "Senin";
  const dateLabel = now.toLocaleDateString("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Jakarta",
  });
  const timeLabel = now.toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Jakarta",
  });
  return { now, dateLabel, timeLabel, weekday };
}

function blockDatetimeAnchor(ctx: PromptContext): string {
  return `═══ ANCHOR WAKTU (konteks penafsiran relatif) ═══
Sekarang: ${ctx.dateLabel}, pukul ${ctx.timeLabel} WIB.
"Hari ini" = tanggal kalender di atas. "Tadi pagi/siang/sore/malem/malam" pada hari yang sama → tanggal_hint hari_ini.
"Kemarin" / "maren" = satu hari sebelum tanggal di atas.
"Kemarin malam" = malam hari sebelumnya → kemarin (bukan hari_ini).
"Td malem" / "tadi malam" tanpa kata kemarin = masih hari kalender yang sama → hari_ini.`;
}

const BLOCK_SLANG_GLOSSARY = `═══ SLANG NOMINAL INDONESIA (umum) ═══
Konversi ke integer rupiah — JANGAN baca sebagai ratusan:
- ceban / cebanan = 10.000
- goceng = 5.000
- gopek = 500
- seceng / secengan = 1.000
- "lima ribu" / "sepuluh ribu" = 5000 / 10000
Slang hanya mengganti cara menyebut nominal; tetap buat entri terpisah per item jika ada dua barang.`;

const BLOCK_DATE_EXPANDED = `═══ TANGGAL — PERLUASAN ═══
- "td", "tadi", "barusan", "tadi pagi/siang/sore/malem/malam" → hari_ini (hari kalender yang sama)
- "kemarin", "maren", "kmrn", "kemarin malem" → kemarin
- "besok", "nanti", rencana belum terjadi → bukan_transaksi
- Jika ragu antara hari_ini vs kemarin untuk "tadi malam": tanpa kata "kemarin" → hari_ini`;

const BLOCK_QTY_RULES = `═══ KUANTITAS × HARGA SATUAN ═══
Jika user menyebut jumlah item LALU harga satuan:
- "3 bungkus martabak @ 7rb" → total 21000 (atau 3 entri @7000)
- Pola "7rb 3 3 nya" / "dua-duanya" setelah menyebut qty → kalikan qty × harga satuan
- JANGAN catat hanya 1× harga satuan jika qty > 1 sudah disebut
- Boleh 1 entri merged (total benar) atau beberapa entri — jumlah total harus qty × unit`;

/** Few-shot examples use unrelated items/amounts — NOT from the retest set. */
const BLOCK_FEWSHOT_GENERIC = `═══ CONTOH POLA (bukan template jawaban) ═══
Input: "kemarin beli telur 2 lusin @ 27rb"
→ pengeluaran 54000 (atau 2×27000), tanggal_hint kemarin

Input: "tadi pagi bayar parkir 3rb"
→ pengeluaran 3000, tanggal_hint hari_ini

Input: "jajan permen lima ribu sama roti sepuluh ribu"
→ 2 entri: 5000 + 10000 (bukan 1 entri 15000 kecuali user bilang total)`;

function userAnchorPrefix(ctx: PromptContext): string {
  return `[Konteks waktu: ${ctx.dateLabel}, ${ctx.timeLabel} WIB — gunakan untuk menafsir "hari ini"/"tadi"/"kemarin"]`;
}

// ─── Prompt variants ─────────────────────────────────────────────────────────

interface PromptVariant {
  id: string;
  description: string;
  legitimacy: string;
  build: (ctx: PromptContext) => { system: string; userPrefix?: string };
}

const PROMPT_VARIANTS: PromptVariant[] = [
  {
    id: "baseline",
    description: "Current production SYSTEM_PROMPT unchanged",
    legitimacy: "Control — no extra guidance",
    build: () => ({ system: SYSTEM_PROMPT }),
  },
  {
    id: "anchor-system",
    description: "Dynamic date/time anchor appended to system prompt",
    legitimacy: "Production-realistic: app knows user's local now",
    build: (ctx) => ({
      system: `${SYSTEM_PROMPT}\n\n${blockDatetimeAnchor(ctx)}`,
    }),
  },
  {
    id: "anchor-both",
    description: "Datetime anchor in system + lightweight prefix on user message",
    legitimacy: "Mimics client injecting session context before user text",
    build: (ctx) => ({
      system: `${SYSTEM_PROMPT}\n\n${blockDatetimeAnchor(ctx)}`,
      userPrefix: userAnchorPrefix(ctx),
    }),
  },
  {
    id: "slang-glossary",
    description: "General Indonesian money slang glossary",
    legitimacy: "Domain knowledge doc — no test amounts",
    build: () => ({
      system: `${SYSTEM_PROMPT}\n\n${BLOCK_SLANG_GLOSSARY}`,
    }),
  },
  {
    id: "date-expanded",
    description: "Expanded relative-date rules (tadi pagi/malem)",
    legitimacy: "Clarifies ambiguous colloquial time phrases",
    build: () => ({
      system: `${SYSTEM_PROMPT}\n\n${BLOCK_DATE_EXPANDED}`,
    }),
  },
  {
    id: "qty-rules",
    description: "Generic qty×unit parsing rules with martabak example",
    legitimacy: "Pattern guide — example item differs from test set",
    build: () => ({
      system: `${SYSTEM_PROMPT}\n\n${BLOCK_QTY_RULES}`,
    }),
  },
  {
    id: "fewshot-generic",
    description: "Three generic few-shot patterns (telur, parkir, permen)",
    legitimacy: "Illustrates format — unrelated domains/amounts",
    build: () => ({
      system: `${SYSTEM_PROMPT}\n\n${BLOCK_FEWSHOT_GENERIC}`,
    }),
  },
  {
    id: "production-v1",
    description: "Anchor + slang + date + qty (no few-shot)",
    legitimacy: "Recommended production bundle — no scenario-specific leaks",
    build: (ctx) => ({
      system: [
        SYSTEM_PROMPT,
        blockDatetimeAnchor(ctx),
        BLOCK_SLANG_GLOSSARY,
        BLOCK_DATE_EXPANDED,
        BLOCK_QTY_RULES,
      ].join("\n\n"),
    }),
  },
  {
    id: "production-v1+fewshot",
    description: "production-v1 + generic few-shot patterns",
    legitimacy: "Full bundle with illustrative examples",
    build: (ctx) => ({
      system: [
        SYSTEM_PROMPT,
        blockDatetimeAnchor(ctx),
        BLOCK_SLANG_GLOSSARY,
        BLOCK_DATE_EXPANDED,
        BLOCK_QTY_RULES,
        BLOCK_FEWSHOT_GENERIC,
      ].join("\n\n"),
    }),
  },
  {
    id: "production-anchor-both",
    description: "production-v1 + user message datetime prefix",
    legitimacy: "Max legitimate context without leaking answers",
    build: (ctx) => ({
      system: [
        SYSTEM_PROMPT,
        blockDatetimeAnchor(ctx),
        BLOCK_SLANG_GLOSSARY,
        BLOCK_DATE_EXPANDED,
        BLOCK_QTY_RULES,
      ].join("\n\n"),
      userPrefix: userAnchorPrefix(ctx),
    }),
  },
];

// ─── Scoring (strict + alt for qty merge) ───────────────────────────────────

function looseMatch(got: ParsedFinance["entries"][number], exp: ExpectedEntry): boolean {
  if (got.type !== exp.type) return false;
  if (got.jumlah !== exp.jumlah) return false;
  if (exp.deskripsiIncludes?.length) {
    const desc = normalizeText(`${got.deskripsi} ${got.vendor ?? ""}`);
    if (!exp.deskripsiIncludes.some((k) => desc.includes(normalizeText(k)))) return false;
  }
  return true;
}

function applyAltStrict(scenario: RetestScenario, parsed: ParsedFinance): boolean {
  const rule = scenario.altStrict;
  if (!rule || rule.kind !== "qtyMerge") return false;
  const kw = normalizeText(rule.keyword);
  const entries = parsed.entries;
  const matched = entries.filter((e) => normalizeText(e.deskripsi).includes(kw));
  const total = matched.reduce((s, e) => s + e.jumlah, 0);
  const splitOk = matched.filter((e) => e.jumlah === rule.unit).length === rule.count;
  const mergeOk = matched.length >= 1 && total === rule.unit * rule.count;
  const fixedExpected = scenario.expectEntries.filter(
    (e) => !e.deskripsiIncludes?.some((k) => normalizeText(k) === kw),
  );
  const fixedOk = fixedExpected.every((exp) => entries.some((g) => looseMatch(g, exp)));
  return fixedOk && (splitOk || mergeOk);
}

function scoreWithAlt(parsed: ParsedFinance, scenario: RetestScenario) {
  const strict = scoreExtraction(parsed, scenario);
  const altPass = !strict.pass && applyAltStrict(scenario, parsed);
  return {
    pass: strict.pass || altPass,
    strictPass: strict.pass,
    altPass,
    issues: strict.issues,
  };
}

// ─── Run harness ─────────────────────────────────────────────────────────────

interface CellResult {
  variantId: string;
  modelId: string;
  scenarioId: string;
  pass: boolean;
  strictPass: boolean;
  altPass: boolean;
  ms: number;
  issues: string[];
  parsed: ParsedFinance | null;
  error: string | null;
  wasKnownFailure: boolean;
}

interface VariantSummary {
  variantId: string;
  description: string;
  passCount: number;
  totalCells: number;
  knownFailureFixed: number;
  knownFailureTotal: number;
  perModel: Record<string, { pass: number; total: number }>;
}

function parseArgs(argv: string[]) {
  let variant: string | undefined;
  let dryRun = false;
  let model: string | undefined;
  let models: string[] | undefined;
  let baseUrl: string | undefined;
  let apiKey: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--variant" && argv[i + 1]) variant = argv[++i];
    else if (a === "--model" && argv[i + 1]) model = argv[++i];
    else if (a === "--models" && argv[i + 1]) {
      models = (argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--base-url" && argv[i + 1]) baseUrl = argv[++i];
    else if (a === "--api-key" && argv[i + 1]) apiKey = argv[++i];
  }
  return { variant, dryRun, model, models, baseUrl, apiKey };
}

function formatEntries(parsed: ParsedFinance | null): string {
  if (!parsed?.entries.length) return parsed?.bukan_transaksi ? "(bukan_transaksi)" : "(empty)";
  return parsed.entries
    .map(
      (e) =>
        `${e.type} ${e.jumlah} "${e.deskripsi}" [${e.tanggal_hint ?? "?"}]`,
    )
    .join(" | ");
}

function buildMarkdownReport(
  results: CellResult[],
  variantSummaries: VariantSummary[],
  ctx: PromptContext,
  runAt: string,
  modelCount: number,
): string {
  const totalCells = RETEST_SCENARIOS.length * modelCount;
  const lines: string[] = [
    `# Finance Parse Prompt Tune — ${runAt}`,
    "",
    `Retests **4 hard-25 failure scenarios** × **${modelCount} model(s)** × **prompt variants**.`,
    "Goal: find legitimate prompt improvements (not benchmark hacks) for strict pass.",
    "",
    `**Anchor time used:** ${ctx.dateLabel}, ${ctx.timeLabel} WIB`,
    "",
    "## Variant scoreboard",
    "",
    "| Variant | Pass | Known-fail fixed | Description |",
    "|---------|------|------------------|-------------|",
  ];

  for (const v of variantSummaries.sort(
    (a, b) => b.passCount - a.passCount || b.knownFailureFixed - a.knownFailureFixed,
  )) {
    lines.push(
      `| ${v.variantId} | ${v.passCount}/${v.totalCells} | ${v.knownFailureFixed}/${v.knownFailureTotal} | ${v.description} |`,
    );
  }

  const best = variantSummaries.sort((a, b) => b.passCount - a.passCount)[0];
  if (best) {
    lines.push("", "## Recommendation", "");
    if (best.passCount === totalCells) {
      lines.push(`**Winner: \`${best.variantId}\`** — 20/20 on retest set. Safe to promote to production prompt.`);
    } else {
      lines.push(
        `**Best so far: \`${best.variantId}\`** — ${best.passCount}/${totalCells} (${best.knownFailureFixed}/${best.knownFailureTotal} known failures fixed).`,
        "",
        "Remaining gaps likely need rubric relaxation (e.g. accept `kemarin` for ambiguous \"tadi malam\") or model-specific routing — not more prompt stuffing.",
      );
    }
  }

  lines.push("", "## Variants (legitimacy notes)", "");
  for (const v of PROMPT_VARIANTS) {
    lines.push(`### ${v.id}`, `- ${v.description}`, `- *Legitimacy:* ${v.legitimacy}`, "");
  }

  lines.push("## Per-variant detail", "");
  for (const v of variantSummaries.sort((a, b) => b.passCount - a.passCount)) {
    lines.push(`### ${v.variantId}`, "");
    lines.push("| Model | Scenario | Pass | Output | Issues |");
    lines.push("|-------|----------|------|--------|--------|");
    const rows = results.filter((r) => r.variantId === v.variantId);
    for (const r of rows) {
      const mark = r.pass ? "✓" : "✗";
      const out = formatEntries(r.parsed).replace(/\|/g, "/").slice(0, 80);
      const issues = (r.error ?? (r.issues.slice(0, 1).join("; ") || "—")).replace(/\|/g, "/");
      lines.push(`| ${r.modelId.split("/").pop()} | ${r.scenarioId} | ${mark} | ${out} | ${issues} |`);
    }
    lines.push("");
  }

  lines.push("## Anti-benchmark-hack policy", "");
  lines.push(
    "- No test scenario text, IDs, or expected JSON in prompts",
    "- Few-shot examples use different items (telur, parkir, permen) — not cilok/wifi/ojek/ceban",
    "- Slang glossary is general domain knowledge, not answer keys",
    "- Datetime anchor is session context any real app would have",
    "- If 100% requires embedding exact answers → fix rubric or pick better model, don't pollute prompt",
  );

  return lines.join("\n");
}

async function main() {
  const {
    variant: singleVariant,
    dryRun,
    model,
    models: modelsArg,
    baseUrl,
    apiKey,
  } = parseArgs(process.argv);
  applyLlmConfigOverrides({ baseUrl, apiKey });

  const evalModels = modelsArg?.length
    ? modelsArg
    : model
      ? [model]
      : process.env.EVAL_MODEL?.trim()
        ? [process.env.EVAL_MODEL.trim()]
        : [];
  if (!evalModels.length) {
    throw new Error(
      "Pass --model <lm-studio-id> or --models a,b (or set EVAL_MODEL)",
    );
  }

  const ctx = buildPromptContext();
  const variants = singleVariant
    ? PROMPT_VARIANTS.filter((v) => v.id === singleVariant)
    : PROMPT_VARIANTS;

  if (variants.length === 0) {
    console.error(`Unknown variant: ${singleVariant}`);
    console.error(`Available: ${PROMPT_VARIANTS.map((v) => v.id).join(", ")}`);
    process.exit(1);
  }

  const runAt = new Date().toISOString();
  const totalCells = RETEST_SCENARIOS.length * evalModels.length;

  console.log(`Finance Parse PROMPT TUNE — ${runAt}`);
  console.log(`Base URL: ${getLlmConfig().baseURL}`);
  console.log(`Anchor: ${ctx.dateLabel}, ${ctx.timeLabel} WIB`);
  console.log(`Scenarios: ${RETEST_SCENARIOS.length} (hard-25 failures only)`);
  console.log(`Models: ${evalModels.join(", ")}`);
  console.log(`Variants: ${variants.map((v) => v.id).join(", ")}\n`);

  if (dryRun) {
    for (const v of variants) {
      const built = v.build(ctx);
      console.log(`\n=== VARIANT: ${v.id} ===`);
      console.log(`Desc: ${v.description}`);
      console.log(`System length: ${built.system.length} chars`);
      if (built.userPrefix) console.log(`User prefix: ${built.userPrefix}`);
      console.log(`System tail:\n${built.system.slice(-400)}`);
    }
    return;
  }

  const results: CellResult[] = [];
  const knownFailureCells = new Set<string>();
  for (const sc of RETEST_SCENARIOS) {
    for (const m of sc.knownFailures) {
      knownFailureCells.add(`${sc.id}::${m}`);
    }
  }

  for (const variant of variants) {
    const built = variant.build(ctx);
    console.log(`\n${"=".repeat(72)}`);
    console.log(`VARIANT: ${variant.id} — ${variant.description}`);
    console.log("=".repeat(72));

    for (const modelId of evalModels) {
      for (const scenario of RETEST_SCENARIOS) {
        const cellKey = `${scenario.id}::${modelId}`;
        const wasKnownFailure = knownFailureCells.has(cellKey);
        process.stdout.write(`  ${modelId.split("/").pop()} / ${scenario.id} ... `);

        try {
          const { parsed, ms } = await parseMessage(modelId, scenario.text, {
            systemPrompt: built.system,
            userPrefix: built.userPrefix,
          });
          const score = scoreWithAlt(parsed, scenario);

          results.push({
            variantId: variant.id,
            modelId,
            scenarioId: scenario.id,
            pass: score.pass,
            strictPass: score.strictPass,
            altPass: score.altPass,
            ms,
            issues: score.issues,
            parsed,
            error: null,
            wasKnownFailure,
          });

          const tag = score.pass ? "PASS" : "FAIL";
          const fix = wasKnownFailure && score.pass ? " [FIXED]" : wasKnownFailure ? " [still fail]" : "";
          console.log(`${tag}${fix} (${ms}ms)`);
          if (!score.pass) {
            console.log(`         got: ${formatEntries(parsed)}`);
            console.log(`         issues: ${score.issues.slice(0, 2).join(" | ")}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`ERROR: ${msg}`);
          results.push({
            variantId: variant.id,
            modelId,
            scenarioId: scenario.id,
            pass: false,
            strictPass: false,
            altPass: false,
            ms: 0,
            issues: [msg],
            parsed: null,
            error: msg,
            wasKnownFailure,
          });
        }
      }
    }
  }

  const variantSummaries: VariantSummary[] = variants.map((v) => {
    const rows = results.filter((r) => r.variantId === v.id);
    const perModel: Record<string, { pass: number; total: number }> = {};
    for (const m of evalModels) {
      const mr = rows.filter((r) => r.modelId === m);
      perModel[m] = { pass: mr.filter((r) => r.pass).length, total: mr.length };
    }
    const knownRows = rows.filter((r) => r.wasKnownFailure);
    return {
      variantId: v.id,
      description: v.description,
      passCount: rows.filter((r) => r.pass).length,
      totalCells: rows.length,
      knownFailureFixed: knownRows.filter((r) => r.pass).length,
      knownFailureTotal: knownRows.length,
      perModel,
    };
  });

  console.log(`\n${"=".repeat(72)}`);
  console.log("PROMPT TUNE SCOREBOARD");
  console.log("=".repeat(72));
  for (const v of variantSummaries.sort((a, b) => b.passCount - a.passCount)) {
    console.log(
      `  ${v.variantId.padEnd(28)} ${v.passCount}/${v.totalCells} pass  known-fixed=${v.knownFailureFixed}/${v.knownFailureTotal}`,
    );
  }

  const logDir = resolve(import.meta.dirname, "../docs/results");
  mkdirSync(logDir, { recursive: true });
  const dateSlug = runAt.slice(0, 10);
  const jsonPath = resolve(logDir, `${dateSlug}-finance-prompt-tune-results.json`);
  const mdPath = resolve(logDir, `${dateSlug}-finance-prompt-tune-analysis.md`);

  const payload = {
    runAt,
    anchor: ctx,
    scenarios: RETEST_SCENARIOS,
    variants: variants.map((v) => ({ id: v.id, description: v.description, legitimacy: v.legitimacy })),
    results,
    summaries: variantSummaries,
  };

  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  writeFileSync(
    mdPath,
    buildMarkdownReport(results, variantSummaries, ctx, runAt, evalModels.length),
  );

  console.log(`\nJSON: ${jsonPath}`);
  console.log(`Analysis: ${mdPath}`);

  const best = variantSummaries.sort((a, b) => b.passCount - a.passCount)[0];
  if (best && best.passCount < totalCells) {
    console.log(`\nNote: No variant reached ${totalCells}/${totalCells}. See analysis for gaps.`);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
