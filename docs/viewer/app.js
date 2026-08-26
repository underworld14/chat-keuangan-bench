/**
 * Parse Results Viewer — static SPA (hash routing).
 * Fetches relative to docs/viewer/ so it works on GitHub Pages and local preview.
 */

const LB_URL = "../results/parse/parse-leaderboard-latest.json";
const RUNS_BASE = "../results/runs/";

const app = document.getElementById("app");

/** @type {object | null} */
let leaderboardCache = null;
/** @type {Map<string, object>} */
const runCache = new Map();

// ─── utils ───────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function basename(path) {
  if (!path) return null;
  const norm = String(path).replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

function frac(pass, total) {
  if (pass == null || total == null) return "—";
  return `${pass}/${total}`;
}

function fmtMs(ms) {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms >= 10000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

function fmtNum(n, digits = 0) {
  if (n == null || Number.isNaN(n)) return "—";
  return digits ? Number(n).toFixed(digits) : String(Math.round(n));
}

function pct(n, d) {
  if (n == null || d == null || !d) return 0;
  return Math.max(0, Math.min(100, (n / d) * 100));
}

function encodeModel(id) {
  return encodeURIComponent(id);
}

function decodeModel(seg) {
  return decodeURIComponent(seg);
}

function barHtml(value, max, kind = "") {
  const w = pct(value, max);
  const cls = kind ? ` bar-fill ${kind}` : " bar-fill";
  return `<div class="bar-row"><div class="bar-track"><div class="${cls.trim()}" style="width:${w.toFixed(1)}%"></div></div></div>`;
}

function crumbs(...parts) {
  const items = [];
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) items.push(`<span class="sep">/</span>`);
    const p = parts[i];
    if (typeof p === "string") items.push(`<span>${esc(p)}</span>`);
    else items.push(`<a href="${esc(p.href)}">${esc(p.label)}</a>`);
  }
  return `<nav class="crumbs">${items.join("")}</nav>`;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url} (${res.status})`);
  return res.json();
}

async function loadLeaderboard() {
  if (leaderboardCache) return leaderboardCache;
  leaderboardCache = await fetchJson(LB_URL);
  return leaderboardCache;
}

async function loadRun(sourcePath) {
  const name = basename(sourcePath);
  if (!name) return null;
  if (runCache.has(name)) return runCache.get(name);
  const data = await fetchJson(RUNS_BASE + name);
  runCache.set(name, data);
  return data;
}

function findRow(lb, modelId) {
  return lb.leaderboard.find((r) => r.modelId === modelId) ?? null;
}

function parseHash() {
  const raw = (location.hash || "#/").replace(/^#/, "") || "/";
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  const segs = path.split("/").filter(Boolean);
  // #/model/<id...>/base|hard/<scenarioId> — modelId may contain "/" (org/name).
  // Treat base|hard as sentinels so slashy ids stay intact even if the hash is decoded.
  if (segs[0] === "model" && segs.length >= 2) {
    const suiteIdx = segs.findIndex((s, i) => i >= 2 && (s === "base" || s === "hard"));
    if (suiteIdx > 1) {
      const modelId = decodeModel(segs.slice(1, suiteIdx).join("/"));
      const suite = segs[suiteIdx];
      const rest = segs.slice(suiteIdx + 1);
      if (rest.length) {
        return {
          view: "case",
          modelId,
          suite,
          scenarioId: decodeURIComponent(rest.join("/")),
        };
      }
      return { view: "model", modelId, suite };
    }
    const modelId = decodeModel(segs.slice(1).join("/"));
    return { view: "model", modelId, suite: null };
  }
  return { view: "leaderboard" };
}

function navigate(hash) {
  location.hash = hash.startsWith("#") ? hash : `#${hash}`;
}

// ─── views ───────────────────────────────────────────────────────────

