# Findings notes (local workflow)

This repo is now focused on **local OpenAI-compatible** eval (LM Studio), not cloud providers.

## Goal

Parse Indonesian casual finance chat (WhatsApp / voice style) into structured `pemasukan` / `pengeluaran` JSON — without hallucinating transactions, copying adjacent prices, or flipping income/expense direction.

## Local loop

1. Serve a model in LM Studio (OpenAI-compatible `/v1`).
2. `bun run eval:single -- --model <id> --label <tag>`
3. Inspect `docs/results/runs/*-results.json`
4. Generate SFT data with a stronger local teacher: `bun run generate:sft-parse`
5. Fine-tune (Unsloth outside this repo) → import GGUF → re-eval

## Hard failure modes worth training on

- Qty × unit (`5rb 4 4 nya`) collapse
- Price bleed across adjacent items
- Slang (`ceban`, `goceng`, `gopek`)
- Koreksi mid-sentence (`15rb… eh 50rb`)
- Non-transaction / future intent (`mau bayar`, curhat)
- Income vs expense direction (refund / gaji / TF masuk)

See `scripts/eval-hard-25.ts` `HARD_SCENARIOS` for the discriminative set.
