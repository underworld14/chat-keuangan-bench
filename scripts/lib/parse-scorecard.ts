/**
 * Offline Parse scorecard helpers — discover base + hard-25 run artifacts,
 * keep newest per modelId, merge into leaderboard rows.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const PARSE_BENCH_NAME = "Parse";
export const PARSE_BENCH_VERSION = "1.0.0";

export type ParseBaseArtifact = {
  kind?: string;
  suite?: string;
  runAt: string;
  modelId: string;
  passCount: number;
  total: number;
  meanMs: number;
};

export type ParseHardSummary = {
  modelId: string;
  strictPass: number;
  meanComposite: number;
  meanMs: number;
};

export type ParseHardArtifact = {
  kind?: string;
  runAt: string;
  modelId?: string;
  model?: string;
  strictPass?: number;
  totalScenarios?: number;
  meanComposite?: number;
  avgMs?: number;
  summaries?: Array<{
    modelId: string;
    strictPass: number;
    meanComposite: number;
    meanMs: number;
  }>;
  results?: Array<{
    modelId?: string;
    ms?: number;
    error?: string | null;
    quality?: { compositeScore?: number; strictPass?: boolean } | null;
    strictPass?: boolean;
  }>;
};

export type ParseSuiteSnapshot = {
  modelId: string;
  runAt: string;
  sourcePath: string;
  passCount: number;
  total: number;
  meanMs: number;
  meanComposite?: number;
};

export type ParseLeaderboardRow = {
  rank: number;
  modelId: string;
  basePass: number | null;
  baseTotal: number | null;
  baseMeanMs: number | null;
  baseSourcePath: string | null;
  hardStrict: number | null;
  hardTotal: number | null;
  hardComposite: number | null;
  hardMeanMs: number | null;
  hardSourcePath: string | null;
};

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Prefer newer runAt; tie-break by path (lexicographic, newer filenames last). */
export function isNewerRun(
  a: { runAt: string; sourcePath: string },
  b: { runAt: string; sourcePath: string },
): boolean {
  if (a.runAt !== b.runAt) return a.runAt > b.runAt;
  return a.sourcePath > b.sourcePath;
}

export function extractBaseSnapshot(
  path: string,
  data: unknown,
): ParseSuiteSnapshot | null {
  if (!isRecord(data)) return null;
  if (data.kind !== "parse-base") return null;
  if (data.suite !== "base" && data.suite != null) return null;
  const modelId = typeof data.modelId === "string" ? data.modelId : null;
  const runAt = typeof data.runAt === "string" ? data.runAt : null;
  if (!modelId || !runAt) return null;
  return {
    modelId,
    runAt,
    sourcePath: path,
    passCount: Number(data.passCount ?? 0),
    total: Number(data.total ?? 0),
    meanMs: Number(data.meanMs ?? 0),
  };
}

function hardFromSingle(path: string, data: ParseHardArtifact): ParseSuiteSnapshot | null {
  const modelId = data.modelId ?? data.model;
  if (!modelId || !data.runAt) return null;
  let meanComposite = data.meanComposite;
  if (meanComposite == null && data.results?.length) {
    const comps = data.results
      .map((r) => r.quality?.compositeScore)
      .filter((n): n is number => typeof n === "number");
    meanComposite = comps.length
      ? comps.reduce((a, b) => a + b, 0) / comps.length
      : undefined;
  }
  const total = data.totalScenarios ?? data.results?.length ?? 25;
  const strict =
    data.strictPass ??
    data.results?.filter((r) => r.strictPass || r.quality?.strictPass).length ??
    0;
  return {
    modelId,
    runAt: data.runAt,
    sourcePath: path,
    passCount: strict,
    total,
    meanMs: data.avgMs ?? 0,
    meanComposite,
  };
}

function hardFromMulti(
  path: string,
  data: ParseHardArtifact,
): ParseSuiteSnapshot[] {
  if (!data.runAt) return [];
  if (data.summaries?.length) {
    return data.summaries.map((s) => ({
      modelId: s.modelId,
      runAt: data.runAt,
      sourcePath: path,
      passCount: s.strictPass,
      total: 25,
      meanMs: s.meanMs,
      meanComposite: s.meanComposite,
    }));
  }
  // Legacy multi without summaries: group results by modelId
  if (!data.results?.length) return [];
  const byModel = new Map<string, NonNullable<ParseHardArtifact["results"]>>();
  for (const r of data.results) {
    if (!r.modelId) continue;
    const list = byModel.get(r.modelId) ?? [];
    list.push(r);
    byModel.set(r.modelId, list);
  }
  return [...byModel.entries()].map(([modelId, rows]) => {
    const comps = rows
      .map((r) => r.quality?.compositeScore)
      .filter((n): n is number => typeof n === "number");
    const ms = rows.filter((r) => (r.ms ?? 0) > 0).map((r) => r.ms!);
    return {
      modelId,
      runAt: data.runAt,
      sourcePath: path,
      passCount: rows.filter((r) => r.quality?.strictPass || r.strictPass).length,
      total: rows.length,
      meanMs: ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : 0,
      meanComposite: comps.length
        ? comps.reduce((a, b) => a + b, 0) / comps.length
        : undefined,
    };
  });
}