function renderLeaderboard(lb) {
  const rows = lb.leaderboard ?? [];
  const maxBase = Math.max(...rows.map((r) => r.baseTotal || 0), 1);
  const maxHard = Math.max(...rows.map((r) => r.hardTotal || 0), 1);
  const maxComp = 100;
  const maxLat = Math.max(...rows.map((r) => r.hardMeanMs || r.baseMeanMs || 0), 1);

  const body = rows
    .map((r) => {
      const href = `#/model/${encodeModel(r.modelId)}`;
      return `<tr class="clickable" data-href="${esc(href)}">
        <td class="num">${esc(r.rank)}</td>
        <td><a href="${esc(href)}"><code>${esc(r.modelId)}</code></a></td>
        <td class="num">${esc(frac(r.basePass, r.baseTotal))}</td>
        <td class="hide-sm">${barHtml(r.basePass, maxBase)}</td>
        <td class="num">${esc(frac(r.hardStrict, r.hardTotal))}</td>
        <td class="hide-sm">${barHtml(r.hardStrict, maxHard)}</td>
        <td class="num">${esc(fmtNum(r.hardComposite, 1))}</td>
        <td class="hide-sm">${barHtml(r.hardComposite, maxComp, "composite")}</td>
        <td class="num">${esc(fmtMs(r.hardMeanMs ?? r.baseMeanMs))}</td>
        <td class="hide-sm">${barHtml(r.hardMeanMs ?? r.baseMeanMs, maxLat, "latency")}</td>
      </tr>`;
    })
    .join("");

  app.innerHTML = `
    ${crumbs({ href: "#/", label: "Leaderboard" })}
    <h1>${esc(lb.bench)} Leaderboard</h1>
    <p class="meta">
      v${esc(lb.version)} · generated ${esc(lb.generatedAt)}<br />
      Ranking: <code>${esc(lb.ranking)}</code>
    </p>
    ${
      rows.length
        ? `<div class="table-wrap"><table>
      <thead>
        <tr>
          <th class="num">#</th>
          <th>Model</th>
          <th class="num">Base</th>
          <th class="hide-sm"></th>
          <th class="num">Hard strict</th>
          <th class="hide-sm"></th>
          <th class="num">Composite</th>
          <th class="hide-sm"></th>
          <th class="num">Hard latency</th>
          <th class="hide-sm"></th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table></div>`
        : `<div class="empty-state">No leaderboard rows yet. Run <code>bun run eval:parse</code> then <code>bun run score:parse</code>.</div>`
    }
  `;

  bindRowClicks();
}

function suiteScenarios(run, suite) {
  if (!run) return [];
  if (suite === "hard" && Array.isArray(run.results)) {
    return run.results.map((r) => ({
      id: r.scenarioId,
      strictPass: !!r.strictPass,
      ms: r.ms,
      composite: r.quality?.compositeScore ?? null,
      tier: r.quality?.tier ?? null,
      issues: r.issues ?? [],
      raw: r,
    }));
  }
  // Base: only failures listed; synthesize pass/fail from failures + byStyle totals when possible
  if (suite === "base") {
    const failMap = new Map((run.failures ?? []).map((f) => [f.id, f]));
    // Prefer explicit results if present
    if (Array.isArray(run.results) && run.results.length) {
      return run.results.map((r) => ({
        id: r.scenarioId ?? r.id,
        strictPass: !!(r.strictPass ?? r.pass),
        ms: r.ms ?? null,
        composite: r.quality?.compositeScore ?? null,
        tier: r.quality?.tier ?? null,
        issues: r.issues ?? [],
        raw: r,
      }));
    }
    // Failure-only artifact: show failures as fail rows; we don't have pass scenario ids
    return [...failMap.values()].map((f) => ({
      id: f.id,
      strictPass: false,
      ms: null,
      composite: null,
      tier: null,
      issues: f.issues ?? [],
      raw: f,
      failureOnly: true,
    }));
  }
  return [];
}

