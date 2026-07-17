# Parse local runs

JSON artifacts from base + Parse-25 evals. Cloud OpenRouter/DeepSeek runs were removed.

## Commands

```bash
bun run eval:parse -- --model <lm-studio-id> --label my-run
# or:
bun run eval -- --model <id> --suite base
bun run eval:single -- --model <id> --label my-run
```

## File kinds

| Kind | Filename pattern | Source |
|------|------------------|--------|
| `parse-base` | `{date}-parse-base-{model}-results.json` | `bun run eval -- --suite base` |
| `parse-hard-25` | `{date}-parse-hard-25-{model}-{label}-results.json` | `eval:single` / `eval:parse` |
| `parse-hard-25` | `{date}-finance-hard-25-results.json` | `eval:hard-25` (multi-model) |

`bun run score:parse` picks the **newest run per modelId** for each kind and builds
`docs/results/parse/parse-leaderboard-latest.*` plus charts under `docs/charts/parse/`.
