/**
 * Every text this repo scores a model on, in one place.
 *
 * Exists so the SFT leak guard can check generated data against the WHOLE benchmark
 * rather than just hard-25. Before this, the guard covered 25 of ~89 scored items:
 * a generated line reusing a base-suite text (e.g. "top up gopay 100k") was
 * structurally unreachable, and the eval it leaked into was our own.
 *
 * Nothing here is a training input. The taxonomy must NOT import this module —
 * only the leak guard may, so that no bench wording can flow into a teacher prompt.
 */

import { SCENARIOS, STRESS_SCENARIOS } from "./eval-core.ts";
import { AGENTIC_HARD_20 } from "../agentic/scenarios/hard-20.ts";
import { AGENTIC_HARD_PLUS } from "../agentic/scenarios/hard-plus.ts";
import { HARD_SCENARIOS as HARD_12 } from "../../scripts/eval-hard-12.ts";
import { HARD_SCENARIOS as HARD_25 } from "../../scripts/eval-hard-25.ts";

export type ScoredText = {
  /** Which suite the text belongs to — for reporting which corpus a leak hit. */
  suite: "base" | "stress" | "hard-12" | "hard-25" | "agentic-hard-20" | "agentic-hard-plus";
  id: string;
  text: string;
  /** Gold amounts, when the suite asserts them. Numbers leak harder than wording. */
  amounts: number[];
};

function fromParseSuite(
  suite: Extract<ScoredText["suite"], "base" | "stress" | "hard-12" | "hard-25">,
  scenarios: ReadonlyArray<{ id: string; text: string; expectEntries: ReadonlyArray<{ jumlah: number }> }>,
): ScoredText[] {
  return scenarios.map((s) => ({
    suite,
    id: s.id,
    text: s.text,
    amounts: s.expectEntries.map((e) => e.jumlah),
  }));
}

function fromAgenticSuite(
  suite: Extract<ScoredText["suite"], "agentic-hard-20" | "agentic-hard-plus">,
  scenarios: ReadonlyArray<{ id: string; turns: ReadonlyArray<{ role: string; content: string }> }>,
): ScoredText[] {
  return scenarios.flatMap((s) =>
    s.turns
      .filter((t) => t.role === "user")
      .map((t, i) => ({
        suite,
        id: `${s.id}#turn${i + 1}`,
        text: t.content,
        amounts: [],
      })),
  );
}

/** Every scored text across every suite. */
export const ALL_SCORED_TEXTS: ScoredText[] = [
  ...fromParseSuite("base", SCENARIOS),
  ...fromParseSuite("stress", STRESS_SCENARIOS),
  ...fromParseSuite("hard-12", HARD_12),
  ...fromParseSuite("hard-25", HARD_25),
  ...fromAgenticSuite("agentic-hard-20", AGENTIC_HARD_20),
  ...fromAgenticSuite("agentic-hard-plus", AGENTIC_HARD_PLUS),
];

/** Distinct gold amounts across every suite that asserts them. */
export const ALL_SCORED_AMOUNTS: ReadonlySet<number> = new Set(
  ALL_SCORED_TEXTS.flatMap((t) => t.amounts),
);

export function corpusCounts(): Record<ScoredText["suite"], number> {
  const out = {} as Record<ScoredText["suite"], number>;
  for (const t of ALL_SCORED_TEXTS) out[t.suite] = (out[t.suite] ?? 0) + 1;
  return out;
}
