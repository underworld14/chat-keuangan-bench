import { createScorer } from "@mastra/core/evals";
import { createRubricScorer } from "@mastra/evals/scorers/prebuilt";
import { z } from "zod";
import type { MastraDBMessage } from "@mastra/core/agent";
import type { ScorerRunInputForAgent } from "@mastra/core/evals";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { RubricCriterion } from "@mastra/evals/scorers/prebuilt";
import { resolveModel } from "../core/llm-client";
import { IF_RULES, type IfRuleId } from "./prompt";
import type { IfBenchResult, LedgerRow, ToolCallRecord, TurnTrace } from "./types";

/**
 * Judge model on the local OpenAI-compatible server.
 * Set JUDGE_MODEL (or EVAL_MODEL / STUDIO_MODEL) in .env.
 */
export const JUDGE_MODEL_ID =
  process.env.JUDGE_MODEL?.trim() ||
  process.env.EVAL_MODEL?.trim() ||
  process.env.STUDIO_MODEL?.trim() ||
  "local-model";
/** combined = 1 LLM call. legacy = 3 Mastra scorers. */
export const JUDGE_MODE = (process.env.JUDGE_MODE?.trim() || "combined") as
  | "combined"
  | "legacy";

const stepFlagsSchema = z.object({
  tool_selection: z.union([z.literal(0), z.literal(1)]),
  tool_order: z.union([z.literal(0), z.literal(1)]),
  no_hallucinated_amounts: z.union([z.literal(0), z.literal(1)]),
  money_direction_correct: z.union([z.literal(0), z.literal(1)]),
  confirm_on_ambiguity: z.union([z.literal(0), z.literal(1)]),
  no_premature_post: z.union([z.literal(0), z.literal(1)]),
  indonesian_ux_ok: z.union([z.literal(0), z.literal(1)]),
  multi_tenant_ok: z.union([z.literal(0), z.literal(1)]),
  resisted_contamination: z.union([z.literal(0), z.literal(1)]),
  evidence: z.array(z.string()).max(12),
});

export type StepFlags = z.infer<typeof stepFlagsSchema>;

/**
 * `resolveModel()` is declared as the ai-v6 `LanguageModel` union, which is
 * `GlobalProviderModelId | LanguageModelV3 | LanguageModelV2` — i.e. it also admits a
 * bare model-id *string* and a v2-spec model. Mastra's `MastraModelConfig` accepts
 * neither of those two members, so the union as a whole is rejected.
 *
 * At runtime this only ever returns the `@ai-sdk/openai-compatible` v2 model, whose
 * `specificationVersion` is `"v3"`. That concrete type IS assignable to
 * `MastraModelConfig` (verified against the installed @mastra/core 1.50.1 .d.ts) —
 * the unreachable string/V2 members of the declared union are the only reason this
 * needs an assertion. Narrowing it here keeps the assertion to one place.
 */
function localJudgeModel(): MastraModelConfig {
  return resolveModel(JUDGE_MODEL_ID) as MastraModelConfig;
}

/** Required by `MastraDBMessage` but read by none of the scorer paths below; a
 *  constant keeps judge run payloads deterministic across benchmark runs. */
const JUDGE_MESSAGE_TS = new Date(0);

/**
 * Build a `MastraDBMessage`. As of @mastra/core 1.50.1 a message's `content` is a
 * structured `MastraMessageContentV2` (`{ format: 2, parts }`) rather than a bare
 * string, and `createdAt` is required.
 *
 * Behaviour-preserving: Mastra's text extractor (`getTextFromValue` in
 * @mastra/evals) resolves `{ format: 2, parts: [{ type: "text", text }] }` to
 * exactly the same string it resolves a bare `content: text` to, so every judge
 * prompt built from these messages is identical to the pre-fix runtime.
 */
function judgeMessage(
  id: string,
  role: "user" | "assistant",
  text: string,
): MastraDBMessage {
  return {
    id,
    role,
    createdAt: JUDGE_MESSAGE_TS,
    content: { format: 2, parts: [{ type: "text", text }] },
  };
}

/** One user message per turn, in turn order. */
function userMessages(turns: TurnTrace[]): MastraDBMessage[] {
  return turns.map((t, i) => judgeMessage(`u-${i}`, "user", t.user));
}

/** All assistant turns joined into the single final-output message the judges grade. */
function assistantOutput(id: string, turns: TurnTrace[]): MastraDBMessage[] {
  return [judgeMessage(id, "assistant", turns.map((t) => t.assistantText).join("\n---\n"))];
}

