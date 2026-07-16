/**
 * Programmatic gates for SFT rows. Every check here is free — no GPU, no model call.
 *
 * The rule this module exists to enforce: NEVER route a candidate label through
 * `parseFinanceJson`. That function normalizes before it validates, which is right for
 * *grading* a sloppy model and catastrophic for *minting* a gold label. Measured: feed it
 * `{type:"makan", jumlah:"25rb", confidence:0.9}` and it returns a schema-valid
 * `{type:"pengeluaran", jumlah:25000, confidence:"high"}` — every field invented, silently.
 * The raw schema rejects the same input. So we validate against the raw schema, strictly.
 */

import { z } from "zod";
import { financeParseSchema, type ParsedFinance } from "../../src/core/eval-core.ts";
import {
  hasAmbiguousAmount,
  tokenizeAmounts,
  traceAmount,
  unexcusedAtoms,
  type AmountAtom,
  type TraceTier,
} from "../../src/core/rupiah.ts";

type DateHint = ParsedFinance["entries"][number]["tanggal_hint"];

/** Rejecting an entry that legitimately repeats (4 × cilok @5rb) would gut the best cells. */
export type RowShape = { allowDuplicateEntries?: boolean };

const MAX_DESKRIPSI_WORDS = 8;

function crossFieldRules(v: ParsedFinance, ctx: z.RefinementCtx, shape: RowShape = {}): void {
  // Biconditional, not one-way: "no entries" and "not a transaction" must mean each other,
  // or the student learns two conflicting ways to say nothing happened.
  if (v.bukan_transaksi !== (v.entries.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["bukan_transaksi"],
      message: `bukan_transaksi=${v.bukan_transaksi} but entries.length=${v.entries.length}`,
    });
  }

  v.entries.forEach((e, i) => {
    if (e.jumlah <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", i, "jumlah"], message: "jumlah must be > 0" });
    }
    if (e.ambigu && !e.catatan_ambigu) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", i, "catatan_ambigu"], message: "ambigu=true requires catatan_ambigu" });
    }
    if (!e.ambigu && e.catatan_ambigu) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", i, "ambigu"], message: "catatan_ambigu set but ambigu=false" });
    }
    if (e.ambigu && e.confidence === "high") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", i, "confidence"], message: "ambigu=true contradicts confidence=high" });
    }
    if (e.deskripsi.trim().length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", i, "deskripsi"], message: "deskripsi must not be empty" });
    }
    // SYSTEM_PROMPT asks for a short label, not a sentence. A lazy teacher echoes the message.
    if (e.deskripsi.trim().split(/\s+/).length > MAX_DESKRIPSI_WORDS) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", i, "deskripsi"], message: `deskripsi longer than ${MAX_DESKRIPSI_WORDS} words` });
    }
    if (e.kategori && e.kategori === e.deskripsi) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", i, "kategori"], message: "kategori duplicates deskripsi" });
    }
    // KBBI lusa = the day after tomorrow. SYSTEM_PROMPT extracts only what already happened
    // and rules future intent non-transactional, so a correct parse can never reach it.
    if (e.tanggal_hint === "lusa") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", i, "tanggal_hint"], message: "lusa is future — a past transaction cannot carry it" });
    }
  });

  if (!shape.allowDuplicateEntries) {
    const seen = new Set<string>();
    v.entries.forEach((e, i) => {
      const key = JSON.stringify(e);
      if (seen.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["entries", i], message: "duplicate entry (set allowDuplicateEntries for qty-split cells)" });
      }
      seen.add(key);
    });
  }
}

/** `.strict()` must come before `.superRefine()` — superRefine returns ZodEffects, which has no .strict(). */
export function buildStrictSchema(shape: RowShape = {}) {
  const strictEntry = financeParseSchema.shape.entries.element.strict();
  return financeParseSchema
    .extend({ entries: z.array(strictEntry) })
    .strict()
    .superRefine((v, ctx) => crossFieldRules(v, ctx, shape));
}

