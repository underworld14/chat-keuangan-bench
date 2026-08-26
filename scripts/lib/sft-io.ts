/**
 * Durable I/O for the SFT generator.
 *
 * Design rule: `raw.jsonl` is append-only and NEVER truncated; the split files are a pure
 * function of it. Resume, determinism, and "a dead server cannot destroy yesterday's corpus"
 * all fall out of that one property. The old generator called `writeFileSync(out, "")`
 * before its first API call, so a run against a stopped LM Studio zeroed the dataset — and
 * because data/sft is gitignored, it was unrecoverable.
 */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { ParsedFinance } from "../../src/core/eval-core.ts";
import { LeakError } from "../../src/core/parse-leakguard.ts";
import { RejectError } from "./sft-validate.ts";

export type RowSplit = "train" | "eval_iid" | "eval_compositional";

/** One accepted sample, with everything needed to rebuild the splits and audit the run. */
export type RawRow = {
  planIndex: number;
  cellId: string;
  aspect: string;
  tier: string;
  split: RowSplit;
  text: string;
  label: ParsedFinance;
  meta: {
    traceTiers: string[];
    maxSimilarity: number;
    systemPromptMode: SystemPromptMode;
    teacher: string;
    textMs: number;
    labelMs: number;
  };
};

export type SystemPromptMode = "full" | "short" | "none";

export type RejectRow = {
  planIndex: number;
  cellId: string;
  phase: string;
  message: string;
  issues?: unknown;
  text?: string;
  rawContent?: string;
};

/**
 * Build the on-disk record for a failed attempt.
 *
 * `text` is the whole point. The generator used to omit it, so rejects.jsonl carried the
 * verdict and not the evidence: every agreement reject read `"text": null`, and answering
 * "is the teacher wrong, or is the spec wrong?" — the only question that matters, since the
 * blind parse is frequently the one that is right — meant rebuilding the cell's prompt by hand.
 */
export function toRejectRow(
  spec: { planIndex: number; cellId: string },
  err: unknown,
  text: string | null,
): RejectRow {
  const phase =
    err instanceof RejectError ? err.phase : err instanceof LeakError ? "text:leak" : "transport";
  return {
    planIndex: spec.planIndex,
    cellId: spec.cellId,
    phase,
    message: err instanceof Error ? err.message : String(err),
    ...(err instanceof RejectError && err.issues !== undefined ? { issues: err.issues } : {}),
    ...(text !== null ? { text } : {}),
  };
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Write via a temp file + rename so a crash can never leave a half-written split. */
export function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, path);
}

export function gitProvenance(): { gitSha: string; dirty: boolean } {
  try {
    const gitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { gitSha, dirty: status.trim().length > 0 };
  } catch {
    // A dataset with no code provenance is unreproducible, but that is not worth aborting on.
    return { gitSha: "unknown", dirty: true };
  }
}

/** Append-only sink. Opening it never truncates, so a failed run costs nothing. */
export class RawSink {
  private rows: RawRow[] = [];

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) this.rows = readRaw(path);
  }

  get count(): number {
    return this.rows.length;
  }

  /** planIndexes already accepted — lets a resumed run skip work instead of redoing it. */
  get donePlanIndexes(): Set<number> {
    return new Set(this.rows.map((r) => r.planIndex));
  }

  get all(): RawRow[] {
    return [...this.rows];
  }

  append(row: RawRow): void {
    appendFileSync(this.path, `${JSON.stringify(row)}\n`);
    this.rows.push(row);
  }
}

export function readRaw(path: string): RawRow[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as RawRow);
}

export class RejectSink {
  private n = 0;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  get count(): number {
    return this.n;
  }

  write(row: RejectRow): void {
    appendFileSync(this.path, `${JSON.stringify(row)}\n`);
    this.n++;
  }
}

export type ChatMlRow = { messages: Array<{ role: string; content: string }> };

/**
 * Short prompt for the `short` mode. The student still needs the money-direction rule —
 * it is the costliest error class — but not the full 862-token ruleset.
 */
export const SHORT_SYSTEM_PROMPT =
  "Ekstrak transaksi keuangan yang SUDAH TERJADI dari pesan chat Indonesia ke JSON " +
  "(entries[type/tanggal_hint/deskripsi/jumlah/kategori/vendor/confidence/ambigu/catatan_ambigu], " +
  "bukan_transaksi, ringkasan). type=pemasukan jika uang MASUK, pengeluaran jika KELUAR. " +
  "jumlah = integer Rupiah. Rencana/curhat → bukan_transaksi=true, entries=[].";

export function toChatMl(row: RawRow, fullSystemPrompt: string): ChatMlRow {
  const messages: Array<{ role: string; content: string }> = [];
  if (row.meta.systemPromptMode === "full") {
    messages.push({ role: "system", content: fullSystemPrompt });
  } else if (row.meta.systemPromptMode === "short") {
    messages.push({ role: "system", content: SHORT_SYSTEM_PROMPT });
  }
  messages.push({ role: "user", content: row.text });
  // Stable key order: JSON.stringify follows insertion order, and financeParseSchema.parse
  // rebuilds objects in declaration order, so serialization is deterministic across runs.
  messages.push({ role: "assistant", content: JSON.stringify(row.label) });
  return { messages };
}

/**
 * Route rows to files by the split their CELL was assigned.
 *
 * Splitting by cell rather than by row is deliberate: rows within a cell share the same
 * `nilai` and near-identical structure, so a row-level holdout measures memorization.
 * The taxonomy stratifies eval cells per aspect, so every aspect still keeps train cells —
 * whole-aspect holdout would leave the student never having seen e.g. slang.
 */
export function splitRows(rows: RawRow[]): Record<"train" | "valid" | "test", RawRow[]> {
  const ordered = [...rows].sort((a, b) => a.planIndex - b.planIndex);
  return {
    train: ordered.filter((r) => r.split === "train"),
    valid: ordered.filter((r) => r.split === "eval_iid"),
    test: ordered.filter((r) => r.split === "eval_compositional"),
  };
}

export type Manifest = Record<string, unknown>;

export function writeRun(args: {
  outDir: string;
  rows: RawRow[];
  fullSystemPrompt: string;
  manifest: Manifest;
  /** docs/results/sft — committed. The rows themselves stay gitignored. */
  publishDir: string;
  stamp: string;
}): { counts: Record<string, number>; manifestPaths: string[] } {
  const splits = splitRows(args.rows);
  const counts: Record<string, number> = {};

  for (const [name, rows] of Object.entries(splits)) {
    counts[name] = rows.length;
    const body = rows.map((r) => JSON.stringify(toChatMl(r, args.fullSystemPrompt))).join("\n");
    writeAtomic(join(args.outDir, `${name}.jsonl`), body.length ? `${body}\n` : "");
  }

  const manifestJson = JSON.stringify(args.manifest, null, 2);
  const local = join(args.outDir, "manifest.json");
  const pinned = join(args.publishDir, `${args.stamp}-sft-parse-manifest.json`);
  const latest = join(args.publishDir, "sft-parse-manifest-latest.json");
  for (const p of [local, pinned, latest]) writeAtomic(p, manifestJson);

  return { counts, manifestPaths: [local, pinned, latest] };
}
