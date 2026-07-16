/**
 * Core parser + scoring + scenario suites for chat-keuangan-bench.
 *
 * @see https://github.com/volfadar/chat-keuangan-bench
 */

import { config } from "dotenv";
import { resolve } from "node:path";
import { generateText, Output } from "ai";
import { z } from "zod";
import {
  applyLlmConfigOverrides,
  getLlmConfig,
  resolveModel,
} from "./llm-client.ts";

config({ path: resolve(import.meta.dirname, "../../.env") });

/** Default local model id (override with --model / EVAL_MODEL). */
const DEFAULT_MODEL =
  process.env.EVAL_MODEL?.trim() || "local-model";

type Suite = "base" | "stress" | "all";

export const financeParseSchema = z.object({
  entries: z.array(
    z.object({
      type: z.enum(["pengeluaran", "pemasukan"]),
      tanggal_hint: z
        .enum([
          "hari_ini",
          "kemarin",
          "lusa",
          "minggu_ini",
          "bulan_ini",
          "tidak_jelas",
        ])
        .nullable(),
      deskripsi: z.string(),
      jumlah: z.number().int().nonnegative(),
      kategori: z.string().nullable(),
      vendor: z.string().nullable(),
      confidence: z.enum(["high", "medium", "low"]),
      ambigu: z.boolean(),
      catatan_ambigu: z.string().nullable(),
    }),
  ),
  bukan_transaksi: z.boolean(),
  ringkasan: z.string().nullable(),
});

export type ParsedFinance = z.infer<typeof financeParseSchema>;

function normalizeTanggalHint(
  value: unknown,
): ParsedFinance["entries"][number]["tanggal_hint"] {
  if (value == null) return null;
  const raw = String(value).toLowerCase().trim();
  const key = raw.replace(/\s+/g, "_");
  const aliases: Record<string, NonNullable<ParsedFinance["entries"][number]["tanggal_hint"]>> = {
    hari_ini: "hari_ini",
    td: "hari_ini",
    tadi: "hari_ini",
    barusan: "hari_ini",
    kemarin: "kemarin",
    maren: "kemarin",
    kmrn: "kemarin",
    lusa: "lusa",
    minggu_ini: "minggu_ini",
    bulan_ini: "bulan_ini",
    tidak_jelas: "tidak_jelas",
  };
  return aliases[key] ?? "tidak_jelas";
}

function normalizeConfidence(value: unknown): ParsedFinance["entries"][number]["confidence"] {
  if (value === "high" || value === "medium" || value === "low") return value;
  if (typeof value === "number") {
    if (value >= 0.8) return "high";
    if (value >= 0.5) return "medium";
    return "low";
  }
  const asNum = Number(value);
  if (!Number.isNaN(asNum)) return normalizeConfidence(asNum);
  return "medium";
}

function parseRupiahAmount(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.round(raw);
  const s = String(raw ?? "").toLowerCase().trim();
  if (!s) return 0;

  const jt = s.match(/([\d.,]+)\s*j[tu](?:\s*an)?/);
  if (jt?.[1]) {
    const n = Number.parseFloat(jt[1].replace(/\./g, "").replace(",", "."));
    if (!Number.isNaN(n)) return Math.round(n * 1_000_000);
  }

  const rb = s.match(/([\d.,]+)\s*r[b]?(?:\s*uan)?/);
  if (rb?.[1]) {
    const cleaned = rb[1].includes(".") && rb[1].length > 4
      ? rb[1].replace(/\./g, "")
      : rb[1].replace(",", ".");
    const n = Number.parseFloat(cleaned);
    if (!Number.isNaN(n)) return Math.round(n * 1000);
  }

  const k = s.match(/([\d.,]+)\s*k\b/);
  if (k?.[1]) {
    const n = Number.parseFloat(k[1].replace(",", "."));
    if (!Number.isNaN(n)) return Math.round(n * 1000);
  }

  const digits = s.replace(/[^\d]/g, "");
  return Number(digits) || 0;
}

function normalizeType(value: unknown): ParsedFinance["entries"][number]["type"] {
  const s = String(value ?? "").toLowerCase().trim();
  if (s === "pemasukan" || s === "income" || s === "masuk" || s === "credit") return "pemasukan";
  return "pengeluaran";
}

function normalizeBukanTransaksi(
  value: unknown,
  entryCount: number,
): boolean {
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return entryCount === 0;
  if (entryCount > 0) return false;
  return true;
}

