import { appendPluginRecord, SessionSeq } from '@deepseek-ai/dsh-session'
import { commandSchema, demand, digestOf, RECORD_TYPE, transition } from './state.js'
import { ResearchArtifacts } from './artifacts.js'

const messageText = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const confirmations = /确认|同意|开始|执行|按.*方案|^(?:好[的啊，,。!！\s]*|可以[，,。!！\s]*|行[，,。!！\s]*|yes|ok(?:ay)?|confirm|approve|start|go ahead)/i
const acceptance = /接受.*报告|验收通过|报告.*(?:通过|满意)|accept.*report|approve.*report/i
const refusal = /(?:不要|不用|不必|无需|不能|不想|别|暂不|先不|停止|暂停|取消|不)\s*(?:再\s*)?(?:继续|开始|确认|同意|执行|恢复|研究|修改|深入|完善|接受|验收)|\b(?:do not|don't)\s+(?:continue|resume|start|research|revise|accept|approve)\b|^(?:stop|pause|cancel)\b/i

/** One session barrier: validate, append, then await the host durability checkpoint. */
export class ResearchStore {
  locks = new WeakMap()
  pending = new WeakSet()
  dirty = new WeakSet()
  constructor(ctx) { this.ctx = ctx; this.artifacts = new ResearchArtifacts(ctx) }
  current(session) {
    const state = this.ctx.sessionProjections.stateOf(session, 'superResearch')
    demand(state !== undefined, 'Research projection is unavailable')
    return state
  }
  async checkpoint(session) {
    demand(await this.ctx.sessions.flush(session), 'Host session persistence is unavailable; research is paused')
    this.pending.delete(session)
  }
  async access(session, signal, run) {
    const previous = this.locks.get(session) ?? Promise.resolve()
    const operation = previous.catch(() => {}).then(async () => {
      signal.throwIfAborted()
      if (this.pending.has(session)) await this.checkpoint(session)
      if (this.dirty.has(session)) await this.export(session, signal)
      signal.throwIfAborted()
      return run()
    })
    this.locks.set(session, operation)
    try { return await operation }
    finally { if (this.locks.get(session) === operation) this.locks.delete(session) }
  }
  read(session, signal) {
    return this.access(session, signal, () => this.current(session))
  }
  async export(session, signal) {
    await this.artifacts.sync(session, this.current(session), signal)
    this.dirty.delete(session)
  }
  async ensureWorkspace(session, signal) {
    const state = this.current(session)
    if (!state.workspace && state.proposal) {
      await this.write(session, signal, { requestId: 'host:workspace:v1', expectedRevision: false,
        command: { action: 'workspace', workspace: await this.artifacts.workspace(session, state.proposal.maxToolCalls) } })
    } else if (state.workspace) {
      // A process restart loses in-memory dirty flags; reconstruct views before use.
      await this.access(session, signal, async () => {
        this.dirty.add(session)
        await this.export(session, signal)
        return { directory: state.workspace.directory }
      })
    }
  }
  validateSource(session, command) {
    if (['confirm', 'resume', 'review', 'limits'].includes(command.action)) {
      const event = session.eventAt(SessionSeq(command.user.seq))
      demand(event?.type === 'user/message' && event.data.source.kind === 'user', 'Authorization must reference a direct user message in this session')
      const original = messageText(event.data).trim()
      demand(original === command.user.quote.trim(), 'Use the complete explicit user confirmation, not an extracted fragment')
      const latest = session.snapshotEvents().findLast(item => item.type === 'user/message' && item.data.source.kind === 'user')
      demand(latest?.seq === event.seq, 'Authorization must reference the latest direct user instruction')
      // The model resolves the user's requested work semantically. Provenance and
      // refusal checks belong here; a phrase allow-list would block useful edits.
      demand(!refusal.test(original), 'The user did not give explicit confirmation to execute this action')
      if (command.action === 'confirm') demand(confirmations.test(original), 'A proposal requires explicit confirmation from the user')
      if (command.action === 'review' && command.decision === 'accept') demand(acceptance.test(original), 'Accepting a report requires explicit confirmation from the user')
    }
    if (command.action === 'evidence') {
      const item = command.evidence, event = session.eventAt(SessionSeq(item.sourceSeq))
      const supplied = item.kind === 'supplied'
      demand(supplied ? event?.type === 'user/message' && event.data.source.kind === 'user'
        : event?.type === 'tool/result' && !event.data.message.isError, 'Evidence must reference an original user input or a successful host tool result')
      const original = messageText(supplied ? event.data : event.data.message)
      demand(original.includes(item.quote), 'Evidence quote is missing from the original source event')
      if (item.ref) demand(original.includes(item.ref), 'Source URL or path is missing from the original source event')
      if (/^[a-z]+:/i.test(item.ref)) demand(/^https?:\/\//i.test(item.ref), 'Only HTTP(S) source links may be opened')
    }
  }
  write(session, signal, request) {
    return this.access(session, signal, async () => {
      const state = this.current(session)
      let command = commandSchema.parse(request.command)
      const existing = state.requests.find(item => item.id === request.requestId)
      // Preserve retries of pre-v0.1.1 proposals, whose digest has no workspace.
      if (existing?.digest === digestOf(command)) return { revision: existing.revision, duplicate: true }
      if (command.action === 'propose') {
        command = { ...command, workspace: state.workspace || await this.artifacts.workspace(session) }
      }
      const record = { version: 2, requestId: request.requestId, expectedRevision: request.expectedRevision === false ? state.revision : request.expectedRevision, digest: digestOf(command), command }
      const previous = state.requests.find(item => item.id === record.requestId)
      if (previous) {
        demand(previous.digest === record.digest, 'Request id was reused for different input')
        return { revision: previous.revision, duplicate: true }
      }
      this.validateSource(session, command)
      const next = transition(state, record, session.seq)
      signal.throwIfAborted()
      appendPluginRecord(session, RECORD_TYPE, { ...record, state: next })
      this.pending.add(session)
      this.dirty.add(session)
      await this.checkpoint(session)
      await this.export(session, signal)
      return { revision: this.current(session).revision, duplicate: false }
    })
  }
  change(session, signal, requestId, command) {
    return this.write(session, signal, { requestId, expectedRevision: false, command })
  }
}
