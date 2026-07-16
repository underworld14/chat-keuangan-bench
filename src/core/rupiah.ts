/**
 * Rupiah amount tokenizer for SFT data validation.
 *
 * Deliberately separate from `parseRupiahAmount` in eval-core.ts. That one sits on the
 * *grading* path (normalizeFinancePayload → parseFinanceJson → scoreExtraction) where
 * leniency is a feature: it must not crash on a sloppy model. Here leniency is a
 * catastrophe — a wrong amount becomes a gold training label. Two irreconcilable
 * semantics, so two modules. Do not merge them, and do not "fix" the other one: it
 * would silently re-grade every published result.
 *
 * This module is pure and dependency-free so it can be unit tested without a server.
 */

/** Attested Hokkien-derived money slang. Morphemes: cap=10, pek=100, ceng=1_000, ban=10_000, tiao=1_000_000. */
export const SLANG_TABLE: Readonly<Record<string, number>> = {
  cepek: 100,
  gopek: 500,
  seceng: 1_000,
  ceceng: 1_000,
  noceng: 2_000,
  goceng: 5_000,
  ceban: 10_000,
  goban: 50_000,
  cetiao: 1_000_000,
  gotiao: 5_000_000,
  // Etymology says go(5)×cap(10)=50, but modern usage means 50_000. Ships as 50_000;
  // taxonomy cells that use it should expect ambigu=true rather than a flat label.
  gocap: 50_000,
};

/**
 * Javanese numerals, which unlike jaksel/betawi slang actually CHANGE the amount —
 * so a parser that ignores them mis-books the ledger rather than merely sounding off.
 * `ewu` = ribu, and `<numeral> ewu` = numeral × 1000 ("seket ewu" = 50 × 1000).
 * `sewu` is the fused se+ewu = 1000.
 */
const JAWA_NUMERALS: ReadonlyArray<readonly [string, number]> = [
  ["selawe", 25],
  ["seket", 50],
  ["rong", 2],
  ["telung", 3],
  ["patang", 4],
  ["limang", 5],
  ["nem", 6],
  ["pitung", 7],
  ["wolung", 8],
  ["sangang", 9],
  ["sepuluh", 10],
];

/** Spelled-out amounts. Longest surface first — matching is order-sensitive. */
const SPELLED: ReadonlyArray<readonly [string, number]> = [
  ["setengah juta", 500_000],
  ["seperempat juta", 250_000],
  ["setengah jt", 500_000],
  ["sejuta", 1_000_000],
  ["semiliar", 1_000_000_000],
];

/** Multiplier suffixes. Longest first so "ribu" wins over "rb"-style prefixes. */
const SUFFIXES: ReadonlyArray<readonly [string, number]> = [
  ["miliar", 1_000_000_000],
  ["milyar", 1_000_000_000],
  ["juta", 1_000_000],
  ["jute", 1_000_000],
  ["ribu", 1_000],
  ["rebu", 1_000],
  ["jt", 1_000_000],
  ["rb", 1_000],
  ["k", 1_000],
];

/**
 * Units that make a preceding number a QUANTITY, not money ("beras 5kg", "2 lusin",
 * "spp 3 anak @250rb"). Without this the reverse gate false-fires on every qty word.
 */
const QUANTITY_UNITS = [
  "kg", "gr", "gram", "ltr", "liter", "l", "ml", "lusin", "rim", "tusuk", "pcs", "pc",
  "buah", "biji", "bungkus", "porsi", "piring", "gelas", "botol", "kaleng", "sachet",
  "orang", "anak", "ekor", "lembar", "pack", "pak", "box", "dus", "kardus", "meter", "m",
];

/**
 * A bare integer below this is not a plausible Rupiah amount — it is a stray quantity
 * ("4 4 nya", "2 lusin"). The smallest attested money slang is cepek=100, so 100 is the floor.
 * Numbers carrying an explicit suffix/separator are exempt; this gate is for BARE digits only.
 */
const BARE_MONEY_FLOOR = 100;

export type AmountKind =
  | "suffix"
  | "dot"
  | "bare"
  | "slang"
  | "spelled"
  | "rp"
  /** "12.500 rb" — dot-thousands AND a multiplier. Genuinely ambiguous; never guess. */
  | "suspect-dot-suffix";

export type AmountAtom = {
  /** The literal surface as it appears in the text. */
  raw: string;
  value: number;
  /** Character offset of `raw` in the source text — used by the excuse-cue window. */
  index: number;
  kind: AmountKind;
};

export type ExcuseTag = "koreksi" | "future" | "batal" | "share" | "diskon";

/**
 * Cues that legitimise an amount appearing in the text but NOT in the label.
 * Without these the reverse gate false-fires on 7/25 hand-authored gold scenarios.
 */
