import { describe, expect, test } from "bun:test";
import { financeParseSchema, parseFinanceJson, type ParsedFinance } from "../../src/core/eval-core.ts";
import {
  RejectError,
  buildStrictSchema,
  compareLabelToSpec,
  strictFinanceSchema,
  validateRow,
  type LabelExpectation,
} from "./sft-validate.ts";

const entry = (over: Partial<ParsedFinance["entries"][number]> = {}): ParsedFinance["entries"][number] => ({
  type: "pengeluaran",
  tanggal_hint: "hari_ini",
  deskripsi: "kopi",
  jumlah: 20_000,
  kategori: null,
  vendor: null,
  confidence: "high",
  ambigu: false,
  catatan_ambigu: null,
  ...over,
});

const label = (over: Partial<ParsedFinance> = {}): ParsedFinance => ({
  entries: [entry()],
  bukan_transaksi: false,
  ringkasan: null,
  ...over,
});

describe("the coercion gap this module exists to close", () => {
  // If this ever passes, parseFinanceJson has become safe to mint labels with — until then,
  // routing a candidate label through it silently invents the answer.
  test("parseFinanceJson mints a wrong label where the raw schema rejects", () => {
    const garbage = {
      entries: [{ type: "makan", tanggal_hint: "today", deskripsi: "nasi", jumlah: "25rb", kategori: null, vendor: null, confidence: 0.9, ambigu: false, catatan_ambigu: null }],
      bukan_transaksi: [],
      ringkasan: null,
    };
    const minted = parseFinanceJson(JSON.stringify(garbage));
    // "makan" is not a direction at all, yet it becomes an expense.
    expect(minted.entries[0]?.type).toBe("pengeluaran");
    expect(minted.entries[0]?.jumlah).toBe(25_000);

    expect(financeParseSchema.safeParse(garbage).success).toBe(false);
    expect(strictFinanceSchema.safeParse(garbage).success).toBe(false);
  });

  test("strict schema rejects unknown keys that the raw schema silently strips", () => {
    const withExtra = { ...label(), entries: [{ ...entry(), amount: 20_000 }] };
    expect(financeParseSchema.safeParse(withExtra).success).toBe(true);
    expect(strictFinanceSchema.safeParse(withExtra).success).toBe(false);
  });
});

describe("cross-field rules", () => {
  test("bukan_transaksi must agree with entry count, both ways", () => {
    expect(strictFinanceSchema.safeParse(label({ entries: [], bukan_transaksi: false })).success).toBe(false);
    expect(strictFinanceSchema.safeParse(label({ entries: [entry()], bukan_transaksi: true })).success).toBe(false);
    expect(strictFinanceSchema.safeParse(label({ entries: [], bukan_transaksi: true })).success).toBe(true);
  });

  test("ambigu and catatan_ambigu are biconditional", () => {
    expect(strictFinanceSchema.safeParse(label({ entries: [entry({ ambigu: true, catatan_ambigu: null, confidence: "low" })] })).success).toBe(false);
    expect(strictFinanceSchema.safeParse(label({ entries: [entry({ ambigu: false, catatan_ambigu: "ragu" })] })).success).toBe(false);
  });

  test("ambigu=true contradicts confidence=high", () => {
    expect(strictFinanceSchema.safeParse(label({ entries: [entry({ ambigu: true, catatan_ambigu: "ragu", confidence: "high" })] })).success).toBe(false);
  });

  test.each([
    ["jumlah <= 0", entry({ jumlah: 0 })],
    ["empty deskripsi", entry({ deskripsi: "  " })],
    ["deskripsi is a whole sentence", entry({ deskripsi: "tadi saya beli kopi susu gula aren di kantin dekat kantor" })],
    ["lusa is future", entry({ tanggal_hint: "lusa" })],
  ])("rejects %s", (_l, e) => {
    expect(strictFinanceSchema.safeParse(label({ entries: [e] })).success).toBe(false);
  });

  test("duplicate entries reject by default but pass for qty-split cells", () => {
    const dup = label({ entries: [entry({ jumlah: 5_000, deskripsi: "cilok" }), entry({ jumlah: 5_000, deskripsi: "cilok" })] });
    expect(strictFinanceSchema.safeParse(dup).success).toBe(false);
    // 4 × cilok @5rb is legitimate — a blanket dedup would reject the most valuable cells.
    expect(buildStrictSchema({ allowDuplicateEntries: true }).safeParse(dup).success).toBe(true);
  });
});

