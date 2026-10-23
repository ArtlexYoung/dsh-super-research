import { z } from 'zod'
import { createHash } from 'node:crypto'
import { workspaceSchema, countLimit, limitsSchema, withinLimit, limitFits } from './config.js'

export const RECORD_TYPE = 'plugin:dsh-super-research/event'
const text = z.string().trim().min(1)
const short = text.max(240)
const id = text.max(100).regex(/^[a-zA-Z0-9_.:-]+$/)
const seq = z.number().int().nonnegative()
const refs = z.array(id)
const userRef = z.object({ seq, quote: text.max(16000) }).strict()
const proposal = z.object({
  title: short, question: text.max(4000), approach: text.max(6000),
  criteria: z.array(short).min(1).max(12),
  mode: z.enum(['general', 'algorithm', 'quantitative']),
  maxToolCalls: countLimit,
  protocol: z.string().max(6000),
}).strict().refine(value => value.mode !== 'quantitative' || value.protocol.trim().length > 0,
  'Offline quantitative research requires a frozen data/split/metric/cost protocol')
const evidence = z.object({
  id, kind: z.enum(['source', 'counterevidence', 'measurement', 'supplied']),
  claim: text.max(4000), sourceSeq: seq, quote: text.max(6000), ref: z.string().max(2000),
}).strict()
const progress = z.object({
  stage: z.enum(['planned', 'active', 'blocked', 'completed']),
  summary: text.max(400), nextStep: z.string().trim().max(400),
}).strict().refine(value => value.stage === 'completed' || value.nextStep.length > 0,
  'Unfinished plans need a concrete next step or a way to resolve the blocker')
const node = z.object({
  id, title: short, parents: refs, evidenceIds: refs,
  status: z.enum(['open', 'supported', 'refuted', 'inconclusive']), note: text.max(4000),
  progress: progress.optional(),
}).strict()
const experiment = z.object({
  id, method: text.max(4000), input: text.max(4000), protocol: text.max(6000),
  baseline: text.max(4000), candidate: text.max(4000), metrics: text.max(4000),
  status: z.enum(['completed', 'failed', 'inconclusive']), evidenceIds: refs.min(1), limits: text.max(4000),
}).strict()
// Optional for historical snapshots; new live report writes require a model-authored summary.
const report = z.object({ summary: text.max(400).optional(), text: text.max(16000), evidenceIds: refs.min(1), limits: text.max(4000) }).strict()
export const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('propose'), proposal, workspace: workspaceSchema.optional() }).strict(),
  z.object({ action: z.literal('workspace'), workspace: workspaceSchema }).strict(),
  z.object({ action: z.literal('confirm'), user: userRef }).strict(),
  z.object({ action: z.literal('resume'), user: userRef }).strict(),
  z.object({ action: z.literal('limits'), limits: limitsSchema, user: userRef }).strict(),
  z.object({ action: z.literal('stop'), reason: text.max(2000) }).strict(),
  z.object({ action: z.literal('evidence'), evidence }).strict(),
  z.object({ action: z.literal('node'), node }).strict(),
  z.object({ action: z.literal('node_update'), id, progress,
    status: z.enum(['open', 'supported', 'refuted', 'inconclusive']).optional(), evidenceIds: refs.optional(), note: text.max(4000).optional(),
  }).strict(),
  z.object({ action: z.literal('experiment'), experiment }).strict(),
  z.object({ action: z.literal('report'), report }).strict(),
  z.object({ action: z.literal('review'), decision: z.enum(['accept', 'revise']), user: userRef }).strict(),
  z.object({ action: z.literal('begin'), operation: z.object({ id, tool: short }).strict() }).strict(),
  z.object({ action: z.literal('settle'), id, outcome: z.enum(['completed', 'failed', 'unknown']) }).strict(),
])

export function emptyState() {
  return { version: 1, revision: 0, status: 'empty', proposal: false, proposalSeq: -1,
    reportSeq: -1, controlSeq: -1, statusNote: '', proposalRevision: 0, authorizationSeq: -1, evidence: [], nodes: [],
    experiments: [], operations: [], report: false, review: false, requests: [], error: '' }
}

