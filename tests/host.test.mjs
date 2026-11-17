import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, inject, name } from '../lib/index.js'

const SESSION_ID = 'session-abc'
const MODEL = { provider: 'deepseek', model: 'deepseek-flash' }

function makeSession(overrides = {}) {
  return {
    id: SESSION_ID,
    requestHeader: () => ({ config: { ...MODEL, reasoningEffort: 'max', ...overrides } }),
  }
}

/**
 * A fake Cordis context recording every registration the plugin makes, so the
 * suite can drive `session/event` traffic and command invocations exactly as the
 * host would, with no DSH process involved.
 */
function createHarness(config) {
  const sections = []
  const commands = []
  const listeners = []
  const agents = new Map()
  const effects = []
  const ctx = {
    systemPrompt: {
      section: (definition) => {
        sections.push(definition)
        return () => {}
      },
    },
    commands: {
      register: (definition) => {
        commands.push(definition)
        return () => {}
      },
    },
    agents: { get: (id) => agents.get(id) },
    on: (event, handler) => {
      listeners.push({ event, handler })
      return () => {}
    },
    effect: (factory, label) => {
      effects.push(label)
      const disposer = factory()
      return () => disposer?.()
    },
  }
  apply(ctx, config)
  const emit = (type, data, time, session = makeSession()) => {
    for (const listener of listeners) {
      if (listener.event === 'session/event') listener.handler(session, { type, data, time })
    }
  }
  const sectionText = (session = makeSession()) => {
    if (sections.length === 0) return undefined
    return sections[0].text({ agent: { session } })
  }
  const invoke = async (rawInput, session = makeSession()) => {
    assert.equal(commands.length, 1, 'exactly one command must be registered')
    // The host hands the command the live Agent, whose `model` seat the plugin reads and writes.
    const agent = agents.get(session.id) ?? { session }
    return commands[0].handler({ agent, rawInput, commandId: 'cmd-1', attachments: [], signal: new AbortController().signal })
  }
  return { sections, commands, listeners, agents, effects, emit, sectionText, invoke }
}


/** A live model seat: `requestHeader()` mirrors whatever `select()` last wrote. */
function makeLiveAgent(sessionId, effort) {
  let live = { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: effort }
  const session = {
    id: sessionId,
    requestHeader: () => ({ config: { ...MODEL, reasoningEffort: live.reasoningEffort } }),
  }
  const agent = {
    session,
    model: {
      current: () => ({ ...live }),
      select: (next) => {
        live = { ...live, ...next }
      },
    },
    effort: () => live.reasoningEffort,
  }
  return { session, agent }
}

/** Let queued microtasks (the plugin's deferred effort write) run. */
const flush = () => new Promise((resolve) => setImmediate(resolve))