export const EXCUSE_CUES: ReadonlyArray<{ tag: ExcuseTag; re: RegExp }> = [
  { tag: "koreksi", re: /\b(eh|bukan|maksudnya|maksud|salah|ralat|koreksi|revisi|typo)\b/i },
  { tag: "future", re: /\b(besok|nanti|rencana|rencananya|mau|akan|minggu depan|bulan depan|lusa|sisanya|lunasin)\b/i },
  { tag: "batal", re: /\b(batal|cancel|gak jadi|ga jadi|nggak jadi|engga jadi|jadinya gak|refund gagal)\b/i },
  { tag: "share", re: /\b(total|patungan|bagian|share|bareng|split|urunan|masing-masing)\b/i },
  { tag: "diskon", re: /\b(diskon|disc|potongan|jadi cuma|net|setelah potong|harga asli)\b/i },
];

/** How far either side of an unconsumed atom we look for an excuse cue. */
const EXCUSE_WINDOW = 45;

function parseNumeric(numStr: string): { value: number; suspectDot: boolean } {
  const hasComma = numStr.includes(",");
  const hasDot = numStr.includes(".");

  // "2,5" → comma is the decimal separator in Indonesian.
  if (hasComma && !hasDot) {
    return { value: Number(numStr.replace(",", ".")), suspectDot: false };
  }
  if (hasDot && !hasComma) {
    const parts = numStr.split(".");
    const last = parts[parts.length - 1] ?? "";
    // "12.500" + a multiplier is unresolvable: 12.5×1000 or 12500×1000? Flag, never guess.
    if (parts.length >= 2 && last.length === 3) {
      return { value: Number(parts.join("")), suspectDot: true };
    }
    // "27.5" → decimal.
    return { value: Number(numStr), suspectDot: false };
  }
  if (hasComma && hasDot) {
    // "1.500,50" → dots group, comma decimals.
    return { value: Number(numStr.replace(/\./g, "").replace(",", ".")), suspectDot: false };
  }
  return { value: Number(numStr), suspectDot: false };
}

function isQuantity(text: string, endIndex: number): boolean {
  const after = text.slice(endIndex, endIndex + 12).toLowerCase();
  const m = after.match(/^\s*([a-z]+)/);
  if (!m?.[1]) return false;
  return QUANTITY_UNITS.includes(m[1]);
}

/** Extract every money-bearing atom, left to right, without overlaps. */
export function tokenizeAmounts(text: string): AmountAtom[] {
  const atoms: AmountAtom[] = [];
  const taken: boolean[] = new Array(text.length).fill(false);

  const claim = (start: number, end: number): boolean => {
    for (let i = start; i < end; i++) if (taken[i]) return false;
    for (let i = start; i < end; i++) taken[i] = true;
    return true;
  };

  const lower = text.toLowerCase();

  // 0. Javanese "<numeral> ewu" and the fused "sewu" — before everything, since a bare
  //    "ewu" would otherwise be invisible and the numeral would look like plain prose.
  for (const [word, n] of JAWA_NUMERALS) {
    const re = new RegExp(`\\b${word}\\s+ewu\\b`, "gi");
    for (const m of lower.matchAll(re)) {
      const idx = m.index;
      if (claim(idx, idx + m[0].length)) {
        atoms.push({
          raw: text.slice(idx, idx + m[0].length),
          value: n * 1_000,
          index: idx,
          kind: "spelled",
        });
      }
    }
  }
  for (const m of lower.matchAll(/\bsewu\b/g)) {
    const idx = m.index;
    if (claim(idx, idx + 4)) {
      atoms.push({ raw: text.slice(idx, idx + 4), value: 1_000, index: idx, kind: "spelled" });
    }
  }

  // 1. Spelled ("setengah juta") — before suffixes, which would otherwise eat "juta".
  //    Word-boundary matched like every other family: a bare indexOf turns "sejutaan"
  //    ("roughly a million" — `-an` is Indonesian's fuzzy marker) into an exact 1_000_000
  //    with ambigu=false, which every downstream gate then accepts. Silently wrong gold is
  //    worse than a rejected row, so an approximate surface must yield no atom and reject.
  for (const [surface, value] of SPELLED) {
    const re = new RegExp(`\\b${surface.replace(/\s+/g, "\\s+")}\\b`, "gi");
    for (const m of lower.matchAll(re)) {
      const idx = m.index;
      if (claim(idx, idx + m[0].length)) {
        atoms.push({ raw: text.slice(idx, idx + m[0].length), value, index: idx, kind: "spelled" });
      }
    }
  }

  // 2. Slang — word-boundary matched so "ceban" never fires inside a longer word.
  for (const [surface, value] of Object.entries(SLANG_TABLE)) {
    const re = new RegExp(`\\b${surface}\\b`, "gi");
    for (const m of lower.matchAll(re)) {
      const idx = m.index;
      if (claim(idx, idx + surface.length)) {
        atoms.push({ raw: text.slice(idx, idx + surface.length), value, index: idx, kind: "slang" });
      }
    }
  }

  // 3. Number + multiplier suffix ("25rb", "2,5jt", "27.5k", "1 juta").
  const suffixAlt = SUFFIXES.map(([s]) => s).join("|");
  const suffixRe = new RegExp(`(\\d[\\d.,]*)\\s*(${suffixAlt})\\b`, "gi");
  for (const m of text.matchAll(suffixRe)) {
    const idx = m.index;
    const whole = m[0];
    const numStr = m[1] ?? "";
    const suffix = (m[2] ?? "").toLowerCase();
    const mult = SUFFIXES.find(([s]) => s === suffix)?.[1] ?? 1;
    if (!claim(idx, idx + whole.length)) continue;
    const { value, suspectDot } = parseNumeric(numStr);
    atoms.push({
      raw: whole,
      value: Math.round(value * mult),
      index: idx,
      kind: suspectDot ? "suspect-dot-suffix" : "suffix",
    });
  }

  // 4. Rp-prefixed ("Rp 15.000").
  for (const m of text.matchAll(/\bRp\.?\s*([\d.,]+)/gi)) {
    const idx = m.index;
    if (!claim(idx, idx + m[0].length)) continue;
    const { value } = parseNumeric(m[1] ?? "");
    atoms.push({ raw: m[0], value: Math.round(value), index: idx, kind: "rp" });
  }

  // 5. Dot/comma-grouped thousands ("350.000", "63.700").
  for (const m of text.matchAll(/\b\d{1,3}(?:\.\d{3})+\b/g)) {
    const idx = m.index;
    if (!claim(idx, idx + m[0].length)) continue;
    atoms.push({
      raw: m[0],
      value: Number(m[0].replace(/\./g, "")),
      index: idx,
      kind: "dot",
    });
  }

  // 6. Bare integers — only above the money floor and not acting as a quantity.
  for (const m of text.matchAll(/\b\d+\b/g)) {
    const idx = m.index;
    const end = idx + m[0].length;
    if (!claim(idx, end)) continue;
    const value = Number(m[0]);
    if (value < BARE_MONEY_FLOOR) continue;
    if (isQuantity(text, end)) continue;
    atoms.push({ raw: m[0], value, index: idx, kind: "bare" });
  }

  return atoms.sort((a, b) => a.index - b.index);
}

