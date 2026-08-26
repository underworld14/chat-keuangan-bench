/**
 * Batch helpers for SFT generation: pack N RowSpecs into one text-generation call,
 * and N texts into one blind labeling call. Mapping is always by planIndex id — never by
 * array position — so a reordered or truncated teacher response can still salvage the
 * items that landed correctly.
 */

import { z } from "zod";
import {
  financeParseBatchSchema,
  financeParseSchema,
  type ParsedFinance,
} from "../../src/core/eval-core.ts";
import { buildTextPrompt, textTeacherSystemRules, type RowSpec } from "./sft-spec.ts";
import type { RejectPhase } from "./sft-validate.ts";

/** One text item the teacher returns for a planned row. */
export const batchTextItemSchema = z.object({
  id: z.number().int().nonnegative(),
  text: z.string().min(1),
});

export const batchTextResponseSchema = z.object({
  items: z.array(batchTextItemSchema),
});

export type BatchTextItem = z.infer<typeof batchTextItemSchema>;
export type BatchTextResponse = z.infer<typeof batchTextResponseSchema>;

/** Re-export the eval-core batch label schema so callers share one source of truth. */
export const batchLabelResponseSchema = financeParseBatchSchema;
export const batchLabelItemSchema = z.object({
  id: z.number().int().nonnegative(),
  label: financeParseSchema,
});

export type BatchLabelItem = z.infer<typeof batchLabelItemSchema>;
export type BatchLabelResponse = z.infer<typeof financeParseBatchSchema>;

export type MappedOk<T> = { id: number; value: T };
export type MappedFail = { id: number; phase: RejectPhase; message: string };

/**
 * Partition a teacher/labeler response against the expected id set.
 *
 * Rules:
 *  - unknown id → discarded (does not create a reject for a phantom planIndex)
 *  - duplicate id → both copies fail; neither is salvaged
 *  - missing expected id → fail for that id
 *  - present unique expected id → ok
 *
 * Order in `raw` is irrelevant.
 */
export function mapById<T extends { id: number }>(
  expectedIds: readonly number[],
  raw: readonly T[],
): { ok: T[]; fail: MappedFail[] } {
  const expected = new Set(expectedIds);
  const byId = new Map<number, T[]>();
  for (const item of raw) {
    if (!expected.has(item.id)) continue;
    const list = byId.get(item.id) ?? [];
    list.push(item);
    byId.set(item.id, list);
  }

  const ok: T[] = [];
  const fail: MappedFail[] = [];

  for (const id of expectedIds) {
    const hits = byId.get(id) ?? [];
    if (hits.length === 0) {
      fail.push({ id, phase: "batch:missing", message: `id ${id} missing from batch response` });
      continue;
    }
    if (hits.length > 1) {
      fail.push({
        id,
        phase: "batch:duplicate",
        message: `id ${id} appeared ${hits.length} times in batch response`,
      });
      continue;
    }
    ok.push(hits[0]!);
  }

  return { ok, fail };
}

/**
 * Shared system prompt for the text-generation stage.
 * Reuses the single-item BAGUS/JELEK rules, then adds batch JSON framing on top.
 */
export function batchTextSystemPrompt(): string {
  return [
    "Kamu menulis pesan yang dikirim user ke AI/bot pencatat keuangan berbahasa Indonesia.",
    textTeacherSystemRules(),
    "",
    "BATCH MODE: kamu akan menerima beberapa brief bernomor. Untuk SETIAP brief, tulis PERSIS SATU pesan.",
    "Kembalikan JSON object dengan bentuk:",
    '{ "items": [ { "id": <nomor brief>, "text": "<satu baris pesan>" }, ... ] }',
    "- Sertakan SEMUA id yang diminta, masing-masing tepat sekali.",
    "- Field text mengikuti Aturan keras di atas (satu baris, tanpa JSON di dalam text).",
  ].join("\n");
}

/**
 * Build the user prompt for a text-generation batch. Each brief keeps the same constraints
 * as the single-item `buildTextPrompt`, keyed by `planIndex` so the response can be remapped.
 */
export function buildBatchTextPrompt(specs: readonly RowSpec[]): { system: string; user: string } {
  const system = batchTextSystemPrompt();
  const blocks = specs.map((spec) => {
    const { user } = buildTextPrompt(spec);
    return [`### Brief id=${spec.planIndex}`, user].join("\n");
  });
  const user = [
    `Tulis ${specs.length} pesan. Kembalikan JSON { "items": [...] } dengan id yang sama.`,
    "",
    ...blocks,
  ].join("\n");
  return { system, user };
}

/**
 * Blind user-payload builder for tests / dry inspection.
 * Production labeling goes through `parseMessagesBatch`, which wraps the full SYSTEM_PROMPT
 * with BATCH MODE framing — same blindness guarantee (id + text only; no specs).
 */