function normalizeFinancePayload(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const o = raw as Record<string, unknown>;
  const entriesRaw = o.entries ?? o.transaksi ?? o.transactions ?? [];
  const entries = Array.isArray(entriesRaw)
    ? entriesRaw.map((entry) => {
        if (!entry || typeof entry !== "object") return entry;
        const e = entry as Record<string, unknown>;
        const jumlahRaw = e.jumlah ?? e.amount;
        const jumlah = parseRupiahAmount(jumlahRaw);
        return {
          type: normalizeType(e.type),
          tanggal_hint: normalizeTanggalHint(e.tanggal_hint),
          deskripsi: String(e.deskripsi ?? e.description ?? ""),
          jumlah,
          kategori: e.kategori == null ? null : String(e.kategori),
          vendor: e.vendor == null ? null : String(e.vendor),
          confidence: normalizeConfidence(e.confidence),
          ambigu: Boolean(e.ambigu),
          catatan_ambigu: e.catatan_ambigu == null ? null : String(e.catatan_ambigu),
        };
      })
    : [];
  return {
    entries,
    bukan_transaksi: normalizeBukanTransaksi(o.bukan_transaksi, entries.length),
    ringkasan: o.ringkasan == null ? null : String(o.ringkasan),
  };
}

function extractJsonBlock(text: string): string | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  if (trimmed.startsWith("{")) return trimmed.match(/\{[\s\S]*\}/)?.[0] ?? null;
  return trimmed.match(/\{[\s\S]*\}/)?.[0] ?? null;
}

export function parseFinanceJson(text: string): ParsedFinance {
  const block = extractJsonBlock(text);
  if (!block) throw new Error("No JSON block in model response");
  const raw: unknown = JSON.parse(block);
  return financeParseSchema.parse(normalizeFinancePayload(raw));
}

type ChatStyle =
  | "casual_slang"
  | "whatsapp_short"
  | "formal_dictation"
  | "ambiguous_amount"
  | "multi_entry"
  | "relative_date"
  | "income"
  | "pesantren"
  | "non_transaction"
  | "typo_slang"
  | "split_bill"
  | "bulk_list"
  | "future_intent"
  | "stress_extreme";

export interface ExpectedEntry {
  type: "pengeluaran" | "pemasukan";
  jumlah: number;
  /** Acceptable range when amount is fuzzy (e.g. "800an" → 800_000) */
  jumlahMin?: number;
  jumlahMax?: number;
  tanggal_hint?: ParsedFinance["entries"][number]["tanggal_hint"];
  deskripsiIncludes?: string[];
  ambigu?: boolean;
}

export interface Scenario {
  id: string;
  style: ChatStyle;
  text: string;
  expectNonTransaction?: boolean;
  expectEntries: ExpectedEntry[];
  notes?: string;
}

export const SYSTEM_PROMPT = `Anda adalah parser pencatatan keuangan untuk pengguna Indonesia (chat WhatsApp / suara / teks bebas).

Tugas: dari SATU pesan pengguna, ekstrak SEMUA transaksi keuangan yang SUDAH TERJADI (pengeluaran ATAU pemasukan).

═══ ATURAN PALING PENTING: ARAH UANG (type) ═══
Tentukan type dari ARAH aliran uang bagi pengguna yang bicara:

PEMASUKAN (uang MASUK ke user/rekening/kas):
- Kata kunci: terima, dapet/dapat, masuk, cair, gaji, THR, refund, dikembalikan, transfer masuk, setoran (dari wali/orang lain), donasi masuk, pemasukan, dibayarkan ke saya, honor, fee diterima
- Contoh: "komisi lomba cair 1,3jt" → pemasukan | "kembalian deposit masuk" → pemasukan | "terima titipan kas RT 640rb" → pemasukan
- JANGAN tandai gaji/THR/refund/transfer masuk/setoran sebagai pengeluaran

PENGELUARAN (uang KELUAR dari user):
- Kata kunci: beli, bayar, jajan, top up, ongkir, parkir, listrik, zakat/infaq KELUAR, catat pengeluaran, bon, utang dibayar
- Contoh: "isi solar 90rb" → pengeluaran | "bayar iuran warga 175rb" → pengeluaran
- Donasi/zakat yang user BAYAR = pengeluaran. Donasi yang user TERIMA = pemasukan.

Campuran dalam satu pesan: buat entri TERPISAH dengan type berbeda jika perlu.

═══ ATURAN ANGKA RUPIAH (jumlah = integer) ═══
- "12rb", "12 rebu", "12k" → 12000
- "50k", "50rb" → 50000
- "1,5jt", "1.5 juta", "4,5jt" → 1500000 / 4500000
- "Rp 15.000" / "87.500" → 15000 / 87500 (titik = pemisah ribuan)
- "<angka>an" tanpa satuan (mis. "300an") → biasanya ratusan ribu; ambigu=true jika tidak jelas
- Pola "<N> <N> nya" / "semuanya" / "@<harga>" × N orang → hitung per item; jangan salin nominal item sebelahnya
- Setiap baris item WAJIB punya jumlah sendiri — JANGAN copy-paste harga item lain

═══ ATURAN TANGGAL (tanggal_hint) ═══
- "hari ini", "td", "tadi", "barusan", "sore tadi" → hari_ini (BUKAN kemarin)
- "kemarin", "maren", "kmrn" → kemarin
- "bulan ini" → bulan_ini
- "besok", "nanti", "mau bayar", "rencana" tanpa bukti sudah bayar → BUKAN transaksi (jangan catat)
- Tidak disebut → tidak_jelas

═══ ATURAN KONTEN ═══
- Satu pesan bisa banyak entri.
- Split bill: catat bagian user ("punyaku 30rb").
- Koreksi di tengah kalimat: pakai angka TERAKHIR yang dikoreksi user ("8rb... eh 23rb" → 23000).
- Obrolan tanpa transaksi riil (curhat, salam, rencana belum bayar) → bukan_transaksi=true, entries=[].
- Nominal/item ragu → ambigu=true + catatan_ambigu singkat.
- deskripsi: ringkas Bahasa Indonesia (barang/jasa, bukan kalimat penuh).
- JANGAN mengarang transaksi.

═══ FORMAT JSON (WAJIB persis) ═══
{
  "entries": [{ "type", "tanggal_hint", "deskripsi", "jumlah", "kategori", "vendor", "confidence", "ambigu", "catatan_ambigu" }],
  "bukan_transaksi": boolean,
  "ringkasan": string|null
}
- Key "entries" (JANGAN "transaksi"/"transactions")
- "bukan_transaksi" boolean (JANGAN array)
- "jumlah" integer rupiah (JANGAN string)
- "confidence": "high" | "medium" | "low" (JANGAN angka 0.9)
- "tanggal_hint": hari_ini | kemarin | lusa | minggu_ini | bulan_ini | tidak_jelas (pakai underscore, JANGAN spasi)

Kembalikan HANYA JSON valid.`;

