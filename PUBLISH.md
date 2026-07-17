# Publishing checklist

```bash
cd /path/to/chat-keuangan-bench
git add -A
git commit -m "Release: describe changes"
git push origin main
```

## Before publishing

- [ ] Never commit `.env`
- [ ] Parse: `bun run eval:parse -- --model <id> --label <tag>` then `bun run score:parse`
- [ ] Rupiah-Pro: `bun run eval:agentic` then `bun run score:rupiah-pro`
- [ ] SFT generator (optional): `bun run generate:sft-parse`

## Artifacts

| Artifact | Bench |
|----------|-------|
| `docs/results/runs/*-parse-*-results.json` | Parse raw (base + hard) |
| `docs/results/parse/parse-leaderboard-latest.*` | Parse board |
| `docs/charts/parse/*` | Parse charts |
| `docs/results/agentic/*-agentic-suite.json` | Rupiah-Pro raw |
| `docs/results/agentic/rupiah-pro-leaderboard-latest.*` | Rupiah-Pro board |
| `data/sft/**/*.jsonl` | Generated SFT (always gitignored; only the manifest is published) |
| `src/core/model-roster.ts` | Optional local model list |
