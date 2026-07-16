/**
 * Cell → RowSpec: turn a taxonomy cell into a concrete answer key, BEFORE the teacher speaks.
 *
 * This is the inversion that makes the pipeline trustworthy. The old generator asked the
 * teacher for {text, label} in one call, so the teacher authored both the question and its
 * own answer key and nothing could contradict it. Here a seeded RNG draws the answer first;
 * the teacher only writes prose; a blind parse must then rediscover the answer. The spec is
 * a second opinion whose errors cannot correlate with the teacher's, because it is not a
 * language model — which is why the agreement check costs zero GPU.
 */

import type { Cell, Invariant, TokenValue } from "../../src/core/parse-taxonomy.ts";
import type { ExpectedEntry, LabelExpectation } from "./sft-validate.ts";

export type RowSpec = {
  planIndex: number;
  cell: Cell;
  /** Surfaces that must appear literally in the generated text. */
  surfaces: TokenValue[];
  /** Amounts the text must mention but the label must NOT book. */
  distractors: Array<{ rupiah: number; why: string }>;
  expectation: LabelExpectation;
  /** qty-split cells legitimately repeat identical entries. */
  allowDuplicateEntries: boolean;
  /** Set for qty cells: the message must state how many items, or the count is unguessable. */
  quantity: { keyword: string; unit: number; count: number } | null;
};

function inv<K extends Invariant["kind"]>(cell: Cell, kind: K): Extract<Invariant, { kind: K }>[] {
  return cell.invariants.filter((i): i is Extract<Invariant, { kind: K }> => i.kind === kind);
}

/**
 * Derive the acceptable label(s) from a cell's invariants.
 *
 * Two cases need care:
 *  - `direction_count` fixes how many entries flow each way but not WHICH amount is which,
 *    so we assign deterministically (income takes the first N amounts) and tell the teacher.
 *  - `qty_merge_ok` admits two correct readings (N × unit, or one merged total), so both
 *    become alternatives rather than forcing a coin-flip the teacher could lose fairly.
 */
export function cellToExpectation(cell: Cell): LabelExpectation {
  if (inv(cell, "non_transaction").length > 0) {
    return { nonTransaction: true, alternatives: [[]] };
  }

  const dateHints = inv(cell, "date_hint");
  const allHint = dateHints.find((d) => d.appliesTo === "all")?.hint;
  const absent = inv(cell, "amount_absent").map((a) => a.rupiah);
  const ambiguAtLeast = inv(cell, "ambigu_flagged")[0]?.atLeast ?? 0;

  const qty = inv(cell, "qty_merge_ok")[0];
  if (qty) {
    const split: ExpectedEntry[] = Array.from({ length: qty.count }, () => ({
      direction: "pengeluaran" as const,
      amount: qty.unit,
      ...(allHint ? { dateHint: allHint } : {}),
    }));
    const merged: ExpectedEntry[] = [
      {
        direction: "pengeluaran",
        amount: inv(cell, "sum_out")[0]?.total ?? qty.unit * qty.count,
        ...(allHint ? { dateHint: allHint } : {}),
      },
    ];
    return { nonTransaction: false, alternatives: [split, merged], absentAmounts: absent };
  }

  const amounts = inv(cell, "amount_present").map((a) => a.rupiah);
  const counts = inv(cell, "direction_count")[0];
  const masuk = counts?.masuk ?? (cell.direction === "in" ? amounts.length : 0);

  const entries: ExpectedEntry[] = amounts.map((amount, i) => ({
    direction: i < masuk ? ("pemasukan" as const) : ("pengeluaran" as const),
    amount,
    ...(allHint ? { dateHint: allHint } : {}),
    ...(i < ambiguAtLeast ? { ambigu: true } : {}),
  }));

  return { nonTransaction: false, alternatives: [entries], absentAmounts: absent };
}

export function cellToSpec(cell: Cell, planIndex: number): RowSpec {
  const expectation = cellToExpectation(cell);
  const distractors = inv(cell, "amount_absent").map((a) => ({ rupiah: a.rupiah, why: a.why }));
  const qty = inv(cell, "qty_merge_ok")[0] ?? null;
  return {
    planIndex,
    cell,
    surfaces: cell.nilai,
    distractors,
    expectation,
    allowDuplicateEntries: qty !== null,
    quantity: qty ? { keyword: qty.keyword, unit: qty.unit, count: qty.count } : null,
  };
}

/**
 * Amounts the TEXT must contain — derived from the ordered SURFACES, not from the booked
 * entries. The two differ on purpose: a non-transaction cell orders a nominal that must be
 * mentioned and NOT booked ("besok mau beli kulkas 3jt"), and a qty cell mentions its unit
 * price once while booking it N times. Deriving from booked entries would reject both.
 */
export function expectedTextAmounts(spec: RowSpec): number[] {
  const surfaces = spec.surfaces.map((s) => s.rupiah);
  return [...surfaces, ...spec.distractors.map((d) => d.rupiah)];
}

