import { describe, expect, test } from "bun:test";
import { ALL_SCORED_TEXTS } from "./eval-corpus.ts";
import { NGRAM_THRESHOLD, findLeaks, maxSimilarity } from "./parse-leakguard.ts";

/**
 * Two failure modes, both silent, both pinned here.
 *
 * FALSE NEGATIVE: a bench item reaches training data and our own Parse-25 number becomes a lie.
 * FALSE POSITIVE: ordinary messages are rejected, the `ordinary` tier (40% of the corpus)
 * starves, and the manifest still reports a healthy accept rate for the cells that survived.
 * The second is the one that actually bit: a flat "shares >=2 amounts" rule blocked 7 of 15
 * ordinary two-amount messages whose lexical similarity to the bench was ~0.13.
 */

/** One-word paraphrases of real bench items. The old gate (jaccard>=0.85) accepted 8 of these. */
const LEAKY_PARAPHRASES = [
  "bayar wifi 350.000 sama token listrik 102.500 tadi malam",
  "kemarin bli beras 5kg 68rb sm minyak goreng 2 ltr 38rb di pasar",
  "barang tokopedia rusak, refund 85rb sudah masuk saldo tadi",
  "tadi jajan es teh ceban dan gorengan goceng",
  "tadi belanja di alfamart 63.700 terus parkir 2rb beli air mineral 6rb",
  "ngopi tadi 27.5k terus parkir 2k aja",
  "beli sepatu 250rb tapi ada diskon 50rb jadi cuma bayar 200rb",
  "rekap hari ini: sarapan 20rb, bensin 40rb, parkir 5rb, makan siang 30rb, kopi sore 18rb",
];

/**
 * Ordinary Indonesian finance chat sharing NO wording with any scored item. Most carry two
 * round amounts, because that is what real messages look like — and round amounts collide
 * with the bench by coincidence, not by leakage.
 */
const ORDINARY = [
  "laundry 25rb setrika 15rb",
  "tiket bioskop 50rb popcorn 35rb",
  "beli galon 20rb, gas melon 25rb",
  "potong rambut 35rb sama semir 15rb",
  "iuran rt 50rb sampah 20rb",
  "vitamin 45rb masker 15rb",
  "beli pulsa 25rb sama paket data 50rb",
  "servis ac 150rb freon 100rb",
  "buku tulis 15rb pulpen 5rb",
  "nasi goreng 20rb es jeruk 8rb",
  "ongkir 10rb barang 45rb",
  "kopi 18rb roti 12rb",
  "bayar parkir 5rb sama bensin 30rb",
  "sabun 15rb odol 12rb",
  "tiket kereta 100rb ojek 25rb",
  "beli kopi 20rb di kantin",
  "gaji masuk 7jt alhamdulillah",
  "bayar kos bulan ini 1,2jt transfer bca",
  "top up dana 50rb",
  "dapet thr 3jt kemarin",
  "servis motor 185rb di bengkel",
  "bayar bpjs 150rb sama pdam 87rb",
];

describe("findLeaks — sensitivity", () => {
  test("every scored text leaks against itself", () => {
    const missed = ALL_SCORED_TEXTS.filter((t) => findLeaks(t.text).length === 0).map((t) => t.id);
    expect(missed).toEqual([]);
  });

  test.each(LEAKY_PARAPHRASES)("catches a one-word paraphrase: %s", (text) => {
    expect(findLeaks(text).length).toBeGreaterThan(0);
  });
});

describe("findLeaks — specificity", () => {
  // This is the regression test for the false-reject bug. Without it, tightening the guard
  // silently starves the corpus's largest tier and nothing fails.
  test.each(ORDINARY)("passes ordinary chat: %s", (text) => {
    const hits = findLeaks(text);
    expect(hits.map((h) => `${h.reason}:${h.scoredId}`)).toEqual([]);
  });

  test("ordinary messages carry no lexical echo of the bench", () => {
    // maxSimilarity reports max(token-jaccard, char-ngram-containment); the two have
    // different thresholds (0.5 / 0.7), so this only sanity-bounds the looser one.
    for (const t of ORDINARY) expect(maxSimilarity(t)).toBeLessThan(NGRAM_THRESHOLD);
  });
});

describe("findLeaks — amount overlap counts only distinctive amounts", () => {
  test("sharing common round amounts is not a leak", () => {
    // 25.000 + 15.000 recur across many scored items; co-occurrence teaches nothing.
    expect(findLeaks("laundry 25rb setrika 15rb")).toEqual([]);
  });

  test("two fingerprint amounts leak even when every word differs", () => {
    // 350.000 + 102.500 occur together only in hard-sep-wifi-token. Reusing the pair
    // hands over that item's gold regardless of wording — the case a purely lexical
    // gate cannot see.
    const hits = findLeaks("langganan internet 350.000 plus setrum 102.500 semalem");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.reason === "amounts" || h.reason === "jaccard")).toBe(true);
  });
});