export function buildBatchLabelPrompt(
  items: ReadonlyArray<{ id: number; text: string }>,
): { system: string; user: string } {
  const system = [
    "Anda adalah parser pencatatan keuangan untuk pengguna Indonesia.",
    "Untuk SETIAP pesan di bawah, ekstrak transaksi yang SUDAH TERJADI ke skema finance JSON.",
    "Kembalikan JSON object:",
    '{ "items": [ { "id": <sama dengan input>, "label": { "entries": [...], "bukan_transaksi": bool, "ringkasan": string|null } }, ... ] }',
    "Sertakan SEMUA id, masing-masing tepat sekali. Jangan ubah id. Jangan menambah id lain.",
  ].join("\n");

  const lines = items.map((it) => `### id=${it.id}\n${it.text}`);
  const user = [
    `Parse ${items.length} pesan. Kembalikan JSON { "items": [...] }.`,
    "",
    ...lines,
  ].join("\n\n");
  return { system, user };
}

/**
 * Token budget for a text-generation batch. One short WA message is ~30–80 tokens; with
 * reasoning overhead, 128/item leaves headroom without inviting novels.
 */
export function textBatchMaxTokens(batchSize: number): number {
  return Math.max(256, batchSize * 128);
}

/**
 * Token budget for a label batch. A finance label is denser than a chat line; 256/item
 * covers multi-entry rows plus structured-output wrappers.
 */
export function labelBatchMaxTokens(batchSize: number): number {
  return Math.max(2048, batchSize * 256);
}

/** Chunk a plan into batches of at most `batchSize`, preserving order. Last chunk may be short. */
export function chunkPlan<T>(items: readonly T[], batchSize: number): T[][] {
  if (batchSize <= 0) throw new Error(`batchSize must be positive, got ${batchSize}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    out.push(items.slice(i, i + batchSize));
  }
  return out;
}

/**
 * Pure claim step for the batch worker pool. Encodes the no-overshoot invariant:
 * never reserve more than `count - accepted - inFlight` slots; return `"wait"` while
 * siblings may still free capacity or append rerolls.
 */
export type ClaimBatchInput = {
  aborted: boolean;
  accepted: number;
  count: number;
  inFlight: number;
  batchSize: number;
  cursor: number;
  done: ReadonlySet<number>;
};

export type ClaimBatchResult<T extends { planIndex: number }> =
  | { kind: "batch"; items: T[]; nextCursor: number; reserved: number }
  | { kind: "wait" }
  | { kind: "done" };

export function claimBatchFromPlan<T extends { planIndex: number }>(
  state: ClaimBatchInput,
  plan: readonly T[],
): ClaimBatchResult<T> {
  if (state.aborted || state.accepted >= state.count) return { kind: "done" };
  const remaining = state.count - state.accepted - state.inFlight;
  if (remaining <= 0) return state.inFlight > 0 ? { kind: "wait" } : { kind: "done" };
  if (state.batchSize <= 0) throw new Error(`batchSize must be positive, got ${state.batchSize}`);

  const want = Math.min(state.batchSize, remaining);
  const items: T[] = [];
  let cursor = state.cursor;
  while (items.length < want && cursor < plan.length) {
    const spec = plan[cursor++]!;
    if (state.done.has(spec.planIndex)) continue;
    items.push(spec);
  }
  if (items.length === 0) {
    return state.inFlight > 0 ? { kind: "wait" } : { kind: "done" };
  }
  return { kind: "batch", items, nextCursor: cursor, reserved: items.length };
}

/** Normalize a single text item the same way the single-row path does. */
export function normalizeBatchText(raw: string): string {
  // Strip wrapping quotes both before and after the first-line cut: a teacher that
  // returns `"pesan"\nnote` leaves a trailing quote if we only strip once up front.
  const first = raw.trim().split("\n")[0]?.trim() ?? "";
  return first.replace(/^["'`]+|["'`]+$/g, "").trim();
}

export type SalvagedText = { id: number; text: string };
export type SalvagedLabel = { id: number; label: ParsedFinance };

/**
 * After a text-batch response: map by id, normalize texts, and surface empty texts as fails
 * so the scheduler can reroll those cells without discarding the rest of the batch.
 */
export function salvageTextBatch(
  expectedIds: readonly number[],
  response: BatchTextResponse,
): { ok: SalvagedText[]; fail: MappedFail[] } {
  const mapped = mapById(expectedIds, response.items);
  const ok: SalvagedText[] = [];
  const fail = [...mapped.fail];
  for (const item of mapped.ok) {
    const text = normalizeBatchText(item.text);
    if (text.length < 3) {
      fail.push({ id: item.id, phase: "text:bijection", message: "teacher returned an empty message" });
      continue;
    }
    ok.push({ id: item.id, text });
  }
  return { ok, fail };
}

/** After a label-batch response: map by id; schema validation already happened upstream. */
export function salvageLabelBatch(
  expectedIds: readonly number[],
  response: BatchLabelResponse,
): { ok: SalvagedLabel[]; fail: MappedFail[] } {
  const mapped = mapById(expectedIds, response.items);
  return {
    ok: mapped.ok.map((item) => ({ id: item.id, label: item.label })),
    fail: mapped.fail,
  };
}
