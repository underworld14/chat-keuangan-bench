import { describe, expect, test } from "bun:test";
import type { Cell } from "../../src/core/parse-taxonomy.ts";
import {
  batchLabelResponseSchema,
  batchTextResponseSchema,
  buildBatchLabelPrompt,
  buildBatchTextPrompt,
  claimBatchFromPlan,
  chunkPlan,
  labelBatchMaxTokens,
  mapById,
  salvageLabelBatch,
  salvageTextBatch,
  textBatchMaxTokens,
} from "./sft-batch.ts";
import { cellToSpec, textTeacherSystemRules } from "./sft-spec.ts";

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

describe("mapById", () => {
  test("accepts reordered ids", () => {
    const { ok, fail } = mapById([1, 2, 3], [
      { id: 3, text: "c" },
      { id: 1, text: "a" },
      { id: 2, text: "b" },
    ]);
    expect(fail).toEqual([]);
    expect(ok.map((x) => x.id)).toEqual([1, 2, 3]);
    expect(ok.map((x) => x.text)).toEqual(["a", "b", "c"]);
  });

  test("reports missing ids", () => {
    const { ok, fail } = mapById([10, 11, 12], [
      { id: 10, text: "a" },
      { id: 12, text: "c" },
    ]);
    expect(ok.map((x) => x.id)).toEqual([10, 12]);
    expect(fail).toEqual([
      { id: 11, phase: "batch:missing", message: "id 11 missing from batch response" },
    ]);
  });

  test("rejects duplicates — neither copy is salvaged", () => {
    const { ok, fail } = mapById([1, 2], [
      { id: 1, text: "a" },
      { id: 1, text: "a2" },
      { id: 2, text: "b" },
    ]);
    expect(ok.map((x) => x.id)).toEqual([2]);
    expect(fail).toEqual([
      { id: 1, phase: "batch:duplicate", message: "id 1 appeared 2 times in batch response" },
    ]);
  });

  test("ignores unknown ids without inventing rejects", () => {
    const { ok, fail } = mapById([1], [
      { id: 1, text: "a" },
      { id: 99, text: "ghost" },
    ]);
    expect(ok).toHaveLength(1);
    expect(fail).toEqual([]);
  });
});

describe("salvageTextBatch", () => {
  test("partial salvage keeps valid texts and fails empty ones", () => {
    const response = batchTextResponseSchema.parse({
      items: [
        { id: 0, text: "beli kopi 20rb" },
        { id: 1, text: "  " },
        { id: 2, text: "gaji masuk 5jt" },
      ],
    });
    const { ok, fail } = salvageTextBatch([0, 1, 2], response);
    expect(ok).toEqual([
      { id: 0, text: "beli kopi 20rb" },
      { id: 2, text: "gaji masuk 5jt" },
    ]);
    expect(fail.some((f) => f.id === 1 && f.phase === "text:bijection")).toBe(true);
  });

  test("strips wrapping quotes and takes first line only", () => {
    const response = batchTextResponseSchema.parse({
      items: [{ id: 7, text: '"catat ya bayar wifi 150rb"\npenjelasan tambahan' }],
    });
    const { ok, fail } = salvageTextBatch([7], response);
    expect(fail).toEqual([]);
    expect(ok[0]?.text).toBe("catat ya bayar wifi 150rb");
  });
});

describe("salvageLabelBatch", () => {
  test("maps labels by id regardless of order", () => {
    const label = {
      entries: [
        {
          type: "pengeluaran" as const,
          tanggal_hint: null,
          deskripsi: "kopi",
          jumlah: 20_000,
          kategori: null,
          vendor: null,
          confidence: "high" as const,
          ambigu: false,
          catatan_ambigu: null,
        },
      ],
      bukan_transaksi: false,
      ringkasan: null,
    };
    const response = batchLabelResponseSchema.parse({
      items: [
        { id: 2, label },
        { id: 1, label },
      ],
    });
    const { ok, fail } = salvageLabelBatch([1, 2], response);
    expect(fail).toEqual([]);
    expect(ok.map((x) => x.id)).toEqual([1, 2]);
  });
});

