/**
 * eval-finance-hard-12.ts — 12 extreme-but-realistic Indonesian finance-parse scenarios.
 *
 * Targets failure modes seen in the 40-scenario suite: qty ambiguity, price-copy,
 * phantom income, td→date, voice corrections, patungan vs total, non-transaction curhat.
 *
 * Run:
 *   bun run eval:hard-12 -- --models <lm-studio-id>
 *   bun run eval:hard-12 -- --dry-run
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseMessage,
  scoreExtraction,
  normalizeText,
  type ExpectedEntry,
  type ParsedFinance,
  type Scenario,
} from "../src/core/eval-core.ts";
import { applyLlmConfigOverrides, getLlmConfig } from "../src/core/llm-client.ts";

/** Pass --model <lm-studio-id> (no default cloud roster). */
const HARD_12_MODELS: string[] = [];

type HardScenario = Scenario & {
  /** What makes this scenario hard — for the report */
  failureMode: string;
  /** Acceptable alternate strict outcomes (scenario-specific) */
  altStrictIds?: string[];
};

export const HARD_SCENARIOS: HardScenario[] = [
  {
    id: "hard-bakmi-qty-22",
    style: "ambiguous_amount",
    failureMode: "qty×unit price ('12rb 2 2 nya') — models collapse to 1×12rb",
    text: "hmm maren gw keknya beli sarden 12rb terus hari ini makan bakmi 2 bungkus, harganya sih 12rb 2 2 nya",
    expectEntries: [
      { type: "pengeluaran", jumlah: 12000, tanggal_hint: "kemarin", deskripsiIncludes: ["sarden"] },
      { type: "pengeluaran", jumlah: 12000, tanggal_hint: "hari_ini", deskripsiIncludes: ["bakmi"], ambigu: true },
      { type: "pengeluaran", jumlah: 12000, tanggal_hint: "hari_ini", deskripsiIncludes: ["bakmi"], ambigu: true },
    ],
    notes: "Alt: 1 bakmi entry @24rb merged",
  },
  {
    id: "hard-cod-shopee-phantom",
    style: "multi_entry",
    failureMode: "COD Shopee — Ling hallucinated pemasukan Rp0",
    text: "baru cod shopee case hp 95rb terus sekalian beli kabel type c 25rb di toko samping",
    expectEntries: [
      { type: "pengeluaran", jumlah: 95000, deskripsiIncludes: ["case", "shopee", "hp"] },
      { type: "pengeluaran", jumlah: 25000, deskripsiIncludes: ["kabel", "type"] },
    ],
  },
  {
    id: "hard-indomaret-price-copy",
    style: "bulk_list",
    failureMode: "adjacent price bleed (kopi 35rb copied from 87.5k or 18rb)",
    text: "kemarin indomaret belanja 87.500 terus gojek 18rb kopi susu 35rb",
    expectEntries: [
      { type: "pengeluaran", jumlah: 87500, tanggal_hint: "kemarin", deskripsiIncludes: ["indomaret"] },
      { type: "pengeluaran", jumlah: 18000, deskripsiIncludes: ["gojek"] },
      { type: "pengeluaran", jumlah: 35000, deskripsiIncludes: ["kopi"] },
    ],
  },
  {
    id: "hard-gaji-cair-bca",
    style: "income",
    failureMode: "income misclassified as pengeluaran (GLM v1 bug)",
    text: "td sore gaji cair 4,5 jt masuk rekening bca alhamdulillah",
    expectEntries: [
      { type: "pemasukan", jumlah: 4500000, tanggal_hint: "hari_ini", deskripsiIncludes: ["gaji"] },
    ],
  },
  {
    id: "hard-td-zakat-4orang",
    style: "relative_date",
    failureMode: "td→kemarin wrong; 4×45rb vs 180rb total",
    text: "td zakat fitrah 4 orang @ 45rb di masjid deket rumah",
    expectEntries: [
      { type: "pengeluaran", jumlah: 45000, tanggal_hint: "hari_ini", deskripsiIncludes: ["zakat"] },
      { type: "pengeluaran", jumlah: 45000, tanggal_hint: "hari_ini", deskripsiIncludes: ["zakat"] },
      { type: "pengeluaran", jumlah: 45000, tanggal_hint: "hari_ini", deskripsiIncludes: ["zakat"] },
      { type: "pengeluaran", jumlah: 45000, tanggal_hint: "hari_ini", deskripsiIncludes: ["zakat"] },
    ],
    notes: "Alt: single 180000 entry",
  },
  {
    id: "hard-voice-triple-correct",
    style: "ambiguous_amount",
    failureMode: "voice self-correction chain — must land on final 50rb not 15rb",
    text: "gojek ke kampus... 15rb... eh engga 50rb... iya 50rb bener kemarin",
    expectEntries: [
      { type: "pengeluaran", jumlah: 50000, tanggal_hint: "kemarin", deskripsiIncludes: ["gojek"] },
    ],
  },
  {
    id: "hard-tf-admin-fee",
    style: "multi_entry",
    failureMode: "transfer principal + admin fee — 2 entries or merged",
    text: "tf 2jt ke vendor cleaning tapi kena admin 6500",
    expectEntries: [
      { type: "pengeluaran", jumlah: 2000000, deskripsiIncludes: ["vendor", "cleaning", "tf", "transfer"] },
      { type: "pengeluaran", jumlah: 6500, deskripsiIncludes: ["admin"] },
    ],
    notes: "Alt: single 2006500 merged",
  },
  {
    id: "hard-infaq-donasi-mixed",
    style: "income",
    failureMode: "mixed direction same message — infaq out, donasi in",
    text: "hari ini infaq jumat 50rb terus siang dapat transfer donasi 300rb dari pak ustadz",
    expectEntries: [
      { type: "pengeluaran", jumlah: 50000, tanggal_hint: "hari_ini", deskripsiIncludes: ["infaq"] },
      { type: "pemasukan", jumlah: 300000, tanggal_hint: "hari_ini", deskripsiIncludes: ["donasi"] },
    ],
  },
  {
    id: "hard-curhat-tanpa-nominal",
    style: "non_transaction",
    failureMode: "emotional vent with no amounts — should not invent transactions",
    text: "abis jajan di mall tadi dompet kering banget huhu males banget",
    expectNonTransaction: true,
    expectEntries: [],
  },
  {
    id: "hard-laptop-15-juta",
    style: "ambiguous_amount",
    failureMode: "15 vs 15 juta correction — must not record 15000",
    text: "beli laptop kemarin 15... eh maksudnya 15 juta bukan 15 ribu",
    expectEntries: [
      { type: "pengeluaran", jumlah: 15000000, tanggal_hint: "kemarin", deskripsiIncludes: ["laptop"] },
    ],
  },
  {
    id: "hard-patungan-warung",
    style: "split_bill",
    failureMode: "total bill vs personal patungan share — only 80rb is user's expense",
    text: "kemarin makan rame2 di warung total 320rb gw patungan 80rb sendiri",
    expectEntries: [
      { type: "pengeluaran", jumlah: 80000, tanggal_hint: "kemarin", deskripsiIncludes: ["warung", "makan", "patungan"] },
    ],
    notes: "Acceptable with ambigu if 320000 also listed with catatan patungan",
  },
  {
    id: "hard-setoran-3-line",
    style: "bulk_list",
    failureMode: "three distinct school supplies — fotokopi price copy risk",
    text: "setoran buku tulis 2 pack 24rb fotokopi 12 lembar 36rb jilid 15rb",
    expectEntries: [
      { type: "pengeluaran", jumlah: 24000, deskripsiIncludes: ["buku"] },
      { type: "pengeluaran", jumlah: 36000, deskripsiIncludes: ["fotokopi"] },
      { type: "pengeluaran", jumlah: 15000, deskripsiIncludes: ["jilid"] },
    ],
  },
];