export const SCENARIOS: Scenario[] = [
  {
    id: "user-example-maren-bakmi",
    style: "casual_slang",
    text: "hmm maren gw keknya beli sarden 12rb terus hari ini makan bakmi 2 bungkus, harganya sih 12rb 2 2 nya",
    expectEntries: [
      { type: "pengeluaran", jumlah: 12000, tanggal_hint: "kemarin", deskripsiIncludes: ["sarden"] },
      { type: "pengeluaran", jumlah: 12000, tanggal_hint: "hari_ini", deskripsiIncludes: ["bakmi"] },
      { type: "pengeluaran", jumlah: 12000, tanggal_hint: "hari_ini", deskripsiIncludes: ["bakmi"] },
    ],
    notes: "2 bungkus bakmi @12rb each — 3 entries total",
  },
  {
    id: "bensin-parkir-mall",
    style: "casual_slang",
    text: "abis beli bensin 50k sama parkir 5rb di mall",
    expectEntries: [
      { type: "pengeluaran", jumlah: 50000, deskripsiIncludes: ["bensin"] },
      { type: "pengeluaran", jumlah: 5000, deskripsiIncludes: ["parkir"] },
    ],
  },
  {
    id: "gaji-4-5jt",
    style: "income",
    text: "terima gaji 4,5jt bulan ini alhamdulillah",
    expectEntries: [
      { type: "pemasukan", jumlah: 4500000, tanggal_hint: "bulan_ini", deskripsiIncludes: ["gaji"] },
    ],
  },
  {
    id: "donasi-renovasi",
    style: "income",
    text: "duit masuk dari donasi 2jt buat renovasi masjid",
    expectEntries: [
      { type: "pemasukan", jumlah: 2000000, deskripsiIncludes: ["donasi"] },
    ],
  },
  {
    id: "wa-catat-nasi-padang",
    style: "whatsapp_short",
    text: "catat 25rb nasi padang tadi siang",
    expectEntries: [
      { type: "pengeluaran", jumlah: 25000, tanggal_hint: "hari_ini", deskripsiIncludes: ["nasi", "padang"] },
    ],
  },
  {
    id: "martabak-slang",
    style: "typo_slang",
    text: "td abis jajan martabak 15 rebu di depan pesantren",
    expectEntries: [
      { type: "pengeluaran", jumlah: 15000, tanggal_hint: "hari_ini", deskripsiIncludes: ["martabak"] },
    ],
  },
  {
    id: "belanja-bulanan-800an",
    style: "ambiguous_amount",
    text: "kemarin belanja bulanan kira2 800an",
    expectEntries: [
      {
        type: "pengeluaran",
        jumlah: 800000,
        jumlahMin: 800000,
        jumlahMax: 800000,
        tanggal_hint: "kemarin",
        ambigu: true,
        deskripsiIncludes: ["belanja"],
      },
    ],
    notes: "800an = ~800rb, should flag ambigu",
  },
  {
    id: "transfer-ortu-buku",
    style: "multi_entry",
    text: "kemarin dapet transfer 500rb dari ortu, terus beli buku 80rb",
    expectEntries: [
      { type: "pemasukan", jumlah: 500000, tanggal_hint: "kemarin", deskripsiIncludes: ["transfer"] },
      { type: "pengeluaran", jumlah: 80000, tanggal_hint: "kemarin", deskripsiIncludes: ["buku"] },
    ],
  },
  {
    id: "atk-gojek-parkir-formal",
    style: "formal_dictation",
    text: "jadi gini pak, kemarin saya beli ATK buat kantor itu totalnya sekitar 350 ribu terus ada juga ongkir gojek 25 ribu sama parkir 5 ribu",
    expectEntries: [
      { type: "pengeluaran", jumlah: 350000, tanggal_hint: "kemarin", deskripsiIncludes: ["atk"] },
      { type: "pengeluaran", jumlah: 25000, tanggal_hint: "kemarin", deskripsiIncludes: ["gojek", "ongkir"] },
      { type: "pengeluaran", jumlah: 5000, tanggal_hint: "kemarin", deskripsiIncludes: ["parkir"] },
    ],
  },
  {
    id: "curhat-bukan-transaksi",
    style: "non_transaction",
    text: "gw lagi males banget hari ini pengen tidur aja",
    expectNonTransaction: true,
    expectEntries: [],
  },
  {
    id: "infaq-jumat",
    style: "pesantren",
    text: "infaq jumat kemarin 50rb ke masjid",
    expectEntries: [
      { type: "pengeluaran", jumlah: 50000, tanggal_hint: "kemarin", deskripsiIncludes: ["infaq"] },
    ],
  },
  {
    id: "split-bill-makan",
    style: "split_bill",
    text: "makan siang bareng 120rb dibagi 4, punyaku 30rb",
    expectEntries: [
      { type: "pengeluaran", jumlah: 30000, deskripsiIncludes: ["makan"] },
    ],
  },
  {
    id: "bulk-wa-list",
    style: "bulk_list",
    text: "sore tadi:\n- indomaret 87.500\n- gojek ke kampus 18rb\n- kopi 35k",
    expectEntries: [
      { type: "pengeluaran", jumlah: 87500, deskripsiIncludes: ["indomaret"] },
      { type: "pengeluaran", jumlah: 18000, deskripsiIncludes: ["gojek"] },
      { type: "pengeluaran", jumlah: 35000, deskripsiIncludes: ["kopi"] },
    ],
  },
  {
    id: "listrik-500rb",
    style: "formal_dictation",
    text: "bayar listrik kemarin 500rb lewat m-banking",
    expectEntries: [
      { type: "pengeluaran", jumlah: 500000, tanggal_hint: "kemarin", deskripsiIncludes: ["listrik"] },
    ],
  },
  {
    id: "ukt-1-25jt",
    style: "formal_dictation",
    text: "Rp 1.250.000 buat bayar UKT semester ini",
    expectEntries: [
      { type: "pengeluaran", jumlah: 1250000, deskripsiIncludes: ["ukt"] },
    ],
  },
  {
    id: "spp-besok-belum",
    style: "future_intent",
    text: "besok mau bayar SPP 2 juta, belum sempet transfer",
    expectNonTransaction: true,
    expectEntries: [],
    notes: "rencana belum terjadi — should NOT book",
  },
  {
    id: "sembako-dapur-pesantren",
    style: "pesantren",
    text: "beli sembako dapur pesantren 3,2jt dari pasar induk tadi pagi",
    expectEntries: [
      { type: "pengeluaran", jumlah: 3200000, tanggal_hint: "hari_ini", deskripsiIncludes: ["sembako"] },
    ],
  },
  {
    id: "shopee-cod-2-item",
    style: "multi_entry",
    text: "cod shopee dateng td, case hp 45rb sama kabel type c 25rb",
    expectEntries: [
      { type: "pengeluaran", jumlah: 45000, tanggal_hint: "hari_ini", deskripsiIncludes: ["case", "hp"] },
      { type: "pengeluaran", jumlah: 25000, tanggal_hint: "hari_ini", deskripsiIncludes: ["kabel"] },
    ],
  },
  {
    id: "gopay-topup-100k",
    style: "whatsapp_short",
    text: "top up gopay 100k",
    expectEntries: [
      { type: "pengeluaran", jumlah: 100000, deskripsiIncludes: ["gopay", "top"] },
    ],
  },
  {
    id: "thr-diterima",
    style: "income",
    text: "alhamdulillah thr cair 1,8 juta masuk rekening",
    expectEntries: [
      { type: "pemasukan", jumlah: 1800000, deskripsiIncludes: ["thr"] },
    ],
  },
  {
    id: "warung-ga-ingat-harga",
    style: "ambiguous_amount",
    text: "beli es teh sama pentol di warung tapi lupa totalnya, kira2 20an ribu deh",
    expectEntries: [
      {
        type: "pengeluaran",
        jumlah: 20000,
        jumlahMin: 15000,
        jumlahMax: 30000,
        ambigu: true,
        deskripsiIncludes: ["warung"],
      },
    ],
  },
  {
    id: "salam-doang",
    style: "non_transaction",
    text: "assalamualaikum pak ustadz, gimana kabarnya?",
    expectNonTransaction: true,
    expectEntries: [],
  },
  {
    id: "ojek-15rb-atau-50rb-typo",
    style: "ambiguous_amount",
    text: "gojek ke masjid 15rb... eh maksudnya 50rb",
    expectEntries: [
      { type: "pengeluaran", jumlah: 50000, deskripsiIncludes: ["gojek"] },
    ],
    notes: "user self-corrects — should take 50rb",
  },
  {
    id: "catat-pengeluaran-formal-wafi",
    style: "formal_dictation",
    text: "catat pengeluaran 200rb ATK Toko Maju",
    expectEntries: [
      { type: "pengeluaran", jumlah: 200000, deskripsiIncludes: ["atk"] },
    ],
  },
  {
    id: "mixed-income-expense-santri",
    style: "pesantren",
    text: "kemarin terima setoran wali Ahmad 750rb, terus beli buku pelajaran 120rb buat dia",
    expectEntries: [
      { type: "pemasukan", jumlah: 750000, tanggal_hint: "kemarin", deskripsiIncludes: ["setoran"] },
      { type: "pengeluaran", jumlah: 120000, tanggal_hint: "kemarin", deskripsiIncludes: ["buku"] },
    ],
  },
  {
    id: "voice-rambling-pulsa",
    style: "casual_slang",
    text: "eh iya tadi gw beli pulsa 50 ribu terus sekalian kuota 25rb buat anak kos",
    expectEntries: [
      { type: "pengeluaran", jumlah: 50000, tanggal_hint: "hari_ini", deskripsiIncludes: ["pulsa"] },
      { type: "pengeluaran", jumlah: 25000, tanggal_hint: "hari_ini", deskripsiIncludes: ["kuota"] },
    ],
  },
  {
    id: "refund-marketplace",
    style: "income",
    text: "refund tokopedia masuk 89rb kemarin",
    expectEntries: [
      { type: "pemasukan", jumlah: 89000, tanggal_hint: "kemarin", deskripsiIncludes: ["refund"] },
    ],
  },
  {
    id: "zakat-fitrah-keluarga",
    style: "pesantren",
    text: "bayar zakat fitrah 4 orang @45rb td di mushola",
    expectEntries: [
      { type: "pengeluaran", jumlah: 180000, tanggal_hint: "hari_ini", deskripsiIncludes: ["zakat"] },
    ],
    notes: "4 x 45rb = 180rb total OR 4 entries — accept either",
  },
];

