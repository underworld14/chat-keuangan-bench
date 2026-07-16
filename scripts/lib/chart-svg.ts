/**
 * Shared SVG chart helpers for Parse-25 and Rupiah-Pro report assets.
 *
 * Scatter convention (best practice):
 *   X = cost, left = cheaper → right = more expensive
 *   Y = quality, bottom = low → top = high
 *   Ideal quadrant = top-left
 */

export const CHART_WIDTH = 960;
export const BAR_HEIGHT = 36;
export const LABEL_W = 220;
export const VALUE_W = 140;

export const PALETTE = [
  "#2563eb",
  "#16a34a",
  "#dc2626",
  "#9333ea",
  "#ea580c",
  "#0891b2",
  "#ca8a04",
  "#4f46e5",
  "#0d9488",
  "#be185d",
  "#65a30d",
  "#7c3aed",
];

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function barChartSvg(opts: {
  title: string;
  rows: Array<{ label: string; value: number; display: string; color: string }>;
  maxValue?: number;
  width?: number;
  barHeight?: number;
  unit?: string;
}): string {
  const width = opts.width ?? CHART_WIDTH;
  const barH = opts.barHeight ?? BAR_HEIGHT;
  const gap = 12;
  const labelW = LABEL_W;
  const valueW = VALUE_W;
  const chartW = width - labelW - valueW - 48;
  const max = opts.maxValue ?? Math.max(...opts.rows.map((r) => r.value), 1);
  const height = 56 + opts.rows.length * (barH + gap) + 28;

  const bars = opts.rows
    .map((r, i) => {
      const y = 52 + i * (barH + gap);
      const w = Math.max(4, (r.value / max) * chartW);
      return `
    <text x="8" y="${y + barH * 0.72}" class="label">${escapeXml(r.label)}</text>
    <rect x="${labelW}" y="${y}" width="${w}" height="${barH}" rx="4" fill="${r.color}"/>
    <text x="${labelW + chartW + 8}" y="${y + barH * 0.72}" class="value">${escapeXml(r.display)}</text>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <style>
    .title { font: 600 18px system-ui, sans-serif; fill: #0f172a; }
    .label { font: 14px system-ui, sans-serif; fill: #334155; }
    .value { font: 14px system-ui, sans-serif; fill: #475569; }
    .sub { font: 12px system-ui, sans-serif; fill: #64748b; }
  </style>
  <rect width="100%" height="100%" fill="#fafafa"/>
  <text x="16" y="28" class="title">${escapeXml(opts.title)}</text>
  ${opts.unit ? `<text x="16" y="46" class="sub">${escapeXml(opts.unit)}</text>` : ""}
  ${bars}
</svg>`;
}

/**
 * Quality vs cost scatter.
 * X = cost in natural units (cheaper left, expensive right).
 * Ideal quadrant = top-left (high quality, low cost).
 */
export function scatterSvg(opts: {
  title: string;
  points: Array<{ label: string; x: number; y: number; color: string }>;
  xLabel: string;
  yLabel: string;
  yMin?: number;
  yMax?: number;
  /** Fixed X domain (same units as point.x). When set, skips auto-fit from data. */
  xMin?: number;
  xMax?: number;
  /** Tick values in the same units as point.x (ascending left→right) */
  xMetricTicks?: number[];
  /** Format tick label from numeric cost */
  formatXTick?: (n: number) => string;
  shortLabel?: (label: string) => string;
  xPadLeft?: number;
  xPadRight?: number;
  width?: number;
  height?: number;
}): string {
  const W = opts.width ?? CHART_WIDTH;
  const H = opts.height ?? 560;
  const pad = { l: 72, r: 72, t: 48, b: 88 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;
  const dataMinX = Math.min(...opts.points.map((p) => p.x));
  const dataMaxX = Math.max(...opts.points.map((p) => p.x));
  const dataSpan = dataMaxX - dataMinX || 1;
  const xPadLeft = opts.xPadLeft ?? 0.12;
  const xPadRight = opts.xPadRight ?? 0.12;
  const displayMinX =
    opts.xMin != null ? opts.xMin : Math.max(0, dataMinX - dataSpan * xPadLeft);
  const displayMaxX =
    opts.xMax != null ? opts.xMax : dataMaxX + dataSpan * xPadRight;
  const displaySpan = displayMaxX - displayMinX || 1;
  const minY = opts.yMin ?? 0;
  const maxY = opts.yMax ?? 100;
  const ySpan = maxY - minY || 1;
  const labelFn = opts.shortLabel ?? ((s: string) => s);
  const tickFmt =
    opts.formatXTick ?? ((n: number) => `Rp\u00a0${Math.round(n).toLocaleString("id-ID")}`);

  const plotX = (cost: number) =>
    pad.l + ((cost - displayMinX) / displaySpan) * plotW;
  const plotY = (value: number) => {
    const yClamped = Math.min(maxY, Math.max(minY, value));
    return pad.t + plotH - ((yClamped - minY) / ySpan) * plotH;
  };

  // Four-quadrant matrix: midlines + strong top-left ideal band
  const midX = pad.l + plotW / 2;
  const midY = pad.t + plotH / 2;
  const qW = plotW / 2;
  const qH = plotH / 2;
  const idealQuad = `
  <rect x="${pad.l}" y="${pad.t}" width="${qW}" height="${qH}" fill="#bbf7d0" opacity="0.55" rx="2"/>
  <rect x="${midX}" y="${pad.t}" width="${qW}" height="${qH}" fill="#fef3c7" opacity="0.35" rx="2"/>
  <rect x="${pad.l}" y="${midY}" width="${qW}" height="${qH}" fill="#e2e8f0" opacity="0.35" rx="2"/>
  <rect x="${midX}" y="${midY}" width="${qW}" height="${qH}" fill="#fecaca" opacity="0.35" rx="2"/>
  <line x1="${midX}" y1="${pad.t}" x2="${midX}" y2="${pad.t + plotH}" stroke="#64748b" stroke-width="1.5" stroke-dasharray="6 4"/>
  <line x1="${pad.l}" y1="${midY}" x2="${pad.l + plotW}" y2="${midY}" stroke="#64748b" stroke-width="1.5" stroke-dasharray="6 4"/>
  <text x="${pad.l + 12}" y="${pad.t + 22}" class="ideal">Ideal · high quality · low cost</text>
  <text x="${midX + 12}" y="${pad.t + 22}" class="quad-label">Premium · high quality · high cost</text>
  <text x="${pad.l + 12}" y="${pad.t + plotH - 12}" class="quad-label">Budget miss · low quality · low cost</text>
  <text x="${midX + 12}" y="${pad.t + plotH - 12}" class="quad-label">Avoid · low quality · high cost</text>`;

  const yTicks = [minY, minY + ySpan * 0.5, maxY];
  const yGrid = yTicks
    .map((tick) => {
      const cy = pad.t + plotH - ((tick - minY) / ySpan) * plotH;
      return `
    <line x1="${pad.l}" y1="${cy}" x2="${pad.l + plotW}" y2="${cy}" stroke="#cbd5e1" stroke-dasharray="3 3" opacity="0.6"/>
    <text x="${pad.l - 8}" y="${cy + 4}" text-anchor="end" class="tick">${tick.toFixed(0)}</text>`;
    })
    .join("");

  const xTicks = opts.xMetricTicks ?? [];
  const xGrid = xTicks
    .map((cost) => {
      const cx = plotX(cost);
      if (cx < pad.l - 2 || cx > pad.l + plotW + 2) return "";
      return `
    <line x1="${cx}" y1="${pad.t}" x2="${cx}" y2="${pad.t + plotH}" stroke="#e2e8f0" stroke-dasharray="4 4"/>
    <text x="${cx}" y="${pad.t + plotH + 20}" text-anchor="middle" class="tick">${escapeXml(tickFmt(cost))}</text>`;
    })
    .join("");

  const dots = opts.points
    .map((p) => {
      const cx = plotX(p.x);
      const cy = plotY(p.y);
      return `
    <circle cx="${cx}" cy="${cy}" r="9" fill="${p.color}" opacity="0.85"/>
    <text x="${cx}" y="${cy + 22}" text-anchor="middle" class="dot-label">${escapeXml(labelFn(p.label))}</text>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <style>
    .title { font: 600 18px system-ui, sans-serif; fill: #0f172a; }
    .axis { font: 13px system-ui, sans-serif; fill: #64748b; }
    .tick { font: 11px system-ui, sans-serif; fill: #94a3b8; }
    .dot-label { font: 12px system-ui, sans-serif; fill: #334155; }
    .ideal { font: 700 13px system-ui, sans-serif; fill: #15803d; }
    .quad-label { font: 600 11px system-ui, sans-serif; fill: #64748b; }
  </style>
  <rect width="100%" height="100%" fill="#fafafa"/>
  <text x="12" y="22" class="title">${escapeXml(opts.title)}</text>
  ${idealQuad}
  ${yGrid}
  ${xGrid}
  <line x1="${pad.l}" y1="${pad.t + plotH}" x2="${pad.l + plotW}" y2="${pad.t + plotH}" stroke="#cbd5e1"/>
  <line x1="${pad.l}" y1="${pad.t}" x2="${pad.l}" y2="${pad.t + plotH}" stroke="#cbd5e1"/>
  <text x="${pad.l + plotW / 2}" y="${H - 10}" text-anchor="middle" class="axis">${escapeXml(opts.xLabel)}</text>
  <text x="18" y="${pad.t + plotH / 2}" transform="rotate(-90 18 ${pad.t + plotH / 2})" text-anchor="middle" class="axis">${escapeXml(opts.yLabel)}</text>
  ${dots}
</svg>`;
}

/** Round-ish IDR ticks between min and max (ascending). */
export function idrCostTicks(minIdr: number, maxIdr: number): number[] {
  const span = maxIdr - minIdr || 1;
  const stepGuess = span / 5;
  const niceSteps = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
  const step =
    niceSteps.find((s) => s >= stepGuess) ??
    Math.max(1, Math.round(stepGuess / 100) * 100);
  const start = Math.floor(minIdr / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= maxIdr + step * 0.01; v += step) {
    if (v >= minIdr * 0.85 && v <= maxIdr * 1.05) ticks.push(v);
  }
  if (ticks.length < 3) {
    return [minIdr, Math.round((minIdr + maxIdr) / 2), maxIdr];
  }
  return ticks;
}

/** Full-width chart block for GitHub README / REPORT. */
export function chartEmbedMd(
  relPath: string,
  title: string,
  caption?: string,
): string[] {
  const lines = [
    `#### ${title}`,
    ``,
    `<p align="center">`,
    `  <img src="${relPath}" alt="${title}" width="${CHART_WIDTH}" />`,
    `</p>`,
    ``,
  ];
  if (caption) lines.splice(1, 0, caption, ``);
  return lines;
}