/**
 * Amounts reachable by arithmetic over the atoms: qty×unit, pair sums, pair differences.
 * A wide net, so a `derived`-only trace is a smell rather than a clean pass.
 */
export function deriveCandidates(atoms: AmountAtom[]): Map<number, string> {
  const out = new Map<number, string>();
  const vals = atoms.map((a) => a.value);

  for (let i = 0; i < vals.length; i++) {
    const a = vals[i]!;
    // qty×unit: small integer multipliers cover "4 tusuk @5rb", "3 anak @250rb".
    for (let q = 2; q <= 12; q++) {
      if (!out.has(a * q)) out.set(a * q, `${a}×${q}`);
    }
    for (let j = i + 1; j < vals.length; j++) {
      const b = vals[j]!;
      if (!out.has(a + b)) out.set(a + b, `${a}+${b}`);
      const d = Math.abs(a - b);
      if (d > 0 && !out.has(d)) out.set(d, `|${a}-${b}|`);
    }
  }
  return out;
}

export type TraceTier = "direct" | "derived" | "none";

/** Can this label amount be justified by the text? `direct` is the only clean answer. */
export function traceAmount(
  value: number,
  atoms: AmountAtom[],
): { tier: TraceTier; via?: string } {
  for (const a of atoms) {
    if (a.value === value) return { tier: "direct", via: a.raw };
  }
  const derived = deriveCandidates(atoms);
  const via = derived.get(value);
  if (via) return { tier: "derived", via };
  return { tier: "none" };
}

/**
 * Money mentioned in the text but absent from the label, with no cue explaining why.
 * Catches DROPPED entries — the failure forward tracing is blind to, and the worse poison.
 */
export function unexcusedAtoms(
  text: string,
  atoms: AmountAtom[],
  consumed: Set<number>,
): Array<{ atom: AmountAtom; excuses: ExcuseTag[] }> {
  const out: Array<{ atom: AmountAtom; excuses: ExcuseTag[] }> = [];
  for (const atom of atoms) {
    if (consumed.has(atom.value)) continue;
    const from = Math.max(0, atom.index - EXCUSE_WINDOW);
    const to = Math.min(text.length, atom.index + atom.raw.length + EXCUSE_WINDOW);
    const window = text.slice(from, to);
    const excuses = EXCUSE_CUES.filter((c) => c.re.test(window)).map((c) => c.tag);
    if (excuses.length === 0) out.push({ atom, excuses });
  }
  return out;
}

/** Atoms whose dot/suffix combination is unresolvable — reject the row rather than guess. */
export function hasAmbiguousAmount(atoms: AmountAtom[]): boolean {
  return atoms.some((a) => a.kind === "suspect-dot-suffix");
}
