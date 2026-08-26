import { describe, expect, test } from "bun:test";
import {
  DATE_SURFACES,
  VENDORS,
  assertCellCoherent,
  buildTaxonomy,
  type Cell,
} from "./parse-taxonomy.ts";

/** A minimal cell that passes every existing coherence rule — the baseline to perturb. */
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

const SEEDS = [42, 7, 1234];

describe("the baseline cell is coherent", () => {
  // If this fails every other test in this file is meaningless — they perturb this cell.
  test("passes assertCellCoherent unmodified", () => {
    expect(() => assertCellCoherent(cell())).not.toThrow();
  });
});

describe("date surfaces are unambiguous", () => {
  // "bulan ini kemarin awal" embeds `kemarin`, the trigger for a DIFFERENT hint. Any cell
  // drawing it orders a text the blind parse must read as kemarin, then rejects the teacher
  // for the disagreement — unpassable by construction.
  test("no surface embeds a surface belonging to another hint", () => {
    for (const [hint, surfaces] of Object.entries(DATE_SURFACES)) {
      for (const s of surfaces) {
        for (const [otherHint, otherSurfaces] of Object.entries(DATE_SURFACES)) {
          if (otherHint === hint) continue;
          for (const other of otherSurfaces) {
            expect(
              new RegExp(`\\b${other}\\b`, "i").test(s),
              `${hint} surface "${s}" contains ${otherHint} trigger "${other}"`,
            ).toBe(false);
          }
        }
      }
    }
  });

  test("assertCellCoherent rejects a surface carrying a foreign trigger", () => {
    expect(() =>
      assertCellCoherent(cell({ dateHint: "bulan_ini", dateSurface: "bulan ini kemarin awal" })),
    ).toThrow(/foreign|trigger|kemarin/i);
  });

  test.each(SEEDS)("buildTaxonomy(%i) draws no ambiguous date surface", (seed) => {
    for (const c of buildTaxonomy(seed)) {
      if (c.dateSurface === null || c.dateHint === "kemarin") continue;
      expect(/\b(kemarin|maren|kmrn|kemaren)\b/i.test(c.dateSurface), `${c.id} → "${c.dateSurface}"`).toBe(false);
    }
  });
});

describe("carrier axes must not fight the asserted direction", () => {
  // The module contract: register/noise/rail/vendor are perturbation only and "must NOT
  // change the parse". A donation vendor on an income cell breaks exactly that — no
  // Indonesian sentence books `infaq` as money coming in.
  test("every vendor declares a direction polarity", () => {
    for (const v of VENDORS) {
      expect(["out", "in", "any"], `vendor ${v.id}`).toContain(v.polarity);
    }
  });

  test("assertCellCoherent rejects an income cell carrying an expense-only vendor", () => {
    expect(() =>
      assertCellCoherent(cell({ aspect: "ord_vendor_named", direction: "in", vendors: ["masjid_infaq"] })),
    ).toThrow(/polarity|direction/i);
  });

  test("assertCellCoherent allows an expense cell carrying an expense-only vendor", () => {
    expect(() => assertCellCoherent(cell({ direction: "out", vendors: ["masjid_infaq"] }))).not.toThrow();
  });

  // dir_income_refund_cashback pairs RETAIL with direction=in ON PURPOSE — its benchAnalogue
  // is "refund booked as pengeluaran because the vendor name reads like a purchase". A refund
  // IS income from a shop, so the polarity guard must not gut the aspect it was built for.
  test("assertCellCoherent allows an income cell carrying a refundable retail vendor", () => {
    expect(() =>
      assertCellCoherent(cell({ aspect: "dir_income_refund_cashback", direction: "in", vendors: ["shopee"] })),
    ).not.toThrow();
  });

  test.each(SEEDS)("buildTaxonomy(%i) pairs no cell with a contradictory vendor", (seed) => {
    for (const c of buildTaxonomy(seed)) {
      if (c.direction !== "in" && c.direction !== "out") continue;
      for (const id of c.vendors) {
        const v = VENDORS.find((x) => x.id === id);
        expect(v?.polarity === "any" || v?.polarity === c.direction, `${c.id} (${c.direction}) × ${id}`).toBe(true);
      }
    }
  });
});

describe("qty cells count items, not packs", () => {
  // lusin = 12. Ordering "3 lusin @62.500" and expecting 3 entries asks the teacher to be
  // wrong about Indonesian: both it and the parser correctly read 36 items, and the row is
  // rejected for their competence.
  test("assertCellCoherent rejects a qty keyword that denotes more than one item", () => {
    expect(() =>
      assertCellCoherent(
        cell({
          cardinality: "tiga",
          invariants: [
            { kind: "qty_merge_ok", keyword: "lusin", unit: 20_000, count: 3 },
            { kind: "amount_present", rupiah: 20_000 },
          ],
        }),
      ),
    ).toThrow(/lusin|multi|pack|satuan/i);
  });

  test("assertCellCoherent allows a single-item qty keyword", () => {
    expect(() =>
      assertCellCoherent(
        cell({
          cardinality: "tiga",
          invariants: [
            { kind: "qty_merge_ok", keyword: "porsi", unit: 20_000, count: 3 },
            { kind: "amount_present", rupiah: 20_000 },
          ],
        }),
      ),
    ).not.toThrow();
  });

  test.each(SEEDS)("buildTaxonomy(%i) draws no multi-item qty keyword", (seed) => {
    for (const c of buildTaxonomy(seed)) {
      for (const i of c.invariants) {
        if (i.kind !== "qty_merge_ok") continue;
        expect(/\b(lusin|kodi|gross|rim)\b/i.test(i.keyword), `${c.id} → "${i.keyword}"`).toBe(false);
      }
    }
  });
});
