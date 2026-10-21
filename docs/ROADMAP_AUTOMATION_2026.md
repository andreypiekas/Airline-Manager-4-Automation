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
- [ ] Dispatch page-by-page, reusing the verified native current page when available, with fresh per-aircraft details and no repeated full-list navigation.
- [ ] Checkpoint every page and confirmed departure in persistent run state; preserve uncertain-click quarantine.
- [ ] Resume deferred aircraft on a later scheduled cycle, never replaying a confirmed or uncertain click. Compare against newly verified fleet state and demand.
- [ ] Instrument stage latencies, page revisits, safe holds and number of full scans.
- [ ] Ensure eligible aircraft are not blocked only by a count cap, and all unfinished work has a precise status.

## M3 — Post-dispatch supply top-up

- [ ] After a fully verified dispatch cycle, re-read **live** Fuel and CO2 stock, price and cash.
- [ ] Replenish towards verified storage capacity when price <= configured effective ceilings, within purchase budget and minimum cash reserve.
- [ ] Prevent duplicate purchases and quarantine unknown outcomes.
- [ ] Distinguish pre-dispatch purchase from post-dispatch replenishment in the summary and Telegram.
- [ ] No post-dispatch purchase when the cycle is incomplete or another operation is uncertain.

## M4 — Manual aircraft and route registration renaming

- [ ] Separate `workflow_dispatch` entrypoint; **no cron** and no call from production.
- [ ] Preview mappings or import CSV; validate native edit controls for BOTH available name/registration fields.
- [ ] Require explicit manual confirmation; verify each saved field, log success/failure, support dry-run.
- [ ] Never use mutable display names as persistent technical identity.

## M5 — Route intelligence (strictly last)

- [ ] Determine the authorized access/export contract of the specific Discord route bot.
- [ ] Validate data provenance and compatibility with https://brasil.gt.tc/rotas.
- [ ] Compare candidate routes using live verified aircraft, demand, bookings, Fuel, CO2, maintenance, cost, income and daily cycles.
- [ ] Provide evidence-backed KEEP/HOLD/REROUTE recommendations in read-only mode first.
- [ ] Enable mutations only after separate offline, safety and economic validation.

### Safety invariants

No unattended re-click after unknown departure outcome. Never bypass a challenge/CAPTCHA. Always confirm native controls and current target state. No guessed Fuel/CO2 requirement, purchase price, or aircraft identity. All code changes travel through a tested pull request; offline CI does not access the game.
