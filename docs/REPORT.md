# Parse report (local)

OpenAI-compatible / LM Studio only. Single-turn finance-chat parse scorecard: **base (28)** + **Parse-25 hard**.

## Run

```bash
# Recommended — base then hard, sequential
bun run eval:parse -- --model <lm-studio-id>
bun run eval:parse -- --model <id> --label my-run --score

# Or pieces:
bun run eval -- --model <id> --suite base
bun run eval:single -- --model <id> --label my-run
bun run eval:hard-25 -- --models model-a,model-b
```

Raw runs: `docs/results/runs/` (`kind: parse-base` / `parse-hard-25`).

## Scorecard + charts

```bash
bun run score:parse
```

Writes:

- `docs/results/parse/parse-leaderboard-latest.json` + `.md`
- `docs/charts/parse/` — `base-pass.svg`, `hard-strict.svg`, `hard-composite.svg`, `hard-latency.svg`

Ranking: hard strict → hard composite → base pass → latency. Columns stay separate (not blended into one score).

## Scoring

- **Base** — deterministic strict pass on 28 everyday scenarios
- **Hard strict** — deterministic match on Parse-25 expected entries
- **Hard composite / tiers** — quality notes in the hard-25 harness (`excellent` … `broken`)
