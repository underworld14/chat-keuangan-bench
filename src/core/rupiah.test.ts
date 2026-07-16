import { describe, expect, test } from "bun:test";
import { HARD_SCENARIOS } from "../../scripts/eval-hard-25.ts";
import {
  SLANG_TABLE,
  hasAmbiguousAmount,
  tokenizeAmounts,
  traceAmount,
  unexcusedAtoms,
} from "./rupiah.ts";

const values = (text: string) => tokenizeAmounts(text).map((a) => a.value);

describe("tokenizeAmounts — notation", () => {
  test.each([
    ["beli bensin 50rb", [50_000]],
    ["ngopi 12 rebu", [12_000]],
    ["jajan 50 ribu", [50_000]],
    ["parkir 2k doang", [2_000]],
    ["bonus cair 2,5jt", [2_500_000]],
    ["gaji 1.5 juta", [1_500_000]],
    ["bayar wifi 350.000", [350_000]],
    ["belanja 63.700", [63_700]],
    ["ngopi 27.5k", [27_500]],
    ["bayar Rp 15.000", [15_000]],
    ["biaya admin 2500", [2_500]],
  ])("%s → %j", (text, expected) => {
    expect(values(text)).toEqual(expected);
  });

  test("dot is a decimal with a k-suffix but a thousands separator alone", () => {
    expect(values("27.5k")).toEqual([27_500]);
    expect(values("102.500")).toEqual([102_500]);
  });
});

describe("tokenizeAmounts — slang", () => {
  test("attested Hokkien values", () => {
    expect(values("es teh ceban sama gorengan goceng")).toEqual([10_000, 5_000]);
    expect(values("kasih gopek")).toEqual([500]);
    expect(values("kasih goban")).toEqual([50_000]);
    expect(values("cepek aja")).toEqual([100]);
  });

  // The bench (hard-20.ts:369) asserts gopek→50rb. That contradicts the morphology
  // go(5)×pek(100)=500; 50_000 is goban. This module is the single source of truth.
  test("gopek is 500, not 50_000 — 50_000 is goban", () => {
    expect(SLANG_TABLE.gopek).toBe(500);
    expect(SLANG_TABLE.goban).toBe(50_000);
  });

  test("slang only matches whole words", () => {
    expect(values("cebanyak orang")).toEqual([]);
  });
});

describe("tokenizeAmounts — spelled", () => {
  test("setengah juta", () => {
    expect(values("dapet bonus setengah juta dari klien")).toEqual([500_000]);
  });
});

describe("tokenizeAmounts — Javanese numerals", () => {
  // Unlike jaksel/betawi markers, these change the AMOUNT, so missing them mis-books
  // the ledger. `<numeral> ewu` = numeral × 1000; `sewu` is the fused se+ewu.
  test.each([
    ["tuku beras seket ewu", [50_000]],
    ["bayar sewu", [1_000]],
    ["jajan limang ewu", [5_000]],
    ["rong ewu wae", [2_000]],
    ["selawe ewu", [25_000]],
  ])("%s → %j", (text, expected) => {
    expect(values(text)).toEqual(expected);
  });

  test("a bare Javanese numeral without ewu is not money", () => {
    expect(values("seket wong teka")).toEqual([]);
  });
});

describe("tokenizeAmounts — quantities are not money", () => {
  test.each([
    ["beli beras 5kg 68rb sm minyak 2 ltr 38rb", [68_000, 38_000]],
    ["jajan cilok 4 tusuk 5rb 4 4 nya", [5_000]],
    ["bayar spp 3 anak @ 250rb", [250_000]],
    ["pulpen 2 lusin 30rb, kertas 1 rim 55rb", [30_000, 55_000]],
  ])("%s → %j", (text, expected) => {
    expect(values(text)).toEqual(expected);
  });
});

describe("hasAmbiguousAmount", () => {
  // eval-core's parseRupiahAmount returns 12_500_000 here. We refuse to guess instead.
  test("dot-thousands plus a multiplier is unresolvable", () => {
    const atoms = tokenizeAmounts("bayar 12.500 rb");
    expect(hasAmbiguousAmount(atoms)).toBe(true);
    expect(atoms[0]?.kind).toBe("suspect-dot-suffix");
  });

  test("plain amounts are never flagged", () => {
    expect(hasAmbiguousAmount(tokenizeAmounts("bayar 12.500"))).toBe(false);
    expect(hasAmbiguousAmount(tokenizeAmounts("bayar 12rb"))).toBe(false);
  });
});

// The empirical licence for making both gates hard rejections.
describe("gold recall — the repo's own hand-authored scenarios", () => {
  test("every gold amount traces DIRECTly to its text (45/45, no misses)", () => {
    const missed: string[] = [];
    const notDirect: string[] = [];
    let total = 0;

    for (const s of HARD_SCENARIOS) {
      const atoms = tokenizeAmounts(s.text);
      for (const e of s.expectEntries) {
        total++;
        const t = traceAmount(e.jumlah, atoms);
        if (t.tier === "none") missed.push(`${s.id}:${e.jumlah}`);
        else if (t.tier !== "direct") notDirect.push(`${s.id}:${e.jumlah}`);
      }
    }

    expect(missed).toEqual([]);
    expect(notDirect).toEqual([]);
    expect(total).toBe(45);
  });

  test("the reverse gate false-rejects zero gold scenarios", () => {
    const falseRejects: string[] = [];
    for (const s of HARD_SCENARIOS) {
      const atoms = tokenizeAmounts(s.text);
      const consumed = new Set(s.expectEntries.map((e) => e.jumlah));
      const unexcused = unexcusedAtoms(s.text, atoms, consumed);
      if (unexcused.length > 0) {
        falseRejects.push(`${s.id}: ${unexcused.map((u) => u.atom.value).join(",")}`);
      }
    }
    expect(falseRejects).toEqual([]);
  });

  test("the excuse window rescues exactly the 7 scenarios that need it", () => {
    const rescued: string[] = [];
    for (const s of HARD_SCENARIOS) {
      const atoms = tokenizeAmounts(s.text);
      const consumed = new Set(s.expectEntries.map((e) => e.jumlah));
      const naive = atoms.filter((a) => !consumed.has(a.value));
      if (naive.length > 0 && unexcusedAtoms(s.text, atoms, consumed).length === 0) {
        rescued.push(s.id);
      }
    }
    // A naive reverse check fires on these 7 (28%) — each is a legitimate superseded,
    // future, shared, discounted or cancelled amount, not a dropped entry.
    expect(rescued.sort()).toEqual([
      "hard-cancelled-jaket",
      "hard-diskon-net-price",
      "hard-future-kulkas",
      "hard-hp-2juta",
      "hard-past-future-dp",
      "hard-patungan-tim",
      "hard-voice-ojek-correct",
    ]);
  });
});

describe("unexcusedAtoms — catches genuinely dropped entries", () => {
  test("an unexplained extra amount is reported", () => {
    const text = "beli bensin 50rb sama parkir 5rb";
    const atoms = tokenizeAmounts(text);
    const unexcused = unexcusedAtoms(text, atoms, new Set([50_000])); // parkir dropped
    expect(unexcused.map((u) => u.atom.value)).toEqual([5_000]);
  });

  test("a superseded correction is excused", () => {
    const text = "ojek 20rb... eh bukan, 35rb";
    const atoms = tokenizeAmounts(text);
    expect(unexcusedAtoms(text, atoms, new Set([35_000]))).toEqual([]);
  });
});