function renderModel(lb, row, baseRun, hardRun, suite, filter) {
  const activeSuite = suite === "hard" ? "hard" : "base";
  const run = activeSuite === "hard" ? hardRun : baseRun;
  let scenarios = suiteScenarios(run, activeSuite);
  const filterMode = filter || "all";

  if (filterMode === "pass") scenarios = scenarios.filter((s) => s.strictPass);
  if (filterMode === "fail") scenarios = scenarios.filter((s) => !s.strictPass);

  const modelHref = `#/model/${encodeModel(row.modelId)}`;
  const suiteHref = (s) => `#/model/${encodeModel(row.modelId)}/${s}`;

  const note =
    activeSuite === "base" && baseRun && !Array.isArray(baseRun.results)
      ? `<p class="meta">Base runs store failures only — passing scenarios are not listed individually.</p>`
      : "";

  const styleCards =
    activeSuite === "base" && baseRun?.byStyle
      ? `<h2>By style</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>Style</th><th class="num">Pass</th><th class="num">Total</th></tr></thead>
          <tbody>
            ${Object.entries(baseRun.byStyle)
              .map(
                ([k, v]) =>
                  `<tr><td><code>${esc(k)}</code></td><td class="num">${esc(v.pass)}</td><td class="num">${esc(v.total)}</td></tr>`,
              )
              .join("")}
          </tbody>
        </table></div>`
      : "";

  const rowsHtml = scenarios
    .map((s) => {
      const href = `#/model/${encodeModel(row.modelId)}/${activeSuite}/${encodeURIComponent(s.id)}`;
      const badge = s.strictPass
        ? `<span class="badge pass">pass</span>`
        : `<span class="badge fail">fail</span>`;
      const tier = s.tier ? `<span class="badge tier">${esc(s.tier)}</span>` : "—";
      return `<tr class="clickable" data-href="${esc(href)}">
        <td><a href="${esc(href)}"><code>${esc(s.id)}</code></a></td>
        <td>${badge}</td>
        <td class="num">${esc(s.composite != null ? fmtNum(s.composite, 0) : "—")}</td>
        <td>${tier}</td>
        <td class="num">${esc(fmtMs(s.ms))}</td>
        <td class="hide-sm muted">${esc((s.issues ?? []).slice(0, 2).join("; ") || "—")}</td>
      </tr>`;
    })
    .join("");

  const emptyMsg =
    activeSuite === "base" && !baseRun
      ? "No base run file found for this model."
      : activeSuite === "hard" && !hardRun
        ? "No hard-25 run file found for this model."
        : scenarios.length === 0
          ? filterMode === "all"
            ? "No scenarios in this run."
            : `No ${filterMode} scenarios.`
          : null;

  app.innerHTML = `
    ${crumbs({ href: "#/", label: "Leaderboard" }, { href: modelHref, label: row.modelId })}
    <h1><code>${esc(row.modelId)}</code></h1>
    <p class="meta">Rank #${esc(row.rank)}</p>

    <div class="cards">
      <div class="card"><span class="label">Base</span><span class="value">${esc(frac(row.basePass, row.baseTotal))}</span><div class="sub">${esc(fmtMs(row.baseMeanMs))} mean</div></div>
      <div class="card"><span class="label">Hard strict</span><span class="value">${esc(frac(row.hardStrict, row.hardTotal))}</span><div class="sub">${esc(fmtMs(row.hardMeanMs))} mean</div></div>
      <div class="card"><span class="label">Hard composite</span><span class="value">${esc(fmtNum(row.hardComposite, 1))}</span><div class="sub">0–100 quality</div></div>
    </div>

    <div class="toolbar">
      <div class="seg" role="tablist" aria-label="Suite">
        <button type="button" data-nav="${esc(suiteHref("base"))}" class="${activeSuite === "base" ? "active" : ""}">Base</button>
        <button type="button" data-nav="${esc(suiteHref("hard"))}" class="${activeSuite === "hard" ? "active" : ""}">Hard-25</button>
      </div>
      <div class="seg" role="tablist" aria-label="Filter">
        <button type="button" data-filter="all" class="${filterMode === "all" ? "active" : ""}">All</button>
        <button type="button" data-filter="fail" class="${filterMode === "fail" ? "active" : ""}">Fail</button>
        <button type="button" data-filter="pass" class="${filterMode === "pass" ? "active" : ""}">Pass</button>
      </div>
    </div>
    ${note}
    ${
      emptyMsg
        ? `<div class="empty-state">${esc(emptyMsg)}</div>`
        : `<div class="table-wrap"><table>
      <thead>
        <tr>
          <th>Scenario</th>
          <th>Result</th>
          <th class="num">Composite</th>
          <th>Tier</th>
          <th class="num">Latency</th>
          <th class="hide-sm">Issues</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table></div>`
    }
    ${styleCards}
  `;

  bindRowClicks();
  app.querySelectorAll("[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => navigate(btn.getAttribute("data-nav")));
  });
  app.querySelectorAll("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const f = btn.getAttribute("data-filter");
      // stash filter in session for this model+suite
      sessionStorage.setItem(`parse-viewer-filter:${row.modelId}:${activeSuite}`, f);
      route();
    });
  });
}