// ─── Quality analysis (beyond strict pass/fail) ─────────────────────────────

type QualityTier = "excellent" | "usable_with_edit" | "partially_usable" | "misleading" | "broken";

interface QualityAnalysis {
  strictPass: boolean;
  strictAltPass: boolean;
  scores: {
    amount: number;
    typeDirection: number;
    dateHint: number;
    entryCount: number;
    noHallucination: number;
    nonTransaction: number;
    ambiguHandling: number;
  };
  compositeScore: number;
  tier: QualityTier;
  strictIssues: string[];
  qualityNotes: string[];
  partialMatches: Array<{ label: string; credit: number; detail: string }>;
  extraEntries: ParsedFinance["entries"];
  zeroAmountEntries: number;
  spuriousIncome: boolean;
  priceCopySuspect: boolean;
}

function amountInRange(got: number, exp: ExpectedEntry): boolean {
  if (exp.jumlahMin != null && got < exp.jumlahMin) return false;
  if (exp.jumlahMax != null && got > exp.jumlahMax) return false;
  return got === exp.jumlah;
}

function entryPartialMatch(
  got: ParsedFinance["entries"][number],
  exp: ExpectedEntry,
): { credit: number; detail: string } {
  let credit = 0;
  const parts: string[] = [];

  if (got.type === exp.type) {
    credit += 35;
    parts.push("type✓");
  } else {
    parts.push(`type✗(${got.type}≠${exp.type})`);
    return { credit, detail: parts.join(" ") };
  }

  if (amountInRange(got.jumlah, exp)) {
    credit += 40;
    parts.push("amount✓");
  } else if (exp.jumlahMin != null || exp.jumlahMax != null) {
    parts.push(`amount✗(${got.jumlah})`);
  } else {
    const ratio = Math.min(got.jumlah, exp.jumlah) / Math.max(got.jumlah, exp.jumlah, 1);
    if (ratio >= 0.9) {
      credit += 30;
      parts.push("amount≈");
    } else {
      parts.push(`amount✗(${got.jumlah}≠${exp.jumlah})`);
    }
  }

  if (exp.tanggal_hint) {
    if (got.tanggal_hint === exp.tanggal_hint) {
      credit += 15;
      parts.push("date✓");
    } else if (got.tanggal_hint === "tidak_jelas") {
      credit += 8;
      parts.push("date?");
    } else {
      parts.push(`date✗(${got.tanggal_hint})`);
    }
  } else {
    credit += 10;
  }

  if (exp.deskripsiIncludes?.length) {
    const desc = normalizeText(`${got.deskripsi} ${got.vendor ?? ""}`);
    const hit = exp.deskripsiIncludes.some((k) => desc.includes(normalizeText(k)));
    if (hit) {
      credit += 10;
      parts.push("desc✓");
    } else {
      parts.push("desc✗");
    }
  } else {
    credit += 10;
  }

  return { credit: Math.min(100, credit), detail: parts.join(" ") };
}

