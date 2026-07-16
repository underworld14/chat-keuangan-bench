/**
 * Hand-authored taxonomy for synthetic SFT generation (Indonesian finance chat → JSON).
 *
 * Dependency direction is the whole point: this module imports NO bench scenario file.
 * The old generator seeded from HARD_SCENARIOS, which pulled the bench's adversarial
 * distribution AND its wording into training data. HARD_SCENARIOS is a TEST set — its
 * marginals are deliberately pathological:
 *
 *   P(pengeluaran | entry)              = 0.911   (4 pemasukan vs 41 pengeluaran)
 *   P(hari_ini | tanggal_hint asserted) = 0.914   (32/35); tidak_jelas NEVER asserted
 *   mixed-direction messages            = 0.04    (1/25)
 *   expectNonTransaction                = 0.12    (3/25)
 *
 * Train on that and a 1.7B student learns two free shortcuts ("always pengeluaran",
 * "always hari_ini") and never sees the ordinary messages that are 95% of production
 * traffic. This taxonomy is authored for the REAL WORLD; the bench stays a held-out
 * yardstick. `benchAnalogue` notes on cells are free text I wrote by hand — they name a
 * failure mode from memory, they are not imported and carry no bench wording.
 *
 * Axis split:
 *   ASSERTED axes carry the label and are programmatically verifiable (amount, direction,
 *   cardinality, date hint, non-transaction).
 *   CARRIER axes are perturbation only — register, noise, rail, vendor identity. They must
 *   NOT change the parse, and are verified indirectly: if an asserted invariant survives a
 *   carrier permutation, the carrier was correctly ignored.
 */

import type { ParsedFinance } from "./eval-core.ts";
import { SLANG_TABLE } from "./rupiah.ts";

export type DateHint = NonNullable<ParsedFinance["entries"][number]["tanggal_hint"]>;

// ─────────────────────────────────────────────────────────────────────────────
// Axes
// ─────────────────────────────────────────────────────────────────────────────

export type Tier =
  | "ordinary"
  | "notation"
  | "register_noise"
  | "direction"
  | "non_tx"
  | "adversarial";

export type Aspect =
  // ordinary (12) — the boring 95%. A product parser must nail these first.
  | "ord_single_out"
  | "ord_single_in"
  | "ord_multi_out"
  | "ord_rekap_list"
  | "ord_vendor_named"
  | "ord_rail_named"
  | "ord_recurring_bill"
  | "ord_topup_ewallet"
  | "ord_date_relative"
  | "ord_no_date"
  | "ord_qty_simple"
  | "ord_wa_wrapper"
  // notation (5) — how the number is written.
  | "not_dot_separator"
  | "not_k_suffix_decimal"
  | "not_spelled_amount"
  | "not_slang_hokkien"
  | "not_regional_numeral"
  // register_noise (3) — surface perturbation that must not move the label.
  | "reg_regional_lexicon"
  | "noi_typo_heavy"
  | "noi_voice_rambling"
  // direction (6) — money-flow direction is lexically determined and learnable.
  | "dir_income_gaji"
  | "dir_income_refund_cashback"
  | "dir_income_transfer_masuk"
  | "dir_mixed_message"
  | "dir_lexical_trap"
  | "dir_topup_not_income"
  // non_tx (4) — a number is present and must NOT be booked.
  | "ntx_curhat"
  | "ntx_future_intent"
  | "ntx_cancelled"
  | "ntx_query"
  // adversarial (10) — the 10% tail.
  | "adv_correction_amount"
  | "adv_correction_magnitude"
  | "adv_price_copy_bait"
  | "adv_qty_x_unit"
  | "adv_split_share"
  | "adv_discount_net"
  | "adv_fee_plus_principal"
  | "adv_fuzzy_amount"
  | "adv_past_plus_future"
  | "adv_phantom_income_bait";

export type Direction = "out" | "in" | "mixed" | "non_tx";
export type Cardinality = "zero" | "single" | "dua" | "tiga" | "banyak";
export type Magnitude = "receh" | "kecil" | "sedang" | "besar" | "jumbo";
export type Notation =
  | "polos"
  | "dot_sep"
  | "k_suffix"
  | "rb_suffix"
  | "jt_suffix"
  | "spelled"
  | "slang"
  | "regional_numeral"
  | "rp_prefix";
export type Noise = "bersih" | "wa_ringkas" | "voice_rambling" | "typo_berat" | "emoji_format";
export type Register =
  | "jaksel_gaul"
  | "pesantren"
  | "baku"
  | "jawa"
  | "betawi"
  | "sunda"
  | "medan"
  | "minang"
  | "makassar_timur";
/** Real chat is code-mixed — lexical insertions into Indonesian, not full dialect. */
export type RegisterIntensity = "sisip" | "campur" | "penuh";
export type Rail =
  | "none"
  | "transfer_bank"
  | "ewallet"
  | "tunai"
  | "qris"
  | "cod"
  | "kartu"
  | "emoney"
  | "pulsa";
export type Correction = "none" | "amount" | "magnitude" | "item" | "cancel" | "direction";
export type Split = "train" | "eval_iid" | "eval_compositional";

/**
 * Magnitude bands, rupiah, [min, max).
 *
 * receh starts at 100, not 500: the smallest attested money slang is cepek=100, and a 500
 * floor would leave it in no band at all — unusable, even though the token holdout design
 * requires cepek in train. rupiah.ts sets its BARE_MONEY_FLOOR to 100 for exactly this
 * reason, so 100 is also the point below which a number stops being plausible money.
 */
export const MAGNITUDE_BANDS: Readonly<Record<Magnitude, readonly [number, number]>> = {
  receh: [100, 5_000],
  kecil: [5_000, 50_000],
  sedang: [50_000, 500_000],
  besar: [500_000, 5_000_000],
  jumbo: [5_000_000, 100_000_000],
};

function bandOf(m: Magnitude): readonly [number, number] {
  return MAGNITUDE_BANDS[m];
}

function inBand(value: number, m: Magnitude): boolean {
  const [lo, hi] = bandOf(m);
  return value >= lo && value < hi;
}

function bandsOverlap(a: readonly [number, number], b: readonly [number, number]): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

// ─────────────────────────────────────────────────────────────────────────────
// Self-checking cell primitives
// ─────────────────────────────────────────────────────────────────────────────

export type Attestation = "kbbi" | "press" | "derived_unverified";

export interface TokenValue {
  /** MUST appear literally in the generated text — that is what makes `rupiah` assertable. */
  surface: string;
  rupiah: number;
  attested: Attestation;
  contested?: { alt: number; note: string };
}

export type Invariant =
  | { kind: "amount_present"; rupiah: number }
  /** The powerful one: catches gross-price copy and pre-correction values. */
  | { kind: "amount_absent"; rupiah: number; why: string }
  | { kind: "entry_count"; n: number }
  | { kind: "direction_count"; masuk: number; keluar: number }
  | { kind: "non_transaction" }
  | { kind: "date_hint"; hint: DateHint; appliesTo: "all" | number }
  | { kind: "qty_merge_ok"; keyword: string; unit: number; count: number }
  | { kind: "sum_out"; total: number }
  | { kind: "ambigu_flagged"; atLeast: number }
  | { kind: "desc_contains"; anyOf: string[]; entryIdx: number }
  | { kind: "no_price_copy"; distinctAmounts: number[] };

export interface Vendor {
  id: string;
  surfaces: string[];
  kategori: string;
  /** Plausibility guard — makes "warung 2jt" a cell-construction bug, not a data point. */
  typicalRange: [number, number];
  registers: Register[];
  urbanity: "urban" | "suburban" | "rural" | "any";
  defaultRails: Rail[];
}

