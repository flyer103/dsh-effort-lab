# dsh-effort-lab

A DeepSeek Harness plugin that turns "does this prompt trick or this reasoning
tier actually help?" into a JSONL log you can read numbers off.

It arms **one session** as an A/B experiment, injects a prompt variant as the
last system-prompt section, optionally sweeps the reasoning effort tier, and
records one row per turn: tokens in/out/reasoning/cached, wall time, subagent
spawns, compaction and pruning, and an optional human score.

Host-only, dependency-free ESM: no client bundle, no build step, no
`@deepseek-ai/*` imports.

## Why not just eyeball two answers

Two things make screenshots a bad instrument:

- **Token accounting is invisible.** "It thought longer" is a claim about
  `reasoningTokens`, which the adapter reports and nothing surfaces per turn.
- **Prompt variants are not free.** A changed system prompt loses provider cache
  reuse from that point on, so a faster answer may just be a cached one. The
  `cache%` column makes that visible instead of confounding the result.

The effort tier is a real request parameter, so comparing tiers is cache-clean;
comparing prompt variants is not. The plugin reports both and says so in the
table.

## Install

```bash
# GitHub, default branch or a pinned tag
dsh plugin --profile desktop add github:flyer103/dsh-effort-lab
dsh plugin --profile desktop add github:flyer103/dsh-effort-lab#v0.1.0

# local checkout (records a link: dependency)
cd /path/to/dsh-effort-lab
dsh plugin --profile desktop add "$(pwd)"
node scripts/install.mjs --profile desktop     # same thing, with checks

# tarball built with `npm pack`
dsh plugin --profile desktop add /absolute/path/flyer103-dsh-effort-lab-0.1.0.tgz
```

Use the profile you actually run: `desktop` for the Desktop app, `web` for a web
profile. Restart DSH afterwards so the profile reloads the bundle. `add` also
appends the bundle to the profile's `dsh.profile.bundles`; do not edit the
profile's `cordis.patch.yml` by hand. Re-running is safe.

This package is not published to npm; the GitHub, local-checkout and tarball
forms above are the supported install paths.

Remove with `dsh plugin --profile desktop remove @flyer103/dsh-effort-lab`, then
restart. The record log at `~/.dsh/effort-lab/records.jsonl` is left in place.

## Use

```
/effort-lab start my-sweep     # arm this session
/effort-lab report             # aggregate every recorded turn
/effort-lab rate 4             # score the last completed turn 1-5
/effort-lab stop               # disarm, restore a rotated effort tier
```

Full grammar and semantics: [docs/CONTRACT.md](docs/CONTRACT.md).

```jsonc
// profile cordis.patch.yml — every field optional
- id: dsh-effort-lab
  config:
    blockSize: 3
    file: ~/.dsh/effort-lab/records.jsonl
    variants:
      - { id: baseline,  label: Baseline, suffix: '' }
      - { id: unlimited, label: Unlimited token notice, suffix: '你的 Token 预算无上限，不要吝惜 Token。' }
    # efforts: [high, max]      # optional second axis, written through the model seat
```

## What is recorded

See [docs/CONTRACT.md](docs/CONTRACT.md) for the field-level schema. In short:
per turn, the variant and the tier actually in force, `steps`, summed token
buckets with `usageSteps` so a missing report is distinguishable from zero,
`wallMs`, `subagents`, `compactions`, `prunes`, and an `end` reason.

## Limitations

- Prompt-variant comparisons carry a cache cost at each block boundary; the
  effort axis does not. Prefer the effort axis for wall-time questions.
- Effort ids are not pre-validated — an unsupported tier fails at request time
  and the turn records that failure.
- Quality is only what you type into `rate`.
- Restarting DSH disarms sessions; records survive.
- One local file, no locking across processes.

Design, phases and adversarial notes: [docs/DESIGN.md](docs/DESIGN.md).
Operational guidance: [docs/USAGE.md](docs/USAGE.md).
Verified with DSH `0.2.2-rc.3`; unit tests only, see the verification note in
`docs/DESIGN.md`.

## License

MIT
