/**
 * Train/test leak guard for generated SFT rows.
 *
 * Dependency direction matters: this module imports both the taxonomy's output and the
 * bench corpus, so that `parse-taxonomy.ts` needs NO bench import at all. The old
 * generator imported HARD_SCENARIOS directly to build its seeds, which is exactly how
 * the bench's adversarial distribution — and its wording — got into training data.
 *
 * The previous gate (exact/substring OR token-Jaccard ≥ 0.85) accepted 8 of 9 one-word
 * paraphrases of bench items: at ~10 tokens per text, 0.85 needs ~9/10 tokens to match,
 * so the substring check did all the work and Jaccard essentially never fired. Three
 * independent signals replace it, and amount overlap is the important one — numbers leak
 * the answer even when every word is different.
 */

import { ALL_SCORED_TEXTS, type ScoredText } from "./eval-corpus.ts";
import { tokenizeAmounts } from "./rupiah.ts";

const JACCARD_THRESHOLD = 0.5;
export const NGRAM_THRESHOLD = 0.7;
const NGRAM_N = 4;

/**
 * Amount overlap only counts DISTINCTIVE amounts.
 *
 * Indonesian casual spending draws from a tiny pool of round numbers, so "shares two amounts
 * with a bench item" is the norm, not evidence. Measured: a flat shared>=2 rule blocked 7 of
 * 15 ordinary two-amount messages whose lexical similarity to the bench was ~0.13 — nowhere
 * near the 0.5 threshold — silently starving the `ordinary` tier, 40% of the corpus.
 *
 * Distinctiveness is about the number's FORM, not just how often it occurs. Document-frequency
 * alone is a trap at this corpus size: 55.000, 150.000, 185.000 and 3jt all have df=1 purely
 * because only one scored item happens to use them, yet they are exactly what ordinary chat
 * produces. What actually fingerprints a scenario is a non-round amount — real messages say
 * "20rb", the bench says "102.500". So an amount identifies a scored item only when it is
 * large enough to be money, NOT a whole thousand, and used by at most a couple of items.
 */
const AMOUNT_RARE_MAX_DF = 2;
/** Below this, a stray integer is a quantity or a year, not a fingerprint. */
const AMOUNT_DISTINCTIVE_MIN = 10_000;
/** Ordinary chat rounds to the thousand; 102.500 and 63.700 do not. */
const AMOUNT_ROUND_MODULUS = 1_000;
const AMOUNT_OVERLAP_THRESHOLD = 1;

/** Tokens that carry no content and inflate similarity between unrelated messages. */
const STOPWORDS = new Set([
  "yang", "sama", "sm", "dan", "di", "ke", "dari", "buat", "untuk", "sih", "deh", "dong",
  "aja", "aje", "udah", "udh", "sudah", "td", "tadi", "gw", "gue", "aku", "saya", "nya",
  "ini", "itu", "ada", "juga", "lagi", "tapi", "terus", "trus", "abis", "doang", "kok",
]);