async function readRecords(file) {
  try {
    const text = await readFile(file, 'utf8')
    return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function waitForRecords(file, expected) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const records = await readRecords(file)
    if (records.length >= expected) return records
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${expected} record(s) at ${file}`)
}

async function withLab(configFactory, run) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-effort-lab-'))
  const file = join(dir, 'records.jsonl')
  try {
    await run({ file, dir, config: configFactory(file, dir) })
  } finally {
    await flush()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
}

function oneTurn(harness, { turn, start, end, usage, subagents = 0, compactions = 0, reason = 'completed', session }) {
  harness.emit('turn/start', { turn }, start, session)
  harness.emit('step/start', { turn, step: 1 }, start, session)
  if (usage) harness.emit('assistant/message', { usage }, start + 100, session)
  harness.emit('step/end', { turn, step: 1 }, start + 200, session)
  for (let index = 0; index < subagents; index += 1) {
    harness.emit('subagent/catalog', {}, start + 300, session)
  }
  for (let index = 0; index < compactions; index += 1) {
    harness.emit('compaction/start', {}, start + 400, session)
  }
  harness.emit('turn/end', { turn, reason }, end, session)
}

test('declares the plugin contract', () => {
  assert.equal(name, 'dsh-effort-lab')
  for (const service of ['systemPrompt', 'commands', 'agents']) {
    assert.ok(inject.includes(service), `inject must include ${service}`)
  }
})

test('registers one late prompt section, one command and one listener', async () => {
  await withLab((file) => ({ file }), async ({ file, config }) => {
    const harness = createHarness(config)
    assert.equal(harness.sections.length, 1)
    assert.equal(harness.commands.length, 1)
    assert.equal(harness.commands[0].name, 'effort-lab')
    assert.ok(harness.listeners.some((listener) => listener.event === 'session/event'))
    const section = harness.sections[0]
    assert.equal(section.name, 'effort-lab:variant')
    assert.ok(section.order > 10200, 'section must land after DEPLOYMENT_PERSONA_SUFFIX (10200)')
  })
})

test('an unarmed session contributes an empty suffix and records nothing', async () => {
  await withLab((file) => ({ file }), async ({ file, config }) => {
    const harness = createHarness(config)
    assert.equal(harness.sectionText(), '')
    oneTurn(harness, { turn: 1, start: 1_000, end: 2_000, usage: { inputTokens: 10, outputTokens: 5 } })
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.deepEqual(await readRecords(file), [])
  })
})

test('armed session injects the block variant and rotates in blocks', async () => {
  await withLab(
    (file) => ({
      file,
      blockSize: 2,
      variants: [
        { id: 'a', suffix: 'SUFFIX-A' },
        { id: 'b', suffix: 'SUFFIX-B' },
      ],
    }),
    async ({ config }) => {
      const harness = createHarness(config)
      await harness.invoke('start')
      assert.equal(harness.sectionText(), '', 'no variant is frozen before the first turn starts')

      const seen = []
      for (let turn = 1; turn <= 4; turn += 1) {
        harness.emit('turn/start', { turn }, turn * 1_000)
        seen.push(harness.sectionText())
        harness.emit('turn/end', { turn, reason: 'completed' }, turn * 1_000 + 500)
      }
      assert.deepEqual(seen, ['SUFFIX-A', 'SUFFIX-A', 'SUFFIX-B', 'SUFFIX-B'])
    },
  )
})

test('records one row per turn with usage, wall time, subagents, compaction and effort', async () => {
  await withLab((file) => ({ file }), async ({ file, config }) => {
    const harness = createHarness(config)
    await harness.invoke('start demo')
    harness.emit('turn/start', { turn: 1 }, 1_000)
    harness.emit('step/end', { turn: 1, step: 1 }, 1_100)
    harness.emit('assistant/message', { usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 20, cacheReadTokens: 40, totalTokens: 150 } }, 1_200)
    harness.emit('step/end', { turn: 1, step: 2 }, 1_300)
    harness.emit('assistant/message', { usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 20, cacheReadTokens: 40, totalTokens: 150 } }, 1_400)
    harness.emit('subagent/catalog', {}, 1_500)
    harness.emit('compaction/start', {}, 1_600)
    harness.emit('compaction/prune', {}, 1_700)
    harness.emit('turn/end', { turn: 1, reason: 'completed' }, 5_000)

    const [record] = await waitForRecords(file, 1)
    assert.equal(record.kind, 'turn')
    assert.equal(record.variant, 'baseline')
    assert.equal(record.label, 'demo')
    assert.equal(record.turn, 1)
    assert.equal(record.steps, 2)
    assert.equal(record.usageSteps, 2)
    assert.equal(record.inputTokens, 200)
    assert.equal(record.outputTokens, 100)
    assert.equal(record.reasoningTokens, 40)
    assert.equal(record.cacheReadTokens, 80)
    assert.equal(record.subagents, 1)
    assert.equal(record.compactions, 1)
    assert.equal(record.prunes, 1)
    assert.equal(record.wallMs, 4_000)
    assert.equal(record.effort, 'max')
    assert.equal(record.model, MODEL.model)
    assert.equal(record.provider, MODEL.provider)
    assert.equal(record.end, 'completed')
  })
})

test('a turn with no reported usage still records, with zeroed token fields', async () => {
  await withLab((file) => ({ file }), async ({ file, config }) => {
    const harness = createHarness(config)
    await harness.invoke('start')
    oneTurn(harness, { turn: 1, start: 1_000, end: 2_000 })
    const [record] = await waitForRecords(file, 1)
    assert.equal(record.usageSteps, 0)
    assert.equal(record.outputTokens, 0)
    assert.equal(record.end, 'completed')
  })
})

test('an aborted turn is recorded with its end reason', async () => {
  await withLab((file) => ({ file }), async ({ file, config }) => {
    const harness = createHarness(config)
    await harness.invoke('start')
    oneTurn(harness, { turn: 1, start: 1_000, end: 2_000, reason: 'aborted' })
    const [record] = await waitForRecords(file, 1)
    assert.equal(record.end, 'aborted')
  })
})

test('report groups variants with the effort in force', async () => {
  await withLab(
    (file) => ({
      file,
      blockSize: 1,
      variants: [
        { id: 'a', suffix: 'SUFFIX-A' },
        { id: 'b', suffix: 'SUFFIX-B' },
      ],
    }),
    async ({ file, config }) => {
      const harness = createHarness(config)
      await harness.invoke('start')
      oneTurn(harness, { turn: 1, start: 1_000, end: 2_000, usage: { inputTokens: 100, outputTokens: 10 } })
      oneTurn(harness, { turn: 2, start: 3_000, end: 4_000, usage: { inputTokens: 100, outputTokens: 30 } })
      await waitForRecords(file, 2)

      const result = await harness.invoke('report')
      assert.equal(result.kind, 'success')
      assert.match(result.text, /a · max/)
      assert.match(result.text, /b · max/)
      assert.match(result.text, /2 turn record\(s\)/)
    },
  )
})

test('report scoped to the session ignores other sessions', async () => {
  await withLab((file) => ({ file }), async ({ file, config }) => {
    const harness = createHarness(config)
    await harness.invoke('start')
    const otherSession = makeSession()
    otherSession.id = 'session-other'
    const otherHarness = createHarness(config)
    await otherHarness.invoke('start', otherSession)
    oneTurn(otherHarness, { turn: 1, start: 1_000, end: 2_000, usage: { inputTokens: 10, outputTokens: 1 }, session: otherSession })
    await waitForRecords(file, 1)

    const scoped = await harness.invoke('report session')
    assert.match(scoped.text, /No turn records for this session yet/)
    const withOwn = await harness.invoke('report')
    assert.match(withOwn.text, /1 turn record\(s\)/)
  })
})

test('rate attaches a score the report shows', async () => {
  await withLab((file) => ({ file }), async ({ file, config }) => {
    const harness = createHarness(config)
    await harness.invoke('start')
    oneTurn(harness, { turn: 1, start: 1_000, end: 2_000, usage: { inputTokens: 10, outputTokens: 5 } })
    await waitForRecords(file, 1)

    const rated = await harness.invoke('rate 4')
    assert.equal(rated.kind, 'success')
    const records = await waitForRecords(file, 2)
    const score = records.find((record) => record.kind === 'score')
    assert.equal(score.score, 4)
    assert.equal(score.turn, 1)

    const report = await harness.invoke('report')
    assert.match(report.text, /4/)
  })
})

test('rate rejects an out-of-range score and a session with no completed turn', async () => {
  await withLab((file) => ({ file }), async ({ config }) => {
    const harness = createHarness(config)
    await harness.invoke('start')
    assert.equal((await harness.invoke('rate 9')).kind, 'error')
    assert.equal((await harness.invoke('rate abc')).kind, 'error')
    assert.equal((await harness.invoke('rate 3')).kind, 'error')
  })
})

test('stop disarms injection and stops recording', async () => {
  await withLab((file) => ({ file }), async ({ file, config }) => {
    const harness = createHarness(config)
    await harness.invoke('start')
    harness.emit('turn/start', { turn: 1 }, 1_000)
    assert.notEqual(harness.sectionText(), undefined)
    harness.emit('turn/end', { turn: 1, reason: 'completed' }, 2_000)
    await waitForRecords(file, 1)

    const stopped = await harness.invoke('stop')
    assert.equal(stopped.kind, 'success')
    assert.equal(harness.sectionText(), '')
    oneTurn(harness, { turn: 2, start: 3_000, end: 4_000, usage: { inputTokens: 10, outputTokens: 5 } })
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal((await readRecords(file)).length, 1)
  })
})

test('reset needs --yes, then empties the log', async () => {
  await withLab((file) => ({ file }), async ({ file, config }) => {
    const harness = createHarness(config)
    await harness.invoke('start')
    oneTurn(harness, { turn: 1, start: 1_000, end: 2_000, usage: { inputTokens: 10, outputTokens: 5 } })
    await waitForRecords(file, 1)

    const refused = await harness.invoke('reset')
    assert.equal(refused.kind, 'error')
    assert.equal((await readRecords(file)).length, 1)

    const done = await harness.invoke('reset --yes')
    assert.equal(done.kind, 'success')
    assert.deepEqual(await readRecords(file), [])
  })
})

test('an unknown subcommand reports usage instead of throwing', async () => {
  await withLab((file) => ({ file }), async ({ config }) => {
    const harness = createHarness(config)
    const result = await harness.invoke('nonsense')
    assert.equal(result.kind, 'error')
    assert.match(result.text, /Unknown subcommand/)
  })
})

test('status reports the arm, the cursor and the variant set', async () => {
  await withLab((file) => ({ file }), async ({ config }) => {
    const harness = createHarness(config)
    const before = await harness.invoke('status')
    assert.match(before.text, /armed: no/)
    await harness.invoke('start sweep')
    const after = await harness.invoke('status')
    assert.match(after.text, /armed: label "sweep"/)
    assert.match(after.text, /baseline \(empty\), unlimited/)
  })
})

test('malformed log lines are skipped, not fatal', async () => {
  await withLab((file) => ({ file }), async ({ file, config }) => {
    const harness = createHarness(config)
    await harness.invoke('start')
    oneTurn(harness, { turn: 1, start: 1_000, end: 2_000, usage: { inputTokens: 10, outputTokens: 5 } })
    await waitForRecords(file, 1)
    const previous = await readFile(file, 'utf8')
    await writeFile(file, `${previous}not json\n{"kind":"mystery"}\n`, 'utf8')

    const report = await harness.invoke('report')
    assert.equal(report.kind, 'success')
    assert.match(report.text, /1 turn record\(s\)/)
    const status = await harness.invoke('status')
    assert.match(status.text, /1 turn\(s\), 0 score\(s\), 2 malformed line\(s\)/)
  })
})

test('a disabled config registers nothing', async () => {
  await withLab((file) => ({ file, enabled: false }), async ({ config }) => {
    const harness = createHarness(config)
    assert.equal(harness.sections.length, 0)
    assert.equal(harness.commands.length, 0)
    assert.equal(harness.listeners.length, 0)
  })
})

test('invalid variant config falls back to the shipped pair', async () => {
  await withLab((file) => ({ file, variants: 'nope', blockSize: 0 }), async ({ file, config }) => {
    const harness = createHarness(config)
    const status = await harness.invoke('status')
    assert.match(status.text, /baseline/)
    assert.match(status.text, /unlimited/)
    assert.match(status.text, /block size: 3/, 'a non-positive blockSize falls back to 3')
  })
})

test('an effort axis rotates the tier per block and restores it on stop', async () => {
  await withLab(
    (file) => ({ file, blockSize: 1, variants: [{ id: 'v', suffix: 'S' }], efforts: ['high', 'max'] }),
    async ({ file, config }) => {
      const harness = createHarness(config)
      const { session, agent } = makeLiveAgent(SESSION_ID, 'high')
      harness.agents.set(session.id, agent)
      await harness.invoke('start', session)

      harness.emit('turn/start', { turn: 1 }, 1_000, session)
      assert.equal(agent.effort(), 'high')
      harness.emit('turn/end', { turn: 1, reason: 'completed' }, 2_000, session)
      await flush()

      harness.emit('turn/start', { turn: 2 }, 3_000, session)
      assert.equal(agent.effort(), 'max', 'the second block applies the second tier')
      harness.emit('turn/end', { turn: 2, reason: 'completed' }, 4_000, session)

      const records = await waitForRecords(file, 2)
      assert.deepEqual(records.map((record) => record.plannedEffort), ['high', 'max'])
      assert.deepEqual(records.map((record) => record.effort), ['high', 'max'])

      await harness.invoke('stop', session)
      assert.equal(agent.effort(), 'high', 'stop restores the tier captured at start')
    },
  )
})

test('variant and effort sweeps combine as the full product, variant-major', async () => {
  await withLab(
    (file) => ({
      file,
      blockSize: 1,
      variants: [
        { id: 'a', suffix: 'SUFFIX-A' },
        { id: 'b', suffix: 'SUFFIX-B' },
      ],
      efforts: ['low', 'max'],
    }),
    async ({ config }) => {
      const harness = createHarness(config)
      const { session, agent } = makeLiveAgent(SESSION_ID, 'low')
      harness.agents.set(session.id, agent)
      await harness.invoke('start', session)

      const cells = []
      for (let turn = 1; turn <= 4; turn += 1) {
        harness.emit('turn/start', { turn }, turn * 1_000, session)
        cells.push([harness.sectionText(session), agent.effort()])
        harness.emit('turn/end', { turn, reason: 'completed' }, turn * 1_000 + 500, session)
        await flush()
      }
      assert.deepEqual(cells, [
        ['SUFFIX-A', 'low'],
        ['SUFFIX-A', 'max'],
        ['SUFFIX-B', 'low'],
        ['SUFFIX-B', 'max'],
      ])
    },
  )
})

test('status shows the effort axis and the next block', async () => {
  await withLab((file) => ({ file, blockSize: 2, efforts: ['high', 'max'] }), async ({ config }) => {
    const harness = createHarness(config)
    const { session, agent } = makeLiveAgent(SESSION_ID, 'high')
    harness.agents.set(session.id, agent)
    await harness.invoke('start', session)
    harness.emit('turn/start', { turn: 1 }, 1_000, session)
    const status = await harness.invoke('status', session)
    assert.match(status.text, /effort axis: high, max/)
    assert.match(status.text, /4 block\(s\)/)
    assert.match(status.text, /next block "baseline @ high"/)
  })
})

test('disarming mid-turn keeps the frozen suffix and still records that turn', async () => {
  await withLab(
    (file) => ({ file, blockSize: 5, variants: [{ id: 'v', suffix: 'SUFFIX-V' }] }),
    async ({ file, config }) => {
      const harness = createHarness(config)
      await harness.invoke('start')
      harness.emit('turn/start', { turn: 1 }, 1_000)
      assert.equal(harness.sectionText(), 'SUFFIX-V')

      await harness.invoke('stop')
      assert.equal(harness.sectionText(), 'SUFFIX-V', 'the open turn must not lose its suffix')

      harness.emit('step/end', { turn: 1, step: 1 }, 1_500)
      harness.emit('turn/end', { turn: 1, reason: 'completed' }, 2_000)
      const [record] = await waitForRecords(file, 1)
      assert.equal(record.variant, 'v')

      harness.emit('turn/start', { turn: 2 }, 3_000)
      assert.equal(harness.sectionText(), '', 'the next turn is unarmed')
    },
  )
})

test('a group with no reported usage shows dashes and says so, not zeros', async () => {
  await withLab((file) => ({ file, blockSize: 1, variants: [{ id: 'v', suffix: 'S' }] }), async ({ file, config }) => {
    const harness = createHarness(config)
    await harness.invoke('start')
    oneTurn(harness, { turn: 1, start: 1_000, end: 2_000 })
    await waitForRecords(file, 1)
    const report = await harness.invoke('report')
    assert.match(report.text, /reported no token usage/)
    assert.match(report.text, /—/)
  })
})

/** A model seat that rejects `select()` exactly like DSH does during a session publication. */
function makePublishingAgent(sessionId, effort) {
  let live = { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: effort }
  let publishing = false
  const session = {
    id: sessionId,
    requestHeader: () => ({ config: { ...MODEL, reasoningEffort: live.reasoningEffort } }),
  }
  const agent = {
    session,
    model: {
      current: () => ({ ...live }),
      select: (next) => {
        if (publishing) throw new Error('session append cannot reenter while another append is being published')
        live = { ...live, ...next }
      },
    },
    effort: () => live.reasoningEffort,
  }
  return { session, agent, setPublishing: (value) => { publishing = value } }
}

test('effort writes are deferred out of the session publication, so they never throw', async () => {
  await withLab(
    (file) => ({ file, blockSize: 1, variants: [{ id: 'v', suffix: 'S' }], efforts: ['low', 'max'] }),
    async ({ file, config }) => {
      const harness = createHarness(config)
      const fx = makePublishingAgent(SESSION_ID, 'low')
      harness.agents.set(fx.session.id, fx.agent)
      await harness.invoke('start', fx.session)
      assert.equal(fx.agent.effort(), 'low')

      const emit = (type, data, time) => {
        fx.setPublishing(true)
        try {
          harness.emit(type, data, time, fx.session)
        } finally {
          fx.setPublishing(false)
        }
      }
      emit('turn/start', { turn: 1 }, 1_000)
      emit('turn/end', { turn: 1, reason: 'completed' }, 2_000)
      await flush()
      assert.equal(fx.agent.effort(), 'max', 'the tier changed after the publication closed, not inside it')

      const status = await harness.invoke('status', fx.session)
      assert.doesNotMatch(status.text, /last error/, 'no reentrancy error should be recorded')
      const records = await waitForRecords(file, 1)
      assert.equal(records[0].plannedEffort, 'low')
    },
  )
})

test('records land in chronological order even when turns end back to back', async () => {
  await withLab((file) => ({ file, blockSize: 1, variants: [{ id: 'v', suffix: 'S' }] }), async ({ file, config }) => {
    const harness = createHarness(config)
    await harness.invoke('start')
    for (let turn = 1; turn <= 6; turn += 1) {
      harness.emit('turn/start', { turn }, turn * 1_000)
      harness.emit('turn/end', { turn, reason: 'completed' }, turn * 1_000 + 100)
    }
    const records = await waitForRecords(file, 6)
    assert.deepEqual(records.map((record) => record.turn), [1, 2, 3, 4, 5, 6])
  })
})

test('an unreadable log makes report fail cleanly and status report it', async () => {
  await withLab((file, dir) => ({ file: dir }), async ({ dir, config }) => {
    const harness = createHarness(config)
    const report = await harness.invoke('report')
    assert.equal(report.kind, 'error')
    assert.match(report.text, /Could not read the log/)
    const status = await harness.invoke('status')
    assert.equal(status.kind, 'success')
    assert.match(status.text, /records: unavailable/)
  })
})

test('stop mid-turn keeps the turn on its own tier and restores afterwards', async () => {
  await withLab(
    (file) => ({ file, blockSize: 1, variants: [{ id: 'v', suffix: 'S' }], efforts: ['low', 'max'] }),
    async ({ file, config }) => {
      const harness = createHarness(config)
      const fx = makePublishingAgent(SESSION_ID, 'high')
      harness.agents.set(fx.session.id, fx.agent)
      await harness.invoke('start', fx.session)
      assert.equal(fx.agent.effort(), 'low')

      harness.emit('turn/start', { turn: 1 }, 1_000, fx.session)
      await harness.invoke('stop', fx.session)
      assert.equal(fx.agent.effort(), 'low', 'the in-flight turn must not be retiered')

      harness.emit('turn/end', { turn: 1, reason: 'completed' }, 2_000, fx.session)
      await flush()
      assert.equal(fx.agent.effort(), 'high', 'the snapshot tier is restored once the turn ends')
      const [record] = await waitForRecords(file, 1)
      assert.equal(record.effort, 'low')
    },
  )
})

test('junk arguments and non-integer scores are rejected', async () => {
  await withLab((file) => ({ file }), async ({ config }) => {
    const harness = createHarness(config)
    await harness.invoke('start')
    for (const input of ['report garbage', 'status garbage', 'stop garbage', 'rate 2.5', 'rate 0', 'rate 6']) {
      const result = await harness.invoke(input)
      assert.equal(result.kind, 'error', `${input} must be rejected`)
    }
  })
})

test('a duplicate turn/start does not silently drop the open turn', async () => {
  await withLab((file) => ({ file, blockSize: 1, variants: [{ id: 'v', suffix: 'S' }] }), async ({ file, config }) => {
    const harness = createHarness(config)
    await harness.invoke('start')
    harness.emit('turn/start', { turn: 1 }, 1_000)
    harness.emit('turn/start', { turn: 2 }, 1_100)
    harness.emit('turn/end', { turn: 1, reason: 'completed' }, 2_000)
    const records = await waitForRecords(file, 1)
    assert.equal(records.length, 1)
    assert.equal(records[0].turn, 1)
    const status = await harness.invoke('status')
    assert.match(status.text, /1 turn\(s\) served/)
  })
})

test('rate works after a restart by falling back to the log', async () => {
  await withLab((file) => ({ file, blockSize: 1, variants: [{ id: 'v', suffix: 'S' }] }), async ({ file, config }) => {
    const first = createHarness(config)
    await first.invoke('start')
    oneTurn(first, { turn: 1, start: 1_000, end: 2_000, usage: { inputTokens: 10, outputTokens: 5 } })
    await waitForRecords(file, 1)

    const restarted = createHarness(config)
    const rated = await restarted.invoke('rate 5')
    assert.equal(rated.kind, 'success', 'a fresh process can still score the last logged turn')
    assert.match(rated.text, /turn 1/)

    const report = await restarted.invoke('report')
    assert.match(report.text, /5/)
  })
})

test('reset --yes also clears the in-memory last turn', async () => {
  await withLab((file) => ({ file }), async ({ file, config }) => {
    const harness = createHarness(config)
    await harness.invoke('start')
    oneTurn(harness, { turn: 1, start: 1_000, end: 2_000, usage: { inputTokens: 10, outputTokens: 5 } })
    await waitForRecords(file, 1)
    await harness.invoke('reset --yes')
    const assessed = await harness.invoke('rate 3')
    assert.equal(assessed.kind, 'error', 'there is no turn to score after a reset')
    assert.deepEqual(await readRecords(file), [])
  })
})
