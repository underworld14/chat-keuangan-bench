// Public API for programmatic use (import as a library).
export {
  financeParseSchema,
  SYSTEM_PROMPT,
  parseMessage,
  parseFinanceJson,
  scoreExtraction,
  normalizeText,
  type ParsedFinance,
  type ExpectedEntry,
  type Scenario,
  type ParseMessageOptions,
} from "./core/eval-core.ts";

export {
  ALL_EVAL_MODELS,
  shortModelName,
  type EvalModelId,
} from "./core/model-roster.ts";

export {
  resolveModel,
  getLlmConfig,
  getCompatibleLlmConfig,
  getOpenAiLlmConfig,
  chatCompletion,
  applyLlmConfigOverrides,
  LLM_PROVIDER_KINDS,
  type LlmProviderKind,
} from "./core/llm-client.ts";
