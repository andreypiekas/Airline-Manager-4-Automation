# Roadmap — Airline Manager 4 Automation (2026-10-21)

Source of truth: [production workflow](../.github/workflows/playwright.yml). This file tracks implementation, not live-game authorization.

## M1 — Dispatch every eligible aircraft (implementation started)

- [x] Interpret `DISPATCH_ALL_READY=true` as explicit `all`, not a fixed cap of 100.
- [x] Keep numeric manual caps 1–100, safe execution deadline and per-aircraft guards.
- [x] Reuse the **complete, identity-checked** Fleet snapshot from the earlier demand analysis after re-reading the native `Routes(N)` heading. No second full details scan just to seed departures when the route count is unchanged.
- [x] Require fresh individual aircraft identity, route, demand, capacity and native departure control before every click.
- [x] If a reroute was actually executed, or the fleet count/identities do not validate, use the existing full read-only recovery scan.
- [x] Persist `execution-report.json` atomically during execution and append a compact `execution-events.jsonl` state-transition journal.
- [x] Generate the human-readable `execution-report.md` at completion rather than after every save.
- [ ] **Live verification:** measure real departed/eligible ratio, elapsed time and transition journal on next ordinary production run. Tests must never trigger production.

## M2 — Page-oriented dispatch and recoverable queue

- [ ] Build a read-only native Fleet cursor that establishes unique `aircraftId`/`routeId` once, without opening every detail.
- [x] Reuse the verified native current Fleet page for adjacent aircraft when it contains the target and Routes(N) is unchanged; fall back to a fresh full-list navigation otherwise. Each target's details remain freshly checked.
- [x] Persist every confirmed departure and uncertain-click event in the durable return journal **before** the next aircraft; persist per-aircraft JSONL and atomic run reports. GitHub transports the return journal on run completion.
- [x] Persist **time-deferred** aircraft into the existing append-only GitHub return journal; on a later run, exact `aircraftId:routeId` matches get priority after the complete fresh Fleet collection, while demand, fuel, campaigns, UI, deadline and uncertainty gates remain mandatory. Fresh rechecks clear old hints. No extra GitHub branch or scheduling was created.
- [x] Record Fleet-page reuse, full-list navigations, full Fleet rescans and preparation latency in `departure-navigation.json`.
- [ ] Add end-to-end latency per stage and reliable native-page offsets/checkpoints that survive across runs.
- [ ] Ensure eligible aircraft are not blocked only by a count cap, and all unfinished work has a precise status.

## M3 — Post-dispatch supply top-up

- [x] After a complete, verified real dispatch cycle with confirmed departures, start a second read of **live** Fuel and CO2 price, stock and cash, subject to finalization time budget.
- [x] Replenish towards verified storage capacity when live price <= configured effective ceilings and native quote passes, within purchase budget, minimum cash reserve and cumulative per-run commodity caps.
- [x] Use an exclusive second-pass marker; never repeat unknown outcomes, skip on incomplete first supply pass and honor persisted unknown quarantines.
- [x] Persist `supply-post-report.json/.md` separately from initial supplies and expose both in the dashboard/Telegram.
- [x] Post-dispatch purchases require a complete real dispatch report with no time, limit or outcome-unknown holds. A safe hold from insufficient demand/fuel remains a legitimate evaluated hold.

## M4 — Manual aircraft and route registration renaming

- [x] Separate **manual-only** `workflow_dispatch` entrypoint; no cron and no call from production.
- [x] Read-only full-fleet preview, strict full CSV or two-prefix numbering; inspect native prompt/AJAX controls separately for aircraft `mode=reg` and route `mode=routeReg` and fail-closed when changed.
- [x] Require matching SHA256 of the preview and explicit approval for apply; write per-field checkpoints, verify UI after saves, refuse uncertain retry. Preview mode cannot mutate.
- [x] Use exact immutable `aircraftId` and `routeId` as targets; registrations never become permanent technical IDs.

## M5 — Route intelligence (strictly last)

- [ ] Determine the authorized access/export contract of the specific Discord route bot.
- [ ] Validate data provenance and compatibility with https://brasil.gt.tc/rotas.
- [ ] Compare candidate routes using live verified aircraft, demand, bookings, Fuel, CO2, maintenance, cost, income and daily cycles.
- [ ] Provide evidence-backed KEEP/HOLD/REROUTE recommendations in read-only mode first.
- [ ] Enable mutations only after separate offline, safety and economic validation.

### Safety invariants

No unattended re-click after unknown departure outcome. Never bypass a challenge/CAPTCHA. Always confirm native controls and current target state. No guessed Fuel/CO2 requirement, purchase price, or aircraft identity. All code changes travel through a tested pull request; offline CI does not access the game.

## M2 cross-run deferred dispatch queue: policy

The last complete departure cycle records only `RUN_TIME_BUDGET_EXHAUSTED_BEFORE_EVALUATION` and `RUN_TIME_BUDGET_EXHAUSTED_BEFORE_MUTATION` as priorities in the existing durable journal. It does **not** persist dispatch authorization. At the beginning of a new production cycle, `readPendingDeferredDispatchKeys` restores hints from the company-scoped return journal. Hints are matched against the complete freshly observed inventory by exact `aircraftId:routeId`; absent, inflight or rerouted aircraft are not promoted. Fresh demand, shared-pool ceilings, fuel, campaigns, native UI control, deadline and persisted unknown-operation quarantine are still enforced. After recheck, earlier matching hints are cleared, unless the aircraft was deferred again. Journal transport compaction keeps only the latest hint state per identity; safety-critical events remain preserved. Failures before a complete verified cycle cannot erase an outstanding queue. `departure-queue.json` summarizes the checkpoint.

Manual production execution and post-flight supply refills are not introduced by this change. Ordinary scheduled runs are the only live verification opportunity.

M4 user guide: [manual fleet rename](./MANUAL_FLEET_RENAME.md). The native game rename UI has not yet been exercised on a real account: preview is safe, and apply stops if its native handler or post-save evidence differs from the supported prompt-based editor. Manual preview/apply must be explicitly invoked by a user; CI checks are offline only.