function applyAltStrict(scenarioId: string, parsed: ParsedFinance, expected: ExpectedEntry[]): boolean {
  const entries = parsed.entries;

  if (scenarioId === "hard-bakmi-qty-22") {
    const sarden = entries.filter((e) => normalizeText(e.deskripsi).includes("sarden"));
    const bakmi = entries.filter((e) => normalizeText(e.deskripsi).includes("bakmi"));
    const bakmiTotal = bakmi.reduce((s, e) => s + e.jumlah, 0);
    return (
      sarden.some((e) => e.jumlah === 12000) &&
      (bakmiTotal === 24000 || bakmi.filter((b) => b.jumlah === 12000).length === 2)
    );
  }

  if (scenarioId === "hard-td-zakat-4orang") {
    const zakat = entries.filter((e) => normalizeText(e.deskripsi).includes("zakat"));
    const total = zakat.reduce((s, e) => s + e.jumlah, 0);
    return total === 180000 || zakat.filter((e) => e.jumlah === 45000).length === 4;
  }

  if (scenarioId === "hard-tf-admin-fee") {
    const out = entries.filter((e) => e.type === "pengeluaran");
    const sum = out.reduce((s, e) => s + e.jumlah, 0);
    const has2m = out.some((e) => e.jumlah === 2000000);
    const has65 = out.some((e) => e.jumlah === 6500);
    return (has2m && has65) || sum === 2006500;
  }

  if (scenarioId === "hard-patungan-warung") {
    const personal = entries.find((e) => e.jumlah === 80000);
    if (personal) return true;
    const total = entries.find((e) => e.jumlah === 320000);
    return Boolean(total?.ambigu || total?.catatan_ambigu);
  }

  if (scenarioId === "user-example-maren-bakmi") {
    return applyAltStrict("hard-bakmi-qty-22", parsed, expected);
  }

  return false;
}

