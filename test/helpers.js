import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import * as workbench from '../src/index.js'
import * as preset from '../src/preset.js'

export const proposal = { title: '排序策略比较', question: '哪种排序策略满足正确性和性能标准？', approach: '固定输入，比较基线，寻找反例。',
  criteria: ['与参考实现结果一致', '报告测量方法和限制'], mode: 'algorithm', maxToolCalls: 6, protocol: '' }
export const plain = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
export function agentIn(ctx, session) {
  const agent = {}, scope = createScope(ctx, agent)
  Object.assign(agent, { id: session.id, session, ctx: scope.ctx })
  return { agent, scope }
}
export async function host(t, { persistence = true, maxToolCalls = 6, configuration = {}, sandboxMode = 'workspace-write' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'super-research-test-'))
  const ctx = new Context()
  t.after(async () => { try { await ctx.fiber.dispose() } finally { await rm(directory, { recursive: true, force: true }) } })
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime, {})
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: directory })
  await ctx.plugin(WorkingDirectory, { defaultDirectory: directory })
  await ctx.plugin(SandboxPolicy, { mode: sandboxMode, workspaceRoot: directory })
  const workbenchFiber = ctx.plugin(workbench, configuration)
  await workbenchFiber.inertia
  const session = ctx.sessions.create(SessionId(`research-${Math.random()}`), { meta: { cwd: directory } })
  const { agent, scope } = agentIn(ctx, session)
  const fiber = scope.ctx.plugin(preset)
  await fiber.inertia
  let flushes = 0, failing = false, calls = 0
  const listener = persistence ? ctx.on('session/flush', async () => { flushes++; if (failing) throw new Error('checkpoint failed') }) : () => {}
  ctx.tools.register(defineTool({ name: 'fixture_measure', description: 'Measure a deterministic fixture.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { calls++; return 'sorted=true, n=128, milliseconds=0.25' },
  }))
  const call = (args, name = 'super_research', signal = new AbortController().signal) => ctx.tools.execute({ name, arguments: args, agent, signal, callId: ToolCallId(`call-${Math.random()}`) })
  const state = () => ctx.sessionProjections.stateOf(session, 'superResearch')
  const record = (command, options = {}) => call({ action: 'record', expectedRevision: state().revision, requestId: `request-${Math.random()}`, record: JSON.stringify(command), ...options })
  const user = text => session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  const propose = () => record({ action: 'propose', proposal: { ...proposal, maxToolCalls } })
  const confirm = async () => { const event = user('确认方案'); return record({ action: 'confirm', user: { seq: event.seq, quote: '确认方案' } }) }
  t.after(async () => { listener(); await scope.dispose() })
  return { ctx, session, agent, scope, fiber, workbenchFiber, directory, call, record, state, user, propose, confirm,
    calls: () => calls, flushes: () => flushes, failFlush: value => { failing = value } }
}
