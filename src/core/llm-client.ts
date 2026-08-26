/**
 * LLM client for Parse-25, Rupiah-Pro, judge, OCR, and SFT generation.
 *
 * Two providers:
 *  - `openai-compatible` — LM Studio / local (default for benches)
 *  - `openai` — official `@ai-sdk/openai` chat models with structuredOutputs
 *    (default for SFT generate; still accepts custom baseURL for cloud gateways)
 */

import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

const DEFAULT_COMPAT_BASE_URL = "http://127.0.0.1:1234/v1";
const DEFAULT_COMPAT_API_KEY = "lm-studio";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

export type LlmProviderKind = "openai-compatible" | "openai";

export const LLM_PROVIDER_KINDS: readonly LlmProviderKind[] = [
  "openai-compatible",
  "openai",
];

export type LlmConfig = {
  baseURL: string;
  apiKey: string;
};

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, "");
}

/** Apply CLI `--base-url` / `--api-key` into the env for the chosen provider. */
export function applyLlmConfigOverrides(opts: {
  baseUrl?: string;
  apiKey?: string;
  /** Defaults to openai-compatible so existing bench CLIs keep working. */
  provider?: LlmProviderKind;
}): void {
  const provider = opts.provider ?? "openai-compatible";
  if (provider === "openai") {
    if (opts.baseUrl?.trim()) {
      process.env.OPENAI_BASE_URL = stripTrailingSlash(opts.baseUrl.trim());
    }
    if (opts.apiKey?.trim()) {
      process.env.OPENAI_API_KEY = opts.apiKey.trim();
    }
    return;
  }
  if (opts.baseUrl?.trim()) {
    process.env.OPENAI_COMPATIBLE_BASE_URL = stripTrailingSlash(opts.baseUrl.trim());
  }
  if (opts.apiKey?.trim()) {
    process.env.OPENAI_COMPATIBLE_API_KEY = opts.apiKey.trim();
  }
}

/** LM Studio / openai-compatible config (bench default). */
export function getCompatibleLlmConfig(): LlmConfig {
  return {
    baseURL: stripTrailingSlash(
      process.env.OPENAI_COMPATIBLE_BASE_URL?.trim() || DEFAULT_COMPAT_BASE_URL,
    ),
    apiKey: process.env.OPENAI_COMPATIBLE_API_KEY?.trim() || DEFAULT_COMPAT_API_KEY,
  };
}

/** Official OpenAI provider config (SFT default). API key has no placeholder — missing key fails at request time. */
export function getOpenAiLlmConfig(): LlmConfig {
  return {
    baseURL: stripTrailingSlash(
      process.env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL,
    ),
    apiKey: process.env.OPENAI_API_KEY?.trim() || "",
  };
}

export function getLlmConfig(provider: LlmProviderKind = "openai-compatible"): LlmConfig {
  return provider === "openai" ? getOpenAiLlmConfig() : getCompatibleLlmConfig();
}

export function chatCompletionsUrl(provider: LlmProviderKind = "openai-compatible"): string {
  return `${getLlmConfig(provider).baseURL}/chat/completions`;
}

/**
 * `auto` leaves the server alone — whatever the LM Studio UI / model.yaml is set to wins.
 * `on` / `off` ask for a mode; whether the server obeys is a separate question (see below).
 */
export type ThinkingMode = "on" | "off" | "auto";

/** Single source of truth for the valid `--thinking` values; CLIs validate against this. */
export const THINKING_MODES: readonly ThinkingMode[] = ["on", "off", "auto"];

/**
 * Body patch that asks the server to toggle reasoning.
 *
 * There is NO documented LM Studio API parameter for this. Its changelog only describes
 * reasoning *output* (`message.reasoning` since 0.3.23, `reasoning_content` since 0.3.9,
 * `reasoning.effort` on /v1/responses only); the supported toggle is app-side model config,
 * and lmstudio-ai/lmstudio-bug-tracker#1559 is still open. `chat_template_kwargs` is the
 * vLLM/SGLang convention — llama.cpp-backed servers may or may not honour it.
 *
 * So this is a REQUEST, not a guarantee. Never trust it: pair every call with
 * `detectThinking()` on the response. A toggle that silently no-ops is worse than no toggle,
 * because it lands a thinking run on the leaderboard labelled non-thinking.
 */
export function thinkingBodyPatch(mode: ThinkingMode): Record<string, unknown> {
  if (mode === "auto") return {};
  return { chat_template_kwargs: { enable_thinking: mode === "on" } };
}

/** The assistant message shape we care about — three ways a server can report reasoning. */
export type ReasoningCarrier = {
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
};

/**
 * Did the model actually reason? Servers report it three ways, so check all three:
 * LM Studio >=0.3.23 splits it into `message.reasoning`, >=0.3.9 used `reasoning_content`,
 * and a server with no reasoning parser for the model leaks raw `<think>` into content.
 */
export function detectThinking(message: ReasoningCarrier): boolean {
  if (message.reasoning?.trim()) return true;
  if (message.reasoning_content?.trim()) return true;
  return /<think>/i.test(message.content ?? "");
}

/**
 * Human-readable complaint when the server ignored the toggle, or null when it obeyed.
 * Callers print this and record `thinkingObserved` — the observation is the provenance,
 * the flag is only the ask.
 */