export interface Cell {
  id: string;
  aspect: Aspect;
  tier: Tier;
  direction: Direction;
  cardinality: Cardinality;
  notation: Notation[];
  magnitude: Magnitude;
  dateHint: DateHint;
  /** The literal trigger in the text ("td", "maren"), or null when no date is stated. */
  dateSurface: string | null;
  correction: Correction;
  nilai: TokenValue[];
  invariants: Invariant[];
  register: Register;
  registerIntensity: RegisterIntensity;
  noise: Noise;
  rail: Rail;
  vendors: string[];
  split: Split;
  rows: number;
  /** Free-text note naming a known failure mode. Written by hand, never imported. */
  benchAnalogue: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vendor pool
//
// `typicalRange` is a construction guard, not a label: a cell pairing `warung` with a
// jumbo amount is a bug in the cell, so assertCellCoherent rejects it. Ranges are
// everyday plausibility, deliberately wide.
// ─────────────────────────────────────────────────────────────────────────────

const ANY_REG: Register[] = [
  "jaksel_gaul", "pesantren", "baku", "jawa", "betawi", "sunda", "medan", "minang", "makassar_timur",
];

export const VENDORS: readonly Vendor[] = [
  // ── ritel / urban ──
  { id: "indomaret", surfaces: ["indomaret", "indom", "indomart"], kategori: "belanja_harian", typicalRange: [5_000, 300_000], registers: ANY_REG, urbanity: "urban", defaultRails: ["tunai", "qris", "kartu"] },
  { id: "alfamart", surfaces: ["alfamart", "alfa"], kategori: "belanja_harian", typicalRange: [5_000, 300_000], registers: ANY_REG, urbanity: "urban", defaultRails: ["tunai", "qris"] },
  { id: "warung_madura", surfaces: ["warung madura", "warmad", "warung pak madura"], kategori: "belanja_harian", typicalRange: [2_000, 100_000], registers: ANY_REG, urbanity: "any", defaultRails: ["tunai", "qris"] },
  { id: "tokopedia", surfaces: ["tokopedia", "tokped"], kategori: "belanja_online", typicalRange: [15_000, 5_000_000], registers: ["jaksel_gaul", "baku", "betawi", "jawa", "sunda", "medan"], urbanity: "any", defaultRails: ["transfer_bank", "ewallet", "cod"] },
  { id: "shopee", surfaces: ["shopee", "spi"], kategori: "belanja_online", typicalRange: [10_000, 3_000_000], registers: ANY_REG, urbanity: "any", defaultRails: ["ewallet", "cod", "transfer_bank"] },
  { id: "mixue", surfaces: ["mixue"], kategori: "jajan", typicalRange: [8_000, 60_000], registers: ["jaksel_gaul", "baku", "betawi", "jawa", "sunda", "medan"], urbanity: "urban", defaultRails: ["tunai", "qris"] },
  { id: "kopi_kenangan", surfaces: ["kopi kenangan", "kenangan"], kategori: "jajan", typicalRange: [15_000, 90_000], registers: ["jaksel_gaul", "baku", "betawi"], urbanity: "urban", defaultRails: ["qris", "ewallet"] },
  { id: "minimarket_lokal", surfaces: ["minimarket", "toko sebelah"], kategori: "belanja_harian", typicalRange: [3_000, 150_000], registers: ANY_REG, urbanity: "any", defaultRails: ["tunai", "qris"] },

  // ── transport / fuel ──
  { id: "grab", surfaces: ["grab", "grabbike", "grabcar"], kategori: "transport", typicalRange: [8_000, 200_000], registers: ANY_REG, urbanity: "urban", defaultRails: ["ewallet", "tunai"] },
  { id: "gojek", surfaces: ["gojek", "gocar", "goride", "ojol"], kategori: "transport", typicalRange: [8_000, 200_000], registers: ANY_REG, urbanity: "urban", defaultRails: ["ewallet", "tunai"] },
  { id: "spbu_pertamina", surfaces: ["spbu", "pertamina", "pom bensin", "pertalite"], kategori: "transport", typicalRange: [20_000, 500_000], registers: ANY_REG, urbanity: "any", defaultRails: ["tunai", "qris", "emoney"] },
  { id: "krl", surfaces: ["krl", "commuter", "commuter line"], kategori: "transport", typicalRange: [3_000, 30_000], registers: ["jaksel_gaul", "baku", "betawi", "jawa", "sunda"], urbanity: "urban", defaultRails: ["emoney"] },
  { id: "ojek_pangkalan", surfaces: ["ojek pangkalan", "opang", "ojek"], kategori: "transport", typicalRange: [5_000, 80_000], registers: ANY_REG, urbanity: "any", defaultRails: ["tunai"] },
  { id: "angkot", surfaces: ["angkot", "angkutan"], kategori: "transport", typicalRange: [2_000, 20_000], registers: ["jawa", "sunda", "betawi", "baku", "medan", "minang"], urbanity: "suburban", defaultRails: ["tunai"] },
  { id: "parkir", surfaces: ["parkir", "karcis parkir"], kategori: "transport", typicalRange: [1_000, 30_000], registers: ANY_REG, urbanity: "any", defaultRails: ["tunai", "emoney"] },
  { id: "tol", surfaces: ["tol", "e-toll", "gerbang tol"], kategori: "transport", typicalRange: [5_000, 150_000], registers: ANY_REG, urbanity: "any", defaultRails: ["emoney"] },

  // ── makan ──
  { id: "warung", surfaces: ["warung", "warung nasi"], kategori: "makan", typicalRange: [3_000, 120_000], registers: ANY_REG, urbanity: "any", defaultRails: ["tunai"] },
  { id: "warteg", surfaces: ["warteg", "warung tegal"], kategori: "makan", typicalRange: [5_000, 80_000], registers: ["jaksel_gaul", "baku", "betawi", "jawa"], urbanity: "any", defaultRails: ["tunai", "qris"] },
  { id: "angkringan", surfaces: ["angkringan", "hik"], kategori: "makan", typicalRange: [2_000, 60_000], registers: ["jawa", "baku"], urbanity: "any", defaultRails: ["tunai"] },
  { id: "kantin", surfaces: ["kantin", "kantin sekolah", "kantin kampus"], kategori: "makan", typicalRange: [3_000, 60_000], registers: ANY_REG, urbanity: "any", defaultRails: ["tunai"] },
  { id: "gofood", surfaces: ["gofood", "go food"], kategori: "makan", typicalRange: [15_000, 300_000], registers: ANY_REG, urbanity: "urban", defaultRails: ["ewallet"] },
  { id: "nasi_padang", surfaces: ["nasi padang", "rm padang", "rumah makan padang"], kategori: "makan", typicalRange: [10_000, 150_000], registers: ANY_REG, urbanity: "any", defaultRails: ["tunai", "qris"] },
  { id: "bakso", surfaces: ["bakso", "bakso urat"], kategori: "makan", typicalRange: [5_000, 60_000], registers: ANY_REG, urbanity: "any", defaultRails: ["tunai"] },

  // ── rural / jasa ──
  { id: "pasar_tradisional", surfaces: ["pasar", "pasar tradisional"], kategori: "belanja_harian", typicalRange: [5_000, 500_000], registers: ANY_REG, urbanity: "rural", defaultRails: ["tunai"] },
  { id: "tukang_sayur", surfaces: ["tukang sayur", "mang sayur", "abang sayur"], kategori: "belanja_harian", typicalRange: [3_000, 100_000], registers: ["jawa", "sunda", "betawi", "baku"], urbanity: "suburban", defaultRails: ["tunai"] },
  { id: "bengkel", surfaces: ["bengkel", "bengkel motor"], kategori: "jasa", typicalRange: [15_000, 2_000_000], registers: ANY_REG, urbanity: "any", defaultRails: ["tunai", "qris"] },
  { id: "tambal_ban", surfaces: ["tambal ban", "tukang tambal ban"], kategori: "jasa", typicalRange: [5_000, 50_000], registers: ANY_REG, urbanity: "any", defaultRails: ["tunai"] },
  { id: "laundry", surfaces: ["laundry", "londri", "laundry kiloan"], kategori: "jasa", typicalRange: [5_000, 150_000], registers: ANY_REG, urbanity: "any", defaultRails: ["tunai", "qris"] },
  { id: "apotik", surfaces: ["apotik", "apotek", "kimia farma"], kategori: "kesehatan", typicalRange: [5_000, 500_000], registers: ANY_REG, urbanity: "any", defaultRails: ["tunai", "qris", "kartu"] },
  { id: "puskesmas", surfaces: ["puskesmas", "klinik"], kategori: "kesehatan", typicalRange: [5_000, 300_000], registers: ANY_REG, urbanity: "any", defaultRails: ["tunai"] },
  { id: "barbershop", surfaces: ["barbershop", "pangkas rambut", "cukur"], kategori: "jasa", typicalRange: [10_000, 150_000], registers: ANY_REG, urbanity: "any", defaultRails: ["tunai", "qris"] },
  { id: "fotokopi", surfaces: ["fotokopi", "fotocopy", "tukang fotokopi"], kategori: "jasa", typicalRange: [1_000, 80_000], registers: ANY_REG, urbanity: "any", defaultRails: ["tunai"] },

  // ── tagihan / institusi ──
  { id: "pln_token", surfaces: ["token listrik", "pln", "listrik"], kategori: "tagihan", typicalRange: [20_000, 1_000_000], registers: ANY_REG, urbanity: "any", defaultRails: ["ewallet", "transfer_bank", "tunai"] },
  { id: "pdam", surfaces: ["pdam", "air pdam", "tagihan air"], kategori: "tagihan", typicalRange: [20_000, 500_000], registers: ANY_REG, urbanity: "any", defaultRails: ["transfer_bank", "ewallet"] },
  { id: "telkomsel_pulsa", surfaces: ["pulsa", "telkomsel", "pulsa telkomsel"], kategori: "tagihan", typicalRange: [5_000, 200_000], registers: ANY_REG, urbanity: "any", defaultRails: ["pulsa", "ewallet", "tunai"] },
  { id: "indihome", surfaces: ["indihome", "wifi", "tagihan wifi"], kategori: "tagihan", typicalRange: [200_000, 900_000], registers: ANY_REG, urbanity: "urban", defaultRails: ["transfer_bank", "ewallet"] },
  { id: "bpjs", surfaces: ["bpjs", "iuran bpjs"], kategori: "tagihan", typicalRange: [35_000, 600_000], registers: ANY_REG, urbanity: "any", defaultRails: ["transfer_bank", "ewallet"] },
  { id: "kos", surfaces: ["kos", "kosan", "sewa kos"], kategori: "tempat_tinggal", typicalRange: [400_000, 4_000_000], registers: ANY_REG, urbanity: "urban", defaultRails: ["transfer_bank", "tunai"] },
  { id: "spp_sekolah", surfaces: ["spp", "spp sekolah", "uang sekolah"], kategori: "pendidikan", typicalRange: [100_000, 3_000_000], registers: ANY_REG, urbanity: "any", defaultRails: ["transfer_bank", "tunai"] },
  { id: "pesantren_syahriah", surfaces: ["syahriah", "syahriyah", "iuran pondok"], kategori: "pendidikan", typicalRange: [150_000, 2_500_000], registers: ["pesantren", "baku", "jawa"], urbanity: "any", defaultRails: ["transfer_bank", "tunai"] },
  { id: "masjid_infaq", surfaces: ["infaq masjid", "kotak amal", "infaq"], kategori: "sosial", typicalRange: [2_000, 500_000], registers: ["pesantren", "baku", "jawa", "betawi", "sunda", "minang"], urbanity: "any", defaultRails: ["tunai", "transfer_bank"] },
  { id: "iuran_warga", surfaces: ["iuran warga", "iuran rt", "kas rt"], kategori: "sosial", typicalRange: [5_000, 300_000], registers: ANY_REG, urbanity: "any", defaultRails: ["tunai"] },
];

const VENDOR_BY_ID = new Map<string, Vendor>(VENDORS.map((v) => [v.id, v]));

// ─────────────────────────────────────────────────────────────────────────────
// Lexical token pools
//
// Slang VALUES are never redefined here — they are read out of SLANG_TABLE so this file
// cannot drift from the tokenizer. `slang()` throws if a surface leaves rupiah.ts, which
// turns a silent divergence into a build failure.
// ─────────────────────────────────────────────────────────────────────────────

function slang(surface: string, contested?: TokenValue["contested"]): TokenValue {
  const rupiah = SLANG_TABLE[surface];
  if (rupiah === undefined) {
    throw new Error(`slang surface "${surface}" is not in SLANG_TABLE — do not invent values`);
  }
  return { surface, rupiah, attested: "press", ...(contested ? { contested } : {}) };
}

/**
 * Hokkien money slang, values sourced from SLANG_TABLE.
 *
 * gopek=500 and goban=50_000 are correct per SLANG_TABLE. The bench asserts gopek=50rb;
 * the bench is wrong and is not mirrored here — training data follows the verified table.
 *
 * `noban` (no=2 × ban=10_000) is deliberately ABSENT: morphologically plausible, zero
 * attested sources, and — decisively — rupiah.ts's tokenizer cannot see it, so any row
 * built from it would fail amount tracing downstream. Excluded rather than guessed.
 */
export const SLANG_TOKENS: readonly TokenValue[] = [
  slang("cepek"),
  slang("gopek"),
  slang("seceng"),
  slang("ceceng"),
  slang("noceng"),
  slang("goceng"),
  slang("ceban"),
  slang("goban"),
  slang("cetiao"),
  slang("gotiao"),
  // Etymology (go=5 × cap=10) says 50; modern usage says 50_000. Cells using it must
  // expect ambigu=true rather than a flat label — see ambigu_flagged in buildInvariants.
  slang("gocap", { alt: 50, note: "etimologi go(5)×cap(10)=50 vs pemakaian modern 50rb" }),
];

const CONTESTED_SURFACES = new Set(SLANG_TOKENS.filter((t) => t.contested).map((t) => t.surface));

/** Tokens held out of training: if the student gets these unseen, it learned the morphology
 *  (no=2 × ceng=1000) rather than memorising a lookup table. */
export const HOLDOUT_TOKENS: ReadonlySet<string> = new Set(["noceng", "seceng", "cetiao"]);

/** Spelled-out amounts. Values mirror the private SPELLED table in rupiah.ts. */
export const SPELLED_TOKENS: readonly TokenValue[] = [
  { surface: "sejuta", rupiah: 1_000_000, attested: "kbbi" },
  { surface: "setengah juta", rupiah: 500_000, attested: "kbbi" },
  { surface: "seperempat juta", rupiah: 250_000, attested: "kbbi" },
];

/**
 * Javanese numerals — the highest-value dialect axis, because unlike every other regional
 * lexicon these CHANGE THE AMOUNT rather than just the surface.
 *
 * Caveat for the generator: rupiah.ts's tokenizer knows none of these, so `traceAmount`
 * will return `none` for them. The TokenValue pair IS the ground truth for these rows.
 */
export const JAWA_NUMERAL_TOKENS: readonly TokenValue[] = [
  { surface: "sewu", rupiah: 1_000, attested: "press" },
  { surface: "rong ewu", rupiah: 2_000, attested: "press" },
  { surface: "limang ewu", rupiah: 5_000, attested: "press" },
  { surface: "seket ewu", rupiah: 50_000, attested: "press" },
  // selawe=25 is attested; "selawe ewu"=25_000 is my composition of two attested morphemes,
  // not a sourced surface. Marked derived_unverified → excluded from the token floor.
  { surface: "selawe ewu", rupiah: 25_000, attested: "derived_unverified" },
];

/** Floor domain: lexical tokens only. Synthesised numerals ("25rb") are not "tokens" —
 *  including them would make the floor vacuous. */
const LEXICAL_TOKENS: readonly TokenValue[] = [
  ...SLANG_TOKENS,
  ...SPELLED_TOKENS,
  ...JAWA_NUMERAL_TOKENS,
];

/** Tokens the floor applies to: attested, and not deliberately held out. */
const FLOOR_TOKENS: readonly string[] = LEXICAL_TOKENS.filter(
  (t) => t.attested !== "derived_unverified" && !HOLDOUT_TOKENS.has(t.surface),
).map((t) => t.surface);

// ─────────────────────────────────────────────────────────────────────────────
// Amounts and surface rendering
// ─────────────────────────────────────────────────────────────────────────────

/** Ladders of "nice" everyday amounts per band — people say 25rb, not 24.371. */
const AMOUNT_LADDER: Readonly<Record<Magnitude, readonly number[]>> = {
  receh: [500, 1_000, 1_500, 2_000, 2_500, 3_000, 3_500, 4_000, 4_500],
  kecil: [
    5_000, 6_000, 7_000, 7_500, 8_000, 10_000, 12_000, 12_500, 15_000, 17_500, 18_000,
    20_000, 22_000, 22_500, 25_000, 27_500, 30_000, 32_500, 35_000, 40_000, 45_000, 47_500,
  ],
  sedang: [
    50_000, 55_000, 60_000, 62_500, 65_000, 75_000, 80_000, 87_500, 90_000, 100_000,
    112_500, 120_000, 125_000, 150_000, 175_000, 187_500, 200_000, 250_000, 300_000,
    350_000, 400_000, 450_000,
  ],
  besar: [
    500_000, 550_000, 600_000, 650_000, 700_000, 750_000, 800_000, 850_000, 900_000,
    950_000, 1_000_000, 1_200_000, 1_250_000, 1_500_000, 1_750_000, 2_000_000, 2_500_000,
    3_000_000, 3_200_000, 3_500_000, 4_000_000, 4_500_000,
  ],
  jumbo: [
    5_000_000, 5_500_000, 6_000_000, 7_000_000, 7_500_000, 8_000_000, 9_000_000,
    10_000_000, 12_000_000, 15_000_000, 18_000_000, 20_000_000, 25_000_000, 30_000_000,
    45_000_000, 60_000_000,
  ],
};

function groupDots(n: number): string {
  const s = String(n);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ".";
    out += s.charAt(i);
  }
  return out;
}