function renderCase(lb, row, run, suite, scenarioId) {
  const modelHref = `#/model/${encodeModel(row.modelId)}/${suite}`;
  const scenarios = suiteScenarios(run, suite);
  const s = scenarios.find((x) => x.id === scenarioId);

  if (!s) {
    app.innerHTML = `
      ${crumbs({ href: "#/", label: "Leaderboard" }, { href: `#/model/${encodeModel(row.modelId)}`, label: row.modelId }, scenarioId)}
      <div class="error">Scenario <code>${esc(scenarioId)}</code> not found in ${esc(suite)} run.</div>
    `;
    return;
  }

  const raw = s.raw ?? {};
  const quality = raw.quality ?? null;
  const scores = quality?.scores ?? null;
  const badge = s.strictPass
    ? `<span class="badge pass">pass</span>`
    : `<span class="badge fail">fail</span>`;

  const scoreGrid = scores
    ? `<div class="score-grid">
        ${Object.entries(scores)
          .map(
            ([k, v]) =>
              `<div class="score-cell"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`,
          )
          .join("")}
        <div class="score-cell"><span class="k">composite</span><span class="v">${esc(quality.compositeScore ?? "—")}</span></div>
        <div class="score-cell"><span class="k">tier</span><span class="v">${esc(quality.tier ?? "—")}</span></div>
      </div>`
    : "";

  const issues = (raw.issues ?? s.issues ?? quality?.strictIssues ?? []).filter(Boolean);
  const notes = quality?.qualityNotes ?? [];
  const matches = quality?.partialMatches ?? [];
  const extras = quality?.extraEntries ?? [];

  const issuesBlock =
    issues.length > 0
      ? `<div class="list-block"><strong>Issues</strong><ul>${issues.map((i) => `<li>${esc(i)}</li>`).join("")}</ul></div>`
      : `<div class="list-block empty">No issues listed.</div>`;

  const notesBlock =
    notes.length > 0
      ? `<div class="list-block"><strong>Quality notes</strong><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>`
      : "";

  const matchesBlock =
    matches.length > 0
      ? `<h2>Partial matches</h2><div class="matches">${matches
          .map((m) => {
            const c = m.credit ?? 0;
            const cls = c >= 90 ? "ok" : c >= 40 ? "mid" : "bad";
            return `<div class="match"><span class="credit ${cls}">${esc(c)}</span><span class="mono">${esc(m.label)}</span><span class="detail muted">${esc(m.detail ?? "")}</span></div>`;
          })
          .join("")}</div>`
      : "";

  const extrasBlock =
    extras.length > 0
      ? `<div class="list-block"><strong>Extra entries</strong><ul>${extras.map((e) => `<li><code>${esc(typeof e === "string" ? e : JSON.stringify(e))}</code></li>`).join("")}</ul></div>`
      : "";

  const metaBits = [
    raw.ms != null ? `latency ${fmtMs(raw.ms)}` : null,
    raw.promptTokens != null ? `prompt ${raw.promptTokens} tok` : null,
    raw.completionTokens != null ? `completion ${raw.completionTokens} tok` : null,
    raw.error ? `error: ${raw.error}` : null,
  ].filter(Boolean);

  app.innerHTML = `
    ${crumbs(
      { href: "#/", label: "Leaderboard" },
      { href: `#/model/${encodeModel(row.modelId)}`, label: row.modelId },
      { href: modelHref, label: suite === "hard" ? "Hard-25" : "Base" },
      scenarioId,
    )}
    <h1><code>${esc(scenarioId)}</code> ${badge}</h1>
    <p class="meta">${esc(metaBits.join(" · ") || "No timing metadata")}</p>
    ${scoreGrid}
    ${issuesBlock}
    ${notesBlock}
    ${matchesBlock}
    ${extrasBlock}
    ${
      s.failureOnly
        ? `<p class="meta">This base artifact only records failures — quality breakdown is unavailable.</p>`
        : ""
    }
  `;
}

function bindRowClicks() {
  app.querySelectorAll("tr.clickable[data-href]").forEach((tr) => {
    tr.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      navigate(tr.getAttribute("data-href"));
    });
  });
}

function showError(err) {
  app.innerHTML = `<div class="error"><strong>Load failed</strong><br />${esc(err.message || err)}</div>`;
}

async function route() {
  const state = parseHash();
  try {
    const lb = await loadLeaderboard();

    if (state.view === "leaderboard") {
      renderLeaderboard(lb);
      return;
    }

    const row = findRow(lb, state.modelId);
    if (!row) {
      app.innerHTML = `<div class="error">Model <code>${esc(state.modelId)}</code> not on the leaderboard.</div>`;
      return;
    }

    const [baseRun, hardRun] = await Promise.all([
      row.baseSourcePath ? loadRun(row.baseSourcePath).catch(() => null) : null,
      row.hardSourcePath ? loadRun(row.hardSourcePath).catch(() => null) : null,
    ]);

    if (state.view === "model") {
      const suite = state.suite || "hard";
      const filter =
        sessionStorage.getItem(`parse-viewer-filter:${row.modelId}:${suite}`) || "all";
      renderModel(lb, row, baseRun, hardRun, suite, filter);
      return;
    }

    if (state.view === "case") {
      const run = state.suite === "hard" ? hardRun : baseRun;
      if (!run) {
        app.innerHTML = `<div class="error">No ${esc(state.suite)} run file for <code>${esc(row.modelId)}</code>.</div>`;
        return;
      }
      renderCase(lb, row, run, state.suite, state.scenarioId);
    }
  } catch (err) {
    showError(err);
  }
}

window.addEventListener("hashchange", route);
route();
