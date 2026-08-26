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

import { VENDORS, type Cell, type Invariant, type Rail, type Register, type TokenValue } from "../../src/core/parse-taxonomy.ts";
import type { ExpectedEntry, LabelExpectation } from "./sft-validate.ts";

const VENDOR_BY_ID = new Map(VENDORS.map((v) => [v.id, v]));

/** Resolve taxonomy vendor ids to natural phrase choices for the teacher prompt. */
function vendorPromptLabels(ids: readonly string[]): string {
  return ids
    .map((id) => {
      const v = VENDOR_BY_ID.get(id);
      if (!v) return `"${id.replace(/_/g, " ")}"`;
      return v.surfaces.slice(0, 3).map((s) => `"${s}"`).join(" / ");
    })
    .join("; ");
}

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
 *    so we assign deterministically (income takes the first N amounts). buildTextPrompt then
 *    states that assignment per surface — without it the teacher is guessing, and on a
 *    two-amount mixed cell it loses the coin flip half the time through no fault of its own.
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
 * Amounts the spec ordered into the text but deliberately did NOT book: a non-transaction's
 * nominal, a distractor (gross price / superseded value), and — under the merged qty reading —
 * the unit price. The dropped-entry gate must treat these as compliance, not omission;
 * without it the gate rejects the teacher for writing exactly what we asked, which silently
 * deleted the ntx_curhat and ntx_query aspects outright.
 */
export function excusedByConstruction(spec: RowSpec): Set<number> {
  const booked = new Set((spec.expectation.alternatives[0] ?? []).map((e) => e.amount));
  const out = new Set<number>();
  for (const d of spec.distractors) out.add(d.rupiah);
  for (const s of spec.surfaces) if (!booked.has(s.rupiah)) out.add(s.rupiah);
  // The unit price under the MERGED reading. `booked` above is alternatives[0] — the SPLIT
  // reading — which books the unit, so the loop never excuses it and the doc comment's promise
  // ("a qty cell's unit price under the merged reading") was not kept: a merged label left the
  // unit sitting in the text unbooked and died at the dropped-entry gate. Excusing it is a
  // no-op for the split reading, where it is genuinely consumed.
  if (spec.quantity) out.add(spec.quantity.unit);
  return out;
}

/**
 * Amounts the SPEC declares correct but the TEXT cannot contain — today, exactly one: a qty
 * cell's merged total. cellToExpectation offers "N × unit" and "one entry of unit×count" as
 * equally valid readings, while buildTextPrompt orders the message to state the unit price and
 * NOT the total ("Jangan tulis total"). So unit×count appears nowhere for traceAmount to find,
 * guardTrace runs before the agreement check, and every merged label was rejected as a
 * hallucination — the offer in alternatives[1] was unreachable code.
 *
 * Deliberately NOT "every amount in every alternative": the bijection gate already pins the
 * text's amounts to the spec's surfaces, so the merged total is the only legal amount that can
 * be missing. Widening this further would blunt the gate that catches invented money.
 */
