# Rupiah-Pro (local)

Multi-turn agentic pencatatan with tools. Uses the same OpenAI-compatible server as Parse-25.

## Run

```bash
bun run eval:agentic -- --suite hard --dry-run
bun run eval:agentic -- --suite all --model <lm-studio-id> --concurrency 1 --skip-judge
bun run score:rupiah-pro
bun run report:rupiah-pro
bun run studio   # http://localhost:4111
```

Set `JUDGE_MODEL` in `.env` when not using `--skip-judge` (same local server).

## Score (public v1)

```text
score = 100 × (det/40)² × (ifBench/100)
```

`score:rupiah-pro` discovers local `docs/results/agentic/*-agentic-suite.json` traces (newest per model).

## Fixtures

```bash
bun run fixtures:receipts
```