function detectPriceCopy(parsed: ParsedFinance, scenario: HardScenario): boolean {
  if (scenario.id !== "hard-indomaret-price-copy" && scenario.id !== "hard-setoran-3-line") {
    return false;
  }
  const amounts = scenario.expectEntries.map((e) => e.jumlah);
  for (const e of parsed.entries) {
    const desc = normalizeText(e.deskripsi);
    if (scenario.id === "hard-indomaret-price-copy" && desc.includes("kopi") && e.jumlah === 87500) {
      return true;
    }
    if (scenario.id === "hard-setoran-3-line" && desc.includes("fotokopi") && e.jumlah === 24000) {
      return true;
    }
    if (scenario.id === "hard-setoran-3-line" && desc.includes("fotokopi") && e.jumlah === 15000) {
      return true;
    }
    // copied adjacent amount that's wrong for this line item
    const wrongForDesc =
      (desc.includes("kopi") && e.jumlah !== 35000) ||
      (desc.includes("fotokopi") && e.jumlah !== 36000);
    if (wrongForDesc && amounts.includes(e.jumlah) && e.jumlah !== scenario.expectEntries.find((x) =>
      x.deskripsiIncludes?.some((k) => desc.includes(normalizeText(k))),
    )?.jumlah) {
      return true;
    }
  }
  return false;
}