/** 12 extreme stress tests — target known model weaknesses from prior evals. */
export const STRESS_SCENARIOS: Scenario[] = [
  {
    id: "stress-gaji-masuk-rekening",
    style: "stress_extreme",
    text: "barusan gajian cair 5,2 juta masuk rekening BCA, alhamdulillah",
    expectEntries: [
      { type: "pemasukan", jumlah: 5200000, tanggal_hint: "hari_ini", deskripsiIncludes: ["gaji"] },
    ],
    notes: "GLM weakness: income as pengeluaran",
  },
  {
    id: "stress-donasi-masuk-vs-infaq-keluar",
    style: "stress_extreme",
    text: "kemarin donasi masuk 1,5jt dari pak haji, terus sore bayar infaq 100rb",
    expectEntries: [
      { type: "pemasukan", jumlah: 1500000, tanggal_hint: "kemarin", deskripsiIncludes: ["donasi"] },
      { type: "pengeluaran", jumlah: 100000, deskripsiIncludes: ["infaq"] },
    ],
  },
  {
    id: "stress-refund-bukan-pengeluaran",
    style: "stress_extreme",
    text: "kemarin refund shopee 127rb masuk gopay bukan keluar ya",
    expectEntries: [
      { type: "pemasukan", jumlah: 127000, tanggal_hint: "kemarin", deskripsiIncludes: ["refund"] },
    ],
  },
  {
    id: "stress-setoran-wali-3-transaksi",
    style: "stress_extreme",
    text: "td pagi terima transfer setoran wali Fatimah 600rb, siang beli buku 95rb, sore bayar fotokopi 12rb",
    expectEntries: [
      { type: "pemasukan", jumlah: 600000, tanggal_hint: "hari_ini", deskripsiIncludes: ["setoran"] },
      { type: "pengeluaran", jumlah: 95000, tanggal_hint: "hari_ini", deskripsiIncludes: ["buku"] },
      { type: "pengeluaran", jumlah: 12000, tanggal_hint: "hari_ini", deskripsiIncludes: ["fotokopi"] },
    ],
  },
  {
    id: "stress-bulk-harga-mirip",
    style: "stress_extreme",
    text: "bon hari ini:\ngofood 28rb\ngrab 28rb\nkopi 28rb",
    expectEntries: [
      { type: "pengeluaran", jumlah: 28000, deskripsiIncludes: ["gofood"] },
      { type: "pengeluaran", jumlah: 28000, deskripsiIncludes: ["grab"] },
      { type: "pengeluaran", jumlah: 28000, deskripsiIncludes: ["kopi"] },
    ],
    notes: "common failure: copy adjacent amount",
  },
  {
    id: "stress-shopee-3-harga-bedain",
    style: "stress_extreme",
    text: "shopee td: mouse 35rb, keyboard 120rb, mousepad 18rb",
    expectEntries: [
      { type: "pengeluaran", jumlah: 35000, deskripsiIncludes: ["mouse"] },
      { type: "pengeluaran", jumlah: 120000, deskripsiIncludes: ["keyboard"] },
      { type: "pengeluaran", jumlah: 18000, deskripsiIncludes: ["mousepad"] },
    ],
  },
  {
    id: "stress-td-bukan-kemarin",
    style: "stress_extreme",
    text: "td abis jajan pentol 8rb sama es doger 7rb depan mushola",
    expectEntries: [
      { type: "pengeluaran", jumlah: 8000, tanggal_hint: "hari_ini", deskripsiIncludes: ["pentol"] },
      { type: "pengeluaran", jumlah: 7000, tanggal_hint: "hari_ini", deskripsiIncludes: ["doger"] },
    ],
  },
  {
    id: "stress-75-ribu-atau-jt",
    style: "stress_extreme",
    text: "beli kabel hdmi 7,5... eh maksudnya 75rb bukan 7,5 juta",
    expectEntries: [
      { type: "pengeluaran", jumlah: 75000, deskripsiIncludes: ["hdmi", "kabel"] },
    ],
  },
  {
    id: "stress-voice-berputar-income-expense",
    style: "stress_extreme",
    text: "jadi ceritanya kemarin dapet honor ngisi kajian 300rb terus habis itu bayar kos 800rb sama utang ke temen 50rb eh iya yang 50rb udah kebayar cash",
    expectEntries: [
      { type: "pemasukan", jumlah: 300000, tanggal_hint: "kemarin", deskripsiIncludes: ["honor"] },
      { type: "pengeluaran", jumlah: 800000, tanggal_hint: "kemarin", deskripsiIncludes: ["kos"] },
      { type: "pengeluaran", jumlah: 50000, tanggal_hint: "kemarin", deskripsiIncludes: ["utang"] },
    ],
  },
  {
    id: "stress-mention-uang-tapi-belum",
    style: "stress_extreme",
    text: "nanti malem mau transfer SPP 3,5jt tapi rekeningnya belum dikirim ustadz",
    expectNonTransaction: true,
    expectEntries: [],
  },
  {
    id: "stress-gratis-ongkir-bayar",
    style: "stress_extreme",
    text: "order baju gratis promo tapi ongkir 22rb sama packing 5rb tetep bayar td",
    expectEntries: [
      { type: "pengeluaran", jumlah: 22000, tanggal_hint: "hari_ini", deskripsiIncludes: ["ongkir"] },
      { type: "pengeluaran", jumlah: 5000, tanggal_hint: "hari_ini", deskripsiIncludes: ["packing"] },
    ],
    notes: "jangan catat baju 0 sebagai transaksi",
  },
  {
    id: "stress-split-utang-sebagian",
    style: "stress_extreme",
    text: "makan rame total 480rb, gw cuma bayar 120rb sisanya utang dulu",
    expectEntries: [
      { type: "pengeluaran", jumlah: 120000, deskripsiIncludes: ["makan"] },
    ],
    notes: "hanya bagian user yang sudah keluar uang",
  },
];

