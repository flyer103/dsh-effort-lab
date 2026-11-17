# dsh-effort-lab design

## Problem

Claims about "reasoning effort" and "prompt tricks" for squeezing model
performance are argued from screenshots and vibes. DSH already exposes the real
lever — the effort tier is serialized into the request body, not hinted in the
prompt — but nothing records whether a given prompt sentence or tier actually
produces more work per turn. This plugin turns the question into a log.

## One-sentence scope

Arm one session, sweep (variant × effort) in blocks, and record one measurable
row per turn.

## Phases

### P0 — this build

- One `systemPrompt` section carrying a per-block variant suffix.
- One slash command with the subcommand grammar in `docs/CONTRACT.md`.
- Per-turn recorder driven entirely by committed `session/event` traffic.
- Append-only JSONL log plus an in-transcript aggregate report.
- Optional effort axis written through `agent.model.select`, restored by `stop`.
- Host-only: no client bundle, no dependencies, no build step.

### P1 — only if P0 earns it

- A composer badge showing the armed cell, so the variant in force is visible
  without `status`.
- CSV export and per-turn deltas (this turn vs the same cell's previous turn).
- Nested-subagent attribution: count grandchildren, not just direct children.

### P2 — speculative, needs a concrete failure first

- Automated quality scoring via an LLM judge. Deliberately out of P0: a judge
  adds a second model in the measurement path with its own bias and cost.
- Cross-session/team aggregation. The file is already portable; no product shell
  is justified yet.

## Non-goals

- Changing the effort tier outside an armed experiment. The plugin only writes
  the seat at block boundaries while armed, and restores on `stop`.
- Judging answer quality automatically. Quality enters through `rate` and is
  reported as a number the human supplied.
- Recording turns the user did not arm. An idle plugin writes nothing and
  contributes no prompt bytes.
- Replacing DSH's own telemetry export. This is a local experiment log, not an
  observability pipeline.

## Adversarial notes

- **Cache confound.** A variant suffix changes the prompt, so at each block
  boundary the cached prefix is lost from the change point. Comparing wall time
  across *variant* arms therefore carries a real cost penalty for whichever arm
  follows a switch. Mitigations: blocks amortize the switch over `blockSize`
  turns; the suffix sits at the very end of the prompt; `cache%` is reported and
  flagged when groups diverge. Comparing *effort* arms is cache-clean, because
  the tier is a request parameter and the prompt is byte-identical — prefer the
  effort axis when wall time is the metric that matters.
- **Crash/restart mid-experiment.** Arm state is in memory, so a restart disarms
  and stops recording. That is the safe direction: no half-applied sweep
  continues silently. Records already written stay valid, because each row is
  self-describing (`variant`, `plannedEffort`, `effort`).
- **Reentrant append.** `session.append` throws while another append is being
  published, and `agent.model.select()` appends. Tier writes therefore run from
  the command handler (outside a publication) or from a microtask queued at
  `turn/end`, never synchronously inside a `session/event` listener. The
  microtask lands before the next turn's first step because a turn only starts
  on new input.
- **Append ordering.** A single promise chain serializes `appendFile` calls, so
  the JSONL is chronological despite fire-and-forget callers. This was a real
  flake source before it was fixed (out-of-order records in roughly 9 of 10 runs
  under back-to-back turns).
- **Disarm mid-turn.** A frozen suffix lives on the open turn, not on the arm, so
  `stop` cannot flip the prompt between two steps of one turn. The in-flight turn
  finishes under its own arm and records; the next turn starts unarmed.
- **Turn aborted or errored.** `turn/end` still fires, so the row is written with
  its `end` reason instead of being lost. The report separates `n` from `done`
  and never silently drops the incomplete turns.
- **Adapter reported no usage.** `usage` is optional; the row records `0` plus
  `usageSteps`, so a report reader can tell "zero tokens" from "not measured".
- **Concurrent sessions.** Accumulators are keyed per session; appends go through
  a single `appendFile` per turn, so interleaved sessions cannot interleave
  within a line.
- **Tier the model does not support.** Not pre-validated; the request fails and
  the turn records the failure, with `status` keeping the last error. Pre-
  validating would require reading the model directory, which is a P1 concern.
- **Reporting bias.** The human decides when to `stop`, so an experiment can end
  early on a good sample. `blockSize` and the fixed cell order exist to make the
  intended sample size a config decision rather than a judgement call.
- **Subagent inheritance.** Subagents do not inherit the suffix. A variant that
  changes delegation behaviour is therefore measured at the parent's turn level
  (child count), which is the observable the claim is about.

## Verification levels

- L1 (unit/contract): `node --test`, fake `systemPrompt`/`commands`/`agents`
  services and a real temp JSONL file. Covers sweep ordering, freezing, record
  fields, aggregation, error paths, malformed-log tolerance, append ordering
  under back-to-back turns, the reentrancy restriction (a fake seat that throws
  while a publication is open), and unreadable-log handling. 31 tests; the suite
  was re-run 12 times with no failures after the ordering fix.
- L2/L3 (live): see `docs/USAGE.md`. Installing the bundle and recording a real
  session is a separate, manual step; the unit suite is not end-to-end evidence.
