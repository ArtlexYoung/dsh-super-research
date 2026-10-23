import test from 'node:test'
import assert from 'node:assert/strict'
import { Session, SessionId, appendPluginRecord } from '@deepseek-ai/dsh-session'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ResearchStore } from '../src/store.js'
import { agentIn, host, plain, proposal } from './helpers.js'
import { RECORD_TYPE } from '../src/state.js'

async function ok(result) { const value = await result; assert.equal(value.isError, false, plain(value)); return value }
async function denied(result, pattern) { const value = await result; assert.equal(value.isError, true, plain(value)); assert.match(plain(value), pattern); return value }

test('confirmation is enforced in host dispatch, with source identity, ordering and complete wording', async t => {
  const h = await host(t)
  const early = h.user('确认方案')
  await denied(h.call({}, 'fixture_measure'), /not running/)
  await ok(h.propose())
  await denied(h.record({ action: 'confirm', user: { seq: early.seq, quote: '确认方案' } }), /follow the latest/)
  const embedded = h.user('不要确认方案')
  await denied(h.record({ action: 'confirm', user: { seq: embedded.seq, quote: '确认方案' } }), /complete explicit/)
  await denied(h.record({ action: 'confirm', user: { seq: embedded.seq, quote: '不要确认方案' } }), /explicit confirmation/)
  await denied(h.record({ action: 'confirm', user: { seq: h.session.seq - 1, quote: '确认方案' } }), /explicit|direct/)
  await ok(h.confirm())
  await ok(h.call({}, 'fixture_measure'))
  assert.equal(h.calls(), 1)
  assert.equal(h.state().operations[0].status, 'completed')
  assert.ok(h.flushes() >= 4)
})

test('proposal revisions reject old approval and writes are idempotent only for identical input', async t => {
  const h = await host(t)
  await ok(h.propose())
  const old = h.user('确认方案')
  const revise = { action: 'propose', proposal: { ...proposal, title: '修订后的方案' } }
  await ok(h.record(revise, { requestId: 'same' }))
  const count = h.session.seq
  await ok(h.record(revise, { requestId: 'same', expectedRevision: 0 }))
  assert.equal(h.session.seq, count)
  await denied(h.record({ ...revise, proposal }, { requestId: 'same' }), /reused/)
  await denied(h.record({ action: 'confirm', user: { seq: old.seq, quote: '确认方案' } }), /follow the latest/)
  await denied(h.record(revise, { expectedRevision: 0 }), /revision changed/)
  await ok(h.confirm())
  await denied(h.record(revise), /protocol is frozen/)
})

test('tool budget is durably reserved, failed attempts count and stopped work cannot dispatch', async t => {
  const h = await host(t, { maxToolCalls: 1 })
  await ok(h.propose()); await ok(h.confirm())
  await ok(h.call({}, 'fixture_measure'))
  await denied(h.call({}, 'fixture_measure'), /budget is exhausted/)
  assert.equal(h.calls(), 1)
  await ok(h.record({ action: 'stop', reason: '核查结果' }))
  const event = h.user('继续研究')
  await ok(h.record({ action: 'resume', user: { seq: event.seq, quote: '继续研究' } }))
  await denied(h.call({}, 'fixture_measure'), /budget is exhausted/)
})

test('checkpoint failure prevents dispatch and retry does not append a second record', async t => {
  const h = await host(t)
  h.failFlush(true)
  const command = { action: 'propose', proposal }
  await denied(h.record(command, { requestId: 'retry' }), /checkpoint failed/)
  const cut = h.session.seq
  await denied(h.call({}, 'fixture_measure'), /persistence is unconfirmed/)
  h.failFlush(false)
  await ok(h.record(command, { requestId: 'retry', expectedRevision: 0 }))
  assert.equal(h.session.seq, cut)
  assert.equal(h.calls(), 0)
})

test('a failed operation reservation never dispatches and remains unknown until explicit reconciliation', async t => {
  const h = await host(t)
  await ok(h.propose()); await ok(h.confirm())
  h.failFlush(true)
  await denied(h.call({}, 'fixture_measure'), /checkpoint failed/)
  assert.equal(h.calls(), 0)
  h.failFlush(false)
  await ok(h.call({ action: 'read' }))
  await denied(h.call({}, 'fixture_measure'), /unknown outcome/)
  await ok(h.record({ action: 'stop', reason: '核查预留调用，未重放' }))
  const event = h.user('继续研究')
  await ok(h.record({ action: 'resume', user: { seq: event.seq, quote: '继续研究' } }))
  assert.equal(h.state().operations[0].status, 'unknown')
  await ok(h.call({}, 'fixture_measure'))
  assert.equal(h.calls(), 1)
})

test('failed and cancelled tools keep their outcomes and consume budget without retries', async t => {
  const h = await host(t)
  h.ctx.tools.register(defineTool({ name: 'fixture_fail', description: 'Fail once.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { throw new Error('fixture failure') },
  }))
  let entered
  const ready = new Promise(resolve => { entered = resolve })
  h.ctx.tools.register(defineTool({ name: 'fixture_wait', description: 'Wait for cancellation.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async (_args, exec) => {
      entered()
      await new Promise((resolve, reject) => {
        if (exec.signal.aborted) reject(exec.signal.reason)
        else exec.signal.addEventListener('abort', () => reject(exec.signal.reason), { once: true })
      })
      return 'unreachable'
    },
  }))
  await ok(h.propose()); await ok(h.confirm())
  await denied(h.call({}, 'fixture_fail'), /fixture failure/)
  assert.equal(h.state().operations[0].status, 'failed')
  const controller = new AbortController()
  const pending = h.call({}, 'fixture_wait', controller.signal)
  await ready
  controller.abort()
  await denied(pending, /aborted|abort/i)
  assert.equal(h.state().operations[1].status, 'unknown')
  assert.equal(h.state().operations.length, 2)
})

