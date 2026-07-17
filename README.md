# chat-keuangan-bench

Open benchmarks for **Indonesian casual finance chat** — WhatsApp-style slang, corrections, receipts, mutasi, and multi-org ledgers.

Local-first: **OpenAI-compatible** (LM Studio / custom `baseURL`). No cloud LLM providers — every
model call is local. (Rupiah-Pro's optional `firecrawl_search` tool is the one remaining cloud
dependency; see [`docs/AGENTIC.md`](docs/AGENTIC.md).)

> **Repo:** [github.com/volfadar/chat-keuangan-bench](https://github.com/volfadar/chat-keuangan-bench)  
> Two suites: **Parse-25** (single-turn extraction) and **Rupiah-Pro** (multi-turn agent).

---

## Two benches

| | **Parse** (base + hard) | **Rupiah-Pro** |
|--|--------------|----------------|
| **What** | One-shot parse → structured `pemasukan` / `pengeluaran` JSON | Multi-turn agent with tools |
| **Run** | `bun run eval:parse -- --model <id>` then `bun run score:parse` | `bun run eval:agentic -- --model <id>` then `bun run score:rupiah-pro` |
| **Docs** | [`docs/REPORT.md`](docs/REPORT.md) · [`docs/FINDINGS.md`](docs/FINDINGS.md) | [`docs/AGENTIC.md`](docs/AGENTIC.md) |

`eval:parse` runs **base (28)** then **Parse-25 hard** sequentially. Prefer this for small
on-device models. Individual runners (`eval --suite base`, `eval:single`, `eval:hard-25`) remain
for smoke tests. An **SFT corpus generator** (`bun run generate:sft-parse`) produces training data
for a small local parser.

---

## Setup

```bash
git clone https://github.com/volfadar/chat-keuangan-bench.git
cd chat-keuangan-bench
cp .env.example .env
bun install

# Start LM Studio → Developer → Server → OpenAI-compatible (http://127.0.0.1:1234/v1)
```

Overrides: `--base-url http://127.0.0.1:1234/v1` · `--api-key lm-studio`
Or set `OPENAI_COMPATIBLE_BASE_URL` / `EVAL_MODEL` / `JUDGE_MODEL` in `.env`.

> **There is no default model roster.** `ALL_EVAL_MODELS` in
> [`src/core/model-roster.ts`](src/core/model-roster.ts) ships empty, so every runner needs an
> explicit `--model` / `--models`. Model ids are whatever `GET /v1/models` returns in LM Studio.
> Fill the roster once if you get tired of typing them.

---

## Benchmarking and comparing local models

Order matters: take the baseline **before** changing anything, or you can't tell what moved.

```bash
# Main entry — base (28) then Parse-25 hard, per model. Add --score to refresh the board.
bun run eval:parse -- --model qwen3-1.7b
bun run eval:parse -- --models qwen3-1.7b,gemma-3-1b --label baseline --score

# Or refresh the Parse scorecard + charts from existing run JSON:
bun run score:parse

# Smoke pieces separately if needed:
bun run eval -- --model qwen3-1.7b --suite base
bun run eval:single -- --model qwen3-1.7b --label smoke
bun run eval:hard-25 -- --dry-run

# Rupiah-Pro — multi-turn agent with tools (separate board).
bun run eval:agentic -- --suite all --model <id> --concurrency 1 --skip-judge
bun run score:rupiah-pro
```

Artifacts: `docs/results/runs/` (raw base/hard JSON) → `docs/results/parse/` (leaderboard) →
`docs/charts/parse/` (SVG). Rupiah-Pro stays under `docs/results/agentic/` + `docs/charts/rupiah-pro/`.

---

## Generating fine-tune data

Produces a ChatML corpus under `data/sft/<stamp>/` (`train/valid/test.jsonl`) for an external
trainer; the manifest prints the command line to consume it.

It is **spec-first**: a seeded RNG draws the answer key from
[`parse-taxonomy.ts`](src/core/parse-taxonomy.ts), the teacher only writes prose, and a blind parse
that never sees the spec must rediscover the answer. The teacher cannot mark its own homework, and
the agreement check costs no GPU because the spec isn't a language model. Rows failing any gate
(leak, amount traceability, dropped entry, schema, spec disagreement) go to `rejects.jsonl` with
structured reasons.

The taxonomy is authored for real-world coverage and imports nothing from the benchmark on purpose:
Parse-25 is an adversarial *test* set (91% pengeluaran, 91% `hari_ini`, `tidak_jelas` never
asserted) and training on that teaches a small model to guess the majority instead of learning
the rule.

```bash
# Free gates — run these first, they need no GPU and no server.
bun run generate:sft-parse -- --self-test           # validators vs hand-authored gold
bun run generate:sft-parse -- --dry-run --count 20  # plan, coverage, sample prompts

# Pilot. Read all 100 rows by hand — this is the real gate.
bun run generate:sft-parse -- --model <teacher-id> --count 100

# Scale up once the pilot looks right.
bun run generate:sft-parse -- --model <teacher-id> --count 2000
```

> **The teacher is not the student.** `--model` here is the *teacher*: a large local model
> (14B–32B) that generates the data. The small model you are fine-tuning never appears in this
> command. A 1.7B teacher will fail preflight (no structured output) or, worse, pass and produce
> junk labels.

Useful flags: `--seed <n>` (reproducible; same seed + same teacher → same corpus) ·
`--concurrency <n>` (default 2 — LM Studio is GPU-bound, more mostly queues) · `--resume` ·
`--overwrite` · `--system-prompt-mode full|short|none|mix` · `--min-success-rate <0-1>`

**After the pilot, read the manifest** (`docs/results/sft/sft-parse-manifest-latest.json`):

| Field | What it tells you |
|---|---|
| `perCellAcceptRate` / `weakCells` | Cells below ~0.9 mean the teacher is weak there — hand-label or drop them |
| `realized.entryLevelPemasukanShare` | Should be near 0.23. Near 0.09 means the corpus drifted back to "always pengeluaran" |
| `realized.zeroYieldAspects` | Any aspect here produced **nothing** — the student will be blind to it |
| `rejectsByPhase` | Why rows died. `rejects.jsonl` has the structured reasons |
| `maxSimilarityVsScoredCorpus` | Audits the no-leak claim instead of asserting it |

---

## Checks

```bash
bun run typecheck   # tsc --noEmit
bun test            # tokenizer gold-recall, leak guard, validators, prompt-leak assertions
```

---

## Repo map

```
src/core/          Parse-25 harness + llm-client (OpenAI-compatible)
  eval-core.ts       SYSTEM_PROMPT, schema, parseMessage, scoring
  rupiah.ts          Amount tokenizer for SFT validation (separate from the grading path)
  parse-taxonomy.ts  Authored cell taxonomy driving SFT generation — no bench imports
  eval-corpus.ts     Every scored text, for the leak guard
  parse-leakguard.ts Train/test leak detection
src/agentic/       Rupiah-Pro harness
src/mastra/        Studio
scripts/           Eval runners + generate:sft-parse
  lib/sft-*.ts       Spec building, validators, corpus I/O
data/sft/<stamp>/  Generated corpus (gitignored: raw/train/valid/test/rejects)
docs/results/sft/  SFT run manifests (committed — stats only, no rows)
fixtures/          Notas, mutasi CSV, rekening PDF
docs/
```

## Contributing

PRs welcome: realistic Indonesian chat scenarios, harder discriminative cases, scoring fixes.

Please **don't** add scenarios that mirror examples in the system prompt — a scenario the prompt
already answers measures nothing. `bun test` enforces this
([`src/core/prompt-leak.test.ts`](src/core/prompt-leak.test.ts)): no scored text may share a
3-word span with `SYSTEM_PROMPT`. If you add a scenario, run the tests; if you add a prompt rule,
illustrate it with an invented item rather than a scored one.

## License

MIT — see [LICENSE](LICENSE).
