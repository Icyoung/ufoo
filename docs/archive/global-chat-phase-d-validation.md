# Global Chat Phase D Validation

Date: 2026-03-06
Owner: codex-6
Status: historical

## Scope

This validation targets Phase D requirements from
`docs/global-chat-multi-project-technical-plan.md`:

- rapid project switching stability
- routing correctness after switch
- latency DoD thresholds:
  - p50 < 500ms
  - p95 < 1200ms

## Benchmark Harness

- Script: `scripts/global-chat-switch-benchmark.js`
- NPM entry: `npm run bench:global-switch -- --switches 50 --json`

What it does:

1. Creates two temporary projects.
2. Initializes `.ufoo` (`context,bus`) for each project.
3. Starts one daemon per project.
4. Connects through `daemonCoordinator` + `daemonTransport`.
5. Executes alternating project switches.
6. Verifies routing by waiting for status from the expected project root after each switch.
7. Reports latency summary and threshold pass/fail.

## Result (2026-03-06)

Command:

```bash
npm run -s bench:global-switch -- --switches 50 --json
```

Output summary:

- `switches`: 50
- `routingChecksPassed`: 50
- `routeOk`: true
- `latency`:
  - `min`: 0.030875 ms
  - `avg`: 0.05726918 ms
  - `p50`: 0.04575 ms
  - `p95`: 0.108958 ms
  - `max`: 0.232375 ms
- `thresholds`:
  - `p50MsLt500`: true
  - `p95MsLt1200`: true
- `overall`: PASS

## Notes

- In sandboxed execution environments, daemon socket binding may require elevated permissions.
- The benchmark uses real daemon socket switching, not mocked switch calls.