export const stateSchema = z.object({
  version: z.literal(1), revision: seq,
  status: z.enum(['empty', 'proposed', 'running', 'stopped', 'report', 'accepted', 'interrupted', 'invalid']),
  proposal: z.union([z.literal(false), proposal]), proposalSeq: z.number().int(), reportSeq: z.number().int(),
  proposalRevision: seq, authorizationSeq: z.number().int(),
  controlSeq: z.number().int(), statusNote: z.string().max(2000),
  evidence: z.array(evidence), nodes: z.array(node), experiments: z.array(experiment),
  operations: z.array(z.object({ id, tool: short, status: z.enum(['running', 'completed', 'failed', 'unknown']) }).strict()),
  report: z.union([z.literal(false), report]),
  review: z.union([z.literal(false), z.object({ decision: z.enum(['accept', 'revise']), user: userRef }).strict()]),
  requests: z.array(z.object({ id, digest: text, revision: seq }).strict()),
  error: z.string().max(500),
  workspace: workspaceSchema.optional(),
}).strict()
export const recordSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]), requestId: id, digest: text, expectedRevision: seq, command: commandSchema,
}).strict()
export const eventSchema = recordSchema.extend({ state: stateSchema })

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
export function digestOf(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}
export function demand(condition, message) {
  if (!condition) throw new Error(message)
}
function running(state) { demand(state.status === 'running', 'Research must be confirmed and running') }
function references(ids, records) {
  demand(new Set(ids).size === ids.length, 'Duplicate references are not allowed')
  demand(ids.every(key => records.some(record => record.id === key)), 'Referenced record does not exist')
}
function insert(records, value, max) {
  demand(!records.some(record => record.id === value.id), 'Record id already exists; preserve evidence history')
  demand(withinLimit(records.length, max), 'Research record limit reached; increase this study’s limits in the experiment page')
  return [...records, value]
}

