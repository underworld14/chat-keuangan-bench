/**
 * Mastra Studio entry — chat-keuangan-bench agentic finance agent.
 *
 * Start: bun run studio  →  http://localhost:4111
 *
 * Traces need Observability + LibSQL storage (MastraStorageExporter).
 * Without that, Studio Agents work but Observability/Traces stays empty.
 */

import { config } from "dotenv";
import { resolve } from "node:path";
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { Observability, MastraStorageExporter, SensitiveDataFilter } from "@mastra/observability";
import { resolveModel } from "../core/llm-client";
import { AGENTIC_SYSTEM_PROMPT } from "../agentic/prompt";
import { createAgenticTools } from "../agentic/tools";
import {
  createSandbox,
  ensureDefaultFixtures,
  type Sandbox,
} from "../agentic/sandbox";
import { createStepQualityScorer } from "../agentic/judge";

config({ path: resolve(import.meta.dirname, "../../.env") });

const DEFAULT_STUDIO_MODEL =
  process.env.STUDIO_MODEL?.trim() ||
  process.env.EVAL_MODEL?.trim() ||
  "local-model";

await ensureDefaultFixtures();

const studioSandbox: Sandbox = await createSandbox("studio-session", {
  seedFiles: [
    { from: "csv/mutasi-personal.csv", to: "in/mutasi.csv" },
    { from: "csv/reconcile-indomaret.csv", to: "in/conflict.csv" },
    { from: "pdf/rekening-pribadi.pdf", to: "in/rekening.pdf" },
  ],
});

const tools = createAgenticTools(studioSandbox);

const storage = new LibSQLStore({
  id: "chat-keuangan-studio",
  url: `file:${resolve(import.meta.dirname, "../../.mastra/studio.db")}`,
});

const memory = new Memory({
  storage,
  options: { lastMessages: 40 },
});

export const financeAgent = new Agent({
  id: "finance-agentic",
  name: "finance-agentic",
  description:
    "Indonesian pencatatan keuangan multi-turn agent (SQLite ledger + CSV/PDF/OCR). Nota user di in/nota-*.png.",
  instructions: `${AGENTIC_SYSTEM_PROMPT}

═══ SESSION ═══
Org aktif default: personal
Orgs: personal, yayasan, sekolah — jangan campur.
Sandbox: in/mutasi.csv, in/conflict.csv, in/rekening.pdf, in/nota-*.png.
Pakai list_inbox + receipt_ocr untuk foto user — jangan google nota.`,
  model: resolveModel(DEFAULT_STUDIO_MODEL) as never,
  tools,
  memory,
  scorers: {
    // Sampling keeps Studio chat cheap — full eval uses CLI judge separately.
    stepQuality: {
      scorer: createStepQualityScorer(),
      sampling: { type: "ratio", rate: 0 },
    },
  },
  defaultOptions: {
    modelSettings: {
      temperature: 0,
      maxOutputTokens: 4096,
    },
  },
});

export const mastra = new Mastra({
  agents: {
    financeAgent,
  },
  tools,
  storage,
  observability: new Observability({
    configs: {
      default: {
        serviceName: "chat-keuangan-bench",
        exporters: [new MastraStorageExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
});

console.info(
  `[studio] sandbox=${studioSandbox.root} tools=${Object.keys(tools).join(",")} storage=.mastra/studio.db observability=on`,
);
