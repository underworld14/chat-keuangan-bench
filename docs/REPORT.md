# Parse-25 report (local)

OpenAI-compatible / LM Studio only. Cloud OpenRouter scorecards and chart assets were removed.

## Run

```bash
bun run eval:single -- --model <lm-studio-id> --label my-run
# or multi-model:
bun run eval:hard-25 -- --models model-a,model-b
```

Results: `docs/results/runs/`.

## Charts

Legacy cloud Parse-25 bar charts (`strict-pass`, `latency`, cost quadrants) were deleted with the OpenRouter scorecard pipeline. Re-add charts from local `docs/results/runs/*-results.json` when you want visuals again (Rupiah-Pro still has `bun run report:rupiah-pro`).

## Scoring

- **Strict pass** — deterministic match on expected entries
- **Composite / tiers** — quality notes in the hard-25 harness (`excellent` … `broken`)