export function extractHardSnapshots(
  path: string,
  data: unknown,
): ParseSuiteSnapshot[] {
  if (!isRecord(data)) return [];
  const art = data as ParseHardArtifact;
  const looksHard =
    art.kind === "parse-hard-25" ||
    path.includes("finance-hard-25-results") ||
    path.includes("parse-hard-25") ||
    (Array.isArray(art.summaries) && Array.isArray(art.results)) ||
    (typeof (art.modelId ?? art.model) === "string" &&
      typeof art.strictPass === "number" &&
      Array.isArray(art.results) &&
      !art.kind);

  if (!looksHard) return [];

  // Multi-model hard-25
  if (art.summaries?.length || (art.results?.some((r) => r.modelId) && !art.model && !art.modelId)) {
    return hardFromMulti(path, art);
  }

  // Single-model (kind parse-hard-25 or legacy label-results)
  if (art.modelId || art.model) {
    const snap = hardFromSingle(path, art);
    return snap ? [snap] : [];
  }

  return hardFromMulti(path, art);
}

export function discoverNewestPerModel(
  snapshots: ParseSuiteSnapshot[],
): Map<string, ParseSuiteSnapshot> {
  const byModel = new Map<string, ParseSuiteSnapshot>();
  for (const snap of snapshots) {
    const prev = byModel.get(snap.modelId);
    if (!prev || isNewerRun(snap, prev)) byModel.set(snap.modelId, snap);
  }
  return byModel;
}

export function discoverParseRuns(runsDir: string): {
  base: Map<string, ParseSuiteSnapshot>;
  hard: Map<string, ParseSuiteSnapshot>;
} {
  const baseSnaps: ParseSuiteSnapshot[] = [];
  const hardSnaps: ParseSuiteSnapshot[] = [];
  if (!existsSync(runsDir)) return { base: new Map(), hard: new Map() };

  const files = readdirSync(runsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(runsDir, f));

  for (const path of files) {
    try {
      const data = loadJson(path);
      const base = extractBaseSnapshot(path, data);
      if (base) baseSnaps.push(base);
      hardSnaps.push(...extractHardSnapshots(path, data));
    } catch {
      /* skip malformed */
    }
  }

  return {
    base: discoverNewestPerModel(baseSnaps),
    hard: discoverNewestPerModel(hardSnaps),
  };
}

export function mergeParseLeaderboard(
  base: Map<string, ParseSuiteSnapshot>,
  hard: Map<string, ParseSuiteSnapshot>,
): ParseLeaderboardRow[] {
  const modelIds = new Set([...base.keys(), ...hard.keys()]);
  const rows: Omit<ParseLeaderboardRow, "rank">[] = [];

  for (const modelId of modelIds) {
    const b = base.get(modelId);
    const h = hard.get(modelId);
    rows.push({
      modelId,
      basePass: b ? b.passCount : null,
      baseTotal: b ? b.total : null,
      baseMeanMs: b ? b.meanMs : null,
      baseSourcePath: b ? b.sourcePath : null,
      hardStrict: h ? h.passCount : null,
      hardTotal: h ? h.total : null,
      hardComposite: h?.meanComposite != null ? Math.round(h.meanComposite * 10) / 10 : null,
      hardMeanMs: h ? h.meanMs : null,
      hardSourcePath: h ? h.sourcePath : null,
    });
  }

  rows.sort((a, b) => {
    const hs = (b.hardStrict ?? -1) - (a.hardStrict ?? -1);
    if (hs !== 0) return hs;
    const hc = (b.hardComposite ?? -1) - (a.hardComposite ?? -1);
    if (hc !== 0) return hc;
    const bp = (b.basePass ?? -1) - (a.basePass ?? -1);
    if (bp !== 0) return bp;
    const latA = a.hardMeanMs ?? a.baseMeanMs ?? Number.POSITIVE_INFINITY;
    const latB = b.hardMeanMs ?? b.baseMeanMs ?? Number.POSITIVE_INFINITY;
    return latA - latB;
  });

  return rows.map((r, i) => ({ rank: i + 1, ...r }));
}

export function defaultRunsDir(fromDirname: string): string {
  return resolve(fromDirname, "../../docs/results/runs");
}
