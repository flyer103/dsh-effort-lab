# Effort lab

Arms one DSH session as an A/B experiment and records, per turn, what the
runtime actually spent: reasoning tier in force, input/output/reasoning/cached
tokens, wall time, spawned subagents, compaction and pruning, and an optional
human score.

## What it does

- Injects one prompt variant as the last system-prompt section, rotating in
  blocks of `N` turns so a comparison is not a single sample.
- Optionally sweeps the reasoning effort tier too, writing it through the model
  seat at each block boundary and restoring the original tier on `stop`.
- Appends one JSONL row per completed turn to
  `~/.dsh/effort-lab/records.jsonl` (configurable).
- Aggregates that log into an in-transcript table with `/effort-lab report`.

The control arm has an empty suffix, so an experiment always has a baseline that
is byte-identical to a profile without this plugin.

## Usage

```
/effort-lab start my-sweep     # arm this session
/effort-lab status             # arm state, next block, record count
/effort-lab report             # aggregate every recorded turn
/effort-lab report session     # only this session
/effort-lab rate 4             # score the last completed turn 1-5
/effort-lab stop               # disarm, restore a rotated effort tier
/effort-lab reset --yes        # empty the log
```

## Essential limitations

- Prompt variants cost prompt-cache reuse at each block boundary; the effort
  axis does not. Prefer the effort axis when comparing wall time.
- Effort ids are not pre-validated against the current model.
- Answer quality is only recorded through manual `rate`; nothing is scored
  automatically.
- Restarting DSH disarms sessions (records survive).
- Host-only: no composer UI, no tools, no client bundle.