describe("chunkPlan", () => {
  test("last batch may be short", () => {
    expect(chunkPlan([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test("exact multiple yields equal chunks", () => {
    expect(chunkPlan(["a", "b", "c", "d"], 2)).toEqual([["a", "b"], ["c", "d"]]);
  });

  test("rejects non-positive batch size", () => {
    expect(() => chunkPlan([1], 0)).toThrow(/batchSize/);
  });
});

describe("token budgets scale with batch size", () => {
  test("text batch floor and linear scale", () => {
    expect(textBatchMaxTokens(1)).toBe(256);
    expect(textBatchMaxTokens(20)).toBe(20 * 128);
  });

  test("label batch floor and linear scale", () => {
    expect(labelBatchMaxTokens(1)).toBe(2048);
    expect(labelBatchMaxTokens(20)).toBe(20 * 256);
  });
});

describe("batch prompts", () => {
  test("text prompt includes every planIndex and never asks for labels", () => {
    const specs = [cellToSpec(cell({ id: "a" }), 10), cellToSpec(cell({ id: "b", aspect: "ord_single_in", direction: "in" }), 11)];
    const { system, user } = buildBatchTextPrompt(specs);
    expect(system).toMatch(/items/);
    expect(user).toContain("### Brief id=10");
    expect(user).toContain("### Brief id=11");
    expect(user).toContain("20rb");
    expect(user).not.toMatch(/"entries"/);
    expect(user).not.toMatch(/bukan_transaksi/);
  });

  test("text system prompt keeps the single-item BAGUS/JELEK rules", () => {
    const { system } = buildBatchTextPrompt([cellToSpec(cell(), 0)]);
    expect(system).toContain(textTeacherSystemRules());
    expect(system).toMatch(/Contoh JELEK/);
    expect(system).toMatch(/BATCH MODE/);
  });

  test("label prompt is blind — texts only, no surfaces or expectations", () => {
    const { system, user } = buildBatchLabelPrompt([
      { id: 3, text: "beli nasi 25rb" },
      { id: 9, text: "gaji cair 5jt" },
    ]);
    expect(system).toMatch(/items/);
    expect(user).toContain("### id=3");
    expect(user).toContain("beli nasi 25rb");
    expect(user).toContain("### id=9");
    expect(user).not.toMatch(/Brief/);
    expect(user).not.toMatch(/Nominal yang WAJIB/);
    expect(user).not.toMatch(/MASUK — pakai kata/);
  });
});

describe("claimBatchFromPlan", () => {
  const plan = [
    { planIndex: 0 },
    { planIndex: 1 },
    { planIndex: 2 },
    { planIndex: 3 },
    { planIndex: 4 },
  ];

  test("last batch may be short", () => {
    const a = claimBatchFromPlan(
      { aborted: false, accepted: 0, count: 5, inFlight: 0, batchSize: 20, cursor: 0, done: new Set() },
      plan,
    );
    expect(a).toEqual({ kind: "batch", items: plan, nextCursor: 5, reserved: 5 });
  });

  test("reserves against accepted + inFlight so parallel workers cannot overshoot", () => {
    const a = claimBatchFromPlan(
      { aborted: false, accepted: 10, count: 20, inFlight: 8, batchSize: 20, cursor: 0, done: new Set() },
      plan,
    );
    expect(a.kind).toBe("batch");
    if (a.kind === "batch") expect(a.reserved).toBe(2);
  });

  test("waits when capacity is full but siblings are in flight", () => {
    expect(
      claimBatchFromPlan(
        { aborted: false, accepted: 18, count: 20, inFlight: 2, batchSize: 20, cursor: 0, done: new Set() },
        plan,
      ),
    ).toEqual({ kind: "wait" });
  });

  test("done when capacity full and nothing in flight", () => {
    expect(
      claimBatchFromPlan(
        { aborted: false, accepted: 20, count: 20, inFlight: 0, batchSize: 20, cursor: 0, done: new Set() },
        plan,
      ),
    ).toEqual({ kind: "done" });
  });

  test("skips done planIndexes and waits if plan exhausted while siblings fly", () => {
    const result = claimBatchFromPlan(
      {
        aborted: false,
        accepted: 0,
        count: 10,
        inFlight: 1,
        batchSize: 20,
        cursor: 0,
        done: new Set([0, 1, 2, 3, 4]),
      },
      plan,
    );
    expect(result).toEqual({ kind: "wait" });
  });
});