/** Indonesian decimal separator is the comma. */
function decimalComma(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n).replace(".", ",");
}

/** The literal surface for a numeric amount, or null when the notation cannot express it. */
function renderSurface(value: number, notation: Notation): string | null {
  switch (notation) {
    case "polos":
      return String(value);
    case "dot_sep":
      return value >= 1_000 ? groupDots(value) : null;
    case "rp_prefix":
      return `Rp ${groupDots(value)}`;
    case "rb_suffix":
      return value % 1_000 === 0 && value < 1_000_000 ? `${value / 1_000}rb` : null;
    case "k_suffix":
      return value % 500 === 0 && value < 1_000_000
        ? `${decimalComma(value / 1_000)}k`
        : null;
    case "jt_suffix":
      return value >= 1_000_000 && value % 50_000 === 0
        ? `${decimalComma(value / 1_000_000)}jt`
        : null;
    // Token-driven notations carry their own surfaces.
    case "spelled":
    case "slang":
    case "regional_numeral":
      return null;
  }
}

const TOKEN_NOTATIONS: readonly Notation[] = ["slang", "spelled", "regional_numeral"];

function isTokenNotation(n: Notation): boolean {
  return TOKEN_NOTATIONS.includes(n);
}

/** Ladder values in `m` that `notation` can actually render. */
function amountsFor(m: Magnitude, notation: Notation): readonly number[] {
  return AMOUNT_LADDER[m].filter((v) => renderSurface(v, notation) !== null);
}