/** Deterministic, versioned fold. Every change remains in the host event log. */
export function transition(state, raw, eventSeq) {
  const record = recordSchema.parse(raw)
  const legacy = record.version === 1
  const previous = state.requests.find(item => item.id === record.requestId)
  if (previous) {
    demand(previous.digest === record.digest, 'Request id was reused for different input')
    return state
  }
  demand(!['invalid'].includes(state.status), 'Research log is invalid; inspect the original session')
  demand(state.revision === record.expectedRevision, 'Research revision changed; read the latest state')
  demand(record.digest === digestOf(record.command), 'Research record digest mismatch')
  if (legacy) demand(state.requests.length < 512, 'Research request limit reached')
  const change = record.command
  let next = { ...state }
  switch (change.action) {
    case 'workspace':
      demand(!state.workspace && state.proposal, 'Only an existing study without an artifact directory can be adopted')
      next.workspace = change.workspace
      break
    case 'propose':
      demand(['empty', 'proposed'].includes(state.status), 'A confirmed protocol is frozen; create a new session for another study')
      next = { ...next, status: 'proposed', proposal: change.proposal, proposalSeq: eventSeq,
        proposalRevision: state.proposalRevision + 1,
        ...(state.workspace || change.workspace ? { workspace: state.workspace || change.workspace } : {}) }
      if (next.workspace) demand(limitFits(change.proposal.maxToolCalls, next.workspace.settings.maxToolCalls), 'Proposal exceeds the configured research tool budget')
      break
    case 'confirm':
      demand(state.status === 'proposed', 'No pending proposal to confirm')
      demand(change.user.seq > state.proposalSeq, 'Confirmation must follow the latest proposal')
      next = { ...next, status: 'running', authorizationSeq: change.user.seq }
      break
    case 'resume':
      demand((legacy ? ['stopped', 'interrupted'] : ['stopped', 'interrupted', 'report', 'accepted']).includes(state.status), 'Only stopped, interrupted or reported research can resume')
      demand(change.user.seq > Math.max(state.authorizationSeq, state.reportSeq, state.proposalSeq, state.controlSeq), 'Resume requires a new user instruction')
      next = { ...next, status: 'running', authorizationSeq: change.user.seq, statusNote: '',
        operations: state.operations.map(item => item.status === 'running' ? { ...item, status: 'unknown' } : item) }
      break
    case 'limits':
      demand(!legacy && state.workspace && state.proposal, 'An existing study is required to change limits')
      demand(change.user.seq > Math.max(state.proposalSeq, state.controlSeq), 'Changing limits requires a new user instruction')
      next.workspace = { ...state.workspace, settings: { ...state.workspace.settings, ...change.limits } }
      next.proposal = { ...state.proposal, maxToolCalls: change.limits.maxToolCalls }
      break
    case 'stop':
      demand(['running', 'interrupted', 'stopped'].includes(state.status), 'No active research to stop')
      next = { ...next, status: 'stopped', controlSeq: eventSeq, statusNote: change.reason }
      break
    case 'begin':
      running(state)
      demand(withinLimit(state.operations.length, state.proposal.maxToolCalls), 'Research tool budget is exhausted')
      next.operations = insert(state.operations, { ...change.operation, status: 'running' }, legacy ? 100 : 0)
      break
    case 'settle':
      demand(state.operations.some(item => item.id === change.id && item.status === 'running'), 'Operation is missing or already settled')
      next.operations = state.operations.map(item => item.id === change.id ? { ...item, status: change.outcome } : item)
      break
    case 'evidence':
      running(state)
      next.evidence = insert(state.evidence, change.evidence, state.workspace?.settings.maxEvidence ?? 64)
      break
    case 'node':
      running(state)
      references(change.node.parents, state.nodes)
      references(change.node.evidenceIds, state.evidence)
      demand(!change.node.parents.includes(change.node.id), 'Exploration cannot depend on itself')
      if (['supported', 'refuted'].includes(change.node.status)) demand(change.node.evidenceIds.length > 0, 'A resolved hypothesis requires evidence')
      next.nodes = insert(state.nodes, change.node, state.workspace?.settings.maxNodes ?? 48)
      break
    case 'node_update': {
      running(state)
      const original = state.nodes.find(item => item.id === change.id)
      demand(original, 'Exploration node does not exist')
      const { action: _action, ...fields } = change
      const updated = { ...original, ...fields }
      references(updated.evidenceIds, state.evidence)
      if (['supported', 'refuted'].includes(updated.status)) demand(updated.evidenceIds.length > 0, 'A resolved hypothesis requires evidence')
      next.nodes = state.nodes.map(item => item.id === change.id ? updated : item)
      break
    }
    case 'experiment':
      running(state)
      references(change.experiment.evidenceIds, state.evidence)
      if (change.experiment.status === 'completed') demand(change.experiment.evidenceIds.some(key => state.evidence.some(item => item.id === key && item.kind === 'measurement')), 'A completed experiment requires a measured host tool result')
      if (state.proposal.mode === 'quantitative') demand(change.experiment.protocol === state.proposal.protocol, 'Quantitative evaluation protocol is frozen')
      next.experiments = insert(state.experiments, change.experiment, state.workspace?.settings.maxExperiments ?? 24)
      break
    case 'report':
      demand(['running', 'stopped'].includes(state.status), 'Research is not ready for a report')
      demand(!state.operations.some(item => item.status === 'running'), 'Unsettled operations must be reviewed before reporting')
      references(change.report.evidenceIds, state.evidence)
      next = { ...next, status: 'report', report: change.report, reportSeq: eventSeq, review: false }
      break
    case 'review':
      demand(state.status === 'report', 'No report awaiting review')
      demand(change.user.seq > state.reportSeq, 'Review must follow the latest report')
      next = { ...next, status: change.decision === 'accept' ? 'accepted' : legacy ? 'stopped' : 'running', controlSeq: eventSeq, review: { decision: change.decision, user: change.user },
        ...(!legacy && change.decision === 'revise' ? { authorizationSeq: change.user.seq, statusNote: '' } : {}) }
      break
    default: throw new Error('Unsupported research action')
  }
  next.revision = state.revision + 1
  next.requests = [...state.requests, { id: record.requestId, digest: record.digest, revision: next.revision }]
  if (legacy) demand(Buffer.byteLength(JSON.stringify(next), 'utf8') <= 256000, 'Research state exceeds 256 KB; use a new session')
  return stateSchema.parse(next)
}
