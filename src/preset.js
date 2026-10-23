import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { ResearchStore } from './store.js'
import { INSTRUCTIONS } from './instructions.js'
import { demand } from './state.js'
import { withinLimit } from './config.js'

export const name = 'super-research'
export const inject = ['tools', 'sessions', 'sessionProjections', 'systemPrompt', 'fs', 'workingDirectory', 'sandboxPolicy', 'superResearchConfiguration']
const owned = 'super_research'
const external = execution => execution.name !== owned

/** Adds no runner or model client; the host retains dispatch and cancellation. */
export function apply(ctx) {
  const store = new ResearchStore(ctx)
  const live = new WeakMap()
  ctx.systemPrompt.section({ name: 'super-research:persona', order: 80, text: INSTRUCTIONS, interpolate: false })
  ctx.systemPrompt.context({ name: 'super-research:state', order: 80, text: ({ agent }) => {
    if (!agent) return ''
    if (store.pending.has(agent.session)) return 'Research checkpoint is unconfirmed. Use super_research read before continuing.'
    const state = store.current(agent.session)
    return JSON.stringify({ revision: state.revision, status: state.status, proposal: state.proposal,
      settings: state.workspace?.settings || ctx.superResearchConfiguration.read(), artifactDirectory: state.workspace?.directory || false,
      budgetUsed: state.operations.length, unknownOperations: state.operations.filter(item => ['running', 'unknown'].includes(item.status)),
      evidenceIds: state.evidence.map(item => item.id), reportAwaitingReview: state.status === 'report' })
  } })
  ctx.tools.register(defineTool({
    name: owned,
    description: 'Read or update the current research. First read; propose, then require a later explicit user confirmation. Record exact source evidence, exploration, experiments, report and human review. record is the JSON command described in the research instructions. source returns an original user/tool event by eventSeq.',
    parameters: {
      action: { type: 'string', required: true, enum: ['read', 'record', 'source'] },
      expectedRevision: { type: 'integer', description: 'Required for record; revision from the latest read.' },
      requestId: { type: 'string', description: 'Unique stable id for this write; retry the same command with the same id.' },
      record: { type: 'string', description: 'JSON-encoded research command; never begin/settle, which the host owns.' },
      eventSeq: { type: 'integer', description: 'Original user/tool event position, for source.' },
    },
    output: { schema: { type: 'object', properties: { json: { type: 'string', required: true } }, additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.json }] },
    async execute(args, exec) {
      demand(exec.agent, 'Research requires an owning DSH session')
      const session = exec.agent.session
      const allowed = args.action === 'read' ? ['action'] : args.action === 'source' ? ['action', 'eventSeq'] : ['action', 'expectedRevision', 'requestId', 'record']
      demand(Object.keys(args).every(key => allowed.includes(key)), 'Fields do not match the selected research action')
      if (args.action === 'read') {
        await store.ensureWorkspace(session, exec.signal)
        const state = await store.read(session, exec.signal)
        const sourceEvents = session.snapshotEvents().filter(event => event.type === 'tool/result'
          || event.type === 'user/message' && event.data.source.kind === 'user').slice(-16).map(event => ({
          seq: event.seq, type: event.type, preview: (event.type === 'tool/result' ? event.data.message : event.data).content
            .filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, 180),
        }))
        return { json: JSON.stringify({ ...state, sourceEvents, settings: state.workspace?.settings || ctx.superResearchConfiguration.read(),
          configuredSettings: ctx.superResearchConfiguration.read(),
          artifactDirectory: state.workspace?.directory || (await store.artifacts.workspace(session)).directory }) }
      }
      if (args.action === 'source') {
        await store.read(session, exec.signal)
        const event = session.eventAt(SessionSeq(args.eventSeq))
        demand(event && ['user/message', 'tool/result'].includes(event.type), 'Source must be an original user or tool event')
        const serialized = JSON.stringify(event)
        demand(Buffer.byteLength(serialized, 'utf8') <= 64000, 'Source exceeds 64 KB; narrow the original host tool output')
        return { json: serialized }
      }
      demand(typeof args.requestId === 'string' && Number.isSafeInteger(args.expectedRevision) && typeof args.record === 'string', 'record requires requestId, expectedRevision and a JSON command')
      demand(Buffer.byteLength(args.record, 'utf8') <= 64000, 'Research command exceeds 64 KB')
      const command = JSON.parse(args.record)
      demand(!['begin', 'settle', 'workspace'].includes(command.action) && !Object.hasOwn(command, 'workspace'), 'Operation records and artifact settings are owned by the host')
      if (command.action === 'report') demand(typeof command.report?.summary === 'string' && command.report.summary.trim().length > 0,
        'Report requires a model-written summary: explain the conclusion and its main qualification in two or three short sentences, then save again.')
      if (command.action === 'resume') demand(!live.get(session)?.size, 'A host operation is still running; wait for it or use the DSH Stop control')
      const receipt = await store.write(session, exec.signal, { requestId: args.requestId, expectedRevision: args.expectedRevision, command })
      return { json: JSON.stringify({ ...receipt, status: store.current(session).status, artifactDirectory: store.current(session).workspace?.directory || false }) }
    },
    presentCall: args => ({ card: 'generic', title: `Super Research · ${args.action}`, kind: 'other', rawInput: args }),
  }))
  // Monotonic guard also covers direct registry calls and PTC sub-dispatches.
  ctx.tools.guard(exec => {
    if (!external(exec)) return undefined
    if (!exec.agent) return 'Research tool requires an owning session'
    if (store.pending.has(exec.agent.session)) return 'Research persistence is unconfirmed; read to retry the checkpoint'
    if (store.dirty.has(exec.agent.session)) return 'Research artifact export is incomplete; use super_research read to retry before continuing'
    const state = store.current(exec.agent.session)
    if (state.status !== 'running') return 'Research is not running. Present a proposal and obtain explicit user confirmation, or request explicit resume.'
    if (state.operations.some(item => item.status === 'running' && !live.get(exec.agent.session)?.has(item.id))) return 'An earlier operation has an unknown outcome. Inspect it, stop research, then obtain explicit resume.'
    if (!withinLimit(state.operations.length, state.proposal.maxToolCalls)) return 'Research tool budget is exhausted. Report available findings and limits, or apply user-requested higher limits.'
    return undefined
  })
  ctx.on('tools/execute', async (exec, next) => {
    if (!external(exec)) return next()
    demand(exec.agent, 'Research requires an owning session')
    const session = exec.agent.session, operationId = randomUUID()
    await store.ensureWorkspace(session, exec.signal)
    await store.artifacts.checkExecution(store.current(session), exec)
    // The serialized durable reservation rechecks the budget after concurrent guards.
    let active = live.get(session)
    if (!active) { active = new Set(); live.set(session, active) }
    active.add(operationId)
    let outcome = 'unknown'
    let reserved = false
    try {
      await store.change(session, exec.signal, `${operationId}:begin`, { action: 'begin', operation: { id: operationId, tool: exec.name } })
      reserved = true
      exec.signal.throwIfAborted()
      const result = await next()
      outcome = exec.signal.aborted ? 'unknown' : result.isError ? 'failed' : 'completed'
      return result
    } finally {
      try {
        // A cancelled body can still settle its log, but no command is retried.
        if (reserved) await store.change(session, new AbortController().signal, `${operationId}:settle`, { action: 'settle', id: operationId, outcome })
      } finally { active.delete(operationId) }
    }
  })
}