/** Band containing a value — the band is DERIVED from the amount, never asserted over it. */
function magnitudeOf(value: number): Magnitude | null {
  for (const m of Object.keys(MAGNITUDE_BANDS) as Magnitude[]) {
    if (inBand(value, m)) return m;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Date surfaces
// ─────────────────────────────────────────────────────────────────────────────

const DATE_SURFACES: Readonly<Record<DateHint, readonly string[]>> = {
  hari_ini: ["td", "tadi", "barusan", "hari ini", "tadi pagi", "sore tadi", "tadi siang"],
  kemarin: ["kemarin", "maren", "kmrn", "kemaren"],
  minggu_ini: ["minggu ini", "pekan ini"],
  bulan_ini: ["bulan ini", "bulan ini kemarin awal"],
  // Unreachable: KBBI lusa = day after tomorrow = FUTURE, and SYSTEM_PROMPT books only what
  // has already happened. The enum value stays in the schema; no cell may ever emit it.
  lusa: [],
  tidak_jelas: [],
};

/**
 * Future triggers. Any of these ⇒ bukan_transaksi. `lusa` lives here and ONLY here —
 * assertCellCoherent rejects a "lusa" surface on any transactional cell.
 */
const FUTURE_SURFACES: readonly string[] = [
  "besok", "nanti", "rencana", "rencananya", "minggu depan", "bulan depan", "lusa", "nanti malem",
];

// ─────────────────────────────────────────────────────────────────────────────
// Aspect specs
//
// `pins` (single allowed value, or listed in hardPins) = the aspect forces the axis and the
// marginal repair must not touch it. `varies` = free, and repair may rewrite it within the
// allowed set. Each aspect keeps ~2-3 genuinely free axes; more than that and rows within a
// cell stop being near-neighbours, fewer and the cell degenerates into a template.
// ─────────────────────────────────────────────────────────────────────────────

export type AxisName =
  | "direction" | "cardinality" | "magnitude" | "notation" | "dateHint"
  | "correction" | "register" | "registerIntensity" | "noise" | "rail";

/** ROWS_PER_CELL: below ~4, teacher sampling variance dominates a cell and its rows no
 *  longer test the same thing. Above ~10, the free axes are exhausted, rows collapse into
 *  near-duplicates, and a 1.7B student memorises the template instead of the rule. */
export const ROWS_PER_CELL = 6;

export const TIER_ROW_BUDGET: Readonly<Record<Tier, number>> = {
  ordinary: 0.40,
  notation: 0.13,
  register_noise: 0.07,
  direction: 0.15,
  non_tx: 0.15,
  adversarial: 0.10,
};

interface AspectSpec {
  aspect: Aspect;
  tier: Tier;
  /** Relative share within the tier — production frequency, not uniform. */
  weight: number;
  direction: readonly Direction[];
  cardinality: readonly Cardinality[];
  magnitude: readonly Magnitude[];
  notation: readonly Notation[];
  dateHint: readonly DateHint[];
  correction: readonly Correction[];
  register: readonly Register[];
  registerIntensity: readonly RegisterIntensity[];
  noise: readonly Noise[];
  rail: readonly Rail[];
  vendorPool: readonly string[];
  /** Axes forced by the aspect's meaning even when several values are listed. */
  hardPins: readonly AxisName[];
  benchAnalogue: string | null;
}

const ALL_NOISE: readonly Noise[] = ["bersih", "wa_ringkas", "voice_rambling", "typo_berat", "emoji_format"];
const ALL_RAIL: readonly Rail[] = [
  "none", "transfer_bank", "ewallet", "tunai", "qris", "cod", "kartu", "emoney", "pulsa",
];
const ALL_INTENSITY: readonly RegisterIntensity[] = ["sisip", "campur", "penuh"];
const DEFAULT_CORRECTION: readonly Correction[] = ["none", "amount", "magnitude", "item"];
const DATED: readonly DateHint[] = ["hari_ini", "kemarin", "minggu_ini", "bulan_ini", "tidak_jelas"];
const NUM_NOTATION: readonly Notation[] = ["polos", "dot_sep", "rb_suffix", "k_suffix", "rp_prefix"];

const RETAIL = ["indomaret", "alfamart", "warung_madura", "minimarket_lokal", "tokopedia", "shopee", "mixue", "kopi_kenangan"];
const TRANSPORT = ["grab", "gojek", "spbu_pertamina", "krl", "ojek_pangkalan", "angkot", "parkir", "tol"];
const MAKAN = ["warung", "warteg", "angkringan", "kantin", "gofood", "nasi_padang", "bakso"];
const JASA = ["pasar_tradisional", "tukang_sayur", "bengkel", "tambal_ban", "laundry", "apotik", "puskesmas", "barbershop", "fotokopi"];
const TAGIHAN = ["pln_token", "pdam", "telkomsel_pulsa", "indihome", "bpjs", "kos", "spp_sekolah", "pesantren_syahriah", "masjid_infaq", "iuran_warga"];
const ANY_VENDOR = [...RETAIL, ...TRANSPORT, ...MAKAN, ...JASA, ...TAGIHAN];

function spec(s: Partial<AspectSpec> & Pick<AspectSpec, "aspect" | "tier" | "weight">): AspectSpec {
  return {
    direction: ["out"],
    cardinality: ["single"],
    magnitude: ["receh", "kecil", "sedang", "besar", "jumbo"],
    notation: NUM_NOTATION,
    dateHint: DATED,
    correction: DEFAULT_CORRECTION,
    register: ANY_REG,
    registerIntensity: ALL_INTENSITY,
    noise: ALL_NOISE,
    rail: ALL_RAIL,
    vendorPool: ANY_VENDOR,
    hardPins: [],
    benchAnalogue: null,
    ...s,
  };
}

export const ASPECT_SPECS: readonly AspectSpec[] = [
  // ── ordinary (40% of rows) ────────────────────────────────────────────────
  spec({
    aspect: "ord_single_out", tier: "ordinary", weight: 8,
    direction: ["out"], cardinality: ["single"], hardPins: ["direction", "cardinality"],
    benchAnalogue: null,
  }),
  spec({
    aspect: "ord_single_in", tier: "ordinary", weight: 2,
    direction: ["in"], cardinality: ["single"], hardPins: ["direction", "cardinality"],
    magnitude: ["kecil", "sedang", "besar", "jumbo"], vendorPool: [],
    benchAnalogue: "income treated as pengeluaran — the 'always keluar' shortcut",
  }),
  spec({
    aspect: "ord_multi_out", tier: "ordinary", weight: 5,
    direction: ["out"], cardinality: ["dua", "tiga", "banyak"], hardPins: ["direction"],
    benchAnalogue: null,
  }),
  spec({
    aspect: "ord_rekap_list", tier: "ordinary", weight: 3,
    direction: ["out"], cardinality: ["tiga", "banyak"], hardPins: ["direction", "noise"],
    noise: ["wa_ringkas", "emoji_format"], notation: NUM_NOTATION,
    benchAnalogue: "bulk list where each line needs its own amount",
  }),
  spec({
    aspect: "ord_vendor_named", tier: "ordinary", weight: 4,
    direction: ["out", "in", "mixed"], cardinality: ["single", "dua", "tiga"],
    benchAnalogue: null,
  }),
  spec({
    aspect: "ord_rail_named", tier: "ordinary", weight: 3,
    direction: ["out", "in", "mixed"], cardinality: ["single", "dua", "tiga"], hardPins: ["rail"],
    rail: ["transfer_bank", "ewallet", "tunai", "qris", "cod", "kartu", "emoney", "pulsa"],
    benchAnalogue: null,
  }),
  spec({
    aspect: "ord_recurring_bill", tier: "ordinary", weight: 3,
    direction: ["out"], cardinality: ["single"], hardPins: ["direction", "cardinality"],
    magnitude: ["kecil", "sedang", "besar"], vendorPool: TAGIHAN,
    dateHint: ["kemarin", "bulan_ini", "minggu_ini", "hari_ini", "tidak_jelas"],
    benchAnalogue: null,
  }),
  spec({
    aspect: "ord_topup_ewallet", tier: "ordinary", weight: 2,
    direction: ["out"], cardinality: ["single"], hardPins: ["direction", "cardinality", "rail"],
    magnitude: ["kecil", "sedang"], rail: ["ewallet", "pulsa"], vendorPool: ["telkomsel_pulsa"],
    benchAnalogue: "top up read as pemasukan because the balance goes up",
  }),
  spec({
    aspect: "ord_date_relative", tier: "ordinary", weight: 4,
    direction: ["out", "in", "mixed"], cardinality: ["single", "dua", "tiga"], hardPins: ["dateHint"],
    dateHint: ["hari_ini", "kemarin", "minggu_ini", "bulan_ini"],
    benchAnalogue: "'td'/'tadi'/'barusan' collapsed to kemarin",
  }),
  spec({
    aspect: "ord_no_date", tier: "ordinary", weight: 4,
    direction: ["out", "in", "mixed"], cardinality: ["single", "dua", "tiga"], hardPins: ["dateHint"],
    dateHint: ["tidak_jelas"],
    benchAnalogue: "tidak_jelas never asserted in the test set — a date is invented instead",
  }),
  spec({
    aspect: "ord_qty_simple", tier: "ordinary", weight: 3,
    direction: ["out"], cardinality: ["single"], hardPins: ["direction", "cardinality"],
    magnitude: ["receh", "kecil", "sedang"],
    benchAnalogue: "qty × unit price merged or split — both labels acceptable",
  }),
  spec({
    aspect: "ord_wa_wrapper", tier: "ordinary", weight: 3,
    direction: ["out", "in", "mixed"], cardinality: ["single", "dua", "tiga"], hardPins: ["noise"],
    noise: ["wa_ringkas"],
    benchAnalogue: null,
  }),

  // ── notation (13%) ────────────────────────────────────────────────────────
  spec({
    aspect: "not_dot_separator", tier: "notation", weight: 3,
    direction: ["out", "in", "mixed"], cardinality: ["single", "dua", "tiga"],
    notation: ["dot_sep", "rp_prefix"], hardPins: ["notation"],
    magnitude: ["kecil", "sedang", "besar"],
    benchAnalogue: "dot as thousands separator read as a decimal point",
  }),
  spec({
    aspect: "not_k_suffix_decimal", tier: "notation", weight: 3,
    direction: ["out", "in", "mixed"], cardinality: ["single", "dua", "tiga"],
    notation: ["k_suffix"], hardPins: ["notation", "magnitude"],
    magnitude: ["receh", "kecil", "sedang"],
    benchAnalogue: "'27,5k' truncated to 27 or blown up to 275rb",
  }),
  spec({
    aspect: "not_spelled_amount", tier: "notation", weight: 2,
    direction: ["out", "in"], cardinality: ["single", "dua"],
    // cardinality is pinned because assignTokens derives it from the token count; leaving it
    // free let repair make a choice that finalize then silently overwrote.
    notation: ["spelled"], hardPins: ["notation", "magnitude", "cardinality"],
    magnitude: ["sedang", "besar"],
    benchAnalogue: null,
  }),
  spec({
    // Weighted above its siblings because the token floor needs slots: 8 floor tokens × 2
    // cells + 3 held-out tokens do not fit in a 2%-of-rows aspect.
    aspect: "not_slang_hokkien", tier: "notation", weight: 5,
    direction: ["out", "in"], cardinality: ["single", "dua"],
    notation: ["slang"], hardPins: ["notation", "magnitude", "cardinality"],
    register: ["jaksel_gaul", "betawi", "baku", "medan"],
    benchAnalogue: "gopek asserted as 50rb in the test set — SLANG_TABLE says 500",
  }),
  spec({
    aspect: "not_regional_numeral", tier: "notation", weight: 2,
    direction: ["out", "in"], cardinality: ["single", "dua"],
    notation: ["regional_numeral"], hardPins: ["notation", "magnitude", "register", "cardinality"],
    register: ["jawa"], registerIntensity: ["sisip", "campur", "penuh"],
    benchAnalogue: "Javanese numerals change the amount, not just the surface",
  }),

  // ── register_noise (7%) ───────────────────────────────────────────────────
  spec({
    // register is restricted but NOT hard-pinned: this aspect is the natural home for the
    // low-share registers (medan/minang/makassar), so repair must be free to steer it there.
    aspect: "reg_regional_lexicon", tier: "register_noise", weight: 3,
    direction: ["out", "in", "mixed"], cardinality: ["single", "dua", "tiga"],
    register: ["medan", "sunda", "minang", "betawi", "makassar_timur", "jawa"],
    benchAnalogue: "Medan 'pajak' = pasar, not a tax payment",
  }),
  spec({
    aspect: "noi_typo_heavy", tier: "register_noise", weight: 2,
    direction: ["out", "in", "mixed"], cardinality: ["single", "dua", "tiga"],
    noise: ["typo_berat"], hardPins: ["noise"],
    benchAnalogue: null,
  }),
  spec({
    aspect: "noi_voice_rambling", tier: "register_noise", weight: 2,
    direction: ["out", "in", "mixed"], cardinality: ["dua", "tiga", "banyak"],
    noise: ["voice_rambling"], hardPins: ["noise"],
    benchAnalogue: "rambling dictation where an amount gets dropped mid-sentence",
  }),

  // ── direction (15%) ───────────────────────────────────────────────────────
  spec({
    // magnitude stays repairable: gaji/THR are the only realistic home for the jumbo band.
    aspect: "dir_income_gaji", tier: "direction", weight: 3,
    direction: ["in"], cardinality: ["single"], hardPins: ["direction", "cardinality"],
    magnitude: ["besar", "jumbo"], vendorPool: [],
    dateHint: ["hari_ini", "bulan_ini", "kemarin", "tidak_jelas"],
    rail: ["transfer_bank", "tunai", "none"],
    benchAnalogue: "gaji/THR booked as pengeluaran",
  }),
  spec({
    aspect: "dir_income_refund_cashback", tier: "direction", weight: 3,
    direction: ["in"], cardinality: ["single", "dua"], hardPins: ["direction"],
    magnitude: ["kecil", "sedang", "besar"], vendorPool: [...RETAIL, "grab", "gojek"],
    rail: ["ewallet", "transfer_bank", "none"],
    benchAnalogue: "refund booked as pengeluaran because the vendor name reads like a purchase",
  }),
  spec({
    aspect: "dir_income_transfer_masuk", tier: "direction", weight: 3,
    direction: ["in"], cardinality: ["single", "dua"], hardPins: ["direction"],
    magnitude: ["sedang", "besar"], vendorPool: [],
    rail: ["transfer_bank", "ewallet", "none"],
    benchAnalogue: "'transfer' keyword pulls the parse to pengeluaran regardless of masuk/keluar",
  }),
  spec({
    aspect: "dir_mixed_message", tier: "direction", weight: 4,
    direction: ["mixed"], cardinality: ["dua", "tiga", "banyak"],
    hardPins: ["direction"],
    benchAnalogue: "mixed-direction message flattened to a single direction",
  }),
  spec({
    // The only home for correction=direction, so repair must be able to steer it there.
    aspect: "dir_lexical_trap", tier: "direction", weight: 2,
    direction: ["out", "in"], cardinality: ["single", "dua"],
    correction: ["none", "direction"],
    benchAnalogue: "'bayar utang' (keluar) vs 'utang dibayar ke saya' (masuk)",
  }),
  spec({
    aspect: "dir_topup_not_income", tier: "direction", weight: 2,
    direction: ["out"], cardinality: ["single", "dua"],
    hardPins: ["direction", "rail"], magnitude: ["kecil", "sedang"],
    rail: ["ewallet", "emoney", "pulsa"], vendorPool: ["telkomsel_pulsa"],
    benchAnalogue: "top up / isi saldo read as pemasukan",
  }),

  // ── non_tx (15%) ──────────────────────────────────────────────────────────
  // ≥60% of these carry a rupiah nominal: "curhat with no number" is free, the
  // discriminative case is a number that must NOT be booked.
  spec({
    aspect: "ntx_curhat", tier: "non_tx", weight: 4,
    direction: ["non_tx"], cardinality: ["zero"], correction: ["none"],
    dateHint: ["tidak_jelas"], rail: ["none"],
    hardPins: ["direction", "cardinality", "dateHint", "correction", "rail"],
    benchAnalogue: null,
  }),
  spec({
    aspect: "ntx_future_intent", tier: "non_tx", weight: 5,
    direction: ["non_tx"], cardinality: ["zero"], correction: ["none"],
    dateHint: ["tidak_jelas"], rail: ["none"],
    hardPins: ["direction", "cardinality", "dateHint", "correction", "rail"],
    benchAnalogue: "'besok mau bayar X' booked as a real transaction",
  }),
  spec({
    // Partial-cancel variant is direction=out: a booked purchase sitting next to a
    // cancelled one. That is the sharpest form of "a number is present and must not be
    // booked", and it is why this aspect allows a transactional direction.
    aspect: "ntx_cancelled", tier: "non_tx", weight: 2,
    direction: ["non_tx", "out"], cardinality: ["zero", "single"],
    correction: ["cancel"], dateHint: ["tidak_jelas", "hari_ini", "kemarin"],
    hardPins: ["correction", "direction"],
    benchAnalogue: "'gak jadi beli' still booked",
  }),
  spec({
    aspect: "ntx_query", tier: "non_tx", weight: 3,
    direction: ["non_tx"], cardinality: ["zero"], correction: ["none"],
    dateHint: ["tidak_jelas"], rail: ["none"],
    hardPins: ["direction", "cardinality", "dateHint", "correction", "rail"],
    benchAnalogue: "a question about spending answered by booking the number in it",
  }),

  // ── adversarial (10%) ─────────────────────────────────────────────────────
  spec({
    aspect: "adv_correction_amount", tier: "adversarial", weight: 2,
    direction: ["out", "in"], cardinality: ["single"],
    correction: ["amount"], hardPins: ["correction", "cardinality"],
    benchAnalogue: "pre-correction amount kept instead of the corrected one",
  }),
  spec({
    aspect: "adv_correction_magnitude", tier: "adversarial", weight: 1,
    direction: ["out"], cardinality: ["single"],
    correction: ["magnitude"], hardPins: ["correction", "cardinality", "direction"],
    magnitude: ["kecil", "sedang"],
    benchAnalogue: "'7,5 ... eh 75rb bukan 7,5 juta' resolved to the juta reading",
  }),
  spec({
    aspect: "adv_price_copy_bait", tier: "adversarial", weight: 2,
    direction: ["out"], cardinality: ["tiga", "banyak"],
    hardPins: ["direction"],
    benchAnalogue: "adjacent line's price copied onto the next item",
  }),
  spec({
    aspect: "adv_qty_x_unit", tier: "adversarial", weight: 1,
    direction: ["out"], cardinality: ["single"],
    hardPins: ["direction", "cardinality"], magnitude: ["receh", "kecil", "sedang"],
    benchAnalogue: "'N x @harga' — unit price copied as the total, or qty ignored",
  }),
  spec({
    aspect: "adv_split_share", tier: "adversarial", weight: 1,
    direction: ["out"], cardinality: ["single"],
    hardPins: ["direction", "cardinality"], magnitude: ["kecil", "sedang"],
    benchAnalogue: "group total booked instead of the user's share",
  }),
  spec({
    aspect: "adv_discount_net", tier: "adversarial", weight: 1,
    direction: ["out"], cardinality: ["single"],
    hardPins: ["direction", "cardinality"], magnitude: ["kecil", "sedang", "besar"],
    benchAnalogue: "gross price booked, discount ignored",
  }),
  spec({
    aspect: "adv_fee_plus_principal", tier: "adversarial", weight: 1,
    direction: ["out"], cardinality: ["dua"],
    hardPins: ["direction", "cardinality"], magnitude: ["kecil", "sedang", "besar"],
    rail: ["transfer_bank", "ewallet", "emoney", "pulsa"],
    benchAnalogue: "admin fee swallowed into the principal, or dropped entirely",
  }),
  spec({
    aspect: "adv_fuzzy_amount", tier: "adversarial", weight: 1,
    direction: ["out", "in"], cardinality: ["single"],
    hardPins: ["cardinality"], magnitude: ["kecil", "sedang", "besar"],
    benchAnalogue: "'800an' — needs ambigu=true, not a confident guess",
  }),
  spec({
    aspect: "adv_past_plus_future", tier: "adversarial", weight: 1,
    direction: ["out"], cardinality: ["single", "dua"],
    hardPins: ["direction"], dateHint: ["hari_ini", "kemarin"],
    benchAnalogue: "the planned half of a past+future message booked too",
  }),
  spec({
    aspect: "adv_phantom_income_bait", tier: "adversarial", weight: 1,
    direction: ["out"], cardinality: ["single"],
    hardPins: ["direction", "cardinality"], magnitude: ["sedang", "besar"],
    benchAnalogue: "'gaji 5jt belum cair' booked as pemasukan on the gaji keyword alone",
  }),
];

const SPEC_BY_ASPECT = new Map<Aspect, AspectSpec>(ASPECT_SPECS.map((s) => [s.aspect, s]));

function specOf(a: Aspect): AspectSpec {
  const s = SPEC_BY_ASPECT.get(a);
  if (!s) throw new Error(`no spec for aspect ${a}`);
  return s;
}

/** Allowed values for an axis, as declared by the aspect. */
function allowedFor(s: AspectSpec, axis: AxisName): readonly string[] {
  switch (axis) {
    case "direction": return s.direction;
    case "cardinality": return s.cardinality;
    case "magnitude": return s.magnitude;
    case "notation": return s.notation;
    case "dateHint": return s.dateHint;
    case "correction": return s.correction;
    case "register": return s.register;
    case "registerIntensity": return s.registerIntensity;
    case "noise": return s.noise;
    case "rail": return s.rail;
  }
}

/** An axis varies iff the aspect offers a choice and does not hard-pin it. */
function varies(s: AspectSpec, axis: AxisName): boolean {
  return allowedFor(s, axis).length > 1 && !s.hardPins.includes(axis);
}

// ─────────────────────────────────────────────────────────────────────────────
// Target marginals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Entry-level pemasukan. NOT the ~10% production base rate: direction is lexically
 * determined ("gaji/refund/masuk/cair" vs "beli/bayar") and therefore cheaply learnable,
 * so at a 9% prior a 1.7B student takes the "always pengeluaran" shortcut for free and
 * still scores well. Oversampling to ~23% prices the shortcut out without teaching a
 * wrong prior — direction at inference is read off the lexicon, not off the base rate.
 */
export const TARGET_PEMASUKAN_ENTRY_SHARE = 0.23;

export const TARGETS = {
  direction: { out: 0.56, in: 0.20, mixed: 0.12, non_tx: 0.12 },
  cardinality: { zero: 0.12, single: 0.50, dua: 0.20, tiga: 0.11, banyak: 0.07 },
  magnitude: { receh: 0.12, kecil: 0.38, sedang: 0.32, besar: 0.14, jumbo: 0.04 },
  dateHint: {
    tidak_jelas: 0.34, hari_ini: 0.38, kemarin: 0.18, minggu_ini: 0.05, bulan_ini: 0.04,
    // Product decision, not a sampling accident: lusa is FUTURE, so it can never label a
    // booked entry. The enum value stays in financeParseSchema; this taxonomy makes it
    // unreachable and assertCellCoherent enforces it.
    lusa: 0,
  },
  noise: { bersih: 0.20, wa_ringkas: 0.45, voice_rambling: 0.13, typo_berat: 0.12, emoji_format: 0.10 },
  register: {
    jaksel_gaul: 0.22, pesantren: 0.20, baku: 0.18, jawa: 0.14, betawi: 0.08, sunda: 0.08,
    medan: 0.05, minang: 0.03, makassar_timur: 0.02,
  },
  // Over NON-BAKU cells only: intensity describes how much regional lexicon is mixed in,
  // which is undefined for baku. Real chat is code-mixed, hence sisip dominating.
  registerIntensity: { sisip: 0.65, campur: 0.30, penuh: 0.05 },
  rail: {
    none: 0.45, transfer_bank: 0.13, ewallet: 0.12, tunai: 0.10, qris: 0.08, cod: 0.04,
    // paylater is deliberately absent: accrual-vs-cash-basis is undecided, so a paylater
    // row has no defensible gold label. The 4% goes to kartu.
    kartu: 0.04, emoney: 0.03, pulsa: 0.01,
  },
  correction: { none: 0.88, amount: 0.05, magnitude: 0.025, item: 0.02, cancel: 0.015, direction: 0.01 },
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Seeded RNG — reproducibility is non-negotiable for a dataset spec, so no Math.random.
// ─────────────────────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;

function pick<T>(rng: Rng, arr: readonly T[]): T {
  if (arr.length === 0) throw new Error("pick from empty array");
  const v = arr[Math.floor(rng() * arr.length) % arr.length];
  if (v === undefined) throw new Error("pick produced undefined");
  return v;
}

function shuffled<T>(rng: Rng, arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const ai = a[i];
    const aj = a[j];
    if (ai === undefined || aj === undefined) continue;
    a[i] = aj;
    a[j] = ai;
  }
  return a;
}

// ─────────────────────────────────────────────────────────────────────────────
// Drafts
// ─────────────────────────────────────────────────────────────────────────────

interface Draft {
  id: string;
  aspect: Aspect;
  tier: Tier;
  direction: Direction;
  cardinality: Cardinality;
  magnitude: Magnitude;
  notation: Notation[];
  dateHint: DateHint;
  correction: Correction;
  register: Register;
  registerIntensity: RegisterIntensity;
  noise: Noise;
  rail: Rail;
  /** Token-driven cells resolve their amounts from here; numeric cells synthesise them. */
  tokens: TokenValue[];
  /** False only for amount-less non_tx cells — magnitude is undefined for those. */
  hasNominal: boolean;
}

function getAxis(d: Draft, axis: AxisName): string {
  switch (axis) {
    case "direction": return d.direction;
    case "cardinality": return d.cardinality;
    case "magnitude": return d.magnitude;
    case "notation": return d.notation[0] ?? "polos";
    case "dateHint": return d.dateHint;
    case "correction": return d.correction;
    case "register": return d.register;
    case "registerIntensity": return d.registerIntensity;
    case "noise": return d.noise;
    case "rail": return d.rail;
  }
}

function setAxis(d: Draft, axis: AxisName, value: string): void {
  switch (axis) {
    case "direction": d.direction = value as Direction; return;
    case "cardinality": d.cardinality = value as Cardinality; return;
    case "magnitude": d.magnitude = value as Magnitude; return;
    case "notation": d.notation = [value as Notation]; return;
    case "dateHint": d.dateHint = value as DateHint; return;
    case "correction": d.correction = value as Correction; return;
    case "register": d.register = value as Register; return;
    case "registerIntensity": d.registerIntensity = value as RegisterIntensity; return;
    case "noise": d.noise = value as Noise; return;
    case "rail": d.rail = value as Rail; return;
  }
}

const ENTRY_COUNT: Readonly<Record<Cardinality, number>> = {
  zero: 0, single: 1, dua: 2, tiga: 3, banyak: 5,
};

/** Axis values that cannot coexist get reconciled here, after every repair pass. */
function relink(d: Draft): void {
  const s = specOf(d.aspect);
  if (d.direction === "non_tx") {
    d.cardinality = "zero";
    d.dateHint = "tidak_jelas";
  } else {
    if (d.cardinality === "zero") {
      d.cardinality = s.cardinality.find((c) => c !== "zero") ?? "single";
    }
    if (!d.hasNominal) d.hasNominal = true;
    // mixed needs at least one entry per direction.
    if (d.direction === "mixed" && ENTRY_COUNT[d.cardinality] < 2) {
      d.cardinality = s.cardinality.find((c) => ENTRY_COUNT[c] >= 2) ?? "dua";
    }
    // Income messages are near-always single-entry in production ("gaji cair 5jt"); a
    // 3-item income list is not a real message shape. Letting repair hand `in` cells the
    // same cardinality spread as `out` cells is also what pushes entry-level pemasukan
    // several points past target, since every extra entry on an in-cell is a masuk.
    if (d.direction === "in" && ENTRY_COUNT[d.cardinality] > 2) {
      d.cardinality = s.cardinality.find((c) => {
        const n = ENTRY_COUNT[c];
        return n >= 1 && n <= 2;
      }) ?? "single";
    }
  }
  if (d.register === "baku") d.registerIntensity = "sisip";
  // A numeric notation that cannot render anything in the band would make the surface a lie.
  if (d.hasNominal && !isTokenNotation(d.notation[0] ?? "polos")) {
    const feasible = s.notation.filter(
      (n) => !isTokenNotation(n) && amountsFor(d.magnitude, n).length > 0,
    );
    const current = d.notation[0] ?? "polos";
    if (!feasible.includes(current)) {
      d.notation = [feasible[0] ?? "polos"];
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — allocation + coverage floor
// ─────────────────────────────────────────────────────────────────────────────

const MIN_CELLS_PER_ASPECT = 2;

/** Largest-remainder apportionment: proportional, integral, and sums exactly to `total`. */
function apportion(weights: readonly number[], total: number, floor: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => floor);
  const exact = weights.map((w) => (w / sum) * total);
  const base = exact.map((e) => Math.max(floor, Math.floor(e)));
  let used = base.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac);
  let k = 0;
  while (used < total && order.length > 0) {
    const o = order[k % order.length];
    if (o) {
      const cur = base[o.i];
      if (cur !== undefined) {
        base[o.i] = cur + 1;
        used++;
      }
    }
    k++;
  }
  // Trim overshoot from the largest allocations, never below the coverage floor.
  while (used > total) {
    let bestIdx = -1;
    let bestVal = floor;
    for (let i = 0; i < base.length; i++) {
      const v = base[i];
      if (v !== undefined && v > bestVal) {
        bestVal = v;
        bestIdx = i;
      }
    }
    if (bestIdx < 0) break;
    const cur = base[bestIdx];
    if (cur === undefined) break;
    base[bestIdx] = cur - 1;
    used--;
  }
  return base;
}

/**
 * Share of an aspect's cells that carry NO rupiah nominal. The floor runs the other way:
 * ≥60% of non_tx cells MUST carry a nominal, because "curhat with no number" is the free
 * case — the discriminative one is a number that must NOT be booked.
 *
 * Applied as floor(n × rate) over the aspect's own cell count, not as a per-cell coin flip
 * and not as an index modulus: sampling put the realized share at 59.6% on some seeds, and
 * a modulus degenerates at the coverage floor (an aspect with 2 cells took `i % 5 < 3` for
 * both, making ntx_curhat 100% amount-less). A floor that holds only on most seeds and most
 * sizes is not a floor.
 */
const NOMINAL_LESS_RATE: Partial<Record<Aspect, number>> = {
  ntx_curhat: 0.6,
  ntx_query: 0.4,
  ntx_future_intent: 0,
  ntx_cancelled: 0,
};

function draftCells(rng: Rng, targetCells: number): Draft[] {
  const drafts: Draft[] = [];
  const tiers = Object.keys(TIER_ROW_BUDGET) as Tier[];

  for (const tier of tiers) {
    const specs = ASPECT_SPECS.filter((s) => s.tier === tier);
    const budget = Math.round(targetCells * TIER_ROW_BUDGET[tier]);
    const counts = apportion(specs.map((s) => s.weight), budget, MIN_CELLS_PER_ASPECT);

    specs.forEach((s, si) => {
      const n = counts[si] ?? MIN_CELLS_PER_ASPECT;
      for (let i = 0; i < n; i++) {
        const magnitude = pick(rng, s.magnitude);
        const notation = pick(rng, s.notation);
        // ntx_cancelled splits deterministically: ~40% pure cancel (non_tx), ~60% partial
        // cancel (a booked purchase beside a cancelled one). Fixed here rather than left to
        // repair, which would drain the pure-cancel variant to zero chasing the direction
        // marginal and delete the aspect's primary lesson.
        const direction: Direction =
          s.aspect === "ntx_cancelled" ? (i % 5 < 2 ? "non_tx" : "out") : pick(rng, s.direction);
        const nominalLess = Math.floor(n * (NOMINAL_LESS_RATE[s.aspect] ?? 0));
        const hasNominal = direction !== "non_tx" ? true : i >= nominalLess;

        const d: Draft = {
          id: `${s.aspect}-${String(i).padStart(2, "0")}`,
          aspect: s.aspect,
          tier,
          direction,
          cardinality: pick(rng, s.cardinality),
          magnitude,
          notation: [notation],
          dateHint: pick(rng, s.dateHint),
          correction: pick(rng, s.correction),
          register: pick(rng, s.register),
          registerIntensity: pick(rng, s.registerIntensity),
          noise: pick(rng, s.noise),
          rail: pick(rng, s.rail),
          tokens: [],
          hasNominal,
        };
        relink(d);
        drafts.push(d);
      }
    });
  }
  return drafts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — token floor
//
// Every attested, non-held-out lexical token must reach ≥2 TRAIN cells. Assignment is
// round-robin rather than random: at these cell counts, random sampling leaves a long tail
// of tokens seen once, and a token seen once is a token the student memorises rather than
// learns. Held-out tokens get their own cells, which markHoldouts then pushes to eval.
// ─────────────────────────────────────────────────────────────────────────────

const TOKEN_POOL_FOR: Readonly<Record<string, readonly TokenValue[]>> = {
  slang: SLANG_TOKENS,
  spelled: SPELLED_TOKENS,
  regional_numeral: JAWA_NUMERAL_TOKENS,
};

/** Distinct train cells each floor token must reach. One above the floor of 2, so a cell
 *  landing in eval_iid cannot by itself drop the token below the floor. */
const TOKEN_CELL_REPS = 3;

function assignTokens(rng: Rng, drafts: Draft[]): Draft[] {
  const out = [...drafts];

  for (const [notation, pool] of Object.entries(TOKEN_POOL_FOR)) {
    const cells = shuffled(rng, out.filter((d) => (d.notation[0] ?? "") === notation));
    const template = cells[0];
    if (!template) continue;
    for (const c of cells) c.tokens = [];

    const holdout = pool.filter((t) => HOLDOUT_TOKENS.has(t.surface));
    const trainable = pool.filter((t) => !HOLDOUT_TOKENS.has(t.surface));
    const byId = new Map(pool.map((t) => [t.surface, t]));
    const capacity = (d: Draft) => Math.max(1, ENTRY_COUNT[d.cardinality]);

    const required: string[] = [];
    for (const t of trainable) {
      const reps = FLOOR_TOKENS.includes(t.surface) ? TOKEN_CELL_REPS : 1;
      for (let i = 0; i < reps; i++) required.push(t.surface);
    }

    // Grow the aspect until every required instance fits. Cheaper than hand-tuning weights,
    // and it makes the token floor a guarantee rather than an aspiration.
    let grown = 0;
    const grow = (): Draft => {
      const clone: Draft = {
        ...template,
        id: `${template.aspect}-x${String(grown++).padStart(2, "0")}`,
        notation: [...template.notation],
        tokens: [],
      };
      out.push(clone);
      cells.push(clone);
      return clone;
    };
    while (cells.length < holdout.length + 1) grow();

    // Held-out tokens get DEDICATED cells. Sharing a cell with a floor token would drag
    // that floor token into eval along with the holdout — which is exactly how the token
    // floor was silently breaking at some seeds.
    const holdoutCells = cells.slice(0, holdout.length);
    const rest = cells.slice(holdout.length);
    let cap = rest.reduce((n, d) => n + capacity(d), 0);
    while (cap < required.length) {
      const g = grow();
      rest.push(g);
      cap += capacity(g);
    }

    holdout.forEach((t, i) => {
      const c = holdoutCells[i];
      if (c) c.tokens = [t];
    });

    // Place each required instance in a DISTINCT cell (fewest tokens first). The previous
    // round-robin advanced its cursor even when a duplicate was rejected, quietly dropping
    // instances and starving whichever token the queue happened to lose.
    for (const surface of shuffled(rng, required)) {
      const tok = byId.get(surface);
      if (!tok) continue;
      let best: Draft | null = null;
      let bestLoad = Infinity;
      for (const c of shuffled(rng, rest)) {
        if (c.tokens.length >= capacity(c)) continue;
        if (c.tokens.some((t) => t.surface === surface)) continue;
        if (c.tokens.length < bestLoad) {
          bestLoad = c.tokens.length;
          best = c;
        }
      }
      if (best) best.tokens.push(tok);
    }

    // Top-up: capacity being sufficient in TOTAL does not mean each token can find `reps`
    // DISTINCT hosts — single-capacity cells fill up with other tokens and the last
    // instance silently finds no home. Mint a dedicated cell for whatever is still short,
    // which makes the floor arithmetic rather than luck.
    for (const t of trainable) {
      const want = FLOOR_TOKENS.includes(t.surface) ? TOKEN_CELL_REPS : 1;
      let have = rest.filter((c) => c.tokens.some((x) => x.surface === t.surface)).length;
      while (have < want) {
        const g = grow();
        g.cardinality = "single";
        g.tokens = [t];
        rest.push(g);
        have++;
      }
    }

    for (const c of rest) {
      if (c.tokens.length === 0) c.tokens.push(pick(rng, trainable.length > 0 ? trainable : pool));
    }

    for (const cell of cells) {
      const chosen = cell.tokens;
      if (chosen.length === 0) continue;
      // Magnitude is DERIVED from the token, never asserted over it.
      const top = chosen.reduce((a, b) => (a.rupiah >= b.rupiah ? a : b));
      const m = magnitudeOf(top.rupiah);
      if (m) cell.magnitude = m;
      cell.cardinality = chosen.length === 1 ? "single" : chosen.length === 2 ? "dua" : "tiga";
      relink(cell);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — deficit-greedy marginal repair
// ─────────────────────────────────────────────────────────────────────────────

/** Options that relink() would immediately overwrite are not real options. */
function feasibleOpts(d: Draft, axis: AxisName): readonly string[] {
  const opts = allowedFor(specOf(d.aspect), axis);
  if (axis !== "cardinality") return opts;
  if (d.direction === "mixed") {
    const ok = opts.filter((o) => ENTRY_COUNT[o as Cardinality] >= 2);
    return ok.length > 0 ? ok : opts;
  }
  if (d.direction === "in") {
    const ok = opts.filter((o) => {
      const n = ENTRY_COUNT[o as Cardinality];
      return n >= 1 && n <= 2;
    });
    return ok.length > 0 ? ok : opts;
  }
  if (d.direction !== "non_tx") {
    const ok = opts.filter((o) => o !== "zero");
    return ok.length > 0 ? ok : opts;
  }
  return opts;
}

/**
 * Fill the residual need on one axis using only the cells whose aspect leaves it free.
 *
 * Scarcest-value-first, not cell-first. A plain per-cell greedy ("each cell takes whatever
 * it needs most") loses every race for a value that only a few aspects can host: `mixed`
 * and `banyak` got assigned to whichever cell happened to come up in the shuffle, and by
 * the time their need dominated, the cells able to host them were already spent. Choosing
 * the value with the highest need-per-available-host, then placing it in the most
 * constrained host, is the standard fix and lands these within noise of target.
 */
function repairAxis(
  rng: Rng,
  drafts: Draft[],
  axis: AxisName,
  target: Readonly<Record<string, number>>,
  filter: (d: Draft) => boolean = () => true,
): void {
  const scope = drafts.filter(filter);
  if (scope.length === 0) return;

  const free: Draft[] = [];
  const pinnedCount: Record<string, number> = {};
  for (const d of scope) {
    if (varies(specOf(d.aspect), axis)) free.push(d);
    else pinnedCount[getAxis(d, axis)] = (pinnedCount[getAxis(d, axis)] ?? 0) + 1;
  }
  if (free.length === 0) return;

  const need: Record<string, number> = {};
  for (const [value, share] of Object.entries(target)) {
    need[value] = Math.max(0, share * scope.length - (pinnedCount[value] ?? 0));
  }
  const sumNeed = Object.values(need).reduce((a, b) => a + b, 0);
  if (sumNeed > 0) {
    for (const k of Object.keys(need)) {
      need[k] = (need[k] ?? 0) * (free.length / sumNeed);
    }
  }

  const pending = new Set(shuffled(rng, free));
  while (pending.size > 0) {
    const supply: Record<string, number> = {};
    for (const d of pending) {
      for (const o of feasibleOpts(d, axis)) supply[o] = (supply[o] ?? 0) + 1;
    }

    let bestValue: string | null = null;
    let bestUrgency = 0;
    for (const [value, n] of Object.entries(need)) {
      const s = supply[value] ?? 0;
      if (n <= 0 || s === 0) continue;
      const urgency = n / s;
      if (urgency > bestUrgency) {
        bestUrgency = urgency;
        bestValue = value;
      }
    }
    if (bestValue === null) {
      for (const d of pending) relink(d);
      break;
    }

    let host: Draft | null = null;
    let hostOpts = Infinity;
    for (const d of pending) {
      const opts = feasibleOpts(d, axis);
      if (!opts.includes(bestValue)) continue;
      if (opts.length < hostOpts) {
        hostOpts = opts.length;
        host = d;
      }
    }
    if (host === null) {
      need[bestValue] = 0;
      continue;
    }
    setAxis(host, axis, bestValue);
    relink(host);
    need[bestValue] = (need[bestValue] ?? 0) - 1;
    pending.delete(host);
  }
}

function repairMarginals(rng: Rng, drafts: Draft[]): void {
  // Two rounds: relink() can undo a choice (mixed forcing cardinality up, non_tx forcing
  // dateHint), so a single pass leaves residue on the downstream axes.
  for (let round = 0; round < 2; round++) {
    repairAxis(rng, drafts, "direction", TARGETS.direction);
    // "zero" is owned by the direction axis via relink — repairing it here too would have
    // the two axes fight. Transactional cells get the target renormalised over 1+ entries.
    const txCard = { single: 0.5 / 0.88, dua: 0.2 / 0.88, tiga: 0.11 / 0.88, banyak: 0.07 / 0.88 };
    repairAxis(rng, drafts, "cardinality", txCard, (d) => d.direction !== "non_tx");
    // Magnitude is undefined for amount-less cells; spending budget on them would skew the
    // realized marginal against cells that actually carry a number.
    repairAxis(rng, drafts, "magnitude", TARGETS.magnitude, (d) => d.hasNominal);
    repairAxis(rng, drafts, "dateHint", TARGETS.dateHint);
    repairAxis(rng, drafts, "correction", TARGETS.correction);
    repairAxis(rng, drafts, "register", TARGETS.register);
    repairAxis(
      rng, drafts, "registerIntensity", TARGETS.registerIntensity,
      (d) => d.register !== "baku",
    );
    repairAxis(rng, drafts, "noise", TARGETS.noise);
    repairAxis(rng, drafts, "rail", TARGETS.rail);
    void round;
  }
  for (const d of drafts) relink(d);
}

// ─────────────────────────────────────────────────────────────────────────────
// Finalise — everything derived (vendors, nilai, invariants) is computed AFTER repair,
// because repair rewrites the axes those are derived from.
// ─────────────────────────────────────────────────────────────────────────────

const CARD_RANGE: Readonly<Record<Cardinality, readonly [number, number]>> = {
  zero: [0, 0], single: [1, 1], dua: [2, 2], tiga: [3, 3], banyak: [4, 6],
};

function entryCountFor(rng: Rng, c: Cardinality): number {
  const [lo, hi] = CARD_RANGE[c];
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** Aspects whose label is one entry regardless of how many amounts the text mentions. */
const QTY_ASPECTS: readonly Aspect[] = ["ord_qty_simple", "adv_qty_x_unit"];
const SINGLE_NILAI_ASPECTS: readonly Aspect[] = [
  "adv_split_share", "adv_discount_net", "adv_fuzzy_amount", "adv_phantom_income_bait",
];

const QTY_KEYWORDS = ["bungkus", "porsi", "orang", "biji", "pcs", "botol", "lusin", "gelas"];

function pickVendors(rng: Rng, d: Draft, want: number): string[] {
  const s = specOf(d.aspect);
  const band = bandOf(d.magnitude);
  let cands = s.vendorPool
    .map((id) => VENDOR_BY_ID.get(id))
    .filter((v): v is Vendor => v !== undefined)
    .filter((v) => bandsOverlap([v.typicalRange[0], v.typicalRange[1] + 1], band))
    .filter((v) => v.registers.includes(d.register));
  if (d.rail !== "none") {
    const railed = cands.filter((v) => v.defaultRails.includes(d.rail));
    if (railed.length > 0) cands = railed;
  }
  if (cands.length === 0 || want === 0) return [];
  return shuffled(rng, cands).slice(0, Math.min(want, cands.length)).map((v) => v.id);
}

function numericNilai(rng: Rng, d: Draft, count: number): TokenValue[] {
  const notation = d.notation[0] ?? "polos";
  const pool = amountsFor(d.magnitude, notation);
  if (pool.length === 0) return [];
  const chosen = shuffled(rng, pool).slice(0, Math.min(count, pool.length));
  // The band must contain the top amount — that is what makes `magnitude` a real claim.
  if (!chosen.some((v) => inBand(v, d.magnitude))) {
    const anchor = pool[Math.floor(rng() * pool.length)];
    if (anchor !== undefined) chosen[0] = anchor;
  }
  return chosen.map((value) => {
    const surface = renderSurface(value, notation);
    if (surface === null) throw new Error(`cannot render ${value} as ${notation}`);
    return { surface, rupiah: value, attested: "kbbi" as const };
  });
}

function pickDateSurface(rng: Rng, d: Draft): string | null {
  // The only place a `lusa` surface can appear — and it is always a non-transaction.
  if (d.aspect === "ntx_future_intent") return pick(rng, FUTURE_SURFACES);
  if (d.dateHint === "tidak_jelas") return null;
  const pool = DATE_SURFACES[d.dateHint];
  return pool.length > 0 ? pick(rng, pool) : null;
}

/** A shadow value in the same band that is not already asserted present. */
function shadowNear(rng: Rng, d: Draft, taken: readonly number[]): number {
  const pool = AMOUNT_LADDER[d.magnitude].filter((v) => !taken.includes(v));
  return pool.length > 0 ? pick(rng, pool) : (taken[0] ?? 10_000) * 2;
}

function buildInvariants(rng: Rng, d: Draft, nilai: TokenValue[], vendors: string[]): Invariant[] {
  if (d.direction === "non_tx") return [{ kind: "non_transaction" }];

  const inv: Invariant[] = [];
  const values = nilai.map((t) => t.rupiah);

  if (QTY_ASPECTS.includes(d.aspect)) {
    const unit = values[0] ?? 10_000;
    const count = 2 + Math.floor(rng() * 4);
    // No entry_count / direction_count: merged (1×total) and split (N×unit) are BOTH correct
    // labels, so asserting either would punish a right answer.
    inv.push({ kind: "qty_merge_ok", keyword: pick(rng, QTY_KEYWORDS), unit, count });
    inv.push({ kind: "sum_out", total: unit * count });
  } else {
    const n = nilai.length;
    inv.push({ kind: "entry_count", n });
    // A mixed message is one income plus N expenses ("gaji masuk, terus bayar kos, listrik,
    // pulsa") — two separate incomes in a single chat message is rare. Splitting n evenly
    // both invented that shape and pushed entry-level pemasukan past its target.
    const masuk = d.direction === "in" ? n : d.direction === "mixed" ? 1 : 0;
    inv.push({ kind: "direction_count", masuk, keluar: n - masuk });
    for (const v of values) inv.push({ kind: "amount_present", rupiah: v });
  }

  inv.push({ kind: "date_hint", hint: d.dateHint, appliesTo: "all" });

  switch (d.correction) {
    case "amount":
      inv.push({
        kind: "amount_absent",
        rupiah: shadowNear(rng, d, values),
        why: "nilai sebelum dikoreksi user",
      });
      break;
    case "magnitude":
      // "7,5 ... eh 75rb bukan 7,5 juta" — the discarded reading is 100× the real one.
      inv.push({
        kind: "amount_absent",
        rupiah: (values[0] ?? 75_000) * 100,
        why: "pembacaan magnitude yang dikoreksi user",
      });
      break;
    case "cancel":
      inv.push({
        kind: "amount_absent",
        rupiah: shadowNear(rng, d, values),
        why: "item dibatalkan — disebut tapi tidak jadi",
      });
      break;
    case "none":
    case "item":
    case "direction":
      break;
  }

  switch (d.aspect) {
    case "adv_price_copy_bait":
    case "ord_rekap_list":
      if (values.length >= 2) inv.push({ kind: "no_price_copy", distinctAmounts: values });
      break;
    case "adv_split_share": {
      const share = values[0] ?? 30_000;
      inv.push({
        kind: "amount_absent",
        rupiah: share * (3 + Math.floor(rng() * 3)),
        why: "total rombongan — hanya bagian user yang dicatat",
      });
      break;
    }
    case "adv_discount_net": {
      const net = values[0] ?? 50_000;
      inv.push({
        kind: "amount_absent",
        rupiah: Math.round((net * (1 + (2 + Math.floor(rng() * 3)) / 10)) / 500) * 500,
        why: "harga sebelum diskon",
      });
      break;
    }
    case "adv_fuzzy_amount":
      inv.push({ kind: "ambigu_flagged", atLeast: 1 });
      break;
    case "adv_past_plus_future":
      inv.push({
        kind: "amount_absent",
        rupiah: shadowNear(rng, d, values),
        why: "rencana belum terjadi — bukan transaksi",
      });
      break;
    case "adv_phantom_income_bait":
      inv.push({
        kind: "amount_absent",
        rupiah: shadowNear(rng, d, values) * 10,
        why: "gaji disebut tapi belum cair — bukan pemasukan",
      });
      break;
    case "ord_vendor_named": {
      const v0 = vendors[0];
      const vendor = v0 === undefined ? undefined : VENDOR_BY_ID.get(v0);
      if (vendor) inv.push({ kind: "desc_contains", anyOf: vendor.surfaces, entryIdx: 0 });
      break;
    }
    default:
      break;
  }

  // gocap is contested (etymology 50 vs modern 50rb) — the honest label flags it rather
  // than silently picking a side.
  if (nilai.some((t) => CONTESTED_SURFACES.has(t.surface))) {
    inv.push({ kind: "ambigu_flagged", atLeast: 1 });
  }
  return inv;
}

function finalize(rng: Rng, d: Draft): Cell {
  const s = specOf(d.aspect);
  let nilai: TokenValue[];

  if (d.tokens.length > 0) {
    nilai = d.tokens;
  } else if (!d.hasNominal) {
    nilai = [];
  } else if (isTokenNotation(d.notation[0] ?? "polos")) {
    // A token-notation cell with no token means assignTokens missed it. numericNilai cannot
    // render slang/spelled/regional surfaces, so without this the cell would silently reach
    // assertCellCoherent with no nilai at all.
    nilai = [pick(rng, TOKEN_POOL_FOR[d.notation[0] ?? ""] ?? SLANG_TOKENS)];
  } else if (QTY_ASPECTS.includes(d.aspect) || SINGLE_NILAI_ASPECTS.includes(d.aspect)) {
    nilai = numericNilai(rng, d, 1);
  } else if (d.aspect === "adv_fee_plus_principal") {
    // Principal and fee genuinely live in different bands — that IS the aspect.
    const principal = numericNilai(rng, d, 1);
    const feeBand: Draft = { ...d, magnitude: d.magnitude === "kecil" ? "receh" : "kecil" };
    nilai = [...principal, ...numericNilai(rng, feeBand, 1)];
  } else if (d.direction === "non_tx") {
    nilai = numericNilai(rng, d, 1);
  } else {
    nilai = numericNilai(rng, d, entryCountFor(rng, d.cardinality));
  }

  if (d.direction !== "non_tx" && nilai.length === 0) {
    nilai = numericNilai(rng, d, 1);
  }

  // Cardinality must describe what was actually built, not what was planned.
  if (d.direction !== "non_tx" && !QTY_ASPECTS.includes(d.aspect) && !SINGLE_NILAI_ASPECTS.includes(d.aspect)) {
    const n = nilai.length;
    const card: Cardinality =
      n <= 1 ? "single" : n === 2 ? "dua" : n === 3 ? "tiga" : "banyak";
    if (CARD_RANGE[d.cardinality][0] !== n || CARD_RANGE[d.cardinality][1] !== n) {
      if (!(d.cardinality === "banyak" && n >= 4 && n <= 6)) d.cardinality = card;
    }
  }
  if (QTY_ASPECTS.includes(d.aspect) || SINGLE_NILAI_ASPECTS.includes(d.aspect)) {
    d.cardinality = "single";
  }
  if (d.aspect === "adv_fee_plus_principal" && nilai.length === 2) d.cardinality = "dua";

  // Magnitude is derived from the amounts that were actually chosen.
  const top = nilai.reduce((a, b) => (a && a.rupiah >= b.rupiah ? a : b), nilai[0]);
  if (top) {
    const m = magnitudeOf(top.rupiah);
    if (m) d.magnitude = m;
  }

  const wantVendors = d.aspect === "ord_rekap_list" ? 3 : nilai.length >= 2 ? 2 : 1;
  const vendors = pickVendors(rng, d, s.vendorPool.length === 0 ? 0 : wantVendors);

  return {
    id: d.id,
    aspect: d.aspect,
    tier: d.tier,
    direction: d.direction,
    cardinality: d.cardinality,
    notation: d.notation,
    magnitude: d.magnitude,
    dateHint: d.dateHint,
    dateSurface: pickDateSurface(rng, d),
    correction: d.correction,
    nilai,
    invariants: buildInvariants(rng, d, nilai, vendors),
    register: d.register,
    registerIntensity: d.registerIntensity,
    noise: d.noise,
    rail: d.rail,
    vendors,
    split: "train",
    rows: ROWS_PER_CELL,
    benchAnalogue: s.benchAnalogue,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — coherence. These throw rather than warn: an incoherent cell produces a row
// whose gold label cannot be right, and a wrong gold label is worse than a missing one.
// ─────────────────────────────────────────────────────────────────────────────

/** Below this, a number is not a plausible Rupiah amount. Matches rupiah.ts's money floor. */
const MONEY_FLOOR = 100;

export function assertCellCoherent(cell: Cell): void {
  const fail = (msg: string): never => {
    throw new Error(`incoherent cell ${cell.id} (${cell.aspect}): ${msg}`);
  };

  if (cell.dateHint === "lusa") {
    fail("tanggal_hint=lusa is unreachable by product decision (lusa = future ⇒ bukan_transaksi)");
  }
  if (cell.dateSurface !== null && cell.direction !== "non_tx") {
    if (/\blusa\b/i.test(cell.dateSurface)) fail("lusa surface on a transactional cell");
  }

  if (cell.direction === "non_tx") {
    if (cell.cardinality !== "zero") fail(`non_tx must be cardinality zero, got ${cell.cardinality}`);
    if (cell.invariants.length !== 1 || cell.invariants[0]?.kind !== "non_transaction") {
      fail("non_tx cells must assert exactly [non_transaction]");
    }
  } else {
    if (cell.cardinality === "zero") fail("transactional cell with cardinality zero");
    if (cell.nilai.length === 0) fail("transactional cell with no nilai");
    const hasCount = cell.invariants.some((i) => i.kind === "entry_count" || i.kind === "qty_merge_ok");
    if (!hasCount) fail("transactional cell asserts neither entry_count nor qty_merge_ok");
    // dateSurface ⟺ a stated date. Non_tx is exempt: its surface is a FUTURE trigger
    // ("besok"), which is precisely why there is no entry to hang a hint on.
    const stated = cell.dateHint !== "tidak_jelas";
    if (stated !== (cell.dateSurface !== null)) {
      fail(`dateSurface/dateHint mismatch: hint=${cell.dateHint} surface=${String(cell.dateSurface)}`);
    }
  }

  for (const t of cell.nilai) {
    if (t.rupiah < MONEY_FLOOR) fail(`nilai ${t.surface}=${t.rupiah} below the money floor`);
    if (!t.surface.trim()) fail("nilai with empty surface");
  }

  if (cell.nilai.length > 0) {
    // The band is defined by the TOP amount. Multi-item baskets and fee+principal genuinely
    // span bands, so requiring every nilai in one band would forbid realistic messages;
    // requiring the top one keeps the guard that catches "warung 2jt".
    const top = cell.nilai.reduce((a, b) => (a.rupiah >= b.rupiah ? a : b));
    if (!inBand(top.rupiah, cell.magnitude)) {
      fail(`top nilai ${top.rupiah} outside magnitude band ${cell.magnitude}`);
    }
  }

  const entryCount = cell.invariants.find((i) => i.kind === "entry_count");
  if (entryCount?.kind === "entry_count") {
    if (entryCount.n !== cell.nilai.length) {
      fail(`entry_count ${entryCount.n} != |nilai| ${cell.nilai.length}`);
    }
    const [lo, hi] = CARD_RANGE[cell.cardinality];
    if (entryCount.n < lo || entryCount.n > hi) {
      fail(`entry_count ${entryCount.n} inconsistent with cardinality ${cell.cardinality}`);
    }
  }

  const dc = cell.invariants.find((i) => i.kind === "direction_count");
  if (dc?.kind === "direction_count") {
    const { masuk, keluar } = dc;
    if (cell.direction === "out" && masuk !== 0) fail("direction=out but masuk>0");
    if (cell.direction === "in" && keluar !== 0) fail("direction=in but keluar>0");
    if (cell.direction === "mixed" && (masuk < 1 || keluar < 1)) fail("direction=mixed needs both");
    if (masuk + keluar !== cell.nilai.length) fail("direction_count does not sum to |nilai|");
  }

  const present = new Set(
    cell.invariants.flatMap((i) => (i.kind === "amount_present" ? [i.rupiah] : [])),
  );
  for (const i of cell.invariants) {
    if (i.kind === "amount_absent" && present.has(i.rupiah)) {
      fail(`amount ${i.rupiah} asserted both present and absent`);
    }
  }

  const band = bandOf(cell.magnitude);
  for (const id of cell.vendors) {
    const v = VENDOR_BY_ID.get(id);
    if (!v) fail(`unknown vendor ${id}`);
    else if (!bandsOverlap([v.typicalRange[0], v.typicalRange[1] + 1], band)) {
      fail(`vendor ${id} range ${v.typicalRange.join("-")} cannot reach ${cell.magnitude}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Holdouts
// ─────────────────────────────────────────────────────────────────────────────

const EVAL_IID_SHARE = 0.08;
const EVAL_COMPOSITIONAL_SHARE = 0.05;

function comboSignature(c: Cell): string {
  return [c.register, c.noise, c.notation[0] ?? "polos", c.direction, c.rail].join("|");
}

/**
 * eval_iid is stratified PER ASPECT, never whole-aspect. A whole-aspect holdout would mean
 * training never sees e.g. slang at all, so the eval would measure "can you do a thing you
 * were never taught" rather than generalisation.
 */
export function markHoldouts(cells: Cell[], seed: number): void {
  const rng = mulberry32(seed ^ 0x5eed);
  for (const c of cells) c.split = "train";

  // Token holdout: train on ceban/goceng/gopek/cepek/goban, hold out noceng/seceng/cetiao.
  // If the student gets noceng=2000 unseen, it learned no(2)×ceng(1000) — the morphology —
  // rather than a lookup table.
  for (const c of cells) {
    if (c.nilai.some((t) => HOLDOUT_TOKENS.has(t.surface))) c.split = "eval_compositional";
  }

  const byAspect = new Map<Aspect, Cell[]>();
  for (const c of cells) {
    const list = byAspect.get(c.aspect) ?? [];
    list.push(c);
    byAspect.set(c.aspect, list);
  }

  /**
   * A cell is safe to hold out only if every floor token it carries survives in ≥2 OTHER
   * train cells. Checked up front rather than repaired afterwards: the earlier version
   * reverted starved cells at the end, and the "≥1 eval per aspect" pass then quietly
   * undid the revert, leaving tokens below the floor on some seeds.
   */
  const trainHosts = (surface: string): number =>
    cells.filter((c) => c.split === "train" && c.nilai.some((t) => t.surface === surface)).length;
  const safeToHoldOut = (c: Cell): boolean =>
    !c.nilai.some((t) => FLOOR_TOKENS.includes(t.surface) && trainHosts(t.surface) <= 2);

  for (const [, list] of byAspect) {
    const trainable = list.filter((c) => c.split === "train");
    const want = Math.max(1, Math.round(list.length * EVAL_IID_SHARE));
    const alreadyEval = list.length - trainable.length;
    const need = Math.max(0, Math.min(want - alreadyEval, trainable.length - 1));
    let taken = 0;
    for (const c of shuffled(rng, trainable)) {
      if (taken >= need) break;
      if (!safeToHoldOut(c)) continue;
      c.split = "eval_iid";
      taken++;
    }
  }

  // eval_compositional: novel AXIS COMBINATIONS whose individual values all appear in train.
  const sigCount = new Map<string, number>();
  for (const c of cells) sigCount.set(comboSignature(c), (sigCount.get(comboSignature(c)) ?? 0) + 1);

  const valueTrainCount = new Map<string, number>();
  const bump = (c: Cell) => {
    for (const v of [c.register, c.noise, c.notation[0] ?? "polos", c.direction, c.rail]) {
      valueTrainCount.set(v, (valueTrainCount.get(v) ?? 0) + 1);
    }
  };
  for (const c of cells) if (c.split === "train") bump(c);

  const wantCompositional = Math.round(cells.length * EVAL_COMPOSITIONAL_SHARE);
  let taken = cells.filter((c) => c.split === "eval_compositional").length;
  for (const c of shuffled(rng, cells)) {
    if (taken >= wantCompositional) break;
    if (c.split !== "train") continue;
    if (!safeToHoldOut(c)) continue;
    if ((sigCount.get(comboSignature(c)) ?? 0) !== 1) continue;
    const trainMates = (byAspect.get(c.aspect) ?? []).filter((x) => x.split === "train").length;
    if (trainMates <= 1) continue;
    // Every individual axis value must survive in train, or this stops being compositional
    // and becomes a plain unseen-value test.
    const vals = [c.register, c.noise, c.notation[0] ?? "polos", c.direction, c.rail];
    if (vals.some((v) => (valueTrainCount.get(v) ?? 0) <= 1)) continue;
    c.split = "eval_compositional";
    for (const v of vals) valueTrainCount.set(v, (valueTrainCount.get(v) ?? 0) - 1);
    taken++;
  }

  // Backstop: revert anything that still leaves a floor token short of 2 train cells.
  for (const surface of FLOOR_TOKENS) {
    const has = (c: Cell) => c.nilai.some((t) => t.surface === surface);
    let inTrain = trainHosts(surface);
    if (inTrain >= 2) continue;
    for (const c of cells) {
      if (inTrain >= 2) break;
      if (c.split === "train" || !has(c)) continue;
      if (c.nilai.some((t) => HOLDOUT_TOKENS.has(t.surface))) continue;
      c.split = "train";
      inTrain++;
    }
  }

  // Every aspect keeps ≥1 train and ≥1 eval cell — a whole-aspect holdout in either
  // direction makes the aspect untrainable or unmeasurable.
  for (const [, list] of byAspect) {
    if (!list.some((c) => c.split === "train")) {
      const victim = list.find((c) => !c.nilai.some((t) => HOLDOUT_TOKENS.has(t.surface)));
      if (victim) victim.split = "train";
    }
    if (!list.some((c) => c.split !== "train") && list.length > 1) {
      const victim = shuffled(rng, list).find(
        (c) =>
          c.split === "train" &&
          !c.nilai.some((t) => HOLDOUT_TOKENS.has(t.surface)) &&
          safeToHoldOut(c),
      );
      if (victim && list.filter((x) => x.split === "train").length > 1) victim.split = "eval_iid";
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Deterministic for a given (seed, totalRows).
 *
 * Sizing: the design point is ~2000 rows ≈ 333 cells × 6. Below ~1000 rows the unconditional
 * coverage floor (40 aspects × 2 cells = 80 cells ≈ 480 rows) consumes the whole budget —
 * the adversarial tier alone wants 10 aspects × 2 cells inside a 10% slice — so tier budgets
 * and the cardinality/direction marginals cannot all be honoured and drift past 3pp. Coverage
 * is the constraint that wins there, deliberately: an aspect with no cells is unrecoverable,
 * a skewed marginal is not. At ≥1000 rows every marginal lands inside ~3pp.
 */
export function buildTaxonomy(seed: number, totalRows = 2000): Cell[] {
  const rng = mulberry32(seed);
  const targetCells = Math.max(ASPECT_SPECS.length * MIN_CELLS_PER_ASPECT, Math.round(totalRows / ROWS_PER_CELL));

  const drafts = assignTokens(rng, draftCells(rng, targetCells));
  repairMarginals(rng, drafts);
  const cells = drafts.map((d) => finalize(rng, d));
  for (const c of cells) assertCellCoherent(c);
  markHoldouts(cells, seed);
  return cells;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats — the generator's manifest reports these, so a drifted distribution is visible in
// the artefact rather than only in the training curve.
// ─────────────────────────────────────────────────────────────────────────────

export interface MarginalReport {
  realized: Record<string, number>;
  target: Record<string, number>;
  maxAbsDeltaPp: number;
  /** Cells the marginal is computed over — not always the whole taxonomy. */
  scope: number;
  note?: string;
}

export interface TaxonomyStats {
  cells: number;
  rows: number;
  rowsPerCell: number;
  marginals: Record<string, MarginalReport>;
  entryLevel: { masuk: number; keluar: number; pemasukanShare: number; target: number; deltaPp: number };
  tiers: Record<string, { cells: number; realizedShare: number; target: number; deltaPp: number }>;
  perAspect: Record<string, { cells: number; rows: number; train: number; eval_iid: number; eval_compositional: number }>;
  splits: Record<Split, number>;
  coverage: {
    aspectsTotal: number;
    aspectsBelowFloor: string[];
    aspectsWithoutTrain: string[];
    aspectsWithoutEval: string[];
    tokensBelowFloor: string[];
    holdoutTokensLeakedToTrain: string[];
    tokenTrainCounts: Record<string, number>;
  };
}

function share(counts: Record<string, number>, total: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(counts)) out[k] = total > 0 ? v / total : 0;
  return out;
}

function marginal(
  cells: readonly Cell[],
  target: Readonly<Record<string, number>>,
  get: (c: Cell) => string,
  filter: (c: Cell) => boolean = () => true,
  note?: string,
): MarginalReport {
  const scope = cells.filter(filter);
  const counts: Record<string, number> = {};
  for (const k of Object.keys(target)) counts[k] = 0;
  for (const c of scope) counts[get(c)] = (counts[get(c)] ?? 0) + 1;
  const realized = share(counts, scope.length);
  let maxAbsDeltaPp = 0;
  for (const k of Object.keys(target)) {
    maxAbsDeltaPp = Math.max(maxAbsDeltaPp, Math.abs((realized[k] ?? 0) - (target[k] ?? 0)) * 100);
  }
  return { realized, target: { ...target }, maxAbsDeltaPp, scope: scope.length, ...(note ? { note } : {}) };
}

export function taxonomyStats(cells: Cell[]): TaxonomyStats {
  const rows = cells.reduce((n, c) => n + c.rows, 0);

  // Entry-level direction, weighted by rows. qty cells carry no direction_count because
  // both the merged and split labels are correct; their canonical form is one keluar entry.
  let masuk = 0;
  let keluar = 0;
  for (const c of cells) {
    const dc = c.invariants.find((i) => i.kind === "direction_count");
    if (dc?.kind === "direction_count") {
      masuk += dc.masuk * c.rows;
      keluar += dc.keluar * c.rows;
    } else if (c.invariants.some((i) => i.kind === "qty_merge_ok")) {
      keluar += c.rows;
    }
  }
  const entryTotal = masuk + keluar;
  const pemasukanShare = entryTotal > 0 ? masuk / entryTotal : 0;

  const tiers: TaxonomyStats["tiers"] = {};
  for (const t of Object.keys(TIER_ROW_BUDGET) as Tier[]) {
    const n = cells.filter((c) => c.tier === t).length;
    const realizedShare = cells.length > 0 ? n / cells.length : 0;
    tiers[t] = {
      cells: n,
      realizedShare,
      target: TIER_ROW_BUDGET[t],
      deltaPp: (realizedShare - TIER_ROW_BUDGET[t]) * 100,
    };
  }

  const perAspect: TaxonomyStats["perAspect"] = {};
  for (const s of ASPECT_SPECS) {
    const list = cells.filter((c) => c.aspect === s.aspect);
    perAspect[s.aspect] = {
      cells: list.length,
      rows: list.reduce((n, c) => n + c.rows, 0),
      train: list.filter((c) => c.split === "train").length,
      eval_iid: list.filter((c) => c.split === "eval_iid").length,
      eval_compositional: list.filter((c) => c.split === "eval_compositional").length,
    };
  }

  const tokenTrainCounts: Record<string, number> = {};
  for (const t of LEXICAL_TOKENS) {
    tokenTrainCounts[t.surface] = cells.filter(
      (c) => c.split === "train" && c.nilai.some((n) => n.surface === t.surface),
    ).length;
  }

  const splits: Record<Split, number> = { train: 0, eval_iid: 0, eval_compositional: 0 };
  for (const c of cells) splits[c.split]++;

  return {
    cells: cells.length,
    rows,
    rowsPerCell: ROWS_PER_CELL,
    marginals: {
      direction: marginal(cells, TARGETS.direction, (c) => c.direction),
      cardinality: marginal(cells, TARGETS.cardinality, (c) => c.cardinality),
      magnitude: marginal(
        cells, TARGETS.magnitude, (c) => c.magnitude, (c) => c.nilai.length > 0,
        "amount-bearing cells only — magnitude is undefined without a nominal",
      ),
      dateHint: marginal(cells, TARGETS.dateHint, (c) => c.dateHint),
      noise: marginal(cells, TARGETS.noise, (c) => c.noise),
      register: marginal(cells, TARGETS.register, (c) => c.register),
      registerIntensity: marginal(
        cells, TARGETS.registerIntensity, (c) => c.registerIntensity,
        (c) => c.register !== "baku", "non-baku cells only",
      ),
      rail: marginal(cells, TARGETS.rail, (c) => c.rail),
      correction: marginal(cells, TARGETS.correction, (c) => c.correction),
    },
    entryLevel: {
      masuk,
      keluar,
      pemasukanShare,
      target: TARGET_PEMASUKAN_ENTRY_SHARE,
      deltaPp: (pemasukanShare - TARGET_PEMASUKAN_ENTRY_SHARE) * 100,
    },
    tiers,
    perAspect,
    splits,
    coverage: {
      aspectsTotal: ASPECT_SPECS.length,
      aspectsBelowFloor: ASPECT_SPECS.filter(
        (s) => (perAspect[s.aspect]?.cells ?? 0) < MIN_CELLS_PER_ASPECT,
      ).map((s) => s.aspect),
      aspectsWithoutTrain: ASPECT_SPECS.filter((s) => (perAspect[s.aspect]?.train ?? 0) < 1).map((s) => s.aspect),
      aspectsWithoutEval: ASPECT_SPECS.filter(
        (s) => ((perAspect[s.aspect]?.eval_iid ?? 0) + (perAspect[s.aspect]?.eval_compositional ?? 0)) < 1,
      ).map((s) => s.aspect),
      tokensBelowFloor: FLOOR_TOKENS.filter((t) => (tokenTrainCounts[t] ?? 0) < 2),
      holdoutTokensLeakedToTrain: [...HOLDOUT_TOKENS].filter((t) => (tokenTrainCounts[t] ?? 0) > 0),
      tokenTrainCounts,
    },
  };
}
