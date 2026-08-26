import { afterEach, describe, expect, test } from "bun:test";
import {
  THINKING_MODES,
  applyLlmConfigOverrides,
  detectThinking,
  getCompatibleLlmConfig,
  getLlmConfig,
  getOpenAiLlmConfig,
  resolveModel,
  thinkingBodyPatch,
  thinkingMismatch,
} from "./llm-client.ts";

const ENV_KEYS = [
  "OPENAI_COMPATIBLE_BASE_URL",
  "OPENAI_COMPATIBLE_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
] as const;

const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe("THINKING_MODES", () => {
  test("every advertised mode produces a body patch", () => {
    // Guards the CLIs, which validate against this list: a mode added here without a
    // thinkingBodyPatch branch would be accepted on the command line and then no-op.
    expect([...THINKING_MODES]).toEqual(["on", "off", "auto"]);
    for (const mode of THINKING_MODES) expect(() => thinkingBodyPatch(mode)).not.toThrow();
  });
});

describe("thinkingBodyPatch", () => {
  test("auto sends nothing — the server config wins untouched", () => {
    expect(thinkingBodyPatch("auto")).toEqual({});
  });

  test("off/on send the vLLM-convention chat_template_kwargs", () => {
    expect(thinkingBodyPatch("off")).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(thinkingBodyPatch("on")).toEqual({
      chat_template_kwargs: { enable_thinking: true },
    });
  });
});

describe("detectThinking", () => {
  test("reads all three ways a server reports reasoning", () => {
    expect(detectThinking({ reasoning: "hmm...", content: "{}" })).toBe(true);
    expect(detectThinking({ reasoning_content: "hmm...", content: "{}" })).toBe(true);
    expect(detectThinking({ content: "<think>hmm</think>{}" })).toBe(true);
  });

  test("a clean non-thinking answer reads false", () => {
    expect(detectThinking({ content: '{"entries":[]}' })).toBe(false);
    expect(detectThinking({})).toBe(false);
  });

  test("empty reasoning fields are not thinking", () => {
    // LM Studio sends reasoning: "" for non-reasoning turns on some builds; treating
    // that as thinking would flag every run as a mismatch.
    expect(detectThinking({ reasoning: "", content: "{}" })).toBe(false);
    expect(detectThinking({ reasoning: "   ", content: "{}" })).toBe(false);
    expect(detectThinking({ reasoning: null, reasoning_content: null, content: "{}" })).toBe(false);
  });
});

describe("thinkingMismatch", () => {
  test("auto never complains — nothing was asked for", () => {
    expect(thinkingMismatch("auto", true)).toBeNull();
    expect(thinkingMismatch("auto", false)).toBeNull();
  });

  test("silence when the server obeyed", () => {
    expect(thinkingMismatch("off", false)).toBeNull();
    expect(thinkingMismatch("on", true)).toBeNull();
  });

  test("off-but-reasoned names the LM Studio fix and the run's real mode", () => {
    const msg = thinkingMismatch("off", true);
    expect(msg).toContain("LM Studio");
    expect(msg).toContain("THINKING run");
  });

  test("on-but-silent is reported too", () => {
    expect(thinkingMismatch("on", false)).toContain("NON-THINKING run");
  });
});

describe("dual provider config", () => {
  test("getLlmConfig defaults to openai-compatible (bench / LM Studio)", () => {
    delete process.env.OPENAI_COMPATIBLE_BASE_URL;
    delete process.env.OPENAI_COMPATIBLE_API_KEY;
    expect(getLlmConfig()).toEqual(getCompatibleLlmConfig());
    expect(getLlmConfig().baseURL).toBe("http://127.0.0.1:1234/v1");
    expect(getLlmConfig().apiKey).toBe("lm-studio");
  });

  test("openai config reads OPENAI_* and defaults to api.openai.com", () => {
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    expect(getOpenAiLlmConfig().baseURL).toBe("https://api.openai.com/v1");
    expect(getOpenAiLlmConfig().apiKey).toBe("");

    process.env.OPENAI_BASE_URL = "https://ai.sumopod.com/v1/";
    process.env.OPENAI_API_KEY = "sk-test";
    expect(getLlmConfig("openai")).toEqual({
      baseURL: "https://ai.sumopod.com/v1",
      apiKey: "sk-test",
    });
  });

  test("applyLlmConfigOverrides routes flags to the chosen provider env", () => {
    applyLlmConfigOverrides({
      provider: "openai",
      baseUrl: "https://ai.sumopod.com/v1/",
      apiKey: "sk-sft",
    });
    expect(process.env.OPENAI_BASE_URL).toBe("https://ai.sumopod.com/v1");
    expect(process.env.OPENAI_API_KEY).toBe("sk-sft");

    applyLlmConfigOverrides({
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:9999/v1",
      apiKey: "lm",
    });
    expect(process.env.OPENAI_COMPATIBLE_BASE_URL).toBe("http://127.0.0.1:9999/v1");
    expect(process.env.OPENAI_COMPATIBLE_API_KEY).toBe("lm");
    // OpenAI env left alone by the compatible override.
    expect(process.env.OPENAI_BASE_URL).toBe("https://ai.sumopod.com/v1");
  });

  test("resolveModel(openai) returns a chat-completions language model", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const model = resolveModel("gpt-4o-mini", { provider: "openai" }) as {
      modelId: string;
      provider: string;
    };
    expect(model.modelId).toBe("gpt-4o-mini");
    // Official OpenAI provider — not openai-compatible — so structuredOutputs can fire.
    expect(model.provider).toMatch(/openai/);
    expect(model.provider).not.toBe("openai-compatible");
  });
});