const REGISTER_HINTS: Record<string, string> = {
  baku: "bahasa Indonesia baku dan formal (saya, membeli, membayar)",
  jaksel_gaul: "gaul Jakarta Selatan (gue/gw, duit, banget, doang, aja) — sisipkan, jangan ubah angkanya",
  betawi: "Betawi (gue, aje, dah, nih, bang)",
  jawa: "campur Jawa (wis, tuku, duwit, piro, rek)",
  sunda: "campur Sunda (meuli, artos, atos, teu, mah, atuh)",
  medan: "Medan — PENTING: pajak=pasar, kereta=sepeda motor, motor=mobil, kedai, awak, kelen",
  minang: "campur Minang (pitih=uang, kadai=kedai, baa, lai)",
  makassar_timur: "Indonesia timur (partikel mi/ji/ki: 'sudah mi', 'berapa ki')",
  pesantren: "lingkungan pesantren (infaq, sedekah, syahriah, setoran wali, ustadz, santri)",
};

const NOISE_HINTS: Record<string, string> = {
  bersih: "tulis rapi, ejaan benar",
  wa_ringkas: "gaya WhatsApp singkat, tanpa kapital, banyak singkatan (td, sm, dr, yg)",
  voice_rambling: "hasil transkrip suara: bertele-tele, ada jeda '...', pengulangan, kata pengisi",
  typo_berat: "banyak typo dan singkatan ngawur, huruf tertukar",
  emoji_format: "pakai emoji dan format list/bullet ala WhatsApp",
};

const RAIL_HINTS: Record<string, string> = {
  none: "",
  tunai: "bayar tunai/cash",
  qris: "bayar pakai QRIS",
  ewallet: "pakai e-wallet (GoPay/OVO/Dana/ShopeePay)",
  transfer: "lewat transfer bank (BCA/BRI/Mandiri/BNI)",
  kartu: "pakai kartu debit/kredit",
  cod: "COD",
  emoney: "pakai e-money (e-Toll/Flazz/Brizzi)",
  pulsa: "potong pulsa",
};

/**
 * Prompt the teacher to write ONE message. It is never shown the JSON schema or the label —
 * only what the message must SAY. That keeps text generation and labeling independent.
 */
export function buildTextPrompt(spec: RowSpec): { system: string; user: string } {
  const c = spec.cell;
  const system = [
    "Kamu menulis SATU pesan chat keuangan berbahasa Indonesia yang realistis, seperti yang benar-benar diketik orang ke aplikasi pencatatan lewat WhatsApp.",
    "",
    "Aturan keras:",
    "- Keluarkan HANYA teks pesannya. Tanpa penjelasan, tanpa JSON, tanpa tanda kutip pembungkus.",
    "- WAJIB memuat setiap nominal yang diminta, PERSIS pada bentuk penulisan yang diberikan.",
    "- JANGAN menambahkan nominal rupiah lain apa pun di luar yang diminta.",
    "- Tulis seperti manusia yang sedang buru-buru, bukan seperti contoh buku teks.",
    "- Panjang wajar: satu baris, biasanya di bawah 20 kata (kecuali diminta bertele-tele).",
  ].join("\n");

  const lines: string[] = [];
  lines.push(`Tulis satu pesan yang menyatakan: ${aspectBrief(c.aspect)}`);
  lines.push("");
  if (spec.surfaces.length === 0) {
    // A dangling "nominal wajib:" header with nothing under it invites an invented amount,
    // which the bijection guard would then reject — burning the cell for our own bad prompt.
    lines.push("JANGAN sebut nominal rupiah apa pun. Pesan ini memang tidak memuat angka uang.");
  } else {
    lines.push("Nominal yang WAJIB muncul persis seperti ini:");
    for (const n of spec.surfaces) lines.push(`  - "${n.surface}"  (artinya Rp${n.rupiah.toLocaleString("id-ID")})`);
  }

  if (spec.quantity) {
    // Without this the message says "beli 1 barang 5rb" while the spec expects 5 entries,
    // and the cell fails every attempt for a reason the teacher was never told.
    lines.push(
      "",
      `Sebutkan JUMLAH ITEMNYA dengan jelas: ${spec.quantity.count} ${spec.quantity.keyword}, ` +
        `masing-masing seharga "${spec.surfaces[0]?.surface ?? spec.quantity.unit}". ` +
        `Jangan tulis totalnya — cukup jumlah item dan harga satuannya.`,
    );
  }

  if (spec.distractors.length > 0) {
    lines.push("");
    lines.push("Nominal berikut juga harus disebut, TAPI pesan harus jelas bahwa nominal ini TIDAK jadi dicatat:");
    for (const d of spec.distractors) {
      lines.push(`  - Rp${d.rupiah.toLocaleString("id-ID")} — ${d.why}`);
    }
  }

  if (c.dateSurface) {
    lines.push("");
    lines.push(`Sebutkan waktunya pakai kata: "${c.dateSurface}"`);
  } else {
    lines.push("");
    lines.push("JANGAN sebut waktu sama sekali (tanpa td/tadi/kemarin/besok).");
  }

  const reg = REGISTER_HINTS[c.register];
  if (reg && c.register !== "baku") {
    const intensity =
      c.registerIntensity === "sisip"
        ? "sisipkan hanya 1-2 kata khasnya, sisanya bahasa Indonesia"
        : c.registerIntensity === "campur"
          ? "campur cukup kentara"
          : "pakai logat itu secara penuh";
    lines.push("", `Gaya bahasa: ${reg}. Intensitas: ${intensity}.`);
  } else if (reg) {
    lines.push("", `Gaya bahasa: ${reg}.`);
  }

  const noise = NOISE_HINTS[c.noise];
  if (noise) lines.push(`Gaya tulis: ${noise}`);

  const rail = RAIL_HINTS[c.rail];
  if (rail) lines.push(`Metode bayar (sebut sekilas, jangan jadikan entri terpisah): ${rail}`);

  if (c.vendors.length > 0) lines.push(`Sebut tempat/barang: ${c.vendors.join(", ")}`);

  return { system, user: lines.join("\n") };
}

