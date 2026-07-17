# Parse charts

Generated: 2026-07-17T06:24:13.790Z

Local OpenAI-compatible runs only. Board: `docs/results/parse/parse-leaderboard-latest.md`.

#### Base strict pass

<p align="center">
  <img src="./base-pass.svg" alt="Base strict pass" width="960" />
</p>

#### Hard-25 strict pass

<p align="center">
  <img src="./hard-strict.svg" alt="Hard-25 strict pass" width="960" />
</p>

#### Hard-25 mean composite

<p align="center">
  <img src="./hard-composite.svg" alt="Hard-25 mean composite" width="960" />
</p>

#### Hard-25 mean latency

<p align="center">
  <img src="./hard-latency.svg" alt="Hard-25 mean latency" width="960" />
</p>

## Table

| Model | Base | Hard strict | Hard composite | Hard latency |
|-------|-----:|------------:|---------------:|-------------:|
| `qwen3-4b-2507` | 24/28 | 20/25 | 93.5 | 7.2s |
| `nemotron-3-nano-4b` | 14/28 | 13/25 | 88.7 | 47.5s |
| `qwen3-1.7b` | 11/28 | 7/25 | 82.7 | 25.1s |
| `lfm2.5-1.2b` | 0/28 | 0/25 | 24.7 | 11.3s |