export const strictFinanceSchema = buildStrictSchema();

export type RejectPhase =
  | "text:leak"
  | "text:ambiguous-amount"
  | "text:bijection"
  | "label:plain-json"
  | "label:schema"
  | "label:trace"
  | "label:dropped-entry"
  | "agreement"
  | "dedup";

export class RejectError extends Error {
  constructor(
    readonly phase: RejectPhase,
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
    this.name = "RejectError";
  }
}

/** Every label amount must be justified by the text. Catches hallucinated amounts. */
export function guardTrace(
  label: ParsedFinance,
  atoms: AmountAtom[],
): { tiers: TraceTier[] } {
  const tiers: TraceTier[] = [];
  for (const e of label.entries) {
    const t = traceAmount(e.jumlah, atoms);
    if (t.tier === "none") {
      throw new RejectError(
        "label:trace",
        `jumlah ${e.jumlah} ("${e.deskripsi}") is not traceable to the text`,
        { jumlah: e.jumlah, atoms: atoms.map((a) => a.raw) },
      );
    }
    tiers.push(t.tier);
  }
  return { tiers };
}

/**
 * Money in the text but not in the label, with no cue explaining the omission.
 * Catches DROPPED entries — invisible to forward tracing, and the worse poison for a ledger.
 */
export function guardDroppedEntries(text: string, atoms: AmountAtom[], label: ParsedFinance): void {
  const consumed = new Set(label.entries.map((e) => e.jumlah));
  const unexcused = unexcusedAtoms(text, atoms, consumed);
  if (unexcused.length > 0) {
    throw new RejectError(
      "label:dropped-entry",
      `text mentions ${unexcused.map((u) => u.atom.raw).join(", ")} with no entry and no koreksi/future/batal/share/diskon cue`,
      { dropped: unexcused.map((u) => ({ raw: u.atom.raw, value: u.atom.value })) },
    );
  }
}

export function guardAmbiguousText(atoms: AmountAtom[]): void {
  if (hasAmbiguousAmount(atoms)) {
    const bad = atoms.filter((a) => a.kind === "suspect-dot-suffix");
    throw new RejectError(
      "text:ambiguous-amount",
      `unresolvable amount ${bad.map((a) => `"${a.raw}"`).join(", ")} — dot-thousands plus a multiplier`,
    );
  }
}

/**
 * What the seeded RNG ordered. Structural fields only — the spec owns these, and the
 * blind parse must agree. Soft fields (deskripsi/kategori/vendor/ringkasan) come from the parse.
 *
 * Kept as its own shape rather than the taxonomy's Cell so validation has no taxonomy import,
 * and deliberately NOT reusing `scoreExtraction`: that takes a full Scenario and mutates its
 * behavior on two magic ids ("zakat-fitrah-keluarga", "user-example-maren-bakmi"), so a
 * synthetic id could silently change scoring. It also carries bench grading leniency
 * (jumlahMin/Max, deskripsiIncludes.some) — the same leniency-vs-minting mismatch as
 * parseFinanceJson, one layer up.
 */
export type ExpectedEntry = {
  direction: "pengeluaran" | "pemasukan";
  amount: number;
  dateHint?: DateHint;
  ambigu?: boolean;
};

export type LabelExpectation = {
  nonTransaction: boolean;
  /**
   * Entry sets, any ONE of which is correct. Usually a single alternative, but qty cells
   * genuinely admit two readings — "5 lusin @40rb" is right as 5×40000 or as 1×200000, and
   * the bench's own altStrict rule says so. Forcing one would reject a correct label.
   * Diffs are reported against alternatives[0], the canonical form.
   */
  alternatives: ExpectedEntry[][];
  /** Amounts present in the text that must NOT be booked (gross price, superseded value). */
  absentAmounts?: number[];
};

