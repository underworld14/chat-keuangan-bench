import { describe, expect, test } from "bun:test";
import { LeakError } from "../../src/core/parse-leakguard.ts";
import { RejectError } from "./sft-validate.ts";
import { toRejectRow } from "./sft-io.ts";

const spec = { planIndex: 7, cellId: "ord_single_in-01" };

describe("toRejectRow", () => {
  // The bug this exists to close: the generator wrote planIndex/cellId/phase/message and
  // dropped the text, so every agreement reject on disk read `"text": null`. Diagnosing why a
  // cell fails means re-deriving its prompt by hand — the one field that explains the reject
  // was the one field not recorded, even though RejectRow already declared it.
  test("carries the text that caused the reject", () => {
    const row = toRejectRow(spec, new RejectError("agreement", "blind parse disagrees with spec on type"), "terima 50.000 bayar tunai");
    expect(row.text).toBe("terima 50.000 bayar tunai");
  });

  test("records no text when the teacher never produced one", () => {
    const row = toRejectRow(spec, new Error("connection reset"), null);
    expect(row.text).toBeUndefined();
  });

  test("a RejectError reports its own phase and issues", () => {
    const issues = [{ field: "type", expected: "pemasukan@8000", got: "pengeluaran@8000" }];
    const row = toRejectRow(spec, new RejectError("agreement", "disagrees", issues), "x");
    expect(row.phase).toBe("agreement");
    expect(row.issues).toEqual(issues);
    expect(row.planIndex).toBe(7);
    expect(row.cellId).toBe("ord_single_in-01");
  });

  test("a LeakError reports as text:leak", () => {
    const err = new LeakError([
      { reason: "amounts", suite: "hard-25", scoredId: "hard-ksuffix-decimal", score: 1, detail: "12.5k" },
    ]);
    expect(toRejectRow(spec, err, "x").phase).toBe("text:leak");
  });

  test("anything else reports as transport", () => {
    expect(toRejectRow(spec, new Error("socket hang up"), null).phase).toBe("transport");
  });
});
