import { describe, expect, test } from "bun:test";
import { parseArgs } from "../generate-sft-parse.ts";

describe("generate-sft-parse defaults and flags", () => {
  test("defaults: provider openai, batch-size 5, concurrency 5", () => {
    const a = parseArgs(["bun", "scripts/generate-sft-parse.ts"]);
    expect(a.provider).toBe("openai");
    expect(a.batchSize).toBe(5);
    expect(a.concurrency).toBe(5);
  });

  test("overrides batch-size, concurrency, and provider", () => {
    const a = parseArgs([
      "bun",
      "scripts/generate-sft-parse.ts",
      "--batch-size",
      "5",
      "--concurrency",
      "1",
      "--provider",
      "openai-compatible",
    ]);
    expect(a.batchSize).toBe(5);
    expect(a.concurrency).toBe(1);
    expect(a.provider).toBe("openai-compatible");
  });

  test("rejects non-positive batch-size", () => {
    expect(() =>
      parseArgs(["bun", "scripts/generate-sft-parse.ts", "--batch-size", "0"]),
    ).toThrow(/batch-size/);
  });

  test("rejects non-positive concurrency", () => {
    expect(() =>
      parseArgs(["bun", "scripts/generate-sft-parse.ts", "--concurrency", "-1"]),
    ).toThrow(/concurrency/);
  });

  test("rejects unknown provider", () => {
    expect(() =>
      parseArgs(["bun", "scripts/generate-sft-parse.ts", "--provider", "anthropic"]),
    ).toThrow(/provider/);
  });
});
