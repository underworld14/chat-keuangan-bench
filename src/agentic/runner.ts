import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import { createFinanceAgent, type AgenticSampling } from "./agent";
import { runDeterministicAsserts, readLedger } from "./asserts";
import {
  scoreRubric,
  scoreStepQuality,
  scoreIfBench,
  scoreCombinedJudge,
  JUDGE_MODEL_ID,
  JUDGE_MODE,
} from "./judge";
import { AGENTIC_PROMPT_STATS, AGENTIC_SYSTEM_PROMPT } from "./prompt";
import { closeSandbox, createSandbox, ensureDefaultFixtures } from "./sandbox";
import { getAgenticHard20, getAllAgenticScenarios } from "./scenarios/hard-20";
import { getAgenticHardPlus } from "./scenarios/hard-plus";
import { getLlmConfig } from "../core/llm-client";
import type {
  AgenticScenario,
  IfBenchResult,
  ScenarioRunResult,
  ToolCallRecord,
  TurnTrace,
} from "./types";

config({ path: resolve(import.meta.dirname, "../../.env") });

function extractAssistantText(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const r = result as Record<string, unknown>;
  if (typeof r.text === "string") return r.text;
  if (typeof r.content === "string") return r.content;
  if (Array.isArray(r.messages)) {
    const asst = [...r.messages].reverse().find((m) => {
      const msg = m as { role?: string; content?: unknown };
      return msg.role === "assistant";
    }) as { content?: unknown } | undefined;
    if (typeof asst?.content === "string") return asst.content;
    if (Array.isArray(asst?.content)) {
      return (asst.content as Array<{ text?: string }>)
        .map((p) => p.text ?? "")
        .join("");
    }
  }
  try {
    return JSON.stringify(result).slice(0, 4000);
  } catch {
    return "";
  }
}

function buildInstructions(scenario: AgenticScenario): string {
  const org = scenario.activeOrgId ?? "personal";
  return `${AGENTIC_SYSTEM_PROMPT}

═══ SESSION ═══
Org aktif default: ${org}
Orgs tersedia: personal, yayasan, sekolah
Saat INSERT, set org_id secara eksplisit.`;
}

