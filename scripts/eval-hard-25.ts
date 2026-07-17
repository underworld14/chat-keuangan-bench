/**
 * eval-finance-hard-25.ts — 25 extreme-but-realistic Indonesian finance-parse scenarios.
 *
 * Scenarios 1–12 are rewrites of the hard-12 suite (same failure mode / test aspect,
 * fresh wording). Scenarios 13–25 add new angles: typos, thousand-separators, k-suffix
 * decimals, money slang (ceban/goceng), spelled amounts, future intent vs past, refund
 * income, discount net price, cancelled purchase, per-kg qty, emoji/WA noise, 5-item rekap.
 *
 * Multi-model runs require --models (roster is empty for local-first).
 *
 * Run:
 *   bun run eval:hard-25 -- --models model-a,model-b
 *   bun run eval:single -- --model <lm-studio-id>
 *   bun run eval:hard-25 -- --dry-run
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseMessage,
  scoreExtraction,
  normalizeText,
  type ExpectedEntry,
  type ParsedFinance,
  type Scenario,
} from "../src/core/eval-core.ts";
import { ALL_EVAL_MODELS } from "../src/core/model-roster.ts";
import {
  applyLlmConfigOverrides,
  getLlmConfig,
} from "../src/core/llm-client.ts";

export { ALL_EVAL_MODELS };

type AltStrictRule =
  | { kind: "qtyMerge"; keyword: string; unit: number; count: number }
  | { kind: "totalOrSplit"; keyword: string; unit: number; count: number }
  | { kind: "principalPlusFee"; principal: number; fee: number }
  | { kind: "personalShare"; personal: number; total: number };

type HardScenario = Scenario & {
  /** What makes this scenario hard — for the report */
  failureMode: string;
  /** rewrite of a hard-12 scenario, or brand-new angle */
  group: "rewrite" | "new";
  /** original hard-12 id this rewrites (for traceability) */
  basedOn?: string;
  /** data-driven alternate strict acceptance (merged qty, total, principal+fee, share) */
  altStrict?: AltStrictRule;
  /** run generic adjacent-price-copy detection (multi-item distinct-amount lists) */
  priceCopyCheck?: boolean;
};