export type AgreementDiff = {
  field: "bukan_transaksi" | "count" | "type" | "jumlah" | "tanggal_hint" | "ambigu" | "amount_absent";
  expected: unknown;
  got: unknown;
};

export type AgreementReport = { ok: boolean; diffs: AgreementDiff[] };

/** Order-insensitive: the teacher may list entries in any order. */
function matchAlternative(label: ParsedFinance, want: ExpectedEntry[]): AgreementDiff[] {
  const diffs: AgreementDiff[] = [];
  if (label.entries.length !== want.length) {
    return [{ field: "count", expected: want.length, got: label.entries.length }];
  }

  const remaining = [...label.entries];
  for (const w of want) {
    const idx = remaining.findIndex((e) => e.jumlah === w.amount && e.type === w.direction);
    if (idx === -1) {
      const byAmount = remaining.find((e) => e.jumlah === w.amount);
      if (byAmount) {
        diffs.push({ field: "type", expected: `${w.direction}@${w.amount}`, got: `${byAmount.type}@${byAmount.jumlah}` });
      } else {
        diffs.push({ field: "jumlah", expected: w.amount, got: remaining.map((e) => e.jumlah) });
      }
      continue;
    }
    const got = remaining[idx]!;
    if (w.dateHint !== undefined && got.tanggal_hint !== w.dateHint) {
      diffs.push({ field: "tanggal_hint", expected: w.dateHint, got: got.tanggal_hint });
    }
    if (w.ambigu !== undefined && got.ambigu !== w.ambigu) {
      diffs.push({ field: "ambigu", expected: w.ambigu, got: got.ambigu });
    }
    remaining.splice(idx, 1);
  }
  return diffs;
}

export function compareLabelToSpec(label: ParsedFinance, spec: LabelExpectation): AgreementReport {
  if (label.bukan_transaksi !== spec.nonTransaction) {
    return { ok: false, diffs: [{ field: "bukan_transaksi", expected: spec.nonTransaction, got: label.bukan_transaksi }] };
  }

  // An absent amount is wrong under EVERY reading, so check it before the alternatives.
  const absentDiffs: AgreementDiff[] = [];
  for (const absent of spec.absentAmounts ?? []) {
    if (label.entries.some((e) => e.jumlah === absent)) {
      absentDiffs.push({ field: "amount_absent", expected: `${absent} must not be booked`, got: absent });
    }
  }
  if (absentDiffs.length > 0) return { ok: false, diffs: absentDiffs };

  const alternatives = spec.alternatives.length > 0 ? spec.alternatives : [[]];
  let best: AgreementDiff[] | null = null;
  for (const alt of alternatives) {
    const diffs = matchAlternative(label, alt);
    if (diffs.length === 0) return { ok: true, diffs: [] };
    if (best === null) best = diffs; // report against the canonical alternative
  }
  return { ok: false, diffs: best ?? [] };
}

/** Full free validation for one candidate row. Throws RejectError on the first failure. */
export function validateRow(args: {
  text: string;
  label: ParsedFinance;
  spec: LabelExpectation;
  shape?: RowShape;
}): { atoms: AmountAtom[]; traceTiers: TraceTier[] } {
  const atoms = tokenizeAmounts(args.text);
  guardAmbiguousText(atoms);

  const parsed = buildStrictSchema(args.shape).safeParse(args.label);
  if (!parsed.success) {
    throw new RejectError("label:schema", "label failed strict validation", parsed.error.issues);
  }

  const { tiers } = guardTrace(args.label, atoms);
  guardDroppedEntries(args.text, atoms, args.label);

  const agree = compareLabelToSpec(args.label, args.spec);
  if (!agree.ok) {
    const first = agree.diffs[0]!;
    throw new RejectError("agreement", `blind parse disagrees with spec on ${first.field}`, agree.diffs);
  }

  return { atoms, traceTiers: tiers };
}
