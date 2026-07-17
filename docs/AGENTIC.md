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

## The one cloud dependency

Every **model** call is local, but the agent's `firecrawl_search` / `firecrawl_scrape` tools call
`api.firecrawl.dev` and need `FIRECRAWL_API_KEY` in `.env`. They exist for web lookups only — the
agent is instructed never to use them to find receipt images. Scenarios that don't exercise those
tools run fully offline; leave the key unset and those tool calls fail closed rather than silently
reaching the network.

## Score (public v1)

```text
score = 100 × (det/40)² × (ifBench/100)
```

`score:rupiah-pro` discovers local `docs/results/agentic/*-agentic-suite.json` traces (newest per model).

## Fixtures

```bash
bun run fixtures:receipts
```