function analyzeQuality(parsed: ParsedFinance, scenario: HardScenario): QualityAnalysis {
  const strict = scoreExtraction(parsed, scenario);
  const strictAltPass = !strict.pass && applyAltStrict(scenario.id, parsed, scenario.expectEntries);
  const strictPass = strict.pass || strictAltPass;

  const qualityNotes: string[] = [];
  const partialMatches: QualityAnalysis["partialMatches"] = [];

  if (strictAltPass && !strict.pass) {
    qualityNotes.push("Alt strict layout accepted (merged qty, zakat total, admin fee, etc.)");
  }

  const zeroAmountEntries = parsed.entries.filter((e) => e.jumlah === 0).length;
  const expectedIncome = scenario.expectEntries.filter((e) => e.type === "pemasukan").length;
  const gotIncome = parsed.entries.filter((e) => e.type === "pemasukan");
  const spuriousIncome =
    gotIncome.length > expectedIncome ||
    gotIncome.some((e) => e.jumlah === 0) ||
    (expectedIncome === 0 && gotIncome.length > 0 && !scenario.expectNonTransaction);

  if (spuriousIncome) {
    qualityNotes.push("Spurious pemasukan detected (phantom/zero income)");
  }

  const priceCopySuspect = detectPriceCopy(parsed, scenario);
  if (priceCopySuspect) {
    qualityNotes.push("Suspected adjacent-price copy bug");
  }

  // Non-transaction scoring
  if (scenario.expectNonTransaction) {
    const nonTransaction =
      parsed.bukan_transaksi && parsed.entries.length === 0
        ? 100
        : parsed.entries.length === 0
          ? 85
          : parsed.bukan_transaksi
            ? 50
            : 0;

    const composite = nonTransaction;
    let tier: QualityTier = "broken";
    if (composite >= 90) tier = "excellent";
    else if (composite >= 70) tier = "usable_with_edit";
    else if (composite >= 50) tier = "partially_usable";
    else if (parsed.entries.length > 0) tier = "misleading";

    if (parsed.bukan_transaksi) qualityNotes.push("Correctly flagged bukan_transaksi");
    if (parsed.entries.length === 0 && !parsed.bukan_transaksi) {
      qualityNotes.push("Empty entries without flag — still usable (no false data)");
    }

    return {
      strictPass,
      strictAltPass,
      scores: {
        amount: 0,
        typeDirection: 0,
        dateHint: 0,
        entryCount: parsed.entries.length === 0 ? 100 : 0,
        noHallucination: parsed.entries.length === 0 ? 100 : Math.max(0, 100 - parsed.entries.length * 30),
        nonTransaction,
        ambiguHandling: 100,
      },
      compositeScore: composite,
      tier,
      strictIssues: strict.issues,
      qualityNotes,
      partialMatches,
      extraEntries: parsed.entries,
      zeroAmountEntries,
      spuriousIncome,
      priceCopySuspect,
    };
  }

  // Greedy partial matching for quality credit
  const gotEntries = [...parsed.entries];
  const used = new Set<number>();
  let amountScore = 0;
  let typeScore = 0;
  let dateScore = 0;
  let ambiguScore = 0;

  for (const exp of scenario.expectEntries) {
    let bestIdx = -1;
    let bestCredit = 0;
    let bestDetail = "";
    for (let i = 0; i < gotEntries.length; i++) {
      if (used.has(i)) continue;
      const { credit, detail } = entryPartialMatch(gotEntries[i]!, exp);
      if (credit > bestCredit) {
        bestCredit = credit;
        bestIdx = i;
        bestDetail = detail;
      }
    }
    if (bestIdx >= 0 && bestCredit >= 40) {
      used.add(bestIdx);
      const g = gotEntries[bestIdx]!;
      partialMatches.push({
        label: `${exp.type} ${exp.jumlah}`,
        credit: bestCredit,
        detail: `${g.deskripsi.slice(0, 40)} → ${bestDetail}`,
      });
      if (amountInRange(g.jumlah, exp)) amountScore += 100;
      else if (Math.min(g.jumlah, exp.jumlah) / Math.max(g.jumlah, exp.jumlah, 1) >= 0.9) amountScore += 70;
      else amountScore += 20;

      if (g.type === exp.type) typeScore += 100;
      if (!exp.tanggal_hint || g.tanggal_hint === exp.tanggal_hint) dateScore += 100;
      else if (g.tanggal_hint === "tidak_jelas") dateScore += 60;

      if (exp.ambigu && g.ambigu) ambiguScore += 100;
      else if (!exp.ambigu) ambiguScore += 100;
      else ambiguScore += 40;
    } else {
      partialMatches.push({ label: `${exp.type} ${exp.jumlah}`, credit: 0, detail: "no match" });
    }
  }

  const n = Math.max(scenario.expectEntries.length, 1);
  const amount = amountScore / n;
  const typeDirection = typeScore / n;
  const dateHint = dateScore / n;
  const ambiguHandling = ambiguScore / n;

  const extraEntries = gotEntries.filter((_, i) => !used.has(i));
  const expectedCount = scenario.expectEntries.length;
  const gotCount = parsed.entries.length;
  const entryCount =
    gotCount === expectedCount
      ? 100
      : gotCount === expectedCount + 1 && strictAltPass
        ? 90
        : Math.max(0, 100 - Math.abs(gotCount - expectedCount) * 25);

  let noHallucination = 100;
  noHallucination -= extraEntries.length * 25;
  if (zeroAmountEntries > 0) noHallucination -= zeroAmountEntries * 30;
  if (spuriousIncome) noHallucination -= 40;
  if (priceCopySuspect) noHallucination -= 35;
  noHallucination = Math.max(0, noHallucination);

  const compositeScore = Math.round(
    amount * 0.3 +
      typeDirection * 0.25 +
      noHallucination * 0.2 +
      entryCount * 0.1 +
      dateHint * 0.05 +
      ambiguHandling * 0.05 +
      100 * 0.05, // non-tx N/A → full weight redistributed implicitly
  );

  let tier: QualityTier = "broken";
  if (strictPass) tier = "excellent";
  else if (compositeScore >= 85 && typeDirection >= 80 && !spuriousIncome && !priceCopySuspect) {
    tier = "usable_with_edit";
    qualityNotes.push("Near-correct — minor edit in confirm UI would suffice");
  } else if (compositeScore >= 70) tier = "usable_with_edit";
  else if (compositeScore >= 50) tier = "partially_usable";
  else if (parsed.entries.length > 0 && (spuriousIncome || priceCopySuspect || typeDirection < 50)) {
    tier = "misleading";
  }

  if (parsed.entries.some((e) => e.ambigu && e.catatan_ambigu)) {
    qualityNotes.push("Model surfaced ambiguity in catatan — good for confirm UI");
  }
  if (amount >= 90 && !strictPass) {
    qualityNotes.push("Amounts mostly correct despite layout mismatch");
  }

  return {
    strictPass,
    strictAltPass,
    scores: {
      amount: Math.round(amount),
      typeDirection: Math.round(typeDirection),
      dateHint: Math.round(dateHint),
      entryCount: Math.round(entryCount),
      noHallucination: Math.round(noHallucination),
      nonTransaction: 100,
      ambiguHandling: Math.round(ambiguHandling),
    },
    compositeScore,
    tier,
    strictIssues: strict.issues,
    qualityNotes,
    partialMatches,
    extraEntries,
    zeroAmountEntries,
    spuriousIncome,
    priceCopySuspect,
  };
}