describe("compareLabelToSpec", () => {
  const spec: LabelExpectation = {
    nonTransaction: false,
    alternatives: [[
      { direction: "pengeluaran", amount: 50_000 },
      { direction: "pemasukan", amount: 25_000 },
    ]],
  };

  test("order does not matter", () => {
    const l = label({
      entries: [entry({ type: "pemasukan", jumlah: 25_000, deskripsi: "cashback" }), entry({ type: "pengeluaran", jumlah: 50_000, deskripsi: "listrik" })],
    });
    expect(compareLabelToSpec(l, spec).ok).toBe(true);
  });

  test("a flipped direction is reported as a type diff, not a missing amount", () => {
    const l = label({
      entries: [entry({ type: "pengeluaran", jumlah: 25_000 }), entry({ type: "pengeluaran", jumlah: 50_000 })],
    });
    const r = compareLabelToSpec(l, spec);
    expect(r.ok).toBe(false);
    expect(r.diffs[0]?.field).toBe("type");
  });

  test("absentAmounts catches a booked gross price", () => {
    const s: LabelExpectation = { nonTransaction: false, alternatives: [[{ direction: "pengeluaran", amount: 200_000 }]], absentAmounts: [250_000] };
    const ok = label({ entries: [entry({ jumlah: 200_000 })] });
    expect(compareLabelToSpec(ok, s).ok).toBe(true);

    const bad = label({ entries: [entry({ jumlah: 250_000 })] });
    expect(compareLabelToSpec(bad, s).diffs.some((d) => d.field === "jumlah" || d.field === "amount_absent")).toBe(true);
  });
});

describe("validateRow — end to end", () => {
  const spec: LabelExpectation = { nonTransaction: false, alternatives: [[{ direction: "pengeluaran", amount: 20_000 }]] };

  test("accepts a clean row", () => {
    const r = validateRow({ text: "beli kopi 20rb di kantin", label: label(), spec });
    expect(r.traceTiers).toEqual(["direct"]);
  });

  test("rejects a hallucinated amount", () => {
    const t = () => validateRow({ text: "beli kopi di kantin", label: label(), spec });
    expect(t).toThrow(RejectError);
    try { t(); } catch (e) { expect((e as RejectError).phase).toBe("label:trace"); }
  });

  test("rejects a dropped entry", () => {
    const t = () =>
      validateRow({ text: "beli kopi 20rb sama parkir 5rb", label: label(), spec });
    try { t(); } catch (e) { expect((e as RejectError).phase).toBe("label:dropped-entry"); }
    expect(t).toThrow(RejectError);
  });

  test("does NOT reject a superseded correction", () => {
    const r = validateRow({
      text: "kopi 15rb... eh bukan, 20rb",
      label: label(),
      spec,
    });
    expect(r.traceTiers).toEqual(["direct"]);
  });

  test("rejects an unresolvable amount rather than guessing", () => {
    const t = () =>
      validateRow({ text: "bayar 12.500 rb", label: label({ entries: [entry({ jumlah: 12_500_000 })] }), spec: { nonTransaction: false, alternatives: [[{ direction: "pengeluaran", amount: 12_500_000 }]] } });
    try { t(); } catch (e) { expect((e as RejectError).phase).toBe("text:ambiguous-amount"); }
    expect(t).toThrow(RejectError);
  });

  test("rejects a spec disagreement", () => {
    const t = () =>
      validateRow({ text: "beli kopi 20rb", label: label({ entries: [entry({ type: "pemasukan" })] }), spec });
    try { t(); } catch (e) { expect((e as RejectError).phase).toBe("agreement"); }
    expect(t).toThrow(RejectError);
  });
});
