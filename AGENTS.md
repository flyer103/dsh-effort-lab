# AGENTS.md（dsh-effort-lab）

Project-level instructions for this repository. The global `~/.agents/AGENTS.md`
still applies; this file only adds project-specific rules.

## Commands

```bash
npm run check   # node --check lib/index.js
npm test        # node --test
```

There is no build step, no bundler and no runtime dependency. The plugin is
dependency-free ESM with no `@deepseek-ai/*` imports. Do not add a framework or
a runtime dep for something writable by hand.

## Repository shape

| path | role |
|---|---|
| `lib/index.js` | the whole host half: config normalization, sweep cells, prompt section, recorder, report, command |
| `tests/host.test.mjs` | `node --test` with fake `systemPrompt`/`commands`/`agents` and a real temp JSONL file |
| `docs/CONTRACT.md` | authoritative: command grammar, prompt contribution, record schema, aggregation |
| `docs/DESIGN.md` | phases, non-goals, adversarial notes, verification levels |
| `docs/USAGE.md` | user semantics and known limitations |
| `locale/*.json`, `icon.svg`, `docs/DETAIL.md` | plugin list and detail-page display resources |

A change that alters a command subcommand, the record schema, the sweep order or
a report column must update `docs/CONTRACT.md`, and both READMEs when the
user-facing summary changes. README bullets must not restate semantics that
belong to CONTRACT/USAGE.

## DSH coupling

- Tested target: DSH `0.2.2-rc.3` (the installed Desktop build). No `engines.dsh`
  and no DSH peer dependency is declared; treat other releases as untested.
- Facts this plugin relies on, verified against the installed `app.asar`:
  - `session/event` is emitted post-commit as `(session, event)`; `turn/start`,
    `step/end`, `assistant/message` (`data.usage?: TokenUsage`), `turn/end`
    (`data.reason`), `subagent/catalog`, `compaction/start`,
    `compaction/prune` all arrive through it. `SessionEvent.time` is epoch ms.
  - `TokenUsage` is `{ inputTokens, outputTokens, totalTokens?, cacheReadTokens?,
    cacheWriteTokens?, reasoningTokens? }` — everything but the first two is
    optional, so the recorder must tolerate absence.
  - `ctx.systemPrompt.section({ name, order, text })` with a per-assembly `text`
    provider whose `AssembleContext` carries `agent`. `''` sections are dropped
    at render. `DEPLOYMENT_PERSONA_SUFFIX` is order `10200`; this plugin uses
    `10201` so the variant is the last thing in the prompt.
  - `agent.model.current()` / `agent.model.select(selection)` are the model seat;
    `select` appends `model/selection` and affects later steps.
  - `ctx.commands.register({ name, description, input, handler })`; the handler
    gets `{ agent, rawInput, signal }` and returns `{ kind: 'success'|'error' }`.
- Do not add a session-log event type or write into the conversation. The log is
  a plain file precisely so nothing enters the transcript.

## Verification expectations

- Host changes: extend `tests/host.test.mjs`. The suite drives real event
  sequences through fake services and asserts the JSONL on disk — keep it that
  way rather than mocking the filesystem.
- `npm test` is L1 only. It is **not** end-to-end evidence. A claim that live
  recording works requires installing the bundle and arming a real session;
  say which of those was actually run.
- Keep README/CONTRACT verification claims level-accurate.

## Release

Only when the user explicitly asks: feature commit(s) first (code + tests +
docs), then a separate `chore: release X.Y.Z` bumping `package.json`,
`dsh.plugin.json`, and version references in both READMEs. `npm publish` is
user-performed. Do not commit, tag, push or publish unless explicitly asked.