export function traceableByConstruction(spec: RowSpec): Set<number> {
  if (!spec.quantity) return new Set();
  return new Set((spec.expectation.alternatives[1] ?? []).map((e) => e.amount));
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

/**
 * A register is a CARRIER: it colours the wording and must NOT move the parse (see the
 * parse-taxonomy header). But several registers carry direction-loaded VERBS — jv `tuku` and
 * su `meuli` both mean "buy", and `infaq`/`sedekah` are money leaving — so pasting them onto an
 * income cell orders a message that reads as an expense. The blind parse then agrees with the
 * text, disagrees with the spec, and the row dies as an "agreement" reject we authored.
 *
 * `core` is direction-free and safe anywhere. `outOnly` holds the spend vocabulary and is
 * offered only where money actually leaves. There is deliberately no `inOnly`: inventing
 * regional income verbs I cannot verify would trade this bug for a subtler one, and the core
 * lexicon already perturbs the text enough to do the register's job.
 */
type RegisterHint = { core: string; outOnly?: string };

const REGISTER_HINTS: Record<Register, RegisterHint> = {
  baku: { core: "bahasa Indonesia baku dan formal (saya, sudah, tersebut)", outOnly: "membeli, membayar" },
  jaksel_gaul: { core: "gaul Jakarta Selatan (gue/gw, duit, banget, doang, aja) — sisipkan, jangan ubah angkanya" },
  betawi: { core: "Betawi (gue, aje, dah, nih) — jangan sapaan 'bang' ke bot" },
  jawa: { core: "campur Jawa (wis, duwit, piro) — jangan sapaan 'rek' ke bot", outOnly: "tuku (beli)" },
  sunda: { core: "campur Sunda (artos, atos, teu, mah, atuh)", outOnly: "meuli (beli)" },
  medan: { core: "Medan — PENTING: pajak=pasar, kereta=sepeda motor, motor=mobil, kedai, awak — jangan sapaan 'kelen' ke bot" },
  minang: { core: "campur Minang (pitih=uang, kadai=kedai, baa, lai)" },
  makassar_timur: { core: "Indonesia timur (partikel mi/ji/ki: 'sudah mi', 'berapa ki')" },
  pesantren: { core: "kosakata pesantren (santri, pondok, ngaji) — jangan sapaan 'ustadz' ke bot", outOnly: "infaq, sedekah, syahriah" },
};

const NOISE_HINTS: Record<string, string> = {
  bersih: "tulis rapi, ejaan benar",
  wa_ringkas: "gaya chat ke bot: singkat, boleh tanpa kapital, singkatan (td, sm, dr, yg, catat ya)",
  voice_rambling: "hasil voice-to-text ke bot: bertele-tele, jeda '...', pengulangan — tetap satu submit pencatatan, bukan ngobrol",
  typo_berat: "banyak typo dan singkatan ngawur, huruf tertukar (tetap pesan ke bot)",
  emoji_format: "boleh emoji / list singkat seperti chat ke bot pencatat",
};

/**
 * Rail phrasing per direction. Same carrier rule as REGISTER_HINTS: an income cell must be told
 * how the money ARRIVED, never how it was paid. The old table was expense-only and pasted onto
 * `in` cells verbatim, so ord_single_in-01 ordered "→ MASUK — pakai kata: terima/dapat" and
 * then "Metode bayar: bayar tunai/cash" four lines later.
 *
 * Typed `Record<Rail, …>`, not `Record<string, …>`: the old table was keyed "transfer" while the
 * Rail axis says "transfer_bank", so every transfer cell — 13% of the taxonomy — silently got no
 * rail line at all and the compiler had nothing to say about it.
 */
const RAIL_HINTS: Record<Rail, { out: string; in: string } | null> = {
  none: null,
  tunai: { out: "bayar tunai/cash", in: "terima tunai/cash" },
  qris: { out: "bayar pakai QRIS", in: "masuk lewat QRIS" },
  ewallet: { out: "pakai e-wallet (GoPay/OVO/Dana/ShopeePay)", in: "masuk ke e-wallet (GoPay/OVO/Dana/ShopeePay)" },
  transfer_bank: { out: "lewat transfer bank (BCA/BRI/Mandiri/BNI)", in: "lewat transfer bank masuk (BCA/BRI/Mandiri/BNI)" },
  kartu: { out: "pakai kartu debit/kredit", in: "masuk ke kartu debit (refund)" },
  cod: { out: "COD", in: "refund COD" },
  emoney: { out: "pakai e-money (e-Toll/Flazz/Brizzi)", in: "masuk ke e-money (e-Toll/Flazz/Brizzi)" },
  pulsa: { out: "potong pulsa", in: "masuk jadi pulsa" },
};

/**
 * Shared teacher rules for single-item and batch text generation.
 * BAGUS/JELEK examples specifically target bijection and direction failures — keep them
 * in every text-gen path, including batch.
 */
export function textTeacherSystemRules(): string {
  return [
    "Ini BUKAN chat ke teman. Frame: user submit teks singkat ke bot pencatat keuangan.",
    "Mayoritas pesan = pencatatan uang yang SUDAH TERJADI (baru bayar / baru terima), bukan curhat atau rencana.",
    "",
    "Contoh BAGUS — pencatatan jadi (ikutin polanya, jangan copy angkanya):",
    "- \"baru beli nasi telur 12rb sama teh pucuk 4rb\"",
    "- \"catat ya bayar parkir 5rb\"",
    "- \"transfer masuk 350rb tadi pagi\"",
    "- \"top up gopay 17.500\"",
    "",
    "Contoh BAGUS — sengaja BUKAN transaksi (hanya jika brief bilang begitu):",
    "- \"rencana beli kulkas 3jt, jangan dicatat dulu\"",
    "- \"batalin order tokped 85rb ya, gak jadi\"",
    "",
    "Contoh JELEK (ditolak sistem):",
    "- nominal diulang dua kali: \"bayar 3.200.000 ... Rp3200000\"",
    "- arah kabur: \"uang 50rb di warung\" (tidak jelas masuk/keluar)",
    "- nominal diganti bentuk lain: diminta \"goceng\" tapi ditulis \"5rb\"",
    "- waktu campur: diminta \"bulan ini\" tapi ada \"kemarin\" juga",
    "- curhat / rencana ditulis seolah sudah dibayar (atau sebaliknya)",
    "",
    "Aturan keras:",
    "- Keluarkan HANYA teks pesannya. Satu baris. Tanpa JSON, tanpa kutip pembungkus, tanpa penjelasan.",
    "- Setiap bentuk nominal di daftar WAJIB muncul PERSIS seperti ditulis, dan TEPAT SATU KALI (jangan diulang).",
    "- JANGAN menambah nominal/rupiah/slang angka lain di luar daftar.",
    "- Arah uang HARUS terbaca dari kata kerja alami (bukan meta-label):",
    "  pemasukan → terima / dapat / masuk / cair / transfer masuk",
    "  pengeluaran → bayar / beli / keluar / top up / transfer ke",
    "- JANGAN sapaan ke manusia (bang, bro, rek, ustadz, mas, kak, kelen).",
    "- JANGAN underscore di nama tempat (\"warung madura\", bukan \"warung_madura\").",
    "- JANGAN meta-label (\"ini pemasukan\", \"bukan transaksi\", \"duit pindah\").",
    "- Hanya jika brief bilang non-transaksi: isyarat alami wajib (\"belum jadi\", \"batal\", \"jangan dicatat\", \"berapa ya\").",
    "- Panjang biasanya <20 kata (kecuali diminta bertele-tele).",
  ].join("\n");
}

/**
 * Prompt the teacher to write ONE message. It is never shown the JSON schema or the label —
 * only what the message must SAY. That keeps text generation and labeling independent.
 */
export function buildTextPrompt(spec: RowSpec): { system: string; user: string } {
  const c = spec.cell;
  const system = [
    "Kamu menulis SATU pesan yang dikirim user ke AI/bot pencatat keuangan berbahasa Indonesia.",
    textTeacherSystemRules(),
  ].join("\n");

  const alt0 = spec.expectation.alternatives[0] ?? [];
  const nMasuk = alt0.filter((e) => e.direction === "pemasukan").length;
  const nKeluar = alt0.filter((e) => e.direction === "pengeluaran").length;
  const nonTx = spec.expectation.nonTransaction;

  const lines: string[] = [];
  lines.push(`Tulis satu pesan yang menyatakan: ${aspectBrief(c.aspect, nMasuk, nKeluar)}`);
  lines.push("");

  if (nonTx) {
    lines.push(
      "INI BUKAN TRANSAKSI JADI — bot HARUS mengabaikan (bukan_transaksi).",
      "Jangan bunyi seperti pencatatan yang sudah terjadi. JANGAN pakai \"catat ya\" / \"baru beli\" / \"sudah terima\".",
      "Pakai isyarat jelas: belum / batal / jangan dicatat / berapa ya / males / belum ada duit.",
      "",
    );
  } else {
    // Keep this direction-neutral: income cells must not be told to "bayar/beli".
    lines.push(
      "INI TRANSAKSI YANG SUDAH TERJADI — gaya catat harian ke bot pencatat.",
      "Boleh singkat ala chat: \"catat ya…\", \"baru…\", \"td…\". Hindari curhat panjang atau rencana masa depan.",
      "",
    );
  }

  if (spec.surfaces.length === 0) {
    // A dangling "nominal wajib:" header with nothing under it invites an invented amount,
    // which the bijection guard would then reject — burning the cell for our own bad prompt.
    lines.push("JANGAN sebut nominal rupiah apa pun. Pesan ini memang tidak memuat angka uang.");
  } else {
    lines.push("Nominal yang WAJIB muncul — salin PERSIS string di dalam tanda kutip, masing-masing TEPAT SEKALI:");
    // The direction MUST be stated per surface. The aspect brief alone is not enough: aspects
    // like ord_vendor_named vary direction across cells while the brief says "pengeluaran",
    // so an `in` cell would order an expense and then reject the teacher for writing one.
    // Deriving it from the expectation keeps prompt and answer key on one source of truth.
    const byAmount = new Map<number, "pemasukan" | "pengeluaran">();
    for (const e of spec.expectation.alternatives[0] ?? []) byAmount.set(e.amount, e.direction);
    for (const n of spec.surfaces) {
      const dir = byAmount.get(n.rupiah);
      const tag =
        dir === "pemasukan"
          ? "  → MASUK — pakai kata: terima/dapat/masuk/cair"
          : dir === "pengeluaran"
            ? "  → KELUAR — pakai kata: bayar/beli/keluar/top up"
            : nonTx
              ? "  → disebut saja, JANGAN seolah sudah dibayar/diterima"
              : "";
      lines.push(`  - "${n.surface}"  (= Rp${n.rupiah.toLocaleString("id-ID")})${tag}`);
    }
    if (spec.surfaces.length > 1 && !spec.quantity) {
      lines.push(
        "",
        `Semua ${spec.surfaces.length} nominal di atas HARUS muncul. Jangan hanya sebagian.`,
      );
    }
  }

  if (spec.quantity) {
    // Without this the message says "beli 1 barang 5rb" while the spec expects 5 entries,
    // and the cell fails every attempt for a reason the teacher was never told.
    lines.push(
      "",
      `Sebutkan JUMLAH ITEM dengan angka jelas: ${spec.quantity.count} ${spec.quantity.keyword}, ` +
        `harga satuan "${spec.surfaces[0]?.surface ?? spec.quantity.unit}" muncul TEPAT SEKALI. ` +
        `Jangan tulis total (bukan ${spec.quantity.count}×harga).`,
    );
  }

  if (spec.distractors.length > 0) {
    lines.push("");
    lines.push(
      "Nominal berikut WAJIB disebut, tapi HARUS ada kata batal/rencana/salah/koreksi/patungan/diskon " +
        "supaya jelas TIDAK dicatat sebagai transaksi jadi:",
    );
    for (const d of spec.distractors) {
      lines.push(`  - Rp${d.rupiah.toLocaleString("id-ID")} — ${d.why}`);
    }
  }

  if (c.dateSurface) {
    lines.push("");
    lines.push(
      `Waktu: pakai PERSIS kata "${c.dateSurface}" sekali. ` +
        `JANGAN tambah kata waktu lain (td/tadi/kemarin/besok/bulan ini/minggu ini) kecuali itu juga yang diminta.`,
    );
  } else {
    lines.push("");
    lines.push("JANGAN sebut waktu sama sekali (tanpa td/tadi/kemarin/besok/bulan ini/minggu ini).");
  }

  // Top-up and fee cells often get split into phantom second entries by the blind parser.
  if (c.aspect === "ord_topup_ewallet" || c.aspect === "dir_topup_not_income") {
    lines.push(
      "",
      "Top up: satu aksi isi saldo saja. Jangan pecah jadi \"top up\" + \"beli pulsa\" terpisah di teks.",
    );
  }

  // Money actually leaves on `out` and on `mixed` (a mixed message has an expense by
  // definition), so spend vocabulary is honest there and nowhere else.
  const spends = !nonTx && nKeluar > 0;

  // Total Record<Register, …>, so the lookup cannot miss — and unlike the old `Record<string,…>`
  // a missing key is now a compile error rather than a silently dropped line.
  const reg = REGISTER_HINTS[c.register]!;
  const regText = spends && reg.outOnly ? `${reg.core}; boleh: ${reg.outOnly}` : reg.core;
  if (c.register !== "baku") {
    const intensity =
      c.registerIntensity === "sisip"
        ? "sisipkan hanya 1-2 kata khasnya, sisanya bahasa Indonesia"
        : c.registerIntensity === "campur"
          ? "campur cukup kentara"
          : "pakai logat itu secara penuh";
    lines.push("", `Gaya bahasa: ${regText}. Intensitas: ${intensity}.`);
  } else {
    lines.push("", `Gaya bahasa: ${regText}.`);
  }

  const noise = NOISE_HINTS[c.noise];
  if (noise) lines.push(`Gaya tulis: ${noise}`);

  // Omitted for non_tx on purpose: naming a rail on a message about money that has NOT moved
  // invites "sudah bayar pakai QRIS", which is exactly the completed-transaction reading the
  // cell must avoid.
  const rail = RAIL_HINTS[c.rail];
  if (rail && !nonTx) {
    lines.push(
      spends
        ? `Metode bayar (sebut sekilas sebagai cara bayar, JANGAN jadi nominal/entri terpisah): ${rail.out}`
        : `Cara uang masuk (sebut sekilas, JANGAN jadi nominal/entri terpisah): ${rail.in}`,
    );
  }

  if (c.vendors.length > 0) {
    lines.push(
      `Sebut tempat/barang dengan nama alami (pilih salah satu frasa, JANGAN tulis id bertanda underscore): ${vendorPromptLabels(c.vendors)}`,
    );
  }

  return { system, user: lines.join("\n") };
}

/**
 * One line per aspect telling the teacher what the message must MEAN.
 *
 * Several aspects vary direction across cells (ord_vendor_named can be out/in/mixed), so the
 * brief must not hardcode "pengeluaran". Where the wording is direction-neutral the caller's
 * per-surface MASUK/KELUAR tags carry the meaning; where it isn't, we override from the spec.
 */
function aspectBrief(aspect: string, nMasuk: number, nKeluar: number): string {
  const generic = (() => {
    if (nMasuk > 0 && nKeluar > 0) return "uang masuk DAN uang keluar dalam satu pesan";
    if (nMasuk > 0) return nMasuk > 1 ? "beberapa pemasukan (uang MASUK)" : "satu pemasukan (uang MASUK)";
    return null;
  })();

  // These briefs are written as expenses but their cells may be income or mixed. When the spec
  // says otherwise the brief would contradict the answer key, so the spec wins.
  const DIRECTION_VARYING = new Set([
    "ord_vendor_named",
    "ord_rail_named",
    "ord_date_relative",
    "ord_no_date",
    "ord_wa_wrapper",
    "not_dot_separator",
    "not_k_suffix_decimal",
    "not_slang_hokkien",
    "reg_regional_lexicon",
    "noi_typo_heavy",
    "noi_voice_rambling",
  ]);
  if (generic && DIRECTION_VARYING.has(aspect)) {
    const flavour: Record<string, string> = {
      ord_vendor_named: "di sebuah toko/tempat yang disebut namanya",
      ord_rail_named: "yang menyebut cara bayar/terimanya",
      ord_date_relative: "dengan keterangan waktu relatif",
      ord_no_date: "tanpa keterangan waktu sama sekali",
      ord_wa_wrapper: "dibungkus basa-basi singkat ke bot ('catat ya', emoji)",
      not_dot_separator: "dengan nominal bertitik ribuan",
      not_k_suffix_decimal: "dengan nominal berakhiran k, ada desimalnya",
      not_slang_hokkien: "dengan nominal memakai slang (ceban/goceng/gopek)",
      reg_regional_lexicon: "dengan kosakata khas daerah",
      noi_typo_heavy: "ditulis dengan banyak typo",
      noi_voice_rambling: "dari voice-to-text yang bertele-tele ke bot",
    };
    return `${generic} ${flavour[aspect] ?? ""}`.trim();
  }

  const briefs: Record<string, string> = {
    ord_single_out: "satu pengeluaran yang baru terjadi, gaya catat harian (mis. beli makan/minum)",
    ord_single_in: "satu pemasukan yang baru diterima (uang MASUK) — submit ke bot pencatat",
    ord_multi_out: "dua atau lebih pengeluaran yang sudah dibayar dalam satu submit (mis. nasi + minum)",
    ord_rekap_list: "rekap beberapa pengeluaran yang sudah terjadi, daftar singkat ke bot",
    ord_vendor_named: "pengeluaran di sebuah toko/tempat yang disebut namanya",
    ord_rail_named: "pengeluaran yang menyebut cara bayarnya",
    ord_recurring_bill: "bayar tagihan rutin (listrik/wifi/kos/spp/bpjs)",
    ord_topup_ewallet: "top up e-wallet (arah uang: keluar/pindah saldo — jangan tulis meta-label di teks)",
    ord_date_relative: "pengeluaran dengan keterangan waktu relatif",
    ord_no_date: "pengeluaran tanpa keterangan waktu sama sekali",
    ord_qty_simple: "beli beberapa buah barang yang sama",
    ord_wa_wrapper: "pengeluaran dibungkus basa-basi singkat ke bot ('catat ya', emoji)",
    not_dot_separator: "pengeluaran dengan nominal bertitik ribuan",
    not_k_suffix_decimal: "pengeluaran dengan nominal berakhiran k, ada desimalnya",
    not_spelled_amount: "pengeluaran dengan nominal ditulis huruf",
    not_slang_hokkien: "pengeluaran dengan nominal memakai slang (ceban/goceng/gopek)",
    not_regional_numeral: "pengeluaran dengan nominal memakai angka bahasa daerah",
    reg_regional_lexicon: "pengeluaran dengan kosakata khas daerah",
    noi_typo_heavy: "pengeluaran ditulis dengan banyak typo",
    noi_voice_rambling: "pengeluaran dari voice-to-text yang bertele-tele ke bot",
    dir_income_gaji: "gaji/honor/THR cair — uang MASUK",
    dir_income_refund_cashback: "refund atau cashback diterima — uang MASUK",
    dir_income_transfer_masuk: "ada transfer masuk ke rekening — uang MASUK",
    dir_mixed_message: "satu submit berisi uang masuk DAN uang keluar sekaligus",
    dir_lexical_trap: "transaksi yang kata kerjanya bisa menyesatkan arah uangnya (utang/piutang, dibayar/membayar)",
    dir_topup_not_income: "top up saldo (uang pindah) — sebut top up/isi saldo secara alami, tanpa meta-label",
    ntx_curhat: "keluhan singkat soal uang TANPA minta dicatat — jangan bunyi seperti pencatatan jadi",
    ntx_future_intent: "rencana belanja yang BELUM terjadi — tegas minta jangan dicatat",
    ntx_cancelled: "pembelian/order dibatalkan — minta bot jangan mencatat",
    ntx_query: "tanya ke bot (berapa/sudah belum), BUKAN submit pencatatan baru",
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
