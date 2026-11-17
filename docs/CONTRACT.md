# dsh-effort-lab contract

Authoritative for: the command surface, the prompt contribution, the sweep
ordering, the record schema, and how the report aggregates. `README.md` points
here instead of restating any of it.

## 1. Command surface

Exactly one command is registered, named `effort-lab`, with
`input.hint = "start [label] | stop | status | report [session] | rate <1-5> | reset --yes"`.
The whole subcommand grammar lives in `rawInput`; there are no per-subcommand
commands, no tools, and no client bundle.

| input | effect |
|---|---|
| *(empty)* or `status` | report the config, the log path, the record count, the arm state and the next block |
| `start` / `start <label>` | arm the invoking session; label defaults to `default` |
| `stop` | disarm the invoking session and restore a rotated effort tier |
| `report` | aggregate every record in the log |
| `report session` | aggregate only the invoking session's records |
| `rate <1-5>` | append a score for the invoking session's last completed turn; the score must be an integer |
| `reset --yes` | truncate the log; `reset` without `--yes` refuses |

Subcommand arguments are validated: `stop` and `status` take none, `report`
takes only `session`, `rate` takes an integer 1-5, and `reset` takes exactly
`--yes`. Any other input returns `kind: 'error'` with the usage line. Commands
never throw: a filesystem failure becomes an error result carrying the message,
and `status` degrades to `records: unavailable (…)` instead of failing the whole
command.

Disarming does not discard a turn already in flight: it finishes with its frozen
suffix, keeps the effort tier it started on, and is recorded. A tier restore
owed by `stop` is applied when that turn ends, not while it is running. Only
turns that start after `stop` are unarmed.

`rate` needs a completed turn. It uses the last turn this process recorded, and
when the process has none (for example right after a restart) it falls back to
the highest `turn` this session has in the log. `reset --yes` clears both the
file and the in-memory last turn, so a later `rate` cannot attach a score to a
deleted turn.

Arming is per session and lives in the plugin's process memory. A restart
therefore **disarms** every session (injection stops, recording stops) while
every already-written record stays on disk. Re-arm with `start`.

## 2. Prompt contribution

The plugin registers exactly one `systemPrompt` section:

| field | value |
|---|---|
| `name` | `effort-lab:variant` |
| `order` | `10201`, i.e. after `DEPLOYMENT_PERSONA_SUFFIX` (`10200`) |
| `text` | a provider, evaluated per assembly |

The provider returns the armed block's suffix, or `''` when the session is not
armed. `''` is dropped during rendering, so the control arm contributes no
bytes: an armed `baseline` block is indistinguishable in the prompt from a
profile without this plugin.

The suffix is frozen at `turn/start` and held for every step of that turn, so a
multi-step turn never changes the prompt mid-turn. That freeze outranks the arm
state: disarming (or re-arming) while a turn is in flight does not change that
turn's suffix, and the turn still records on its `turn/end`. Only the armed session
receives text; subagents the turn spawns do not inherit it, which matches "put
this in *your* system prompt".

Because the contribution is the tail of the system prompt, changing it changes
the assembled prompt. The DeepSeek adapter issues no explicit cache directive,
so reuse is automatic and an unchanged prefix stays eligible; a changed suffix
loses reuse from the first changed token onward. The `cache%` report column
exists to make that cost visible.

## 3. Sweep ordering

Cells are the product `variants × efforts`, in **variant-major** order:

- no `efforts` axis → one cell per variant, in config order;
- with `efforts: [A, B]` and variants `[v1, v2]` → `(v1,A) (v1,B) (v2,A) (v2,B)`.

The cell in force for a turn is
`cells[floor(servedTurns / blockSize) % cells.length]`, where `servedTurns`
counts `turn/start` events since `start`. So each cell owns `blockSize`
consecutive turns.

When a cell names an effort tier, the plugin writes it through
`agent.model.select({ provider, model, reasoningEffort })`, and only when it
differs from the current selection.