export async function runScenario(opts: {
  scenario: AgenticScenario;
  modelId: string;
  skipJudge?: boolean;
  sampling?: AgenticSampling;
}): Promise<ScenarioRunResult> {
  const t0 = Date.now();
  const sandbox = await createSandbox(opts.scenario.id, {
    seedFiles: opts.scenario.seedFiles,
    seedSql: opts.scenario.seedSql,
  });

  const threadId = `thread-${sandbox.id}`;
  const resourceId = `resource-${opts.modelId}`;
  const { agent, memory } = createFinanceAgent({
    modelId: opts.modelId,
    sandbox,
    instructions: buildInstructions(opts.scenario),
    sampling: opts.sampling,
  });

  // Prefill contaminated / prior context into memory (not scored as model output)
  if (opts.scenario.prefill?.length) {
    try {
      await memory.createThread({
        threadId,
        resourceId,
        title: opts.scenario.id,
      });
      const msgs = opts.scenario.prefill.map((m, i) => ({
        id: `prefill-${i}`,
        role: m.role,
        content: m.content,
        createdAt: new Date(Date.now() - (opts.scenario.prefill!.length - i) * 1000),
        threadId,
        resourceId,
      }));
      await memory.saveMessages({
        messages: msgs as never,
      });
    } catch (err) {
      // Fallback: prepend prefill as a synthetic user context turn instruction
      console.warn(
        `[prefill] memory inject failed, using prompt appendix: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const turns: TurnTrace[] = [];
  let error: string | null = null;

  try {
    for (let i = 0; i < opts.scenario.turns.length; i++) {
      const turn = opts.scenario.turns[i]!;
      sandbox.currentTurn = i;
      const turnStart = Date.now();
      const toolStartIdx = sandbox.toolLog.length;

      let content = turn.content;
      if (i === 0 && opts.scenario.prefill?.length) {
        // Ensure model sees contamination even if memory inject failed
        const pref = opts.scenario.prefill
          .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
          .join("\n");
        content = `[RIWAYAT CHAT SEBELUMNYA — bisa mengandung kesalahan AI]\n${pref}\n\n[PESAN BARU]\n${turn.content}`;
      }

      const gen = await agent.generate(content, {
        maxSteps: opts.scenario.maxStepsPerTurn ?? 10,
        memory: { thread: threadId, resource: resourceId },
      });

      const assistantText = extractAssistantText(gen);
      const toolCalls: ToolCallRecord[] = sandbox.toolLog.slice(toolStartIdx).map((t) => ({
        toolName: t.toolName,
        args: t.args,
        result: t.result,
        turnIndex: t.turnIndex,
      }));

      turns.push({
        turnIndex: i,
        user: turn.content,
        assistantText,
        toolCalls,
        ms: Date.now() - turnStart,
      });
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const ledger = readLedger(sandbox);
  const toolLog: ToolCallRecord[] = sandbox.toolLog.map((t) => ({
    toolName: t.toolName,
    args: t.args,
    result: t.result,
    turnIndex: t.turnIndex,
  }));

  const deterministic = runDeterministicAsserts(
    sandbox,
    opts.scenario.asserts,
    toolLog,
    turns.map((t) => t.assistantText),
  );

  let rubricScore = 0;
  let rubricReason = "skipped";
  let stepScore = 0;
  let stepReason = "skipped";
  let stepFlags: Record<string, number> | null = null;
  let ifBench: IfBenchResult = { score: 0, rules: [], reason: "skipped" };

  if (!opts.skipJudge && !error) {
    if (JUDGE_MODE === "combined") {
      const combined = await scoreCombinedJudge({
        criteria: opts.scenario.rubric,
        ifRules: opts.scenario.ifRules ?? [],
        scenarioId: opts.scenario.id,
        judgeFocus: opts.scenario.judgeFocus,
        turns,
        ledger,
        toolLog,
      });
      rubricScore = combined.rubricScore;
      rubricReason = combined.rubricReason;
      stepScore = combined.stepScore;
      stepReason = combined.stepReason;
      stepFlags = combined.stepFlags as Record<string, number> | null;
      ifBench = combined.ifBench;
    } else {
      const [rubric, step, iff] = await Promise.all([
        scoreRubric({
          criteria: opts.scenario.rubric,
          scenarioId: opts.scenario.id,
          turns,
          ledger,
          toolLog,
        }),
        scoreStepQuality({
          scenarioId: opts.scenario.id,
          judgeFocus: opts.scenario.judgeFocus,
          turns,
          ledger,
          toolLog,
        }),
        scoreIfBench({
          ifRules: opts.scenario.ifRules ?? [],
          scenarioId: opts.scenario.id,
          judgeFocus: opts.scenario.judgeFocus,
          turns,
          ledger,
          toolLog,
        }),
      ]);
      rubricScore = rubric.score;
      rubricReason = rubric.reason;
      stepScore = step.score;
      stepReason = step.reason;
      stepFlags = step.flags as Record<string, number> | null;
      ifBench = iff;
    }
  }

  closeSandbox(sandbox);

  // det40 + rub25 + step25 + ifBench10
  const ifPoints = Math.round((ifBench.score / 100) * 10);
  const totalScore = deterministic.score + rubricScore + stepScore + ifPoints;

  return {
    scenarioId: opts.scenario.id,
    modelId: opts.modelId,
    tier: opts.scenario.tier ?? "hard",
    turns,
    ledger,
    deterministic,
    rubricScore,
    rubricReason,
    stepScore,
    stepReason,
    stepFlags,
    ifBench,
    totalScore,
    error,
    ms: Date.now() - t0,
  };
}

export async function runAgenticSuite(opts: {
  modelId: string;
  limit?: number;
  ids?: string[];
  suite?: "hard" | "hardplus" | "all";
  skipJudge?: boolean;
  dryRun?: boolean;
  /** Parallel scenario workers (default 4). Set 1 for serial. */
  concurrency?: number;
  sampling?: AgenticSampling;
}): Promise<{ results: ScenarioRunResult[]; summary: Record<string, unknown> }> {
  await ensureDefaultFixtures();
  const suite = opts.suite ?? "all";
  let scenarios =
    suite === "hard"
      ? getAgenticHard20()
      : suite === "hardplus"
        ? getAgenticHardPlus()
        : getAllAgenticScenarios();

  if (opts.ids?.length) {
    const set = new Set(opts.ids);
    scenarios = scenarios.filter((s) => set.has(s.id));
  }
  if (opts.limit && opts.limit > 0) scenarios = scenarios.slice(0, opts.limit);

  const concurrency = Math.max(1, opts.concurrency ?? 4);

  console.log(
    `Agentic suite=${suite} — model=${opts.modelId} baseURL=${getLlmConfig().baseURL}`,
  );
  console.log(
    `Judge=${JUDGE_MODEL_ID} mode=${JUDGE_MODE} | prompt=${AGENTIC_PROMPT_STATS.chars} chars (~${AGENTIC_PROMPT_STATS.pctOfPrevious}% of prior compressed; IF rules=${AGENTIC_PROMPT_STATS.ifRuleCount})`,
  );
  console.log(
    `Scenarios: ${scenarios.length} concurrency=${concurrency}${opts.skipJudge ? " (skip judge)" : ""}\n`,
  );

  if (opts.dryRun) {
    for (const s of scenarios) {
      console.log(`[dry] ${s.tier ?? "hard"} ${s.id} — ${s.title}`);
      console.log(`      failure: ${s.failureMode}`);
      console.log(
        `      turns=${s.turns.length} prefill=${s.prefill?.length ?? 0} asserts=${s.asserts.length} if=${(s.ifRules ?? []).join(",")}`,
      );
    }
    return { results: [], summary: { dryRun: true, count: scenarios.length, suite } };
  }

  const results: ScenarioRunResult[] = new Array(scenarios.length);
  let next = 0;

  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= scenarios.length) return;
      const scenario = scenarios[idx]!;
      process.stdout.write(`  ▶ ${scenario.id}\n`);
      const r = await runScenario({
        scenario,
        modelId: opts.modelId,
        skipJudge: opts.skipJudge,
        sampling: opts.sampling,
      });
      results[idx] = r;
      if (r.error) {
        console.log(
          `  ✓ ${scenario.id} ERROR ${r.error.slice(0, 120)} (score=${r.totalScore}) ${r.ms}ms`,
        );
      } else {
        console.log(
          `  ✓ ${scenario.id} score=${r.totalScore}/100 (det=${r.deterministic.score}/40 rub=${r.rubricScore}/25 step=${r.stepScore}/25 if=${r.ifBench.score}) ${r.ms}ms`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, scenarios.length) }, () => worker()));

  const ordered = results.filter(Boolean);
  const avg =
    ordered.reduce((s, r) => s + r.totalScore, 0) / Math.max(ordered.length, 1);
  const avgIf =
    ordered.reduce((s, r) => s + r.ifBench.score, 0) / Math.max(ordered.length, 1);
  const summary = {
    modelId: opts.modelId,
    baseURL: getLlmConfig().baseURL,
    suite,
    concurrency,
    sampling: opts.sampling ?? { temperature: 0 },
    judge: { model: JUDGE_MODEL_ID, mode: JUDGE_MODE },
    prompt: AGENTIC_PROMPT_STATS,
    scoring: "det40 + rub25 + step25 + ifBench10",
    scenarioCount: ordered.length,
    avgScore: Math.round(avg * 10) / 10,
    avgIfBench: Math.round(avgIf * 10) / 10,
    hardplusCount: ordered.filter((r) => r.tier === "hardplus").length,
    errors: ordered.filter((r) => r.error).length,
  };

  return { results: ordered, summary };
}

/** @deprecated use runAgenticSuite */
export const runAgenticHard20 = (opts: {
  modelId: string;
  limit?: number;
  ids?: string[];
  skipJudge?: boolean;
  dryRun?: boolean;
}) => runAgenticSuite({ ...opts, suite: "hard" });

export function writeAgenticReport(
  results: ScenarioRunResult[],
  summary: Record<string, unknown>,
  outDir = resolve(import.meta.dirname, "../../docs/results/agentic"),
) {
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const jsonPath = resolve(outDir, `${stamp}-agentic-suite.json`);
  const mdPath = resolve(outDir, `${stamp}-agentic-suite.md`);

  writeFileSync(jsonPath, JSON.stringify({ summary, results }, null, 2));

  const lines: string[] = [
    `# Agentic Suite Results`,
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Summary",
    "```json",
    JSON.stringify(summary, null, 2),
    "```",
    "",
    "## Per scenario",
    "",
    "| Tier | Scenario | Total | Det/40 | Rub/25 | Step/25 | IFBench | Error |",
    "|------|----------|------:|-------:|-------:|--------:|--------:|-------|",
  ];
  for (const r of results) {
    lines.push(
      `| ${r.tier} | ${r.scenarioId} | ${r.totalScore} | ${r.deterministic.score} | ${r.rubricScore} | ${r.stepScore} | ${r.ifBench.score} | ${r.error ? "yes" : ""} |`,
    );
  }
  lines.push("", "## Weak / failed", "");
  for (const r of results.filter((x) => x.totalScore < 70 || x.error)) {
    lines.push(`### ${r.scenarioId}`);
    lines.push(`- total=${r.totalScore} ifBench=${r.ifBench.score}`);
    lines.push(
      `- unmet IF: ${r.ifBench.rules.filter((x) => !x.satisfied).map((x) => x.id).join(", ") || "—"}`,
    );
    lines.push(`- det fails: ${r.deterministic.details.filter((d) => !d.ok).map((d) => d.note).join("; ") || "ok"}`);
    lines.push("");
  }

  writeFileSync(mdPath, lines.join("\n"));
  return { jsonPath, mdPath };
}