function scenariosForSuite(suite: Suite): Scenario[] {
  if (suite === "base") return SCENARIOS;
  if (suite === "stress") return STRESS_SCENARIOS;
  return [...SCENARIOS, ...STRESS_SCENARIOS];
}

export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function amountMatches(
  got: number,
  exp: ExpectedEntry,
): boolean {
  if (exp.jumlahMin !== undefined || exp.jumlahMax !== undefined) {
    const min = exp.jumlahMin ?? exp.jumlah;
    const max = exp.jumlahMax ?? exp.jumlah;
    return got >= min && got <= max;
  }
  return got === exp.jumlah;
}

function entryMatches(got: ParsedFinance["entries"][number], exp: ExpectedEntry): boolean {
  if (got.type !== exp.type) return false;
  if (!amountMatches(got.jumlah, exp)) return false;
  if (
    exp.tanggal_hint &&
    got.tanggal_hint &&
    got.tanggal_hint !== exp.tanggal_hint &&
    got.tanggal_hint !== "tidak_jelas"
  ) {
    return false;
  }
  if (exp.ambigu === true && !got.ambigu) return false;
  if (exp.deskripsiIncludes?.length) {
    const desc = normalizeText(got.deskripsi);
    const vendor = normalizeText(got.vendor ?? "");
    const ok = exp.deskripsiIncludes.some((kw) => {
      const k = normalizeText(kw);
      return desc.includes(k) || vendor.includes(k);
    });
    if (!ok) return false;
  }
  return true;
}