test('concurrent reservations cannot overrun one remaining budget slot', async t => {
  const h = await host(t, { maxToolCalls: 1 })
  await ok(h.propose()); await ok(h.confirm())
  const store = new ResearchStore(h.ctx), signal = new AbortController().signal
  const reservations = await Promise.allSettled(['a', 'b'].map(id => store.change(h.session, signal, id,
    { action: 'begin', operation: { id, tool: 'fixture_measure' } })))
  assert.equal(reservations.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(reservations.filter(item => item.status === 'rejected').length, 1)
  assert.equal(h.state().operations.length, 1)
})

test('no host persistence means no successful research checkpoint', async t => {
  const h = await host(t, { persistence: false })
  await denied(h.propose(), /persistence is unavailable/)
  await denied(h.call({}, 'fixture_measure'), /persistence is unconfirmed/)
})

test('session replay preserves evidence and marks active work interrupted without rerunning it', async t => {
  const h = await host(t)
  await ok(h.propose()); await ok(h.confirm())
  await ok(h.call({}, 'fixture_measure'))
  const restored = Session.create(SessionId('reopened'), h.session.snapshotEvents())
  const state = h.ctx.sessionProjections.stateOf(restored, 'superResearch')
  assert.equal(state.status, 'interrupted')
  assert.equal(state.operations[0].status, 'completed')
  assert.equal(h.calls(), 1)
  assert.equal(h.ctx.sessionProjections.stateOf(h.session, 'superResearch').status, 'running')
})

test('host tools in an unrelated session are unaffected and preset unload removes tools and guards', async t => {
  const h = await host(t)
  const session = h.ctx.sessions.create(SessionId('ordinary'))
  const ordinary = agentIn(h.ctx, session)
  t.after(() => ordinary.scope.dispose())
  const result = await h.ctx.tools.execute({ name: 'fixture_measure', arguments: {}, agent: ordinary.agent,
    signal: new AbortController().signal, callId: ToolCallId('ordinary-call') })
  assert.equal(result.isError, false)
  assert.equal(h.ctx.sessionProjections.stateOf(session, 'superResearch').status, 'empty')
  await h.fiber.dispose()
  await ok(h.call({}, 'fixture_measure'))
  await denied(h.call({ action: 'read' }), /not found|unknown tool|not available/i)
})

test('evidence rejects missing sources and fabricated excerpts; exploration and reports retain provenance', async t => {
  const h = await host(t)
  await ok(h.propose()); await ok(h.confirm())
  const event = h.session.append('tool/result', { turn: 1, step: 1,
    message: createToolResultMessage({ callId: ToolCallId('measured'), content: [{ type: 'text', text: 'sorted=true, n=128, milliseconds=0.25 https://example.org/results' }], isError: false }) }, { surfaceOp: 'append' })
  const evidence = { id: 'e1', kind: 'measurement', claim: '固定输入排序正确', sourceSeq: event.seq,
    quote: 'sorted=true, n=128, milliseconds=0.25', ref: 'https://example.org/results' }
  await denied(h.record({ action: 'evidence', evidence: { ...evidence, sourceSeq: 9999 } }), /original user|successful host/)
  await denied(h.record({ action: 'evidence', evidence: { ...evidence, quote: 'invented' } }), /quote is missing/)
  await denied(h.record({ action: 'evidence', evidence: { ...evidence, ref: 'https://fake.invalid' } }), /URL or path is missing/)
  await ok(h.record({ action: 'evidence', evidence }))
  await denied(h.record({ action: 'evidence', evidence }), /already exists/)
  await denied(h.record({ action: 'node', node: { id: 'a', title: '假设', parents: [], evidenceIds: [], status: 'supported', note: '结论' } }), /requires evidence/)
  await ok(h.record({ action: 'node', node: { id: 'a', title: '假设', parents: [], evidenceIds: ['e1'], status: 'supported', note: '仅覆盖固定输入' } }))
  await denied(h.record({ action: 'node', node: { id: 'b', title: '反例', parents: ['missing'], evidenceIds: ['e1'], status: 'open', note: '待验证' } }), /does not exist/)
  const earlyReview = h.user('接受报告')
  await ok(h.record({ action: 'report', report: { summary: '当前仅有有限证据，尚不能推广结论。', text: '固定输入通过，证据 e1；性能结论尚未成立。', evidenceIds: ['e1'], limits: '单次测量' } }))
  await denied(h.record({ action: 'review', decision: 'accept', user: { seq: earlyReview.seq, quote: '接受报告' } }), /follow the latest report/)
  const oldUser = h.session.snapshotEvents().find(item => item.type === 'user/message')
  await denied(h.record({ action: 'review', decision: 'accept', user: { seq: oldUser.seq, quote: '确认方案' } }), /latest direct|explicit confirmation/)
  const review = h.user('接受报告')
  await ok(h.record({ action: 'review', decision: 'accept', user: { seq: review.seq, quote: '接受报告' } }))
  assert.equal(h.state().status, 'accepted')
  await denied(h.call({}, 'fixture_measure'), /not running/)
})

test('malformed plugin state is retained and disables research while other sessions remain available', async t => {
  const h = await host(t)
  appendPluginRecord(h.session, RECORD_TYPE, { version: 999 })
  assert.equal(h.state().status, 'invalid')
  await denied(h.propose(), /invalid/)
  await denied(h.call({}, 'fixture_measure'), /not running/)
})
