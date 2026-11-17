/**
 * dsh-effort-lab — host half (plain ESM Cordis plugin, no build step, no runtime
 * dependencies).
 *
 * Runs a controlled A/B experiment on ONE session: it injects a per-block prompt
 * variant into the system prompt and records one JSONL row per turn with the
 * performance facts the runtime actually exposes (effort in force, token usage,
 * wall time, spawned subagents, compaction/pruning), so variant and effort-tier
 * comparisons can be read back as numbers instead of impressions.
 *
 * Control surface is slash commands only (no client bundle). Everything the
 * recorder needs arrives post-commit on `session/event`; the variant text is a
 * `systemPrompt` section whose provider returns `''` when the session is not
 * armed, so an idle plugin contributes nothing to the prompt.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'dsh-effort-lab'

export const inject = ['systemPrompt', 'commands', 'agents']

/** Placed after `DEPLOYMENT_PERSONA_SUFFIX` (10200): the last section of the prompt. */
const SECTION_ORDER = 10201

const SECTION_NAME = 'effort-lab:variant'
const RECORD_VERSION = 1
const DEFAULT_BLOCK_SIZE = 3
const DEFAULT_LABEL = 'default'
const COMMAND_NAME = 'effort-lab'
const COMMAND_HINT = 'start [label] | stop | status | report [session] | rate <1-5> | reset --yes'

const DEFAULT_FILE = join(homedir(), '.dsh', 'effort-lab', 'records.jsonl')

/**
 * The variant set shipped by default. `baseline` is deliberately an empty
 * suffix: the section is dropped from the prompt, so the control arm is
 * byte-identical to a profile without this plugin.
 */
const DEFAULT_VARIANTS = Object.freeze([
  Object.freeze({ id: 'baseline', label: 'Baseline', suffix: '' }),
  Object.freeze({ id: 'unlimited', label: 'Unlimited token notice', suffix: '你的 Token 预算无上限，不要吝惜 Token。' }),
])

function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

function normalizeVariants(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return { variants: [...DEFAULT_VARIANTS], fellBack: Array.isArray(raw) }
  const seen = new Set()
  const variants = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    variants.push({
      id,
      label: typeof entry.label === 'string' && entry.label.trim() !== '' ? entry.label.trim() : id,
      suffix: typeof entry.suffix === 'string' ? entry.suffix : '',
    })
  }
  return variants.length > 0 ? { variants, fellBack: false } : { variants: [...DEFAULT_VARIANTS], fellBack: true }
}

/** Effort ids are validated by the model at request time, so only the shape is checked here. */
function normalizeEfforts(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const id = entry.trim()
    if (id !== '') seen.add(id)
  }
  return [...seen]
}

function resolveConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const blockSize = Number(config.blockSize)
  const file = typeof config.file === 'string' && config.file.trim() !== ''
    ? expandHome(config.file.trim())
    : DEFAULT_FILE
  const normalized = normalizeVariants(config.variants)
  return {
    enabled: config.enabled !== false,
    file,
    blockSize: Number.isFinite(blockSize) && blockSize >= 1 ? Math.floor(blockSize) : DEFAULT_BLOCK_SIZE,
    variants: normalized.variants,
    variantsFellBack: normalized.fellBack,
    efforts: normalizeEfforts(config.efforts),
  }
}

function mean(values) {
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0) / values.length
}

function median(values) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function show(value, digits = 1) {
  if (value === undefined || value === null || Number.isNaN(value)) return '—'
  const scale = 10 ** digits
  return String(Math.round(value * scale) / scale)
}

function describeEndReason(reason) {
  if (typeof reason === 'string') return reason
  if (reason !== null && typeof reason === 'object') {
    const kind = reason.kind ?? reason.type ?? reason.name
    if (typeof kind === 'string') return kind
  }
  return 'unknown'
}

function pad(value, width) {
  return String(value).padEnd(width)
}

function num(value, width) {
  return String(value).padStart(width)
}