export function normalizeChatText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function contentTokens(s: string): Set<string> {
  return new Set(
    normalizeChatText(s)
      .split(" ")
      .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function charNgrams(s: string, n = NGRAM_N): Set<string> {
  const norm = normalizeChatText(s).replace(/\s/g, "");
  const out = new Set<string>();
  for (let i = 0; i + n <= norm.length; i++) out.add(norm.slice(i, i + n));
  return out;
}

/** Containment, not Jaccard: a short paraphrase inside a long bench text must still trip. */
function ngramOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  return inter / Math.min(a.size, b.size);
}

type CorpusEntry = ScoredText & {
  norm: string;
  tokens: Set<string>;
  ngrams: Set<string>;
  amountSet: Set<number>;
};

const CORPUS: CorpusEntry[] = ALL_SCORED_TEXTS.map((t) => ({
  ...t,
  norm: normalizeChatText(t.text),
  tokens: contentTokens(t.text),
  ngrams: charNgrams(t.text),
  // Union of asserted gold and amounts written in the text — agentic turns assert neither.
  amountSet: new Set([...t.amounts, ...tokenizeAmounts(t.text).map((a) => a.value)]),
}));

/** How many scored items use each amount. High document-frequency == a round number == no signal. */
const AMOUNT_DF: ReadonlyMap<number, number> = (() => {
  const df = new Map<number, number>();
  for (const c of CORPUS) for (const v of c.amountSet) df.set(v, (df.get(v) ?? 0) + 1);
  return df;
})();

function isDistinctiveAmount(v: number): boolean {
  if (v < AMOUNT_DISTINCTIVE_MIN) return false;
  if (v % AMOUNT_ROUND_MODULUS === 0) return false;
  return (AMOUNT_DF.get(v) ?? 0) <= AMOUNT_RARE_MAX_DF;
}

export type LeakHit = {
  reason: "exact" | "substring" | "jaccard" | "ngram" | "amounts";
  scoredId: string;
  suite: ScoredText["suite"];
  score: number;
  detail: string;
};

/** Every reason this text overlaps the scored corpus. Empty means clean. */
export function findLeaks(text: string): LeakHit[] {
  const norm = normalizeChatText(text);
  const tokens = contentTokens(text);
  const ngrams = charNgrams(text);
  const amounts = new Set(tokenizeAmounts(text).map((a) => a.value));
  const hits: LeakHit[] = [];

  for (const c of CORPUS) {
    if (norm === c.norm) {
      hits.push({ reason: "exact", scoredId: c.id, suite: c.suite, score: 1, detail: c.text });
      continue;
    }
    if (norm.length > 0 && (norm.includes(c.norm) || c.norm.includes(norm))) {
      hits.push({ reason: "substring", scoredId: c.id, suite: c.suite, score: 1, detail: c.text });
      continue;
    }
    const j = jaccard(tokens, c.tokens);
    if (j >= JACCARD_THRESHOLD) {
      hits.push({ reason: "jaccard", scoredId: c.id, suite: c.suite, score: j, detail: c.text });
      continue;
    }
    const g = ngramOverlap(ngrams, c.ngrams);
    if (g >= NGRAM_THRESHOLD) {
      hits.push({ reason: "ngram", scoredId: c.id, suite: c.suite, score: g, detail: c.text });
      continue;
    }
    // Only distinctive amounts count: sharing 25.000 with a bench item teaches a student
    // nothing about it, but sharing 63.700 and 102.500 identifies the scenario.
    const sharedRare: number[] = [];
    for (const v of amounts) if (c.amountSet.has(v) && isDistinctiveAmount(v)) sharedRare.push(v);
    if (sharedRare.length >= AMOUNT_OVERLAP_THRESHOLD) {
      hits.push({
        reason: "amounts",
        scoredId: c.id,
        suite: c.suite,
        score: sharedRare.length,
        detail: `shares distinctive amounts ${sharedRare.join(", ")} with "${c.text}"`,
      });
    }
  }
  return hits;
}

export class LeakError extends Error {
  constructor(readonly hits: LeakHit[]) {
    const h = hits[0]!;
    super(`train/test leak: ${h.reason} vs ${h.suite}/${h.scoredId} (score=${h.score})`);
    this.name = "LeakError";
  }
}

export function assertNoLeak(text: string): void {
  const hits = findLeaks(text);
  if (hits.length > 0) throw new LeakError(hits);
}

/** Worst similarity against the corpus — reported per run so the no-leak claim is auditable. */
export function maxSimilarity(text: string): number {
  const tokens = contentTokens(text);
  const ngrams = charNgrams(text);
  let worst = 0;
  for (const c of CORPUS) {
    worst = Math.max(worst, jaccard(tokens, c.tokens), ngramOverlap(ngrams, c.ngrams));
  }
  return worst;
}