/** Greedy bipartite match — order-independent */
export function scoreExtraction(
  parsed: ParsedFinance,
  scenario: Scenario,
): {
  pass: boolean;
  matched: number;
  expected: number;
  got: number;
  issues: string[];
} {
  const issues: string[] = [];

  if (scenario.expectNonTransaction) {
    if (!parsed.bukan_transaksi) issues.push("expected bukan_transaksi=true");
    if (parsed.entries.length > 0) issues.push(`expected 0 entries, got ${parsed.entries.length}`);
    return {
      pass: issues.length === 0,
      matched: issues.length === 0 ? 1 : 0,
      expected: 0,
      got: parsed.entries.length,
      issues,
    };
  }

  if (parsed.bukan_transaksi && scenario.expectEntries.length > 0) {
    issues.push("marked bukan_transaksi but expected entries");
  }

  const expected = scenario.expectEntries;
  const gotEntries = [...parsed.entries];
  const used = new Set<number>();
  let matched = 0;

  for (const exp of expected) {
    const idx = gotEntries.findIndex((g, i) => !used.has(i) && entryMatches(g, exp));
    if (idx >= 0) {
      used.add(idx);
      matched++;
    } else {
      issues.push(
        `missing/unmatched expected: ${exp.type} ${exp.jumlah} [${exp.deskripsiIncludes?.join(",") ?? ""}]`,
      );
    }
  }

  // Special case: zakat 4 orang — accept 4x45rb OR 1x180rb
  if (scenario.id === "zakat-fitrah-keluarga" && matched < expected.length) {
    const total = gotEntries.reduce((s, e) => s + (e.type === "pengeluaran" ? e.jumlah : 0), 0);
    const count45 = gotEntries.filter((e) => e.jumlah === 45000).length;
    if (total === 180000 || count45 === 4) {
      matched = expected.length;
      issues.length = 0;
    }
  }

  // Special case: user bakmi — accept 2 entries @12rb OR 1 entry @24rb with qty note
  let altPass = false;
  if (scenario.id === "user-example-maren-bakmi") {
    const sarden = gotEntries.filter((e) => normalizeText(e.deskripsi).includes("sarden"));
    const bakmi = gotEntries.filter((e) => normalizeText(e.deskripsi).includes("bakmi"));
    const bakmiTotal = bakmi.reduce((s, e) => s + e.jumlah, 0);
    if (
      sarden.length >= 1 &&
      sarden[0]?.jumlah === 12000 &&
      (bakmiTotal === 24000 || bakmi.filter((b) => b.jumlah === 12000).length === 2)
    ) {
      altPass = true;
      matched = expected.length;
      issues.length = 0;
      if (bakmiTotal === 24000 && bakmi.length === 1) {
        issues.push("(alt) bakmi merged as 24rb single entry — acceptable");
      }
    }
  }

  const extra = altPass ? [] : gotEntries.filter((_, i) => !used.has(i));
  if (extra.length > 0) {
    issues.push(
      `extra entries: ${extra.map((e) => `${e.type} ${e.jumlah} "${e.deskripsi}"`).join("; ")}`,
    );
  }

  const pass =
    (altPass || (matched === expected.length && extra.length === 0)) &&
    issues.filter((i) => !i.startsWith("(alt)")).length === 0;

  return { pass, matched, expected: expected.length, got: gotEntries.length, issues };
}