export function apply(ctx, config) {
  const settings = resolveConfig(config)
  const arms = new Map()
  const openTurns = new Map()
  const lastTurn = new Map()
  let lastError

  function noteError(error) {
    lastError = error instanceof Error ? error.message : String(error)
  }

  /**
   * One experiment cell is a (variant, effort) pair. With no `efforts` axis the
   * sweep is variants-only; otherwise it is the full product, in variant-major
   * order, so each variant still gets every tier.
   */
  function buildCells(variants, efforts) {
    const cells = []
    for (const variant of variants) {
      if (efforts.length === 0) {
        cells.push({ variant, effort: null })
        continue
      }
      for (const effort of efforts) cells.push({ variant, effort })
    }
    return cells
  }

  function pickCell(arm) {
    return arm.cells[Math.floor(arm.count / arm.blockSize) % arm.cells.length]
  }

  /**
   * DSH rejects `session.append` reentrantly while a `session/event` publication
   * is open, and `agent.model.select()` appends `model/selection`. So tier
   * writes are never performed from an event handler directly: they are queued
   * as a microtask and take effect right after the publication closes, which is
   * still before the next turn's first step.
   */
  function scheduleEffort(session, arm, effort) {
    if (effort === null || effort === undefined) return
    const sessionId = session.id
    queueMicrotask(() => {
      if (arms.get(sessionId) !== arm) return
      selectEffort(session, effort)
    })
  }

  function selectEffort(session, effort) {
    const agent = ctx.agents?.get?.(session.id)
    try {
      const current = agent?.model?.current?.()
      if (!current) return
      if (current.reasoningEffort === effort) return
      agent.model.select({ provider: current.provider, model: current.model, reasoningEffort: effort })
    } catch (error) {
      noteError(error)
    }
  }

  function snapshotEffort(agent) {
    try {
      return agent?.model?.current?.()?.reasoningEffort
    } catch (error) {
      noteError(error)
      return undefined
    }
  }

  /**
   * The suffix is frozen on the OPEN TURN, not read from the arm, so disarming
   * or re-arming mid-turn cannot change the prompt between two steps of the
   * same turn (which would invalidate cache and mix two arms in one record).
   */
  function activeSuffix(context) {
    const agent = context?.agent
    if (!agent?.session) return ''
    const open = openTurns.get(agent.session.id)
    if (open) return open.suffix
    const arm = arms.get(agent.session.id)
    if (!arm || arm.turnVariant === null) return ''
    const variant = arm.variants.find((entry) => entry.id === arm.turnVariant)
    return variant?.suffix ?? ''
  }

  function readModelFacts(session) {
    let header
    try {
      header = session.requestHeader?.()
    } catch (error) {
      noteError(error)
      header = undefined
    }
    let selection
    try {
      selection = ctx.agents?.get?.(session.id)?.model?.current?.()
    } catch (error) {
      noteError(error)
      selection = undefined
    }
    const config = header?.config ?? {}
    return {
      provider: config.provider ?? selection?.provider ?? null,
      model: config.model ?? selection?.model ?? null,
      effort: config.reasoningEffort ?? selection?.reasoningEffort ?? null,
      effortDefault: header?.adapterDefaults?.reasoningEffort === true,
    }
  }

  /**
   * One append chain for the whole plugin: fire-and-forget callers and awaited
   * callers still land in call order, so the file reads as a chronological
   * stream and "the last score wins" is actually true.
   */
  let appendChain = Promise.resolve()

  function appendRecord(record) {
    const written = appendChain.then(async () => {
      await mkdir(dirname(settings.file), { recursive: true })
      await appendFile(settings.file, `${JSON.stringify(record)}\n`, 'utf8')
    })
    appendChain = written.then(
      () => undefined,
      (error) => noteError(error),
    )
    return written
  }

  function startTurn(session, arm, event) {
    const cell = pickCell(arm)
    arm.count += 1
    arm.turnVariant = cell.variant.id
    openTurns.set(session.id, {
      session: session.id,
      label: arm.label,
      turn: event.data?.turn ?? null,
      variant: cell.variant.id,
      suffix: cell.variant.suffix,
      plannedEffort: cell.effort,
      startTime: event.time ?? Date.now(),
      steps: 0,
      usageSteps: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      subagents: 0,
      compactions: 0,
      prunes: 0,
    })
  }

  function addUsage(turn, usage) {
    if (usage === null || typeof usage !== 'object') return
    turn.usageSteps += 1
    if (Number.isFinite(usage.inputTokens)) turn.inputTokens += usage.inputTokens
    if (Number.isFinite(usage.outputTokens)) turn.outputTokens += usage.outputTokens
    if (Number.isFinite(usage.reasoningTokens)) turn.reasoningTokens += usage.reasoningTokens
    if (Number.isFinite(usage.cacheReadTokens)) turn.cacheReadTokens += usage.cacheReadTokens
    if (Number.isFinite(usage.cacheWriteTokens)) turn.cacheWriteTokens += usage.cacheWriteTokens
    if (Number.isFinite(usage.totalTokens)) turn.totalTokens += usage.totalTokens
  }

  function finishTurn(session, turn, event) {
    openTurns.delete(session.id)
    lastTurn.set(session.id, turn.turn)
    const facts = readModelFacts(session)
    const record = {
      v: RECORD_VERSION,
      kind: 'turn',
      at: turn.startTime,
      ts: new Date(turn.startTime).toISOString(),
      session: turn.session,
      label: turn.label,
      turn: turn.turn,
      variant: turn.variant,
      plannedEffort: turn.plannedEffort,
      provider: facts.provider,
      model: facts.model,
      effort: facts.effort,
      effortDefault: facts.effortDefault,
      steps: turn.steps,
      usageSteps: turn.usageSteps,
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      reasoningTokens: turn.reasoningTokens,
      cacheReadTokens: turn.cacheReadTokens,
      cacheWriteTokens: turn.cacheWriteTokens,
      totalTokens: turn.totalTokens,
      wallMs: Math.max(0, (event.time ?? Date.now()) - turn.startTime),
      subagents: turn.subagents,
      compactions: turn.compactions,
      prunes: turn.prunes,
      end: describeEndReason(event.data?.reason),
    }
    void appendRecord(record).catch(noteError)
    const arm = arms.get(session.id)
    if (arm) scheduleEffort(session, arm, pickCell(arm).effort)
    if (turn.restoreEffort !== undefined) {
      const restore = turn.restoreEffort
      queueMicrotask(() => selectEffort(session, restore))
    }
  }

  function onSessionEvent(session, event) {
    const type = event?.type
    if (type === 'turn/start') {
      const arm = arms.get(session.id)
      // A second start while one turn is already open is a runtime anomaly, not
      // two turns: keep the open accumulator instead of dropping its samples.
      if (arm && !openTurns.has(session.id)) startTurn(session, arm, event)
      return
    }
    const turn = openTurns.get(session.id)
    if (!turn) return
    switch (type) {
      case 'step/end':
        turn.steps += 1
        break
      case 'assistant/message':
        addUsage(turn, event.data?.usage)
        break
      case 'subagent/catalog':
        turn.subagents += 1
        break
      case 'compaction/start':
        turn.compactions += 1
        break
      case 'compaction/prune':
        turn.prunes += 1
        break
      case 'turn/end':
        finishTurn(session, turn, event)
        break
      default:
        break
    }
  }

  async function readRecords() {
    let text
    try {
      text = await readFile(settings.file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return { turns: [], scores: new Map(), malformed: 0 }
      throw error
    }
    const scores = new Map()
    const turns = []
    let malformed = 0
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        malformed += 1
        continue
      }
      if (record?.kind === 'score') {
        scores.set(`${record.session}:${record.turn}`, record.score)
      } else if (record?.kind === 'turn') {
        turns.push(record)
      } else {
        malformed += 1
      }
    }
    return { turns, scores, malformed }
  }

  function groupKey(record) {
    const effort = record.effort ?? (record.effortDefault ? 'adapter default' : '—')
    return `${record.variant} · ${effort}`
  }

  function buildReport(turns, scores, scope, sessionId) {
    const filtered = scope === 'session'
      ? turns.filter((record) => record.session === sessionId)
      : turns
    if (filtered.length === 0) {
      return scope === 'session'
        ? 'No turn records for this session yet. Run `/effort-lab start` and send a few turns.'
        : `No turn records yet at ${settings.file}. Run \`/effort-lab start\` and send a few turns.`
    }
    const groups = new Map()
    for (const record of filtered) {
      const key = groupKey(record)
      const bucket = groups.get(key) ?? []
      bucket.push({ ...record, score: scores.get(`${record.session}:${record.turn}`) })
      groups.set(key, bucket)
    }
    const rows = [...groups.entries()]
      .map(([key, records]) => {
        // Token statistics only cover turns the adapter actually reported, so a
        // missing report never renders as a measured zero.
        const measured = records.filter((record) => (record.usageSteps ?? 0) > 0)
        const outputs = measured.map((record) => record.outputTokens).filter(Number.isFinite)
        const reasoning = measured.map((record) => record.reasoningTokens).filter(Number.isFinite)
        const walls = records.map((record) => record.wallMs).filter(Number.isFinite)
        const cachePct = measured
          .filter((record) => Number.isFinite(record.inputTokens) && record.inputTokens > 0)
          .map((record) => (record.cacheReadTokens / record.inputTokens) * 100)
        const rated = records.map((record) => record.score).filter(Number.isFinite)
        return {
          key,
          n: records.length,
          completed: records.filter((record) => record.end === 'completed').length,
          unmeasured: records.length - measured.length,
          out: mean(outputs),
          outMed: median(outputs),
          reasoning: mean(reasoning),
          wall: mean(walls),
          subagents: mean(records.map((record) => record.subagents ?? 0)),
          cache: mean(cachePct),
          score: mean(rated),
          rated: rated.length,
        }
      })
      .sort((left, right) => left.key.localeCompare(right.key))

    const header = `${pad('variant · effort', 34)}${num('n', 4)}${num('done', 6)}${num('out tok', 9)}${num('out p50', 9)}${num('reason', 8)}${num('wall ms', 9)}${num('subag', 7)}${num('cache%', 8)}${num('score', 7)}`
    const body = rows.map((row) => {
      const score = row.rated === 0 ? '—' : String(show(row.score))
      return `${pad(row.key, 34)}${num(row.n, 4)}${num(row.completed, 6)}${num(show(row.out, 0), 9)}${num(show(row.outMed, 0), 9)}${num(show(row.reasoning, 0), 8)}${num(show(row.wall, 0), 9)}${num(show(row.subagents, 2), 7)}${num(show(row.cache, 1), 8)}${num(score, 7)}`
    })
    const notes = []
    const caches = rows.map((row) => row.cache).filter(Number.isFinite)
    if (caches.length > 1 && Math.max(...caches) - Math.min(...caches) > 15) {
      notes.push('cache% differs widely between rows: a variant that changes the system-prompt suffix invalidates the cached prefix at each block boundary, so wall time is not directly comparable across those rows.')
    }
    const incomplete = filtered.length - rows.reduce((sum, row) => sum + row.completed, 0)
    if (incomplete > 0) notes.push(`${incomplete} turn(s) did not end with "completed"; they are counted in n but the "done" column shows how many actually completed.`)
    const unmeasured = rows.reduce((sum, row) => sum + row.unmeasured, 0)
    if (unmeasured > 0) notes.push(`${unmeasured} turn(s) reported no token usage; token columns average only the reporting turns and show "—" when a group has none.`)
    const lines = [
      `${filtered.length} turn record(s) at ${settings.file}`,
      '',
      header,
      ...body,
    ]
    if (notes.length > 0) lines.push('', ...notes.map((note) => `note: ${note}`))
    return lines.join('\n')
  }

  function validateArgument(verb, argument) {
    if (verb === 'start') return { ok: true }
    if (verb === 'stop' || verb === 'status') {
      return argument === ''
        ? { ok: true }
        : { ok: false, text: `\`${verb}\` takes no argument. Usage: /${COMMAND_NAME} ${COMMAND_HINT}` }
    }
    if (verb === 'report') {
      return argument === '' || argument === 'session'
        ? { ok: true }
        : { ok: false, text: `Usage: /${COMMAND_NAME} report [session]` }
    }
    if (verb === 'rate') {
      const score = Number(argument)
      return Number.isInteger(score) && score >= 1 && score <= 5
        ? { ok: true, score }
        : { ok: false, text: `Usage: /${COMMAND_NAME} rate <1-5> — an integer score for the last completed turn.` }
    }
    if (verb === 'reset') {
      return argument === '--yes'
        ? { ok: true }
        : { ok: false, text: `This deletes every record in ${settings.file}. Re-run as /${COMMAND_NAME} reset --yes to confirm.` }
    }
    return { ok: false, text: `Unknown subcommand "${verb}". Usage: /${COMMAND_NAME} ${COMMAND_HINT}` }
  }

  async function readRecordsOrError() {
    try {
      return { ok: true, value: await readRecords() }
    } catch (error) {
      noteError(error)
      return { ok: false, text: `Could not read the log at ${settings.file}: ${lastError}` }
    }
  }

  async function commandHandler(invocation) {
    const agent = invocation.agent
    const sessionId = agent?.session?.id
    const input = (invocation.rawInput ?? '').trim()
    const [verbRaw, ...rest] = input === '' ? ['status'] : input.split(/\s+/)
    const verb = verbRaw.toLowerCase()
    const argument = rest.join(' ')

    const checked = validateArgument(verb, argument)
    if (!checked.ok) return { kind: 'error', text: checked.text }

    if (verb === 'start') {
      if (sessionId === undefined) return { kind: 'error', text: 'No session on this invocation.' }
      const label = argument === '' ? DEFAULT_LABEL : argument
      const variants = settings.variants.map((variant) => ({ ...variant }))
      const efforts = [...settings.efforts]
      const cells = buildCells(variants, efforts)
      arms.set(sessionId, {
        label,
        variants,
        efforts,
        cells,
        blockSize: settings.blockSize,
        count: 0,
        turnVariant: null,
        snapshotEffort: snapshotEffort(agent),
      })
      // The command handler runs outside a session publication, so the first
      // block's tier can be applied directly.
      const first = cells[0]
      if (first.effort !== null) selectEffort(agent.session, first.effort)

      const lines = [
        `Armed on this session: label "${label}", ${cells.length} block(s) of ${settings.blockSize} turn(s) each.`,
        `Variants: ${variants.map((variant) => variant.id).join(', ')}.`,
      ]
      if (efforts.length === 0) {
        lines.push('Effort axis: none — the current tier is recorded but not changed; switch it in the composer between blocks.')
      } else {
        lines.push(`Effort axis: ${efforts.join(', ')} — the tier is applied when the previous turn ends and restored by \`stop\`.`)
      }
      lines.push('The variant is chosen at turn start and held for the whole turn.')
      lines.push(
        variants.some((variant) => variant.suffix === '')
          ? 'A variant with an empty suffix is a control arm: it contributes nothing to the prompt.'
          : 'No variant has an empty suffix, so every block changes the prompt.',
      )
      if (settings.variantsFellBack) {
        lines.push('Note: the configured `variants` was empty or invalid, so the shipped pair is in use.')
      }
      return { kind: 'success', text: lines.join('\n') }
    }

    if (verb === 'stop') {
      if (sessionId === undefined) return { kind: 'error', text: 'No session on this invocation.' }
      const arm = arms.get(sessionId)
      arms.delete(sessionId)
      const open = openTurns.get(sessionId)
      if (arm && arm.efforts.length > 0) {
        // An in-flight turn keeps the tier it started with; its restore is queued
        // for turn/end so the record and the tier change agree.
        if (open) open.restoreEffort = arm.snapshotEffort
        else selectEffort(agent.session, arm.snapshotEffort)
      }
      return {
        kind: 'success',
        text: arm === undefined
          ? 'This session was not armed; nothing to stop.'
          : 'Disarmed. Prompt injection stops now; recorded turns stay in the log.',
      }
    }

    if (verb === 'status') {
      const lines = [
        `enabled: ${settings.enabled}`,
        `file: ${settings.file}`,
        `block size: ${settings.blockSize}`,
        `variants: ${settings.variants.map((variant) => `${variant.id}${variant.suffix === '' ? ' (empty)' : ''}`).join(', ')}`,
        `effort axis: ${settings.efforts.length === 0 ? 'none' : settings.efforts.join(', ')}`,
      ]
      if (settings.variantsFellBack) lines.push('variants: configured value was empty or invalid; using the shipped pair')
      const read = await readRecordsOrError()
      if (read.ok) {
        const { turns, scores, malformed } = read.value
        lines.push(
          `records: ${turns.length} turn(s), ${scores.size} score(s)${malformed > 0 ? `, ${malformed} malformed line(s)` : ''}`,
        )
      } else {
        lines.push(`records: unavailable (${lastError})`)
      }
      const arm = sessionId === undefined ? undefined : arms.get(sessionId)
      if (arm) {
        const next = pickCell(arm)
        const describe = (cell) => `${cell.variant.id}${cell.effort === null ? '' : ` @ ${cell.effort}`}`
        lines.push(
          `armed: label "${arm.label}", ${arm.count} turn(s) served, ${arm.cells.length} block(s), current block "${arm.turnVariant ?? 'not started'}", next block "${describe(next)}"`,
        )
      } else {
        lines.push('armed: no (this session is not recording)')
      }
      if (lastError !== undefined) lines.push(`last error: ${lastError}`)
      return { kind: 'success', text: lines.join('\n') }
    }

    if (verb === 'report') {
      const scope = argument === 'session' ? 'session' : 'all'
      if (scope === 'session' && sessionId === undefined) {
        return { kind: 'error', text: 'No session on this invocation.' }
      }
      const read = await readRecordsOrError()
      if (!read.ok) return { kind: 'error', text: read.text }
      return { kind: 'success', text: buildReport(read.value.turns, read.value.scores, scope, sessionId) }
    }

    if (verb === 'rate') {
      if (sessionId === undefined) return { kind: 'error', text: 'No session on this invocation.' }
      let turn = lastTurn.get(sessionId)
      if (turn === undefined) {
        // After a restart the in-memory last turn is gone; fall back to the log.
        const read = await readRecordsOrError()
        if (read.ok) {
          const own = read.value.turns.filter((record) => record.session === sessionId && Number.isFinite(record.turn))
          if (own.length > 0) turn = own.reduce((highest, record) => Math.max(highest, record.turn), -1)
        }
      }
      if (turn === undefined || turn === null || turn < 0) {
        return { kind: 'error', text: 'No completed turn in this session to rate yet.' }
      }
      try {
        await appendRecord({
          v: RECORD_VERSION,
          kind: 'score',
          at: Date.now(),
          ts: new Date().toISOString(),
          session: sessionId,
          turn,
          score: checked.score,
        })
      } catch (error) {
        noteError(error)
        return { kind: 'error', text: `Could not write the score: ${lastError}` }
      }
      return { kind: 'success', text: `Scored turn ${turn} as ${checked.score}/5.` }
    }

    // reset --yes, already validated
    try {
      await mkdir(dirname(settings.file), { recursive: true })
      await writeFile(settings.file, '', 'utf8')
    } catch (error) {
      noteError(error)
      return { kind: 'error', text: `Could not reset the log: ${lastError}` }
    }
    lastTurn.clear()
    return { kind: 'success', text: `Emptied ${settings.file}.` }
  }

  if (!settings.enabled) return

  ctx.effect(
    () => ctx.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      text: (context) => activeSuffix(context),
    }),
    'effort-lab.section()',
  )

  ctx.effect(
    () => ctx.on('session/event', onSessionEvent),
    'effort-lab.events()',
  )

  ctx.effect(
    () => ctx.commands.register({
      name: COMMAND_NAME,
      description: 'A/B a prompt variant against reasoning effort: record per-turn tokens, wall time, subagents and compaction.',
      input: { hint: COMMAND_HINT },
      recordInput: true,
      handler: commandHandler,
    }),
    'effort-lab.command()',
  )
}