Timing is dictated by DSH: `session.append` throws if reentered while another
append is being published, and `select()` itself appends `model/selection`. So
the tier is never written from inside a `session/event` handler. Instead:

- the first cell's tier is written immediately by `start`, which runs outside a
  publication;
- every later cell's tier is queued as a microtask from `turn/end`, so it lands
  right after that publication closes and applies to the **next** turn;
- `stop`'s restore is queued the same way while a turn is open.

An unsupported tier is not pre-validated. The model rejects it at request time
and the turn records that end reason; `plannedEffort` then disagrees with
`effort`, which is the observable signal that the sweep did not take effect.

## 4. Record schema

One JSON object per line, append-only, at `file` (default
`~/.dsh/effort-lab/records.jsonl`). `v` is the schema version.

Turn record (`kind: "turn"`), written on `turn/end`:

| field | type | meaning |
|---|---|---|
| `v` | number | schema version, currently `1` |
| `kind` | `"turn"` | discriminator |
| `at` / `ts` | number / string | turn start, epoch ms and ISO |
| `session` | string | session id |
| `label` | string | the label given to `start` |
| `turn` | number \| null | session turn number |
| `variant` | string | variant id in force |
| `plannedEffort` | string \| null | tier this block asked for, `null` with no effort axis |
| `provider` / `model` | string \| null | from the request header, else the model seat |
| `effort` | string \| null | tier in force, sampled at `turn/end` from the turn's last request header, else the model seat |
| `effortDefault` | boolean | header says the tier came from adapter defaults, not an explicit pick |
| `steps` | number | `step/end` count |
| `usageSteps` | number | `assistant/message` events that carried `usage` |
| `inputTokens` `outputTokens` `reasoningTokens` `cacheReadTokens` `cacheWriteTokens` `totalTokens` | number | summed over reporting steps; `0` when the adapter reported nothing |
| `wallMs` | number | `max(0, turn/end.time - turn/start.time)` |
| `subagents` | number | `subagent/catalog` records in this turn |
| `compactions` / `prunes` | number | `compaction/start` / `compaction/prune` records |
| `end` | string | `completed`, `aborted`, `blocked`, `error`, `max-tokens`, `interrupted`, `forked`, or `unknown` |

Score record (`kind: "score"`), appended by `rate`:
`{ v, kind: "score", at, ts, session, turn, score }`. Scores are a separate
append-only record rather than a rewrite of the turn line, so rating never
rewrites history and the last score for a `(session, turn)` wins when joining.

Absent token fields are recorded as `0` plus `usageSteps = 0`; the report must
not read "0" as "measured zero" without checking `usageSteps`.

Records are appended through a single serialized chain, so the file is in call
order even when several turns end back to back: line order is turn order, and
"the last score for a `(session, turn)` wins" holds. A runtime anomaly that opens
a second turn while one is still open is ignored rather than overwriting the
open accumulator, so no sampled turn is silently dropped.

No event type is added to the session log, and nothing is written into the
conversation.

## 5. Aggregation

Groups are keyed `"<variant> · <effort>"`, where `effort` falls back to
`adapter default` or `—`. Per group the report shows:

| column | statistic |
|---|---|
| `n` | records in the group |
| `done` | records whose `end` is `completed` |
| `out tok` / `out p50` | mean / median `outputTokens`, over usage-reporting turns only |
| `reason` | mean `reasoningTokens` |
| `wall ms` | mean `wallMs` |
| `subag` | mean `subagents` |
| `cache%` | mean of `cacheReadTokens / inputTokens` over records with `inputTokens > 0` |
| `score` | mean of joined scores, `—` when none |

Token statistics cover only turns with `usageSteps > 0`; a group with none shows
`—` rather than `0`, and the report notes how many turns went unmeasured. Wall
time, subagent count and score cover every record in the group.

Malformed lines are skipped and counted; `status` exposes the count. The report
adds a note when `cache%` spans more than 15 percentage points across groups, and
when some records did not end `completed`.
