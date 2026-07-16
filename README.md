# chat-keuangan-bench

Open benchmarks for **Indonesian casual finance chat** — WhatsApp-style slang, corrections, receipts, mutasi, and multi-org ledgers.

Local-first: **OpenAI-compatible** (LM Studio / custom `baseURL`). No cloud LLM providers — every
model call is local. (Rupiah-Pro's optional `firecrawl_search` tool is the one remaining cloud
dependency; see [`docs/AGENTIC.md`](docs/AGENTIC.md).)

> **Repo:** [github.com/volfadar/chat-keuangan-bench](https://github.com/volfadar/chat-keuangan-bench)  
> Two suites: **Parse-25** (single-turn extraction) and **Rupiah-Pro** (multi-turn agent).

---

## Two benches

| | **Parse-25** | **Rupiah-Pro** |
|--|--------------|----------------|
| **What** | One-shot parse → structured `pemasukan` / `pengeluaran` JSON | Multi-turn agent with tools |
| **Run** | `bun run eval:hard-25 -- --model <id>` | `bun run eval:agentic -- --model <id>` then `bun run score:rupiah-pro` |
| **Docs** | [`docs/REPORT.md`](docs/REPORT.md) · [`docs/FINDINGS.md`](docs/FINDINGS.md) | [`docs/AGENTIC.md`](docs/AGENTIC.md) |

---

## Quick start

```bash
git clone https://github.com/volfadar/chat-keuangan-bench.git
cd chat-keuangan-bench
cp .env.example .env
bun install

# Start LM Studio → Developer → Server → OpenAI-compatible (http://127.0.0.1:1234/v1)

# Parse-25
bun run eval:single -- --model <lm-studio-model-id> --label local-smoke

# Rupiah-Pro
bun run eval:agentic -- --suite all --model <lm-studio-model-id> --concurrency 1 --skip-judge
bun run score:rupiah-pro

# Generate SFT data (teacher = larger local model)
bun run generate:sft-parse -- --self-test              # validators vs hand-authored gold, no GPU
bun run generate:sft-parse -- --dry-run --count 20     # plan + coverage, no LLM calls
bun run generate:sft-parse -- --model <teacher-id> --count 200
```

Optional overrides: `--base-url http://127.0.0.1:1234/v1` · `--api-key lm-studio`  
Or set `OPENAI_COMPATIBLE_BASE_URL` / `EVAL_MODEL` / `JUDGE_MODEL` in `.env`.

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

## Fine-tuning a small model

`generate:sft-parse` is **spec-first**: a seeded RNG draws the answer key from
[`parse-taxonomy.ts`](src/core/parse-taxonomy.ts), the teacher only writes prose, and a blind
parse must rediscover the answer. The teacher never authors its own answer key, so the agreement
check costs no GPU. Rows failing any gate (leak, amount traceability, dropped entry, schema,
spec disagreement) are rejected to `rejects.jsonl` with structured reasons.

The taxonomy is authored for real-world coverage, **not** derived from the benchmark — Parse-25 is
an adversarial *test* set (91% pengeluaran, 91% `hari_ini`, 12% non-transaction) and makes a poor
training distribution. Check `perCellAcceptRate` in the manifest: cells below ~0.9 mean the teacher
is weak there and should be hand-labelled.

---

## Contributing

PRs welcome: realistic Indonesian chat scenarios, harder discriminative cases, scoring fixes. Please **don’t** add scenarios that mirror few-shot examples in the system prompt.

## License

MIT — see [LICENSE](LICENSE).