export const HARD_SCENARIOS: HardScenario[] = [
  // ─── 1–12: rewrites of hard-12 (same test aspect, new wording) ──────────────
  {
    id: "hard-cilok-qty-44",
    style: "ambiguous_amount",
    group: "rewrite",
    basedOn: "hard-bakmi-qty-22",
    failureMode: "qty×unit price ('5rb 4 4 nya') — models collapse to 1×5rb",
    text: "td sore beli pulsa 25rb sama jajan cilok 4 tusuk 5rb 4 4 nya",
    expectEntries: [
      { type: "pengeluaran", jumlah: 25000, tanggal_hint: "hari_ini", deskripsiIncludes: ["pulsa"] },
      { type: "pengeluaran", jumlah: 5000, tanggal_hint: "hari_ini", deskripsiIncludes: ["cilok"], ambigu: true },
      { type: "pengeluaran", jumlah: 5000, tanggal_hint: "hari_ini", deskripsiIncludes: ["cilok"], ambigu: true },
      { type: "pengeluaran", jumlah: 5000, tanggal_hint: "hari_ini", deskripsiIncludes: ["cilok"], ambigu: true },
      { type: "pengeluaran", jumlah: 5000, tanggal_hint: "hari_ini", deskripsiIncludes: ["cilok"], ambigu: true },
    ],
    altStrict: { kind: "qtyMerge", keyword: "cilok", unit: 5000, count: 4 },
    notes: "Alt: 1 cilok entry @20rb merged",
  },
  {
    id: "hard-cod-jnt-tip",
    style: "multi_entry",
    group: "rewrite",
    basedOn: "hard-cod-shopee-phantom",
    failureMode: "COD multi-entry — risk of phantom Rp0 'income' from the COD word",
    text: "barusan paket cod jnt sampe, bayar 150rb buat sepatu, sama kasih tip kurir 5rb",
    expectEntries: [
      { type: "pengeluaran", jumlah: 150000, tanggal_hint: "hari_ini", deskripsiIncludes: ["sepatu"] },
      { type: "pengeluaran", jumlah: 5000, tanggal_hint: "hari_ini", deskripsiIncludes: ["tip", "kurir"] },
    ],
  },
  {
    id: "hard-alfamart-price-copy",
    style: "bulk_list",
    group: "rewrite",
    basedOn: "hard-indomaret-price-copy",
    failureMode: "adjacent price bleed (air 6rb copied from 63.700 or parkir 2rb)",
    text: "tadi belanja di alfamart 63.700 terus parkir 2rb beli air mineral 6rb",
    expectEntries: [
      { type: "pengeluaran", jumlah: 63700, tanggal_hint: "hari_ini", deskripsiIncludes: ["alfamart"] },
      { type: "pengeluaran", jumlah: 2000, deskripsiIncludes: ["parkir"] },
      { type: "pengeluaran", jumlah: 6000, deskripsiIncludes: ["air", "mineral"] },
    ],
    priceCopyCheck: true,
  },
  {
    id: "hard-bonus-cair-gopay",
    style: "income",
    group: "rewrite",
    basedOn: "hard-gaji-cair-bca",
    failureMode: "income misclassified as pengeluaran (cair/masuk = pemasukan)",
    text: "td bonus proyek cair 2,5jt masuk gopay alhamdulillah",
    expectEntries: [
      { type: "pemasukan", jumlah: 2500000, tanggal_hint: "hari_ini", deskripsiIncludes: ["bonus"] },
    ],
  },
  {
    id: "hard-td-spp-3anak",
    style: "relative_date",
    group: "rewrite",
    basedOn: "hard-td-zakat-4orang",
    failureMode: "td→hari_ini; 3×250rb vs 750rb total",
    text: "td bayar spp 3 anak @ 250rb di sekolah",
    expectEntries: [
      { type: "pengeluaran", jumlah: 250000, tanggal_hint: "hari_ini", deskripsiIncludes: ["spp"] },
      { type: "pengeluaran", jumlah: 250000, tanggal_hint: "hari_ini", deskripsiIncludes: ["spp"] },
      { type: "pengeluaran", jumlah: 250000, tanggal_hint: "hari_ini", deskripsiIncludes: ["spp"] },
    ],
    altStrict: { kind: "totalOrSplit", keyword: "spp", unit: 250000, count: 3 },
    notes: "Alt: single 750000 entry",
  },
  {
    id: "hard-voice-ojek-correct",
    style: "ambiguous_amount",
    group: "rewrite",
    basedOn: "hard-voice-triple-correct",
    failureMode: "voice self-correction chain — must land on final 35rb not 20rb",
    text: "ojek ke stasiun... 20rb... eh bukan, 35rb... iya 35rb deh tadi pagi",
    expectEntries: [
      { type: "pengeluaran", jumlah: 35000, tanggal_hint: "hari_ini", deskripsiIncludes: ["ojek"] },
    ],
  },
  {
    id: "hard-tf-supplier-admin",
    style: "multi_entry",
    group: "rewrite",
    basedOn: "hard-tf-admin-fee",
    failureMode: "transfer principal + admin fee — 2 entries or merged",
    text: "transfer ke supplier 1,5jt kena biaya admin 2500",
    expectEntries: [
      { type: "pengeluaran", jumlah: 1500000, deskripsiIncludes: ["supplier", "transfer", "tf"] },
      { type: "pengeluaran", jumlah: 2500, deskripsiIncludes: ["admin"] },
    ],
    altStrict: { kind: "principalPlusFee", principal: 1500000, fee: 2500 },
    notes: "Alt: single 1502500 merged",
  },
  {
    id: "hard-listrik-cashback-mixed",
    style: "income",
    group: "rewrite",
    basedOn: "hard-infaq-donasi-mixed",
    failureMode: "mixed direction same message — listrik out, cashback in",
    text: "pagi tadi bayar listrik 200rb, siangnya dapet cashback ovo 25rb",
    expectEntries: [
      { type: "pengeluaran", jumlah: 200000, tanggal_hint: "hari_ini", deskripsiIncludes: ["listrik"] },
      { type: "pemasukan", jumlah: 25000, tanggal_hint: "hari_ini", deskripsiIncludes: ["cashback"] },
    ],
  },
  {
    id: "hard-vent-no-nominal",
    style: "non_transaction",
    group: "rewrite",
    basedOn: "hard-curhat-tanpa-nominal",
    failureMode: "emotional vent, no amounts — should not invent transactions",
    text: "capek banget hari ini muter2 nyari diskonan tapi ujung2nya ga beli apa2",
    expectNonTransaction: true,
    expectEntries: [],
  },
  {
    id: "hard-hp-2juta",
    style: "ambiguous_amount",
    group: "rewrite",
    basedOn: "hard-laptop-15-juta",
    failureMode: "2 vs 2 juta correction — must not record 2000",
    text: "beli hp baru tadi 2... eh maksudnya 2 juta ya bukan 2 ribu",
    expectEntries: [
      { type: "pengeluaran", jumlah: 2000000, tanggal_hint: "hari_ini", deskripsiIncludes: ["hp"] },
    ],
  },
  {
    id: "hard-patungan-tim",
    style: "split_bill",
    group: "rewrite",
    basedOn: "hard-patungan-warung",
    failureMode: "total bill vs personal share — only 90rb is user's expense",
    text: "tadi makan bareng tim total 540rb, gw bagian 90rb aja",
    expectEntries: [
      { type: "pengeluaran", jumlah: 90000, tanggal_hint: "hari_ini", deskripsiIncludes: ["makan", "tim", "bagian", "patungan"] },
    ],
    altStrict: { kind: "personalShare", personal: 90000, total: 540000 },
    notes: "Acceptable with ambigu if 540000 also listed with catatan patungan",
  },
  {
    id: "hard-atk-3line",
    style: "bulk_list",
    group: "rewrite",
    basedOn: "hard-setoran-3-line",
    failureMode: "three distinct ATK items — qty/price copy risk",
    text: "beli atk: pulpen 2 lusin 30rb, kertas hvs 1 rim 55rb, map plastik 8rb",
    expectEntries: [
      { type: "pengeluaran", jumlah: 30000, deskripsiIncludes: ["pulpen"] },
      { type: "pengeluaran", jumlah: 55000, deskripsiIncludes: ["kertas", "hvs"] },
      { type: "pengeluaran", jumlah: 8000, deskripsiIncludes: ["map"] },
    ],
    priceCopyCheck: true,
  },

  // ─── 13–25: new angles ──────────────────────────────────────────────────────
  {
    id: "hard-typo-beras-minyak",
    style: "typo_slang",
    group: "new",
    failureMode: "heavy typos (bli/sm/pasr) + two line items",
    text: "kemarin bli beras 5kg 68rb sm minyak goreng 2 ltr 38rb di pasr",
    expectEntries: [
      { type: "pengeluaran", jumlah: 68000, tanggal_hint: "kemarin", deskripsiIncludes: ["beras"] },
      { type: "pengeluaran", jumlah: 38000, tanggal_hint: "kemarin", deskripsiIncludes: ["minyak"] },
    ],
    priceCopyCheck: true,
  },
  {
    id: "hard-sep-wifi-token",
    style: "multi_entry",
    group: "new",
    failureMode: "dot thousand-separators (350.000 / 102.500) not decimals",
    text: "bayar wifi 350.000 sama token listrik 102.500 td malem",
    expectEntries: [
      { type: "pengeluaran", jumlah: 350000, tanggal_hint: "hari_ini", deskripsiIncludes: ["wifi"] },
      { type: "pengeluaran", jumlah: 102500, tanggal_hint: "hari_ini", deskripsiIncludes: ["token", "listrik"] },
    ],
    priceCopyCheck: true,
  },
  {
    id: "hard-ksuffix-decimal",
    style: "whatsapp_short",
    group: "new",
    failureMode: "k-suffix with decimal (27.5k = 27.500, 2k = 2.000)",
    text: "ngopi tadi 27.5k terus parkir 2k doang",
    expectEntries: [
      { type: "pengeluaran", jumlah: 27500, tanggal_hint: "hari_ini", deskripsiIncludes: ["kopi", "ngopi"] },
      { type: "pengeluaran", jumlah: 2000, tanggal_hint: "hari_ini", deskripsiIncludes: ["parkir"] },
    ],
  },
  {
    id: "hard-future-kulkas",
    style: "future_intent",
    group: "new",
    failureMode: "pure future plan ('besok mau beli') — nothing happened yet",
    text: "besok rencananya mau beli kulkas 3jt, nabung dulu deh sekarang",
    expectNonTransaction: true,
    expectEntries: [],
  },
  {
    id: "hard-past-future-dp",
    style: "future_intent",
    group: "new",
    failureMode: "mixed past+future — record only the paid DP, not the future lunas",
    text: "kemarin udah bayar dp motor 5jt, besok mau lunasin sisanya 15jt",
    expectEntries: [
      { type: "pengeluaran", jumlah: 5000000, tanggal_hint: "kemarin", deskripsiIncludes: ["dp", "motor"] },
    ],
    notes: "Trap: 15jt is future intent and must NOT be recorded",
  },
  {
    id: "hard-refund-tokopedia",
    style: "income",
    group: "new",
    failureMode: "refund masuk saldo = pemasukan (not pengeluaran)",
    text: "barang tokopedia rusak, refund 85rb udah masuk saldo tadi",
    expectEntries: [
      { type: "pemasukan", jumlah: 85000, tanggal_hint: "hari_ini", deskripsiIncludes: ["refund"] },
    ],
  },
  {
    id: "hard-diskon-net-price",
    style: "ambiguous_amount",
    group: "new",
    failureMode: "discount math — net paid is 200rb, not 250rb and not 2 entries",
    text: "beli sepatu 250rb tapi ada diskon 50rb jadi cuma bayar 200rb",
    expectEntries: [
      { type: "pengeluaran", jumlah: 200000, deskripsiIncludes: ["sepatu"] },
    ],
    notes: "Trap: 250000 (gross) or a 50000 discount line are both wrong",
  },
  {
    id: "hard-slang-ceban-goceng",
    style: "casual_slang",
    group: "new",
    failureMode: "money slang (ceban=10rb, goceng=5rb) — must convert, not read 0",
    text: "tadi jajan es teh ceban sama gorengan goceng",
    expectEntries: [
      { type: "pengeluaran", jumlah: 10000, tanggal_hint: "hari_ini", deskripsiIncludes: ["teh"] },
      { type: "pengeluaran", jumlah: 5000, tanggal_hint: "hari_ini", deskripsiIncludes: ["gorengan"] },
    ],
  },
  {
    id: "hard-spelled-setengah-juta",
    style: "income",
    group: "new",
    failureMode: "spelled amount 'setengah juta' = 500.000",
    text: "td dapet bonus setengah juta dari klien lama",
    expectEntries: [
      { type: "pemasukan", jumlah: 500000, tanggal_hint: "hari_ini", deskripsiIncludes: ["bonus"] },
    ],
  },
  {
    id: "hard-cancelled-jaket",
    style: "non_transaction",
    group: "new",
    failureMode: "cancelled purchase ('gak jadi beli') — no transaction occurred",
    text: "jadinya gak jadi beli jaket yang 350rb, batal checkout",
    expectNonTransaction: true,
    expectEntries: [],
  },
  {
    id: "hard-daging-2kg",
    style: "ambiguous_amount",
    group: "new",
    failureMode: "per-kg qty (2kg @ 135rb) — 2×135rb or 270rb merged",
    text: "beli daging sapi 2kg @ 135rb di tukang daging",
    expectEntries: [
      { type: "pengeluaran", jumlah: 135000, deskripsiIncludes: ["daging"] },
      { type: "pengeluaran", jumlah: 135000, deskripsiIncludes: ["daging"] },
    ],
    altStrict: { kind: "qtyMerge", keyword: "daging", unit: 135000, count: 2 },
    notes: "Alt: single 270000 entry",
  },
  {
    id: "hard-emoji-wa-noise",
    style: "multi_entry",
    group: "new",
    failureMode: "emoji + WA formatting noise around two amounts",
    text: "💸 pengeluaran hari ini: bensin 50rb, makan siang 35rb 🙏",
    expectEntries: [
      { type: "pengeluaran", jumlah: 50000, tanggal_hint: "hari_ini", deskripsiIncludes: ["bensin"] },
      { type: "pengeluaran", jumlah: 35000, tanggal_hint: "hari_ini", deskripsiIncludes: ["makan"] },
    ],
    priceCopyCheck: true,
  },
  {
    id: "hard-rekap-5line",
    style: "stress_extreme",
    group: "new",
    failureMode: "5-item daily rekap — count fidelity + no merge/drop",
    text: "rekap hari ini: sarapan 20rb, bensin 40rb, parkir 5rb, makan siang 30rb, kopi sore 18rb",
    expectEntries: [
      { type: "pengeluaran", jumlah: 20000, tanggal_hint: "hari_ini", deskripsiIncludes: ["sarapan"] },
      { type: "pengeluaran", jumlah: 40000, tanggal_hint: "hari_ini", deskripsiIncludes: ["bensin"] },
      { type: "pengeluaran", jumlah: 5000, tanggal_hint: "hari_ini", deskripsiIncludes: ["parkir"] },
      { type: "pengeluaran", jumlah: 30000, tanggal_hint: "hari_ini", deskripsiIncludes: ["makan"] },
      { type: "pengeluaran", jumlah: 18000, tanggal_hint: "hari_ini", deskripsiIncludes: ["kopi"] },
    ],
    priceCopyCheck: true,
  },
];

