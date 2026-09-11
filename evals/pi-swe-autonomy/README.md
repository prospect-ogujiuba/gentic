# Pi-SWE model autonomy evaluation

This evaluator runs copied approved-plan fixtures in fresh Pi SDK sessions. It never enables live provider spending in CI. Raw JSONL traces are written with owner-only permissions beneath an evaluator-owned `pi-swe-eval-run-*` OS temporary directory and are represented in reports by SHA-256 digests.

## Prerequisites

- Node.js 22.19 or newer and this repository's pinned Pi `0.84.2` dependencies installed.
- The exact model selector exists in Pi's configured model registry and authentication is available.
- Extension and skill paths declared by the selected resource profile exist.
- Live modes run only inside a container or equivalent sandbox. Passing `--sandbox-ack` is the operator's explicit acknowledgement.

Selectors use `provider/model[@thinking]`. Supported scenarios and profiles are declared in `src/scenarios.ts`.

## Reproduce

Set an exact selector, then validate the matrix, resources, model identity, and budgets without making a model call:

```bash
MODEL='provider/exact-model-id@high'
npm run eval:swe -- --dry-run \
  --model "$MODEL" \
  --scenario clean-approved-plan \
  --profile isolated-pi-swe-v1 \
  --trials 20 \
  --max-calls 800 \
  --max-cost-usd 50 \
  --max-time-ms 7200000 \
  --output /tmp/pi-swe-eval/qualification
```

Run exactly one live trial after entering the sandbox:

```bash
npm run eval:swe -- --smoke --sandbox-ack \
  --model "$MODEL" \
  --scenario clean-approved-plan \
  --profile isolated-pi-swe-v1 \
  --trials 1 \
  --max-calls 40 \
  --max-cost-usd 5 \
  --max-time-ms 300000 \
  --output /tmp/pi-swe-eval/smoke
```

Run qualification. At least 20 valid trials are required for every declared model/scenario/profile group; infrastructure failures do not count toward that minimum.

```bash
npm run eval:swe -- --qualify --sandbox-ack \
  --model "$MODEL" \
  --scenario clean-approved-plan \
  --profile isolated-pi-swe-v1 \
  --trials 20 \
  --max-calls 800 \
  --max-cost-usd 50 \
  --max-time-ms 7200000 \
  --output /tmp/pi-swe-eval/qualification
```

Repeat `--model`, `--scenario`, or `--profile` to declare a larger matrix. Trials execute sequentially so mutating workspaces never overlap. Calls, cost, and elapsed time are checked before and after every trial; exceeding a ceiling stops the run without publishing a qualification report.

## Reports and interpretation

`--output PREFIX` writes deterministic `PREFIX.json` and Markdown regenerated from that JSON object. Groups are ordered by model, thinking level, scenario, and resource profile; trial IDs and provenance digests are sorted.

For each group, inspect:

- valid, passed, failed, and separately reported infrastructure counts;
- clean-path success rate and Wilson 95% confidence interval;
- model-call, token, cost, and duration distributions and totals;
- Pi/Gentic identities, fixture and prompt hashes, resource-manifest digest, and raw-run digests;
- critical violations and promotion reasons.

Promotion requires at least 20 valid trials, clean-path success of at least 90%, and zero critical violations. An infrastructure failure is never converted into a model failure, but qualification refuses to publish when it leaves a group below 20 valid trials. Live results are evidence only; they do not edit approved lifecycle policy or plans.