export function thinkingMismatch(
  requested: ThinkingMode,
  observed: boolean,
): string | null {
  if (requested === "auto") return null;
  if (requested === "off" && observed) {
    return "requested --thinking off but the server still returned reasoning: it ignored chat_template_kwargs. Turn reasoning off in LM Studio (model config / model.yaml) — results are a THINKING run.";
  }
  if (requested === "on" && !observed) {
    return "requested --thinking on but the server returned no reasoning: results are a NON-THINKING run.";
  }
  return null;
}

export type ResolveModelOptions = {
  thinking?: ThinkingMode;
  /** Defaults to openai-compatible so benches keep using LM Studio. */
  provider?: LlmProviderKind;
};

/**
 * Resolve a LanguageModel.
 * - `openai-compatible` → createOpenAICompatible (LM Studio)
 * - `openai` → createOpenAI(...).chat(...) so Chat Completions + structuredOutputs work on
 *   cloud gateways that do not implement the Responses API
 */
export function resolveModel(
  modelId: string,
  opts?: ResolveModelOptions,
): LanguageModel {
  const provider = opts?.provider ?? "openai-compatible";
  const thinking = opts?.thinking ?? "auto";

  if (provider === "openai") {
    const { baseURL, apiKey } = getOpenAiLlmConfig();
    const openai = createOpenAI({ baseURL, apiKey });
    // Chat Completions — not Responses — so Sumopod / other /v1 gateways keep working.
    return openai.chat(modelId);
  }

  const { baseURL, apiKey } = getCompatibleLlmConfig();
  const patch = thinkingBodyPatch(thinking);
  const compat = createOpenAICompatible({
    name: "openai-compatible",
    baseURL,
    apiKey,
    ...(Object.keys(patch).length > 0
      ? { transformRequestBody: (body: Record<string, any>) => ({ ...body, ...patch }) }
      : {}),
  });
  return compat(modelId);
}

/** GET /models — used to fail fast when the server is down or the id is not loaded. */
export async function listModels(opts?: {
  timeoutMs?: number;
  provider?: LlmProviderKind;
}): Promise<string[]> {
  const provider = opts?.provider ?? "openai-compatible";
  const { baseURL, apiKey } = getLlmConfig(provider);
  const url = `${baseURL}/models`;
  const res = await fetch(url, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: opts?.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
  });
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(
      `LLM HTTP ${res.status} ${res.statusText} at ${url}: ${bodyText.trim().slice(0, 200)}`,
    );
  }
  let payload: { data?: Array<{ id?: string }> };
  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw new Error(
      `LLM returned non-JSON at ${url}: ${bodyText.trim().slice(0, 200)}`,
    );
  }
  return (payload.data ?? []).flatMap((m) => (m.id ? [m.id] : []));
}

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatJsonOptions = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Request JSON object mode when the server supports it. */
  jsonObject?: boolean;
  /** Abort the request after this many ms. Without it a hung server blocks forever. */
  timeoutMs?: number;
  /** Ask the server to toggle reasoning. Defaults to `auto` (leave the server as configured). */
  thinking?: ThinkingMode;
  /** Which base URL / key pair to use. Defaults to openai-compatible. */
  provider?: LlmProviderKind;
};

/**
 * Raw chat completions fetch (shared by eval:single, SFT generator, OCR).
 * Returns assistant text content, plus whether the server actually reasoned — the ask
 * (`opts.thinking`) and the observation (`thinkingObserved`) are deliberately separate.
 */
export async function chatCompletion(opts: ChatJsonOptions): Promise<{
  content: string;
  ms: number;
  thinkingObserved: boolean;
  usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}> {
  const provider = opts.provider ?? "openai-compatible";
  const { apiKey } = getLlmConfig(provider);
  const url = chatCompletionsUrl(provider);
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens ?? 2048,
    // Thinking patch is LM-Studio oriented; harmless no-op on most cloud gateways.
    ...thinkingBodyPatch(opts.thinking ?? "auto"),
  };
  if (opts.jsonObject) {
    body.response_format = { type: "json_object" };
  }

  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
  });

  // Read as text first: a misconfigured baseURL (e.g. missing /v1) answers with
  // an HTML 404, and res.json() would throw a parse error that buries the status.
  const bodyText = await res.text();
  let payload: {
    choices?: Array<{ message?: ReasoningCarrier }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string };
  } = {};
  let parseFailed = false;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    parseFailed = true;
  }

  if (!res.ok) {
    const detail = payload.error?.message ?? bodyText.trim().slice(0, 200);
    throw new Error(
      `LLM HTTP ${res.status} ${res.statusText} at ${url}${detail ? `: ${detail}` : ""}`,
    );
  }
  if (parseFailed) {
    throw new Error(
      `LLM returned non-JSON (HTTP ${res.status}) at ${url}: ${bodyText.trim().slice(0, 200)}`,
    );
  }

  const message = payload.choices?.[0]?.message ?? {};
  const content = message.content;
  if (!content) throw new Error("LLM returned empty content");

  return {
    content,
    ms: Date.now() - t0,
    thinkingObserved: detectThinking(message),
    usage: payload.usage ?? {},
  };
}
