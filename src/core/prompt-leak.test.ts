import { describe, expect, test } from "bun:test";
import { SYSTEM_PROMPT } from "./eval-core.ts";
import { ALL_SCORED_TEXTS } from "./eval-corpus.ts";
import { normalizeChatText } from "./parse-leakguard.ts";

/**
 * SYSTEM_PROMPT must teach the RULES without printing the ANSWERS.
 *
 * It previously carried verbatim spans of six scored scenarios ("beli bensin 50k",
 * "duit masuk dari donasi 2jt", "refund tokopedia masuk", "terima setoran wali",
 * "2 2 nya"), so `bun run eval` was partly reading its own answer key. Parse-25 was
 * never affected — the overlap was base + hard-12 only — but the base leaderboard was.
 *
 * Deliberately NOT asserted: "no gold amount appears in the prompt". Measured, that
 * fires on 30 scenarios across every suite, because common amounts (50000, 2000000,
 * 30000) legitimately appear in rule examples and coincide with unrelated scenarios.
 * It would demand a prompt with no example numbers at all. Rule illustrations may
 * share a NUMBER with a scenario; they may not share its WORDING or hand back its
 * specific answer.
 */

function wordNgrams(s: string, n: number): Set<string> {
  const w = normalizeChatText(s).split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}

const MIN_NGRAM = 3;

describe("SYSTEM_PROMPT does not leak the scored suites", () => {
  test(`no scored text shares a ${MIN_NGRAM}+ word span with the prompt`, () => {
    const promptGrams = wordNgrams(SYSTEM_PROMPT, MIN_NGRAM);
    const leaks: string[] = [];

    for (const t of ALL_SCORED_TEXTS) {
      for (const g of wordNgrams(t.text, MIN_NGRAM)) {
        if (promptGrams.has(g)) leaks.push(`${t.suite}/${t.id}: "${g}"`);
      }
    }

    expect(leaks).toEqual([]);
  });

  test("the prompt does not name a scenario's distinctive fuzzy-amount token", () => {
    // "800an" + its answer 800000 were both printed, handing over belanja-bulanan-800an
    // complete. The rule survives as "<angka>an"; the specific token must not appear.
    expect(SYSTEM_PROMPT).not.toContain("800an");
  });

  test("the prompt does not print a scenario's correction pair", () => {
    // ojek-15rb-atau-50rb-typo is "gojek ke masjid 15rb... eh maksudnya 50rb".
    expect(SYSTEM_PROMPT).not.toMatch(/15rb[^\n]*50rb/);
  });
});

describe("SYSTEM_PROMPT still teaches the rules it must teach", () => {
  test.each([
    ["money direction", /PEMASUKAN|PENGELUARAN/],
    ["rupiah notation", /12rb|50rb|jt/],
    ["date rules", /tanggal_hint|hari_ini|tidak_jelas/],
    ["non-transaction rule", /bukan_transaksi/],
    ["correction rule", /[Kk]oreksi/],
    ["fuzzy-amount rule", /ambigu/],
    ["no price copy rule", /JANGAN copy-paste|jangan salin/],
  ])("still covers %s", (_label, re) => {
    expect(SYSTEM_PROMPT).toMatch(re);
  });
});