// ─── Quality analysis (beyond strict pass/fail) ─────────────────────────────

type QualityTier = "excellent" | "usable_with_edit" | "partially_usable" | "misleading" | "broken";

export interface QualityAnalysis {
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

/** Lightweight match used by alt-strict checks (type + amount + desc keyword). */
function looseMatch(got: ParsedFinance["entries"][number], exp: ExpectedEntry): boolean {
  if (got.type !== exp.type) return false;
  const amtOk =
    exp.jumlahMin != null || exp.jumlahMax != null
      ? got.jumlah >= (exp.jumlahMin ?? exp.jumlah) && got.jumlah <= (exp.jumlahMax ?? exp.jumlah)
      : got.jumlah === exp.jumlah;
  if (!amtOk) return false;
  if (exp.deskripsiIncludes?.length) {
    const desc = normalizeText(`${got.deskripsi} ${got.vendor ?? ""}`);
    if (!exp.deskripsiIncludes.some((k) => desc.includes(normalizeText(k)))) return false;
  }
  return true;
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

/** Data-driven alternate strict acceptance. */
function applyAltStrict(scenario: HardScenario, parsed: ParsedFinance): boolean {
  const rule = scenario.altStrict;
  if (!rule) return false;
  const entries = parsed.entries;

  if (rule.kind === "qtyMerge" || rule.kind === "totalOrSplit") {
    const kw = normalizeText(rule.keyword);
    const matched = entries.filter((e) => normalizeText(e.deskripsi).includes(kw));
    const total = matched.reduce((s, e) => s + e.jumlah, 0);
    const splitOk = matched.filter((e) => e.jumlah === rule.unit).length === rule.count;
    const mergeOk = matched.length >= 1 && total === rule.unit * rule.count;

    // Any non-keyword expected entries must still match under the alternate layout.
    const fixedExpected = scenario.expectEntries.filter(
      (e) => !e.deskripsiIncludes?.some((k) => normalizeText(k) === kw),
    );
    const fixedOk = fixedExpected.every((exp) => entries.some((g) => looseMatch(g, exp)));

    return fixedOk && (splitOk || mergeOk);
  }

  if (rule.kind === "principalPlusFee") {
    const out = entries.filter((e) => e.type === "pengeluaran");
    const sum = out.reduce((s, e) => s + e.jumlah, 0);
    const hasBoth =
      out.some((e) => e.jumlah === rule.principal) && out.some((e) => e.jumlah === rule.fee);
    return hasBoth || sum === rule.principal + rule.fee;
  }

  if (rule.kind === "personalShare") {
    const personal = entries.find((e) => e.jumlah === rule.personal);
    if (personal) return true;
    const total = entries.find((e) => e.jumlah === rule.total);
    return Boolean(total?.ambigu || total?.catatan_ambigu);
  }

  return false;
}

/** Generic adjacent-price-copy: an entry's amount equals a SIBLING line's amount, not its own. */
function detectPriceCopy(parsed: ParsedFinance, scenario: HardScenario): boolean {
  if (!scenario.priceCopyCheck) return false;
  const exps = scenario.expectEntries;
  if (exps.length < 2) return false;
  const distinct = new Set(exps.map((e) => e.jumlah));
  if (distinct.size < 2) return false;

  for (const e of parsed.entries) {
    const desc = normalizeText(`${e.deskripsi} ${e.vendor ?? ""}`);
    const own = exps.find((x) => x.deskripsiIncludes?.some((k) => desc.includes(normalizeText(k))));
    if (!own) continue;
    if (e.jumlah === own.jumlah) continue;
    // amount belongs to a DIFFERENT expected line → bled/copied
    if (exps.some((x) => x !== own && x.jumlah === e.jumlah)) return true;
  }
  return false;
}

export function analyzeQuality(parsed: ParsedFinance, scenario: HardScenario): QualityAnalysis {
  const strict = scoreExtraction(parsed, scenario);
  const strictAltPass = !strict.pass && applyAltStrict(scenario, parsed);
  const strictPass = strict.pass || strictAltPass;

  const qualityNotes: string[] = [];
  const partialMatches: QualityAnalysis["partialMatches"] = [];

  if (strictAltPass && !strict.pass) {
    qualityNotes.push("Alt strict layout accepted (merged qty / total / principal+fee / share)");
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
      : strictAltPass
        ? 90
        : Math.max(0, 100 - Math.abs(gotCount - expectedCount) * 25);

  let noHallucination = 100;
  noHallucination -= extraEntries.length * 25;
  if (zeroAmountEntries > 0) noHallucination -= zeroAmountEntries * 30;
  if (spuriousIncome) noHallucination -= 40;
  if (priceCopySuspect) noHallucination -= 35;
  noHallucination = Math.max(0, noHallucination);

  let compositeScore = Math.round(
    amount * 0.3 +
      typeDirection * 0.25 +
      noHallucination * 0.2 +
      entryCount * 0.1 +
      dateHint * 0.05 +
      ambiguHandling * 0.05 +
      100 * 0.05, // non-tx N/A → full weight
  );

  // A clean strict-alt pass (e.g. merged total/qty) is genuinely excellent —
  // don't let per-expected-entry partial matching under-rate it.
  const cleanStrict =
    strictPass &&
    extraEntries.length === 0 &&
    !spuriousIncome &&
    !priceCopySuspect &&
    zeroAmountEntries === 0;
  if (cleanStrict) compositeScore = Math.max(compositeScore, 92);

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
  group: HardScenario["group"];
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
  meanComposite: number;
  tierCounts: Record<QualityTier, number>;
  meanMs: number;
  errors: number;
  topQualityWins: string[];
  topFailures: string[];
}

function parseArgs(argv: string[]) {
  let model: string | undefined;
  let models: string[] | undefined;
  let dryRun = false;
  let baseUrl: string | undefined;
  let apiKey: string | undefined;
  const mergeFrom: string[] = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--model" && argv[i + 1]) {
      model = argv[++i];
    } else if (a === "--models" && argv[i + 1]) {
      models = (argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--base-url" && argv[i + 1]) {
      baseUrl = argv[++i];
    } else if (a === "--api-key" && argv[i + 1]) {
      apiKey = argv[++i];
    } else if (a === "--merge-from" && argv[i + 1]) {
      mergeFrom.push(resolve(argv[++i]!));
    }
  }
  return { model, models, dryRun, mergeFrom, baseUrl, apiKey };
}

function mergeResultRows(
  base: ScenarioResult[],
  incoming: ScenarioResult[],
): ScenarioResult[] {
  const byKey = new Map<string, ScenarioResult>();
  for (const r of base) byKey.set(`${r.modelId}::${r.scenarioId}`, r);
  for (const r of incoming) byKey.set(`${r.modelId}::${r.scenarioId}`, r);
  return [...byKey.values()];
}

function buildMarkdownReport(
  results: ScenarioResult[],
  summaries: ModelSummary[],
  runAt: string,
): string {
  const total = HARD_SCENARIOS.length;
  const ranked = [...summaries].sort(
    (a, b) => b.strictPass - a.strictPass || b.meanComposite - a.meanComposite,
  );
  const lines: string[] = [
    `# Finance Parse Hard-25 Eval — ${runAt}`,
    "",
    `25 extreme-but-realistic scenarios (12 rewrites + 13 new angles) × ${ranked.length} models.`,
    "",
    "## Models (this run)",
    "",
    ranked.map((s) => `- \`${s.modelId}\``).join("\n"),
    "",
    "## Recommendation",
    "",
  ];

  const best = ranked[0];
  if (best) {
    lines.push(
      `**Top pick: \`${best.modelId}\`** — ${best.strictPass}/${total} strict, composite ${best.meanComposite.toFixed(0)}, ~${best.meanMs.toFixed(0)}ms.`,
      "",
    );
    const fastestStrong = [...summaries]
      .filter((s) => s.strictPass >= best.strictPass - 1)
      .sort((a, b) => a.meanMs - b.meanMs)[0];
    if (fastestStrong && fastestStrong.modelId !== best.modelId) {
      lines.push(
        `**Best speed/quality balance: \`${fastestStrong.modelId}\`** — ${fastestStrong.strictPass}/${total} strict at ~${fastestStrong.meanMs.toFixed(0)}ms.`,
        "",
      );
    }
  }

  lines.push(
    "## Scoreboard",
    "",
    "| Model | Strict | Composite avg | Excellent | Usable+ | Partial | Misleading | Broken | Errors | Latency |",
    "|-------|--------|---------------|-----------|---------|---------|------------|--------|--------|---------|",
  );
  for (const s of ranked) {
    lines.push(
      `| ${s.modelId} | ${s.strictPass}/${total} | ${s.meanComposite.toFixed(0)} | ${s.tierCounts.excellent} | ${s.tierCounts.usable_with_edit} | ${s.tierCounts.partially_usable} | ${s.tierCounts.misleading} | ${s.tierCounts.broken} | ${s.errors} | ${s.meanMs.toFixed(0)}ms |`,
    );
  }

  lines.push("", "## Scenarios", "");
  for (const sc of HARD_SCENARIOS) {
    const tag = sc.group === "rewrite" ? `rewrite of ${sc.basedOn}` : "new";
    lines.push(`### ${sc.id} _(${tag})_`, `- **Failure mode:** ${sc.failureMode}`, `- **Input:** ${sc.text}`, "");
  }

  lines.push("## Per-model analysis", "");
  for (const s of ranked) {
    lines.push(`### ${s.modelId}`, "");
    lines.push(`- Strict pass: **${s.strictPass}/${total}**`);
    lines.push(`- Mean composite quality: **${s.meanComposite.toFixed(1)}**`);
    lines.push(`- Latency: **~${s.meanMs.toFixed(0)}ms**`);
    if (s.topQualityWins.length) lines.push(`- Quality wins: ${s.topQualityWins.join("; ")}`);
    if (s.topFailures.length) lines.push(`- Key failures: ${s.topFailures.join("; ")}`);
    lines.push("", "#### Scenario detail", "");
    lines.push("| Scenario | Strict | Tier | Composite | Got/Exp | Notes |");
    lines.push("|----------|--------|------|-----------|---------|-------|");

    const modelResults = results.filter((r) => r.modelId === s.modelId);
    for (const r of modelResults) {
      const q = r.quality;
      const notes = q
        ? [...q.qualityNotes, ...q.strictIssues].slice(0, 2).join("; ") || "—"
        : r.error ?? "—";
      const gotExp = q ? `${r.parsed?.entries.length ?? 0}/${r.strict?.expected ?? 0}` : "—";
      lines.push(
        `| ${r.scenarioId} | ${q?.strictPass ? "✓" : "✗"} | ${q?.tier ?? "—"} | ${q?.compositeScore ?? "—"} | ${gotExp} | ${notes.replace(/\|/g, "/")} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Cross-model insights (per scenario)", "");
  const byScenario = new Map<string, ScenarioResult[]>();
  for (const r of results) {
    const arr = byScenario.get(r.scenarioId) ?? [];
    arr.push(r);
    byScenario.set(r.scenarioId, arr);
  }
  const nModels = summaries.length;
  for (const sc of HARD_SCENARIOS) {
    const rows = byScenario.get(sc.id) ?? [];
    const passCount = rows.filter((r) => r.quality?.strictPass).length;
    const avgComposite =
      rows.reduce((s, r) => s + (r.quality?.compositeScore ?? 0), 0) / Math.max(rows.length, 1);
    const flag = passCount < nModels ? " ⚠️" : "";
    lines.push(`- **${sc.id}**: ${passCount}/${nModels} strict, avg composite ${avgComposite.toFixed(0)}${flag}`);
  }

  return lines.join("\n");
}

async function main() {
  const { model: singleModel, models: modelsArg, dryRun, mergeFrom, baseUrl, apiKey } =
    parseArgs(process.argv);
  applyLlmConfigOverrides({ baseUrl, apiKey });
  const models = singleModel
    ? [singleModel]
    : modelsArg?.length
      ? modelsArg
      : [...ALL_EVAL_MODELS];
  // Checked below the dry-run branch: --dry-run only prints scenarios, so it must work
  // before any model is wired up.
  if (!dryRun && !models.length) {
    throw new Error(
      "No models to eval. Pass --model <lm-studio-id> or --models a,b (ALL_EVAL_MODELS is empty by default).",
    );
  }
  const runAt = new Date().toISOString();
  const { baseURL } = getLlmConfig();

  console.log(`Finance Parse HARD-25 eval — ${runAt}`);
  console.log(`Base URL: ${baseURL}`);
  console.log(`Scenarios: ${HARD_SCENARIOS.length} (${HARD_SCENARIOS.filter((s) => s.group === "rewrite").length} rewrites + ${HARD_SCENARIOS.filter((s) => s.group === "new").length} new)`);
  console.log(`Models: ${models.join(", ")}\n`);

  if (dryRun) {
    for (const s of HARD_SCENARIOS) {
      console.log(`[dry] ${s.id} (${s.group}): ${s.failureMode}`);
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
          group: scenario.group,
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
          group: scenario.group,
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

  let mergedResults = results;
  if (mergeFrom.length > 0) {
    let prior: ScenarioResult[] = [];
    for (const p of mergeFrom) {
      const data = JSON.parse(readFileSync(p, "utf8")) as { results: ScenarioResult[] };
      prior = mergeResultRows(prior, data.results);
      console.log(`\nMerged ${data.results.length} rows from ${p}`);
    }
    mergedResults = mergeResultRows(prior, results);
    console.log(`Combined total: ${mergedResults.length} result rows, ${new Set(mergedResults.map((r) => r.modelId)).size} models`);
  }

  const summaries: ModelSummary[] = [...new Set(mergedResults.map((r) => r.modelId))].map((modelId) => {
    const rows = mergedResults.filter((r) => r.modelId === modelId);
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
      .filter((r) => r.quality && !r.quality.strictPass && r.quality.compositeScore >= 80)
      .map((r) => `${r.scenarioId}(composite=${r.quality?.compositeScore})`);

    return {
      modelId,
      strictPass: ok.length,
      meanComposite: composites.length ? composites.reduce((a, b) => a + b, 0) / composites.length : 0,
      tierCounts,
      meanMs:
        rows.filter((r) => r.ms > 0).reduce((s, r) => s + r.ms, 0) /
        Math.max(rows.filter((r) => r.ms > 0).length, 1),
      errors: rows.filter((r) => r.error).length,
      topQualityWins: wins,
      topFailures: failures,
    };
  });

  console.log(`\n${"=".repeat(72)}`);
  console.log("HARD-25 SCOREBOARD (strict | composite avg | latency)");
  console.log("=".repeat(72));
  for (const s of summaries.sort((a, b) => b.strictPass - a.strictPass || b.meanComposite - a.meanComposite)) {
    console.log(
      `  ${s.modelId.padEnd(36)} ${s.strictPass}/${HARD_SCENARIOS.length} strict  composite=${s.meanComposite.toFixed(0)}  ~${s.meanMs.toFixed(0)}ms  errors=${s.errors}`,
    );
    console.log(
      `    tiers: excellent=${s.tierCounts.excellent} usable=${s.tierCounts.usable_with_edit} partial=${s.tierCounts.partially_usable} misleading=${s.tierCounts.misleading} broken=${s.tierCounts.broken}`,
    );
  }

  const logDir = resolve(import.meta.dirname, "../docs/results/runs");
  mkdirSync(logDir, { recursive: true });
  const dateSlug = runAt.slice(0, 10);
  const jsonPath = resolve(logDir, `${dateSlug}-finance-hard-25-results.json`);
  const mdPath = resolve(logDir, `${dateSlug}-finance-hard-25-analysis.md`);

  const allModels = [...new Set(mergedResults.map((r) => r.modelId))].sort();

  const payload = {
    kind: "parse-hard-25" as const,
    runAt,
    baseURL: getLlmConfig().baseURL,
    models: allModels,
    scenarios: HARD_SCENARIOS.map((s) => ({
      id: s.id,
      group: s.group,
      basedOn: s.basedOn,
      failureMode: s.failureMode,
      text: s.text,
      expectNonTransaction: s.expectNonTransaction,
      expectEntries: s.expectEntries,
    })),
    results: mergedResults,
    summaries,
  };

  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  writeFileSync(mdPath, buildMarkdownReport(mergedResults, summaries, runAt));

  console.log(`\nJSON log: ${jsonPath}`);
  console.log(`Analysis: ${mdPath}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  });
}