// ─── Run harness ─────────────────────────────────────────────────────────────

interface ScenarioResult {
  modelId: string;
  scenarioId: string;
  scenarioStyle: string;
  failureMode: string;
  ms: number;
  path: string;
  parsed: ParsedFinance | null;
  error: string | null;
  strict: ReturnType<typeof scoreExtraction> | null;
  quality: QualityAnalysis | null;
}

interface ModelSummary {
  modelId: string;
  strictPass: number;
  strictAltIncluded: number;
  meanComposite: number;
  tierCounts: Record<QualityTier, number>;
  meanMs: number;
  errors: number;
  topQualityWins: string[];
  topFailures: string[];
}

function parseArgs(argv: string[]) {
  let model: string | undefined;
  let dryRun = false;
  let baseUrl: string | undefined;
  let apiKey: string | undefined;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--model" && argv[i + 1]) {
      model = argv[++i];
    } else if (a === "--base-url" && argv[i + 1]) {
      baseUrl = argv[++i];
    } else if (a === "--api-key" && argv[i + 1]) {
      apiKey = argv[++i];
    }
  }
  return { model, dryRun, baseUrl, apiKey };
}

function buildMarkdownReport(
  results: ScenarioResult[],
  summaries: ModelSummary[],
  runAt: string,
): string {
  const lines: string[] = [
    `# Finance Parse Hard-12 Eval — ${runAt}`,
    "",
    "## Models (this run)",
    "",
    summaries.map((s) => `- \`${s.modelId}\``).join("\n"),
    "",
    "## Scoreboard",
    "",
    "| Model | Strict | Composite avg | Excellent | Usable+ | Partial | Misleading | Broken | Errors | Latency |",
    "|-------|--------|---------------|-----------|---------|---------|------------|--------|--------|---------|",
  ];

  for (const s of summaries.sort((a, b) => b.strictAltIncluded - a.strictAltIncluded || b.meanComposite - a.meanComposite)) {
    lines.push(
      `| ${s.modelId} | ${s.strictAltIncluded}/12 | ${s.meanComposite.toFixed(0)} | ${s.tierCounts.excellent} | ${s.tierCounts.usable_with_edit} | ${s.tierCounts.partially_usable} | ${s.tierCounts.misleading} | ${s.tierCounts.broken} | ${s.errors} | ${s.meanMs.toFixed(0)}ms |`,
    );
  }

  lines.push("", "## Scenarios", "");
  for (const sc of HARD_SCENARIOS) {
    lines.push(`### ${sc.id}`, `- **Failure mode:** ${sc.failureMode}`, `- **Input:** ${sc.text}`, "");
  }

  lines.push("## Per-model analysis", "");
  for (const s of summaries.sort((a, b) => b.meanComposite - a.meanComposite)) {
    lines.push(`### ${s.modelId}`, "");
    lines.push(`- Strict pass: **${s.strictAltIncluded}/12**`);
    lines.push(`- Mean composite quality: **${s.meanComposite.toFixed(1)}**`);
    if (s.topQualityWins.length) {
      lines.push(`- Quality wins: ${s.topQualityWins.join("; ")}`);
    }
    if (s.topFailures.length) {
      lines.push(`- Key failures: ${s.topFailures.join("; ")}`);
    }
    lines.push("", "#### Scenario detail", "");
    lines.push("| Scenario | Strict | Tier | Composite | Notes |");
    lines.push("|----------|--------|------|-----------|-------|");

    const modelResults = results.filter((r) => r.modelId === s.modelId);
    for (const r of modelResults) {
      const q = r.quality;
      const notes = q
        ? [...q.qualityNotes, ...q.strictIssues].slice(0, 2).join("; ") || "—"
        : r.error ?? "—";
      lines.push(
        `| ${r.scenarioId} | ${q?.strictPass ? "✓" : "✗"} | ${q?.tier ?? "—"} | ${q?.compositeScore ?? "—"} | ${notes.replace(/\|/g, "/")} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Cross-model insights", "");
  const byScenario = new Map<string, ScenarioResult[]>();
  for (const r of results) {
    const arr = byScenario.get(r.scenarioId) ?? [];
    arr.push(r);
    byScenario.set(r.scenarioId, arr);
  }
  for (const [id, rows] of byScenario) {
    const passCount = rows.filter((r) => r.quality?.strictPass).length;
    const avgComposite =
      rows.reduce((s, r) => s + (r.quality?.compositeScore ?? 0), 0) / Math.max(rows.length, 1);
    lines.push(`- **${id}**: ${passCount}/7 strict, avg composite ${avgComposite.toFixed(0)}`);
  }

  return lines.join("\n");
}

async function main() {
  const { model: singleModel, dryRun, baseUrl, apiKey } = parseArgs(process.argv);
  applyLlmConfigOverrides({ baseUrl, apiKey });
  const models = singleModel ? [singleModel] : [...HARD_12_MODELS];
  // Below the dry-run branch: --dry-run only prints scenarios and needs no model.
  if (!dryRun && !models.length) {
    throw new Error("Pass --model <lm-studio-id>");
  }
  const runAt = new Date().toISOString();

  console.log(`Finance Parse HARD-12 eval — ${runAt}`);
  console.log(`Base URL: ${getLlmConfig().baseURL}`);
  console.log(`Models: ${models.join(", ")}\n`);

  if (dryRun) {
    for (const s of HARD_SCENARIOS) {
      console.log(`[dry] ${s.id}: ${s.failureMode}`);
      console.log(`      ${s.text}\n`);
    }
    return;
  }

  const results: ScenarioResult[] = [];

  for (const modelId of models) {
    console.log(`\n${"=".repeat(72)}`);
    console.log(`MODEL: ${modelId}`);
    console.log("=".repeat(72));

    for (const scenario of HARD_SCENARIOS) {
      process.stdout.write(`  ${scenario.id} ... `);
      try {
        const { parsed, ms, path } = await parseMessage(modelId, scenario.text);
        const strict = scoreExtraction(parsed, scenario);
        const quality = analyzeQuality(parsed, scenario);

        results.push({
          modelId,
          scenarioId: scenario.id,
          scenarioStyle: scenario.style,
          failureMode: scenario.failureMode,
          ms,
          path,
          parsed,
          error: null,
          strict,
          quality,
        });

        const icon = quality.strictPass ? "PASS" : quality.tier === "usable_with_edit" ? "EDIT" : "FAIL";
        console.log(
          `${icon} strict=${quality.strictPass} tier=${quality.tier} composite=${quality.compositeScore} (${ms}ms)`,
        );
        if (!quality.strictPass && quality.qualityNotes.length) {
          console.log(`         notes: ${quality.qualityNotes.join(" | ")}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`ERROR: ${msg}`);
        results.push({
          modelId,
          scenarioId: scenario.id,
          scenarioStyle: scenario.style,
          failureMode: scenario.failureMode,
          ms: 0,
          path: "error",
          parsed: null,
          error: msg,
          strict: null,
          quality: null,
        });
      }
    }
  }

  const summaries: ModelSummary[] = models.map((modelId) => {
    const rows = results.filter((r) => r.modelId === modelId);
    const ok = rows.filter((r) => r.quality?.strictPass);
    const composites = rows.filter((r) => r.quality).map((r) => r.quality!.compositeScore);
    const tierCounts: Record<QualityTier, number> = {
      excellent: 0,
      usable_with_edit: 0,
      partially_usable: 0,
      misleading: 0,
      broken: 0,
    };
    for (const r of rows) {
      if (r.quality?.tier) tierCounts[r.quality.tier]++;
    }
    const failures = rows
      .filter((r) => !r.quality?.strictPass && r.quality)
      .sort((a, b) => (a.quality?.compositeScore ?? 0) - (b.quality?.compositeScore ?? 0))
      .slice(0, 4)
      .map((r) => `${r.scenarioId}(${r.quality?.tier})`);
    const wins = rows
      .filter((r) => r.quality && (r.quality.strictPass || r.quality.tier === "usable_with_edit"))
      .filter((r) => !r.quality?.strictPass && r.quality?.compositeScore && r.quality.compositeScore >= 80)
      .map((r) => `${r.scenarioId}(composite=${r.quality?.compositeScore})`);

    return {
      modelId,
      strictPass: ok.length,
      strictAltIncluded: ok.length,
      meanComposite: composites.length ? composites.reduce((a, b) => a + b, 0) / composites.length : 0,
      tierCounts,
      meanMs: rows.filter((r) => r.ms > 0).reduce((s, r) => s + r.ms, 0) / Math.max(rows.filter((r) => r.ms > 0).length, 1),
      errors: rows.filter((r) => r.error).length,
      topQualityWins: wins,
      topFailures: failures,
    };
  });

  console.log(`\n${"=".repeat(72)}`);
  console.log("HARD-12 SCOREBOARD (strict | composite avg | latency)");
  console.log("=".repeat(72));
  for (const s of summaries.sort((a, b) => b.strictAltIncluded - a.strictAltIncluded || b.meanComposite - a.meanComposite)) {
    console.log(
      `  ${s.modelId.padEnd(36)} ${s.strictAltIncluded}/12 strict  composite=${s.meanComposite.toFixed(0)}  ~${s.meanMs.toFixed(0)}ms  errors=${s.errors}`,
    );
    console.log(
      `    tiers: excellent=${s.tierCounts.excellent} usable=${s.tierCounts.usable_with_edit} partial=${s.tierCounts.partially_usable} misleading=${s.tierCounts.misleading} broken=${s.tierCounts.broken}`,
    );
  }

  const logDir = resolve(import.meta.dirname, "../docs/results");
  mkdirSync(logDir, { recursive: true });
  const dateSlug = runAt.slice(0, 10);
  const jsonPath = resolve(logDir, `${dateSlug}-hard-12-results.json`);
  const mdPath = resolve(logDir, `${dateSlug}-hard-12-analysis.md`);

  const payload = {
    runAt,
    models,
    scenarios: HARD_SCENARIOS.map((s) => ({
      id: s.id,
      failureMode: s.failureMode,
      text: s.text,
      expectNonTransaction: s.expectNonTransaction,
      expectEntries: s.expectEntries,
    })),
    results,
    summaries,
  };

  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  writeFileSync(mdPath, buildMarkdownReport(results, summaries, runAt));

  console.log(`\nJSON log: ${jsonPath}`);
  console.log(`Analysis: ${mdPath}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  });
}
