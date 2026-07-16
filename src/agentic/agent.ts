import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { InMemoryStore } from "@mastra/core/storage";
import { AGENTIC_SYSTEM_PROMPT } from "./prompt";
import { createAgenticTools } from "./tools";
import type { Sandbox } from "./sandbox";
import { resolveModel } from "../core/llm-client";

/** Optional sampling knobs (Mastra modelSettings). */
export type AgenticSampling = {
  temperature?: number;
  top_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
};

export function createEvalModel(modelId: string) {
  return resolveModel(modelId);
}

export function createFinanceAgent(opts: {
  modelId: string;
  sandbox: Sandbox;
  agentId?: string;
  instructions?: string;
  sampling?: AgenticSampling;
}) {
  const tools = createAgenticTools(opts.sandbox);
  const memory = new Memory({
    storage: new InMemoryStore(),
    options: {
      lastMessages: 60,
    },
  });

  const temperature = opts.sampling?.temperature ?? 0;

  const agent = new Agent({
    id: opts.agentId ?? `finance-agentic-${opts.modelId.replace(/\//g, "-")}`,
    name: "chat-keuangan-agentic",
    description: "Indonesian pencatatan keuangan multi-turn agent with tools",
    instructions: opts.instructions ?? AGENTIC_SYSTEM_PROMPT,
    model: createEvalModel(opts.modelId) as never,
    tools,
    memory,
    defaultOptions: {
      modelSettings: {
        temperature,
        maxOutputTokens: 4096,
        ...(opts.sampling?.top_p != null ? { topP: opts.sampling.top_p } : {}),
        ...(opts.sampling?.presence_penalty != null
          ? { presencePenalty: opts.sampling.presence_penalty }
          : {}),
        ...(opts.sampling?.frequency_penalty != null
          ? { frequencyPenalty: opts.sampling.frequency_penalty }
          : {}),
      },
    },
  });

  return { agent, tools, memory };
}