function parseArgs(argv: string[]) {
  let model = DEFAULT_MODEL;
  let limit: number | undefined;
  let dryRun = false;
  let suite: Suite = "all";
  let models: string[] | undefined;
  let baseUrl: string | undefined;
  let apiKey: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model" && argv[i + 1]) model = argv[++i] ?? model;
    else if (a === "--models" && argv[i + 1]) {
      models = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    }
    else if (a === "--limit" && argv[i + 1]) limit = Number(argv[++i]);
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--base-url" && argv[i + 1]) baseUrl = argv[++i];
    else if (a === "--api-key" && argv[i + 1]) apiKey = argv[++i];
    else if (a === "--suite" && argv[i + 1]) {
      const s = argv[++i];
      if (s === "base" || s === "stress" || s === "all") suite = s;
    }
  }
  return { model, limit, dryRun, suite, models, baseUrl, apiKey };
}

export interface ParseMessageOptions {
  /** Override default system prompt (for prompt-tuning evals). */
  systemPrompt?: string;
  /** Prepended to user message (e.g. lightweight datetime anchor). */
  userPrefix?: string;
  /**
   * Rethrow the structured-output error instead of retrying as plain JSON.
   *
   * The plain-json path runs `parseFinanceJson`, whose normalizers coerce rather
   * than reject (unknown `type` becomes "pengeluaran", `bukan_transaksi` is
   * inferred). That leniency is correct when grading a model and wrong when
   * minting a gold label, so SFT generation opts out. Bench callers leave it
   * unset and keep the fallback.
   */
  noFallback?: boolean;
  /** Abort the underlying generation after this signal fires. */
  abortSignal?: AbortSignal;
}

export async function parseMessage(
  modelId: string,
  text: string,
  options?: ParseMessageOptions,
): Promise<{ parsed: ParsedFinance; ms: number; path: "structured" | "plain-json" }> {
  const systemPrompt = options?.systemPrompt ?? SYSTEM_PROMPT;
  const prompt = options?.userPrefix ? `${options.userPrefix}\n\n${text}` : text;
  const t0 = Date.now();
  const model = resolveModel(modelId);
  const genBase = {
    model,
    system: systemPrompt,
    prompt,
    temperature: 0,
    maxOutputTokens: 2048,
    abortSignal: options?.abortSignal,
  };

  try {
    const { output } = await generateText({
      ...genBase,
      output: Output.object({ schema: financeParseSchema }),
    });
    return { parsed: output, ms: Date.now() - t0, path: "structured" };
  } catch (err) {
    if (options?.noFallback) throw err;
    const r = await generateText({
      ...genBase,
      system: `${systemPrompt}\n\nKembalikan HANYA JSON valid sesuai schema. Tanpa markdown fence.`,
    });
    const parsed = parseFinanceJson(r.text);
    return { parsed, ms: Date.now() - t0, path: "plain-json" };
  }
}