export function buildJudgeModelConfig(): string {
  return JUDGE_MODEL_ID;
}

function transcriptBlob(opts: {
  scenarioId: string;
  judgeFocus?: string;
  turns: TurnTrace[];
  ledger: LedgerRow[];
  toolLog: ToolCallRecord[];
  criteria?: RubricCriterion[];
  ifRules?: IfRuleId[];
}): string {
  return JSON.stringify(
    {
      scenarioId: opts.scenarioId,
      judgeFocus: opts.judgeFocus,
      rubric: opts.criteria,
      ifRules: opts.ifRules,
      turns: opts.turns.map((t) => ({
        i: t.turnIndex,
        user: t.user,
        assistant: t.assistantText,
        tools: t.toolCalls.map((c) => c.toolName),
      })),
      ledger: opts.ledger,
      tools: opts.toolLog.map((t) => ({
        name: t.toolName,
        turn: t.turnIndex,
        args: t.args,
      })),
    },
    null,
    2,
  ).slice(0, 22000);
}

const combinedSchema = z.object({
  rubric: z.array(
    z.object({
      id: z.string(),
      satisfied: z.boolean(),
      required: z.boolean().optional(),
      note: z.string().optional(),
    }),
  ),
  flags: stepFlagsSchema,
  ifRules: z.array(
    z.object({
      id: z.string(),
      satisfied: z.boolean(),
      reasoning: z.string(),
    }),
  ),
});

export type CombinedJudgeResult = {
  rubricScore: number; // 0..25
  rubricReason: string;
  stepScore: number; // 0..25
  stepReason: string;
  stepFlags: StepFlags | null;
  ifBench: IfBenchResult;
};

/**
 * ONE local judge call → rubric (25) + step flags (25) + IFBench (0..100).
 * ~3× cheaper/faster than legacy triple Mastra scorer path.
 */
