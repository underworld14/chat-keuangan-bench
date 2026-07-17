import { describe, expect, test } from "bun:test";
import {
  extractBaseSnapshot,
  extractHardSnapshots,
  discoverNewestPerModel,
  mergeParseLeaderboard,
  isNewerRun,
  type ParseSuiteSnapshot,
} from "./parse-scorecard.ts";

describe("parse-scorecard discovery", () => {
  test("extractBaseSnapshot accepts parse-base kind", () => {
    const snap = extractBaseSnapshot("/tmp/a.json", {
      kind: "parse-base",
      suite: "base",
      runAt: "2026-07-17T10:00:00.000Z",
      modelId: "qwen3-1.7b",
      passCount: 20,
      total: 28,
      meanMs: 400,
    });
    expect(snap?.modelId).toBe("qwen3-1.7b");
    expect(snap?.passCount).toBe(20);
    expect(snap?.total).toBe(28);
  });

  test("extractBaseSnapshot rejects non-base kinds", () => {
    expect(
      extractBaseSnapshot("/tmp/a.json", {
        kind: "parse-hard-25",
        runAt: "2026-07-17T10:00:00.000Z",
        modelId: "x",
        passCount: 1,
        total: 25,
        meanMs: 1,
      }),
    ).toBeNull();
  });

  test("extractHardSnapshots reads single-model artifact with composite", () => {
    const snaps = extractHardSnapshots("/tmp/h.json", {
      kind: "parse-hard-25",
      runAt: "2026-07-17T11:00:00.000Z",
      modelId: "qwen3-1.7b",
      strictPass: 12,
      totalScenarios: 25,
      meanComposite: 71.5,
      avgMs: 900,
      results: [],
    });
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.passCount).toBe(12);
    expect(snaps[0]!.meanComposite).toBe(71.5);
  });

  test("extractHardSnapshots reads multi-model summaries", () => {
    const snaps = extractHardSnapshots("/tmp/multi-finance-hard-25-results.json", {
      kind: "parse-hard-25",
      runAt: "2026-07-17T12:00:00.000Z",
      summaries: [
        { modelId: "a", strictPass: 10, meanComposite: 60, meanMs: 100 },
        { modelId: "b", strictPass: 15, meanComposite: 80, meanMs: 200 },
      ],
      results: [],
    });
    expect(snaps.map((s) => s.modelId).sort()).toEqual(["a", "b"]);
  });

  test("discoverNewestPerModel keeps latest runAt", () => {
    const snaps: ParseSuiteSnapshot[] = [
      {
        modelId: "m",
        runAt: "2026-07-16T00:00:00.000Z",
        sourcePath: "/old.json",
        passCount: 1,
        total: 28,
        meanMs: 1,
      },
      {
        modelId: "m",
        runAt: "2026-07-17T00:00:00.000Z",
        sourcePath: "/new.json",
        passCount: 20,
        total: 28,
        meanMs: 1,
      },
    ];
    const map = discoverNewestPerModel(snaps);
    expect(map.get("m")?.passCount).toBe(20);
    expect(map.get("m")?.sourcePath).toBe("/new.json");
  });

  test("isNewerRun ties break on path", () => {
    expect(
      isNewerRun(
        { runAt: "t", sourcePath: "/b.json" },
        { runAt: "t", sourcePath: "/a.json" },
      ),
    ).toBe(true);
  });

  test("mergeParseLeaderboard ranks hardStrict then composite then base", () => {
    const base = new Map<string, ParseSuiteSnapshot>([
      [
        "weak-hard",
        {
          modelId: "weak-hard",
          runAt: "t",
          sourcePath: "/b1",
          passCount: 28,
          total: 28,
          meanMs: 10,
        },
      ],
      [
        "strong-hard",
        {
          modelId: "strong-hard",
          runAt: "t",
          sourcePath: "/b2",
          passCount: 10,
          total: 28,
          meanMs: 10,
        },
      ],
    ]);
    const hard = new Map<string, ParseSuiteSnapshot>([
      [
        "weak-hard",
        {
          modelId: "weak-hard",
          runAt: "t",
          sourcePath: "/h1",
          passCount: 5,
          total: 25,
          meanMs: 10,
          meanComposite: 40,
        },
      ],
      [
        "strong-hard",
        {
          modelId: "strong-hard",
          runAt: "t",
          sourcePath: "/h2",
          passCount: 18,
          total: 25,
          meanMs: 10,
          meanComposite: 90,
        },
      ],
    ]);
    const rows = mergeParseLeaderboard(base, hard);
    expect(rows[0]!.modelId).toBe("strong-hard");
    expect(rows[0]!.rank).toBe(1);
    expect(rows[1]!.modelId).toBe("weak-hard");
  });

  test("merge allows model with only one suite", () => {
    const base = new Map<string, ParseSuiteSnapshot>([
      [
        "base-only",
        {
          modelId: "base-only",
          runAt: "t",
          sourcePath: "/b",
          passCount: 22,
          total: 28,
          meanMs: 50,
        },
      ],
    ]);
    const rows = mergeParseLeaderboard(base, new Map());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hardStrict).toBeNull();
    expect(rows[0]!.basePass).toBe(22);
  });
});