interface EvalRunResult {
  modelId: string;
  passCount: number;
  total: number;
  meanMs: number;
  byStyle: Map<ChatStyle, { pass: number; total: number }>;
  failures: Array<{ id: string; issues: string[] }>;
}

async function runEval(modelId: string, scenarios: Scenario[]): Promise<EvalRunResult> {
  console.log(`\n${"=".repeat(72)}`);
  console.log(`Model: ${modelId}`);
  console.log(`Base URL: ${getLlmConfig().baseURL}`);
  console.log(`Scenarios: ${scenarios.length}\n`);

  const byStyle = new Map<ChatStyle, { pass: number; total: number }>();
  let passCount = 0;
  let totalMs = 0;
  const failures: EvalRunResult["failures"] = [];

  for (const scenario of scenarios) {
    try {
      const { parsed, ms } = await parseMessage(modelId, scenario.text);
      totalMs += ms;
      const score = scoreExtraction(parsed, scenario);
      const mark = score.pass ? "✓" : "✗";
      console.log(`${mark} [${scenario.style.padEnd(16)}] ${ms.toString().padStart(5)}ms — ${scenario.id}`);
      if (!score.pass) {
        console.log(`    issues: ${score.issues.join(" | ")}`);
        console.log(`    got: ${JSON.stringify(parsed.entries)}`);
        failures.push({ id: scenario.id, issues: score.issues });
      } else if (score.issues.length > 0) {
        console.log(`    note: ${score.issues.join(" | ")}`);
      }
      if (score.pass) passCount++;

      const bucket = byStyle.get(scenario.style) ?? { pass: 0, total: 0 };
      bucket.total++;
      if (score.pass) bucket.pass++;
      byStyle.set(scenario.style, bucket);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`✗ [${scenario.style.padEnd(16)}]  FAIL — ${scenario.id}`);
      console.log(`    error: ${msg}`);
      failures.push({ id: scenario.id, issues: [msg] });
      const bucket = byStyle.get(scenario.style) ?? { pass: 0, total: 0 };
      bucket.total++;
      byStyle.set(scenario.style, bucket);
    }
  }

  const meanMs = scenarios.length > 0 ? totalMs / scenarios.length : 0;
  console.log(`\n--- ${modelId} ---`);
  console.log(`Pass: ${passCount}/${scenarios.length} (${((passCount / scenarios.length) * 100).toFixed(1)}%)`);
  console.log(`Mean latency: ${meanMs.toFixed(0)}ms`);
  console.log("By style:");
  for (const [style, { pass, total }] of [...byStyle.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${style.padEnd(18)} ${pass}/${total}`);
  }

  return { modelId, passCount, total: scenarios.length, meanMs, byStyle, failures };
}

async function main() {
  const { model, limit, dryRun, suite, models: modelsArg, baseUrl, apiKey } = parseArgs(
    process.argv.slice(2),
  );
  applyLlmConfigOverrides({ baseUrl, apiKey });
  const allScenarios = scenariosForSuite(suite);
  const scenarios = limit ? allScenarios.slice(0, limit) : allScenarios;
  const models = modelsArg?.length ? modelsArg : [model];

  console.log(`\n=== Indonesian Finance Parse Eval ===`);
  console.log(`Base URL: ${getLlmConfig().baseURL}`);
  console.log(`Suite: ${suite} (${scenarios.length} scenarios)`);

  if (dryRun) {
    for (const s of scenarios) {
      console.log(`[dry] ${s.id} (${s.style}): ${s.text.slice(0, 60)}...`);
    }
    return;
  }

  const results: EvalRunResult[] = [];
  for (const m of models) {
    results.push(await runEval(m, scenarios));
  }

  if (results.length > 1) {
    console.log(`\n${"=".repeat(72)}`);
    console.log("=== HEAD-TO-HEAD ===");
    for (const r of results) {
      console.log(
        `  ${r.modelId.padEnd(32)} ${r.passCount}/${r.total} (${((r.passCount / r.total) * 100).toFixed(1)}%)  ~${r.meanMs.toFixed(0)}ms`,
      );
    }
    const best = [...results].sort((a, b) => b.passCount - a.passCount || a.meanMs - b.meanMs)[0];
    if (best) {
      console.log(`\nWinner on accuracy: ${best.modelId} (${best.passCount}/${best.total})`);
    }
  }
}


if (import.meta.main) {
  main().catch((err) => {
    console.error("FATAL:", err);
    process.exit(1);
  });
}
