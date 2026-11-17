# dsh-effort-lab usage

## Run an experiment

1. Pick the session you want to measure. One armed session per experiment keeps
   the comparison clean; arming two sessions records them as one log with two
   `session` values.
2. Set the effort tier you consider the baseline in the model seat, if you use
   the effort axis — `stop` restores whatever tier was selected at `start`.
3. Arm it:

   ```
   /effort-lab start cache-prompt-sweep
   ```

4. Work normally. Each turn is assigned one cell and recorded on completion.
   Keep the task type similar across turns; the log does not know what you asked.
5. Read the aggregate at any time:

   ```
   /effort-lab report
   ```

6. When the sample is large enough, disarm:

   ```
   /effort-lab stop
   ```

   Injection and recording stop immediately; the log is untouched.

## Reading the report

One row per `(variant · effort)` cell. `n` is how many turns that cell got and
`done` how many actually completed. `cache%` tells you how much of the input was
served from cache — when it differs sharply between rows, wall time between
those rows is not a fair comparison (see below).

`/effort-lab rate 4` scores the last completed turn 1-5. Do it right after the
turn while you still know how good the answer was; the score joins to that turn
and appears as the `score` column.

## Choosing a block size

`blockSize` is how many consecutive turns share one cell, default `3`.

- Larger blocks: fewer cache invalidation events, fewer samples per cell.
- Smaller blocks: faster to cover the grid, more cache churn.

With the default two variants and no effort axis, `blockSize: 3` means six turns
give each arm three samples.

## Comparing effort tiers vs comparing prompts

These are not equally clean, and the difference matters for wall time:

- **Effort axis is cache-clean.** The tier is a request parameter; the prompt is
  byte-identical between tiers, so cached prefixes stay valid. Comparing `high`
  against `max` on wall time and output tokens is sound.
- **Prompt variants cost cache at each block boundary.** The suffix is part of
  the system prompt, so switching it invalidates reuse from that point. That
  penalizes whichever arm follows a switch. Use `blockSize` to amortize it, and
  prefer output-token and subagent counts over wall time when comparing variants.

## Limitations

- Effort ids are not validated before use. A tier the current model does not
  declare fails at request time; the turn is recorded with its error end reason.
- A tier change takes effect on the **next** turn, because DSH forbids writing
  the model seat while an event is being published. The turn that ends is always
  recorded under the tier it actually ran on.
- Token usage is only as good as the adapter's reporting. Check `usageSteps`
  before trusting a `0`.
- The log is one local JSONL file, not a database: concurrent writers from
  another process (or a second DSH instance sharing the same `file`) can append
  to the same file, and `reset --yes` truncates everything in it.
- Restarting DSH disarms every session. Records survive; injection does not.
- Subagents spawned during a turn do not receive the variant suffix; their work
  appears only as a count on the parent turn.
- Nothing here scores answer *correctness*. `rate` is a human judgement, and the
  plugin never compares answers by content.
