/**
 * Local model roster for Parse-25 evals.
 * Use LM Studio model ids from GET /v1/models. Override with --model.
 */

/** Example local ids — replace with your loaded LM Studio models. */
export const ALL_EVAL_MODELS = [
  // e.g. "qwen2.5-7b-instruct", "gemma-2-9b-it"
] as const;

export type EvalModelId = string;

export function shortModelName(modelId: string): string {
  return modelId.split("/").pop() ?? modelId;
}
