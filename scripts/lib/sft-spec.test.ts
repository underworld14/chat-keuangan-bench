import { describe, expect, test } from "bun:test";
import type { ParsedFinance } from "../../src/core/eval-core.ts";
import type { Cell, Register } from "../../src/core/parse-taxonomy.ts";
import { buildTextPrompt, cellToSpec, excusedByConstruction, traceableByConstruction } from "./sft-spec.ts";
import { RejectError, validateRow } from "./sft-validate.ts";

const cell = (over: Partial<Cell> = {}): Cell => ({
  id: "test-00",
  aspect: "ord_single_out",
  tier: "ordinary",
  direction: "out",
  cardinality: "single",
  notation: ["polos"],
  magnitude: "kecil",
  dateHint: "tidak_jelas",
  dateSurface: null,
  correction: "none",
  nilai: [{ surface: "20rb", rupiah: 20_000, attested: "kbbi" }],
  invariants: [{ kind: "entry_count", n: 1 }, { kind: "amount_present", rupiah: 20_000 }],
  register: "baku",
  registerIntensity: "sisip",
  noise: "bersih",
  rail: "none",
  vendors: [],
  split: "train",
  rows: 6,
  benchAnalogue: null,
  ...over,
});

const promptFor = (over: Partial<Cell> = {}): string => buildTextPrompt(cellToSpec(cell(over), 0)).user;

/**
 * Every rail, so a newly added one cannot quietly reintroduce expense-only phrasing — and so
 * that a key typo cannot silently drop the hint again. RAIL_HINTS was keyed "transfer" while
 * the Rail type says "transfer_bank", so every transfer cell (13% of the taxonomy) got no rail
 * line at all. `Record<string, string>` typechecks that mistake happily.
 */
const RAIL_TOKEN = {
  transfer_bank: /transfer/i,
  ewallet: /e-wallet/i,
  tunai: /tunai/i,
  qris: /qris/i,
  cod: /cod/i,
  kartu: /kartu/i,
  emoney: /e-money/i,
  pulsa: /pulsa/i,
} as const;
const RAILS = Object.keys(RAIL_TOKEN) as Array<keyof typeof RAIL_TOKEN>;

describe("the prompt never contradicts the direction it ordered", () => {
  // The row that exposed this: ord_single_in-01 ordered "50.000 → MASUK — pakai kata:
  // terima/dapat/masuk/cair" and then, four lines down, "Metode bayar ...: bayar tunai/cash".
  // The teacher wrote an expense, the blind parse agreed with the teacher, and the row was
  // rejected as an agreement failure — for a contradiction we authored.
  test.each(RAILS)("an income cell is never told to pay (rail=%s)", (rail) => {
    const user = promptFor({ aspect: "ord_single_in", direction: "in", rail });
    expect(user).not.toMatch(/\bbayar\b/i);
    expect(user).not.toMatch(/\bbeli\b/i);
  });

  test.each(RAILS)("an expense cell still names its rail (rail=%s)", (rail) => {
    expect(promptFor({ direction: "out", rail })).toMatch(RAIL_TOKEN[rail]);
  });

  test.each(RAILS)("an income cell still names its rail (rail=%s)", (rail) => {
    expect(promptFor({ aspect: "ord_single_in", direction: "in", rail })).toMatch(RAIL_TOKEN[rail]);
  });

  // "kosakata pesantren sebagai isi transaksi (infaq, sedekah, syahriah, setoran wali, santri)"
  // mixes both polarities in one list. On ord_rekap_list-01 (an EXPENSE rekap) the teacher took
  // "setoran wali", the parse read pemasukan, and all six entries flipped.
  test("an expense cell is not offered income vocabulary", () => {
    const user = promptFor({ direction: "out", register: "pesantren", registerIntensity: "campur" });
    expect(user).not.toMatch(/setoran wali/i);
  });

  test.each(["pesantren", "jawa", "sunda"] as const)(
    "an income cell is not offered a buy-verb (register=%s)",
    (register: Register) => {
      const user = promptFor({ aspect: "ord_single_in", direction: "in", register, registerIntensity: "campur" });
      // tuku (jv) and meuli (su) are "buy"; infaq/sedekah/syahriah are money leaving.
      expect(user).not.toMatch(/\b(tuku|meuli|infaq|sedekah|syahriah)\b/i);
    },
  );

  test("a register still perturbs the text when it does not fight the direction", () => {
    const user = promptFor({ direction: "out", register: "jawa", registerIntensity: "campur" });
    expect(user).toMatch(/\bjawa\b/i);
    expect(user).toMatch(/\btuku\b/i);
  });

  // ntx_curhat-12: "kosakata pesantren sebagai ISI TRANSAKSI" fights "INI BUKAN TRANSAKSI JADI"
  // in the same prompt, so the teacher wrote a completed donation and the parse booked it.
  test("a non-transaction cell is not told to make the register a transaction", () => {
    const user = promptFor({
      aspect: "ntx_curhat",
      tier: "non_tx",
      direction: "non_tx",
      cardinality: "zero",
      register: "pesantren",
      registerIntensity: "campur",
      invariants: [{ kind: "non_transaction" }],
      nilai: [{ surface: "47500", rupiah: 47_500, attested: "kbbi" }],
    });
    expect(user).not.toMatch(/isi transaksi/i);
  });
});

describe("a qty cell's merged reading is actually reachable", () => {
  const qtyCell = cell({
    aspect: "ord_qty_simple",
    cardinality: "tiga",
    invariants: [
      { kind: "qty_merge_ok", keyword: "porsi", unit: 20_000, count: 3 },
      { kind: "amount_present", rupiah: 20_000 },
    ],
  });
  const TEXT = "beli 3 porsi bakso @20rb";

  const labelOf = (jumlah: number[]): ParsedFinance => ({
    entries: jumlah.map((j) => ({
      type: "pengeluaran" as const,
      tanggal_hint: null,
      deskripsi: "bakso",
      jumlah: j,
      kategori: null,
      vendor: null,
      confidence: "high" as const,
      ambigu: false,
      catatan_ambigu: null,
    })),
    bukan_transaksi: false,
    ringkasan: null,
  });

  const check = (label: ParsedFinance) => {
    const s = cellToSpec(qtyCell, 0);
    return validateRow({
      text: TEXT,
      label,
      spec: s.expectation,
      shape: { allowDuplicateEntries: s.allowDuplicateEntries },
      excusedByConstruction: excusedByConstruction(s),
      traceableByConstruction: traceableByConstruction(s),
    });
  };

  test("cellToExpectation offers both the split and the merged reading", () => {
    expect(cellToSpec(qtyCell, 0).expectation.alternatives).toHaveLength(2);
  });

  test("the split reading still passes", () => {
    expect(() => check(labelOf([20_000, 20_000, 20_000]))).not.toThrow();
  });

  // The reading cellToExpectation calls legal. The prompt forbids writing the total, so 60.000
  // appears nowhere in the text — guardTrace ran first, called it a hallucination, and killed
  // the row before compareLabelToSpec could say the spec itself had offered it.
  test("the merged reading passes and is reported as derived, not direct", () => {
    expect(check(labelOf([60_000])).traceTiers).toEqual(["derived"]);
  });

  // The guard must still bite: 99.000 is neither in the text nor a reading the spec offers.
  test("a total the spec never offered is still a hallucination", () => {
    const t = () => check(labelOf([99_000]));
    expect(t).toThrow(RejectError);
    try { t(); } catch (e) { expect((e as RejectError).phase).toBe("label:trace"); }
  });
});
