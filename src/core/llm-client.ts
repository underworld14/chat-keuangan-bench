/**
 * Single LLM client for Parse-25, Rupiah-Pro, judge, OCR, and SFT generation.
 * OpenAI-compatible only (LM Studio / custom base URL).
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

const DEFAULT_BASE_URL = "http://127.0.0.1:1234/v1";
const DEFAULT_API_KEY = "lm-studio";

export type LlmConfig = {
  baseURL: string;
  apiKey: string;
};

/** Apply CLI `--base-url` / `--api-key` into process.env. */
export function applyLlmConfigOverrides(opts: {
  baseUrl?: string;
  apiKey?: string;
}): void {
  if (opts.baseUrl?.trim()) {
    process.env.OPENAI_COMPATIBLE_BASE_URL = opts.baseUrl.trim().replace(/\/$/, "");
  }
  if (opts.apiKey?.trim()) {
    process.env.OPENAI_COMPATIBLE_API_KEY = opts.apiKey.trim();
  }
}

export function getLlmConfig(): LlmConfig {
  return {
    baseURL: (
      process.env.OPENAI_COMPATIBLE_BASE_URL?.trim() || DEFAULT_BASE_URL
    ).replace(/\/$/, ""),
    apiKey: process.env.OPENAI_COMPATIBLE_API_KEY?.trim() || DEFAULT_API_KEY,
  };
}

export function chatCompletionsUrl(): string {
  return `${getLlmConfig().baseURL}/chat/completions`;
}

/** Resolve a LanguageModel for the configured OpenAI-compatible server. */
export function resolveModel(modelId: string): LanguageModel {
  const { baseURL, apiKey } = getLlmConfig();
  const provider = createOpenAICompatible({
    name: "openai-compatible",
    baseURL,
    apiKey,
  });
  return provider(modelId);
}

/** GET /models — used to fail fast when the server is down or the id is not loaded. */
export async function listModels(opts?: { timeoutMs?: number }): Promise<string[]> {
  const { baseURL, apiKey } = getLlmConfig();
  const url = `${baseURL}/models`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
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
};

/**
 * Raw chat completions fetch (shared by eval:single, SFT generator, OCR).
 * Returns assistant text content.
 */
export async function chatCompletion(opts: ChatJsonOptions): Promise<{
  content: string;
  ms: number;
  usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}> {
  const { apiKey } = getLlmConfig();
  const url = chatCompletionsUrl();
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0,
    max_tokens: opts.maxTokens ?? 2048,
  };
  if (opts.jsonObject) {
    body.response_format = { type: "json_object" };
  }

  const t0 = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
  });

  // Read as text first: a misconfigured baseURL (e.g. missing /v1) answers with
  // an HTML 404, and res.json() would throw a parse error that buries the status.
  const bodyText = await res.text();
  let payload: {
    choices?: Array<{ message?: { content?: string } }>;
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

  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM returned empty content");

  return {
    content,
    ms: Date.now() - t0,
    usage: payload.usage ?? {},
  };
}