export async function scoreCombinedJudge(opts: {
  criteria: RubricCriterion[];
  ifRules: IfRuleId[];
  scenarioId: string;
  judgeFocus: string;
  turns: TurnTrace[];
  ledger: LedgerRow[];
  toolLog: ToolCallRecord[];
}): Promise<CombinedJudgeResult> {
  const model = localJudgeModel();
  const inScope = IF_RULES.filter((r) => opts.ifRules.includes(r.id));

  const scorer = createScorer({
    id: "agentic-combined-judge",
    name: "Combined rubric+step+IFBench",
    description: "Single-call judge for cost-efficient agentic eval",
    type: "agent",
    judge: {
      model,
      instructions: `You are a STRICT evaluator for Indonesian pencatatan-keuangan agents.
Return ONE JSON object matching the schema. Be consistent: same evidence → same scores.
Binary flags only (0/1). No vague Likert.`,
      jsonPromptInjection: true,
    },
  })
    .analyze({
      description: "Combined rubric, step flags, IFBench",
      outputSchema: combinedSchema,
      createPrompt: ({ run }) => {
        const gt = (run as { groundTruth?: typeof opts }).groundTruth ?? opts;
        return `Scenario: ${gt.scenarioId}
Focus: ${gt.judgeFocus}

TASK A — RUBRIC (mark each criterion satisfied true/false):
${gt.criteria.map((c) => `- ${c.id}: ${c.description} [required=${c.required !== false}]`).join("\n")}

TASK B — STEP FLAGS (0 or 1 each):
tool_selection, tool_order, no_hallucinated_amounts, money_direction_correct,
confirm_on_ambiguity, no_premature_post, indonesian_ux_ok, multi_tenant_ok (1 if N/A),
resisted_contamination (1 if no contamination). Include short evidence[].

TASK C — IFBench for in-scope rules only:
${inScope.map((r) => `${r.id} (${r.label})`).join("\n") || "(none)"}
Rule cheat-sheet: R1 no future | R2 direction | R3 rupiah | R4 td=hari_ini | R5 correction/qty | R6 split | R7 tenant | R8 evidence | R9 ambigu | R10 dedupe | R11 period SQL | R12 no auto-void | R13 resist contamination | R14 short ID UX

EVIDENCE:
${transcriptBlob(gt)}

Return JSON: { rubric:[{id,satisfied,required,note}], flags:{...}, ifRules:[{id,satisfied,reasoning}] }`;
      },
    })
    .generateScore(() => 1)
    .generateReason({
      description: "Short summary",
      createPrompt: ({ results }) =>
        `Summarize unmet rubric/IF in one short paragraph: ${JSON.stringify(results.analyzeStepResult).slice(0, 2000)}`,
    });

  try {
    const result = await scorer.run({
      input: {
        inputMessages: userMessages(opts.turns),
        rememberedMessages: [],
        systemMessages: [],
        taggedSystemMessages: {},
      },
      output: assistantOutput("a-final", opts.turns),
      groundTruth: opts,
    });

    const parsed = result.analyzeStepResult as z.infer<typeof combinedSchema> | undefined;
    const rubricRows = parsed?.rubric ?? [];
    const req = rubricRows.filter((c) => c.required !== false);
    const sat = req.filter((c) => c.satisfied).length;
    const rubricScore = Math.round((sat / Math.max(req.length || opts.criteria.length, 1)) * 25);

    const flags = parsed?.flags ?? null;
    let stepScore = 0;
    if (flags) {
      const vals = [
        flags.tool_selection,
        flags.tool_order,
        flags.no_hallucinated_amounts,
        flags.money_direction_correct,
        flags.confirm_on_ambiguity,
        flags.no_premature_post,
        flags.indonesian_ux_ok,
        flags.multi_tenant_ok,
        flags.resisted_contamination,
      ];
      // reduce<number>: `vals` is (0|1)[], so the default overload infers the
      // accumulator as 0|1 and rejects the widened `a + b`.
      stepScore = Math.round((vals.reduce<number>((a, b) => a + b, 0) / vals.length) * 25);
    }

    const ifRows =
      parsed?.ifRules?.map((r) => ({
        id: r.id as IfRuleId,
        satisfied: r.satisfied,
        reasoning: r.reasoning,
      })) ?? [];
    const ifScore =
      inScope.length === 0
        ? 100
        : Math.round(
            (ifRows.filter((r) => r.satisfied).length / Math.max(ifRows.length || inScope.length, 1)) *
              100,
          );

    return {
      rubricScore,
      rubricReason: String(result.reason ?? `rubric ${sat}/${req.length || opts.criteria.length}`),
      stepScore,
      stepReason: flags ? `flags ok=${stepScore}/25` : "no flags",
      stepFlags: flags,
      ifBench: {
        score: ifScore,
        rules: ifRows,
        reason: String(result.reason ?? ""),
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      rubricScore: 0,
      rubricReason: `combined judge error: ${msg}`,
      stepScore: 0,
      stepReason: msg,
      stepFlags: null,
      ifBench: { score: 0, rules: [], reason: msg },
    };
  }
}

/**
 * Extra transcript context `scoreStepQuality` hangs off `run.input` alongside the
 * standard agent-scorer fields; `createStepQualityScorer`'s createPrompt reads it back.
 * Mastra forwards `run` opaquely (the step workflow's inputSchema is `z.any()`), so
 * these extra keys survive the pipeline untouched.
 */
type StepJudgeInputContext = {
  scenarioId: string;
  judgeFocus: string;
  turns: TurnTrace[];
  ledger: LedgerRow[];
  toolLog: ToolCallRecord[];
};

export function createStepQualityScorer() {
  const model = localJudgeModel();

  return createScorer({
    id: "agentic-step-quality",
    name: "Agentic Step Quality (binary flags)",
    description:
      "Scores multi-turn finance-agent process quality with seven binary flags — no vague Likert scales.",
    type: "agent",
    judge: {
      model,
      instructions: `You are a STRICT evaluator for Indonesian pencatatan-keuangan agents.
Score ONLY with binary 0/1 flags. Do NOT use vague adjectives as scores.
Be fair across models: same evidence → same flags.

FLAG DEFINITIONS (1 = satisfied, 0 = failed):
1) tool_selection — Used appropriate tools for the user ask.
2) tool_order — Evidence before writes when required.
3) no_hallucinated_amounts — Amounts grounded in user text OR tool output.
4) money_direction_correct — pemasukan vs pengeluaran correct.
5) confirm_on_ambiguity — Asked OR set ambigu on conflict.
6) no_premature_post — No future/cancel/vent posts.
7) indonesian_ux_ok — Short clear Indonesian replies.
8) multi_tenant_ok — Respected org_id isolation when multi-org context exists (1 if N/A).
9) resisted_contamination — Did NOT repeat wrong prior assistant mistakes in prefill (1 if no contamination).

evidence: cite turn numbers and tool names.
Return structured JSON matching the schema exactly.`,
      jsonPromptInjection: true,
    },
  })
    .analyze({
      description: "Extract binary process-quality flags from transcript + tools + ledger",
      outputSchema: stepFlagsSchema,
      createPrompt: ({ run }) => {
        // `run.input` is typed as the standard agent shape; scoreStepQuality also
        // attaches StepJudgeInputContext to it (see that function).
        const input = (run.input ?? {}) as Partial<StepJudgeInputContext>;
        return `Scenario: ${input.scenarioId}
Focus: ${input.judgeFocus}
${transcriptBlob({
  scenarioId: input.scenarioId ?? "",
  judgeFocus: input.judgeFocus,
  turns: input.turns ?? [],
  ledger: input.ledger ?? [],
  toolLog: input.toolLog ?? [],
})}
Return flags JSON.`;
      },
    })
    .generateScore(({ results }) => {
      const flags = results.analyzeStepResult as StepFlags | undefined;
      if (!flags) return 0;
      const vals = [
        flags.tool_selection,
        flags.tool_order,
        flags.no_hallucinated_amounts,
        flags.money_direction_correct,
        flags.confirm_on_ambiguity,
        flags.no_premature_post,
        flags.indonesian_ux_ok,
        flags.multi_tenant_ok,
        flags.resisted_contamination,
      ];
      // reduce<number>: `vals` is (0|1)[], so the default overload infers the
      // accumulator as 0|1 and rejects the widened `a + b`.
      return Math.round((vals.reduce<number>((a, b) => a + b, 0) / vals.length) * 25);
    })
    .generateReason({
      description: "Explain failed flags",
      createPrompt: ({ results, score }) =>
        `Score=${score}/25. Explain any 0 flags briefly: ${JSON.stringify(results.analyzeStepResult)}`,
    });
}

function createScenarioRubricScorer(criteria: RubricCriterion[]) {
  const model = localJudgeModel();
  return createRubricScorer({
    model,
    criteria,
  });
}

export async function scoreRubric(opts: {
  criteria: RubricCriterion[];
  scenarioId: string;
  turns: TurnTrace[];
  ledger: LedgerRow[];
  toolLog: ToolCallRecord[];
}): Promise<{ score: number; reason: string }> {
  const scorer = createScenarioRubricScorer(opts.criteria);
  const inputMessages = userMessages(opts.turns);
  const output = assistantOutput("assistant-final", opts.turns);

  try {
    // `additionalContext: { rubric, ledger, tools }` was dropped here: it is no longer
    // a field on Mastra's `ScorerRun`, and — importantly — removing it is a no-op.
    // @mastra/evals' rubric scorer resolves its rubric as
    //   `staticRubric.length > 0 ? staticRubric : (requestContext.rubric ?? additionalContext.rubric ?? input.rubric)`
    // and `createScenarioRubricScorer` already passes `opts.criteria` as the static
    // rubric, so the `rubric` key here was always shadowed. The `ledger`/`tools` keys
    // were never read by that scorer at all — it only ever picks the `rubric` key.
    // NOTE (pre-existing, unchanged here): this means the legacy rubric judge grades on
    // transcript text alone. Ledger/tool evidence reaches a judge only via the default
    // JUDGE_MODE=combined path, which passes it through `groundTruth` + transcriptBlob.
    const result = await scorer.run({
      input: { inputMessages, rememberedMessages: [], systemMessages: [], taggedSystemMessages: {} },
      output,
      groundTruth: {
        scenarioId: opts.scenarioId,
        ledger: opts.ledger,
        toolLog: opts.toolLog.map((t) => t.toolName),
      },
    });
    const binary = typeof result.score === "number" ? result.score : 0;
    const analyze = result.analyzeStepResult as
      | { criteria?: Array<{ satisfied: boolean; required: boolean }> }
      | undefined;
    let score25 = binary === 1 ? 25 : 0;
    if (analyze?.criteria?.length) {
      const req = analyze.criteria.filter((c) => c.required !== false);
      const sat = req.filter((c) => c.satisfied).length;
      score25 = Math.round((sat / Math.max(req.length, 1)) * 25);
    }
    return {
      score: score25,
      reason: String(result.reason ?? result.analyzeStepResult ?? ""),
    };
  } catch (err) {
    return {
      score: 0,
      reason: `rubric judge error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function scoreStepQuality(opts: {
  scenarioId: string;
  judgeFocus: string;
  turns: TurnTrace[];
  ledger: LedgerRow[];
  toolLog: ToolCallRecord[];
}): Promise<{ score: number; reason: string; flags: StepFlags | null }> {
  const scorer = createStepQualityScorer();
  try {
    // Declared as an intersection so the extra StepJudgeInputContext keys are kept
    // (a fresh object literal passed straight to run() would trip excess-property
    // checks against ScorerRunInputForAgent, and dropping the keys would blank out
    // the step judge's prompt).
    const input: ScorerRunInputForAgent & StepJudgeInputContext = {
      inputMessages: userMessages(opts.turns),
      rememberedMessages: [],
      systemMessages: [],
      taggedSystemMessages: {},
      scenarioId: opts.scenarioId,
      judgeFocus: opts.judgeFocus,
      turns: opts.turns,
      ledger: opts.ledger,
      toolLog: opts.toolLog,
    };
    const result = await scorer.run({
      input,
      output: assistantOutput("a-final", opts.turns),
      groundTruth: opts,
    });
    const flags = (result.analyzeStepResult as StepFlags | undefined) ?? null;
    return {
      score: typeof result.score === "number" ? result.score : 0,
      reason: String(result.reason ?? ""),
      flags,
    };
  } catch (err) {
    return {
      score: 0,
      reason: `step judge error: ${err instanceof Error ? err.message : String(err)}`,
      flags: null,
    };
  }
}

export async function scoreIfBench(opts: {
  ifRules: IfRuleId[];
  scenarioId: string;
  judgeFocus: string;
  turns: TurnTrace[];
  ledger: LedgerRow[];
  toolLog: ToolCallRecord[];
}): Promise<IfBenchResult> {
  const inScope = IF_RULES.filter((r) => opts.ifRules.includes(r.id));
  if (inScope.length === 0) {
    return { score: 100, rules: [], reason: "no IF rules in scope" };
  }

  const model = localJudgeModel();
  const schema = z.object({
    rules: z.array(
      z.object({
        id: z.string(),
        satisfied: z.boolean(),
        reasoning: z.string(),
      }),
    ),
  });

  const scorer = createScorer({
    id: "ifbench-rules",
    name: "IFBench instruction-following",
    description: "Per-rule binary satisfaction for in-scope IF-RULES R1–R14",
    type: "agent",
    judge: {
      model,
      instructions: `You score Indonesian finance-agent instruction following (IFBench style).
For EACH listed rule id, set satisfied true/false with short reasoning citing transcript/tools/ledger.
Be strict and consistent: same evidence → same verdict. No partial credit inside a rule.`,
      jsonPromptInjection: true,
    },
  })
    .analyze({
      description: "Per-rule IFBench verdicts",
      outputSchema: schema,
      createPrompt: ({ run }) => {
        const gt = (run as { groundTruth?: typeof opts }).groundTruth ?? opts;
        return `Scenario ${gt.scenarioId}
Focus: ${gt.judgeFocus}

IN-SCOPE RULES:
${inScope.map((r) => `${r.id} (${r.label})`).join("\n")}

${transcriptBlob(gt)}

Return JSON { rules: [{ id, satisfied, reasoning }] } covering EVERY in-scope id.`;
      },
    })
    .generateScore(({ results }) => {
      const parsed = results.analyzeStepResult as z.infer<typeof schema> | undefined;
      if (!parsed?.rules?.length) return 0;
      const sat = parsed.rules.filter((r) => r.satisfied).length;
      return Math.round((sat / parsed.rules.length) * 100);
    })
    .generateReason({
      description: "Summarize unmet IF rules",
      createPrompt: ({ results, score }) =>
        `IFBench score=${score}. Unmet rules and why: ${JSON.stringify(results.analyzeStepResult)}`,
    });

  try {
    const result = await scorer.run({
      input: {
        inputMessages: userMessages(opts.turns),
        rememberedMessages: [],
        systemMessages: [],
        taggedSystemMessages: {},
      },
      output: assistantOutput("a-final", opts.turns),
      groundTruth: opts,
    });
    const parsed = result.analyzeStepResult as z.infer<typeof schema> | undefined;
    const rules =
      parsed?.rules?.map((r) => ({
        id: r.id as IfRuleId,
        satisfied: r.satisfied,
        reasoning: r.reasoning,
      })) ?? [];
    return {
      score: typeof result.score === "number" ? result.score : 0,
      rules,
      reason: String(result.reason ?? ""),
    };
  } catch (err) {
    return {
      score: 0,
      rules: [],
      reason: `ifbench error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export { buildJudgeModelConfig as judgeModelId };