/** One line per aspect telling the teacher what the message must MEAN. */
function aspectBrief(aspect: string): string {
  const briefs: Record<string, string> = {
    ord_single_out: "satu pengeluaran biasa sehari-hari",
    ord_single_in: "satu pemasukan biasa (uang masuk)",
    ord_multi_out: "dua atau lebih pengeluaran dalam satu pesan",
    ord_rekap_list: "rekap beberapa pengeluaran dalam bentuk daftar",
    ord_vendor_named: "pengeluaran di sebuah toko/tempat yang disebut namanya",
    ord_rail_named: "pengeluaran yang menyebut cara bayarnya",
    ord_recurring_bill: "bayar tagihan rutin (listrik/wifi/kos/spp/bpjs)",
    ord_topup_ewallet: "top up e-wallet — ini PENGELUARAN, bukan pemasukan",
    ord_date_relative: "pengeluaran dengan keterangan waktu relatif",
    ord_no_date: "pengeluaran tanpa keterangan waktu sama sekali",
    ord_qty_simple: "beli beberapa buah barang yang sama",
    ord_wa_wrapper: "pengeluaran dibungkus basa-basi WhatsApp ('catat ya:', salam, emoji)",
    not_dot_separator: "pengeluaran dengan nominal bertitik ribuan",
    not_k_suffix_decimal: "pengeluaran dengan nominal berakhiran k, ada desimalnya",
    not_spelled_amount: "pengeluaran dengan nominal ditulis huruf",
    not_slang_hokkien: "pengeluaran dengan nominal memakai slang (ceban/goceng/gopek)",
    not_regional_numeral: "pengeluaran dengan nominal memakai angka bahasa daerah",
    reg_regional_lexicon: "pengeluaran dengan kosakata khas daerah",
    noi_typo_heavy: "pengeluaran ditulis dengan banyak typo",
    noi_voice_rambling: "pengeluaran dari transkrip suara yang bertele-tele",
    dir_income_gaji: "gaji/honor/THR cair — uang MASUK",
    dir_income_refund_cashback: "refund atau cashback diterima — uang MASUK",
    dir_income_transfer_masuk: "ada transfer masuk ke rekening — uang MASUK",
    dir_mixed_message: "satu pesan berisi uang masuk DAN uang keluar sekaligus",
    dir_lexical_trap: "transaksi yang kata kerjanya bisa menyesatkan arah uangnya (utang/piutang, dibayar/membayar)",
    dir_topup_not_income: "top up saldo — uang PINDAH, jelas bukan pemasukan",
    ntx_curhat: "curhat/keluhan soal uang — TIDAK ada transaksi yang sudah terjadi",
    ntx_future_intent: "rencana beli di masa depan — belum terjadi, jangan dicatat",
    ntx_cancelled: "pembelian yang dibatalkan — jangan dicatat",
    ntx_query: "pertanyaan ke aplikasi soal pengeluaran, bukan pencatatan",
    adv_correction_amount: "pengeluaran yang nominalnya diralat di tengah kalimat",
    adv_correction_magnitude: "pengeluaran yang satuannya diralat (ribu vs juta)",
    adv_price_copy_bait: "beberapa barang dengan harga berbeda-beda yang gampang tertukar",
    adv_qty_x_unit: "beberapa item sama dengan harga satuan",
    adv_split_share: "patungan — hanya bagian si penulis yang dicatat",
    adv_discount_net: "beli dengan diskon — yang dicatat harga akhir",
    adv_fee_plus_principal: "transfer dengan biaya admin terpisah",
    adv_fuzzy_amount: "nominal yang tidak pasti ('300an')",
    adv_past_plus_future: "satu yang sudah dibayar dan satu yang baru rencana",
    adv_phantom_income_bait: "ada kata yang terdengar seperti pemasukan padahal bukan (gratis ongkir, COD)",
  };
  return briefs[aspect] ?? aspect;
}
