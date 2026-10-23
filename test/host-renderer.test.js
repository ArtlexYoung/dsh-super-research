import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { installedClient } from './host-client.js'
import { chromium } from 'playwright-core'
import { emptyState } from '../src/state.js'
import { proposal } from './helpers.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const visualStudy = { ...emptyState(), status: 'report', revision: 3,
  proposal: { ...proposal, title: '检索策略的准确率与成本比较', question: '在固定语料与评测集上，比较语义检索与融合检索，寻找质量与成本的平衡。', maxToolCalls: 40 },
  workspace: { directory: '/project/.super-research/study-retrieval', settings: { maxEvidence: 0, maxNodes: 1000000000, maxExperiments: 0 } },
  operations: [{ id: 'op1', tool: 'evaluate_retrieval', status: 'completed' }],
  evidence: [
    { id: 'E1', kind: 'source', claim: '固定语料包含 240 个查询，覆盖事实、比较和长尾问题。', quote: 'dataset v3: 240 queries, three strata, frozen split.', ref: 'https://example.org/research/dataset-v3', sourceSeq: 12 },
    { id: 'E2', kind: 'measurement', claim: '融合检索在当前样本上的召回率达到 0.87。', quote: 'hybrid: recall@10=0.87; median_latency=42ms; seed=42', ref: '', sourceSeq: 18 },
    { id: 'E3', kind: 'counterevidence', claim: '长尾查询存在反例，重复片段挤占了候选位置。', quote: 'case-073: duplicate chunks occupy 6/10 results; expected source missing.', ref: '', sourceSeq: 24 },
  ],
  nodes: [
    { id: 'N1', progress: {"stage": "completed", "summary": "评估协议已固定，语料与参考答案可复用。", "nextStep": ""}, title: '明确研究问题与评估协议', parents: [], evidenceIds: ['E1'], status: 'supported', note: '固定语料、查询分层和独立参考答案。' },
    { id: 'N2', progress: {"stage": "completed", "summary": "语义检索基线已跑通，结果已保存。", "nextStep": ""}, title: '建立语义检索基线', parents: ['N1'], evidenceIds: ['E1'], status: 'supported', note: '固定嵌入模型与候选数量，记录基线。' },
    { id: 'N3', progress: {"stage": "active", "summary": "融合检索提高召回，正在核对延迟与去重。", "nextStep": "补充分层延迟与失败样本。"}, title: '引入关键词与语义融合', parents: ['N1'], evidenceIds: ['E2'], status: 'supported', note: '比较融合后的召回率与额外开销。' },
    { id: 'N4', progress: {"stage": "blocked", "summary": "长查询样本不足，稳定性暂不能判断。", "nextStep": "补充独立长查询测试集。"}, title: '核查长查询的稳定性', parents: ['N2'], evidenceIds: [], status: 'inconclusive', note: '样本尚不足，需要补充长查询分层结果。' },
    { id: 'N5', progress: {"stage": "completed", "summary": "重复片段导致候选挤占，已保留反例。", "nextStep": ""}, title: '排查重复片段带来的反例', parents: ['N3'], evidenceIds: ['E3'], status: 'refuted', note: '重复片段会挤占候选位置，保留该负结果。' },
    { id: 'N6', progress: {"stage": "planned", "summary": "去重与重排方案已提出，等待对照验证。", "nextStep": "固定候选数量后运行去重对照。"}, title: '验证去重与候选重排', parents: ['N3'], evidenceIds: ['E2'], status: 'supported', note: '去重策略在固定样本上改善候选覆盖。' },
    { id: 'N7', progress: {"stage": "planned", "summary": "等待上游验证完成后比较整体代价。", "nextStep": "汇总长查询与去重实验结果。"}, title: '比较质量、延迟与成本', parents: ['N4', 'N6'], evidenceIds: ['E2', 'E3'], status: 'open', note: '补充长尾问题后再决定是否推广。' },
  ],
  experiments: [{ id: 'EXP-01', method: '固定语料上的检索策略对照', input: 'dataset v3 · 240 queries · seed 42', protocol: '同一语料、参考答案与 top-k', baseline: '语义检索', candidate: '融合检索', metrics: 'Recall@10 0.87 · 延迟 42ms', status: 'completed', evidenceIds: ['E2'], limits: '尚未覆盖全部长尾查询。' }],
  report: { summary: '融合检索改善候选覆盖，但长尾查询仍有反例，暂不能直接替换线上基线。', text: '# 检索策略的准确率与成本比较\n\n## 研究结论\n\n在固定评测集上，**融合检索具有更好的候选覆盖**，但长尾查询仍存在由重复片段引起的反例。现有结果支持继续验证，不足以直接替换线上基线。\n\n## 方法与证据\n\n本次研究固定语料版本、查询分层与候选数量，分别运行语义检索和融合检索，并保留原始测量与失败样本。\n\n| 策略 | Recall@10 | 中位延迟 | 观察 |\n| --- | --- | --- | --- |\n| 语义检索 | 0.79 | 28 ms | 长尾查询覆盖不足 |\n| 融合检索 | 0.87 | 42 ms | 召回提高，需去重 |\n\n## 反例与下一步\n\n1. **保留负结果**：重复片段在个别查询中挤占候选位置，见 E3。\n2. **补充分层验证**：扩大长查询与低频主题样本。\n3. **控制额外成本**：记录重排开销，再决定候选数量。\n\n> 这些结论来自当前固定样本，不能外推为所有查询上的稳定收益。', limits: '240 个固定查询；未进行线上 A/B 测试，也未验证其他语料与嵌入模型。', evidenceIds: ['E1', 'E2', 'E3'] },
}

test('installed renderer: selector hooks, live updates, dedicated page, composer isolation and native approvals', { timeout: 30000 }, async t => {
  let host
  try { host = await installedClient() }
  catch (error) { if (error.code === 'ENOENT') { t.skip('Set DSH_APP_ASAR to verify the installed host renderer'); return }; throw error }
  const browser = await chromium.launch({ ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}), headless: true })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1160, height: 850 } })
  page.setDefaultTimeout(5000)
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.setContent('<!doctype html><html><head><style>html,body,#root{height:100%;margin:0}*{box-sizing:border-box}</style></head><body><main id="root"></main></body></html>')
  await page.addScriptTag({ content: host.seed })
  await page.evaluate(() => {
    window.modules = new Map()
    const dependencies = window.HostModules
    window.HostTest = { React: dependencies.react, Cordis: dependencies['@deepseek-ai/cordis'] }
    window.__ModuleLoader__ = { load({ id, factory }) {
      window.modules.set(id, factory(name => {
        if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`)
        return dependencies[name]
      }))
    } }
  })
  await page.addScriptTag({ content: host.renderer })
  await page.addScriptTag({ content: await readFile(join(root, 'client/index.js'), 'utf8') })
  await page.evaluate(async state => {
    const { React, Cordis } = window.HostTest, h = React.createElement
    const source = initial => {
      let value = initial
      const listeners = new Set()
      return { getSnapshot: () => value, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
        update(next) { value = next; listeners.forEach(listener => listener()) }, size: () => listeners.size }
    }
    const ctx = window.ctx = new Cordis.Context()
    await ctx.plugin(window.modules.get('@deepseek-ai/dsh-client-ui-renderer')).inertia
    window.study = source(state); window.hostSession = source({ running: false }); window.shell = source({ view: 'dsh-super-research', approval: false, sidebar: false })
    const sessions = new Map()
    window.prompts = []; window.cancelled = []
    const bindingFor = id => {
      if (!sessions.has(id)) sessions.set(id, { session: {
        ...window.hostSession, prompt: async content => {
          window.feedbackAtDispatch = document.querySelector('.sr-send')?.dataset.state
          window.prompts.push({ id, content })
          if (window.deferPrompt) return new Promise(resolve => { window.resolvePrompt = resolve })
          return { ok: true }
        },
        cancel: async () => { window.cancelled.push(id); return { ok: true } },
      } })
      return sessions.get(id)
    }
    const materialize = id => ({ key: id, ctx, hooks: { session: bindingFor(id).session },
      keyedHooks: { projection: key => { if (key !== 'superResearch') throw new Error('Unknown projection'); return window.study } }, props: { sessionId: id } })
    window.current = source(materialize('real-a'))
    window.switchBinding = id => window.current.update(materialize(id))
    // Installed DSH keeps selection in uiSession.adapter.current, outside the catalog.
    window.sessionList = source({ byId: { 'real-a': { projectionValues: { agentPreset: 'super-research' } } } })
    window.selectMode = (id, preset) => {
      window.current.update(materialize(id))
      window.sessionList.update({ byId: { ...window.sessionList.getSnapshot().byId, [id]: { projectionValues: { agentPreset: preset } } } })
    }
    window.switchSession = id => window.selectMode(id, 'super-research')
    ctx.slots.installScope('session', { current: window.current, bindingSource: () => window.current,
      renderArea: (_binding, props) => props.children })
    ctx.slots.register({ name: 'root', children: {
      'conversation.session': { kind: 'single', scope: 'session' },
      'settings.section': { kind: 'list', scope: 'root' },
    } }, ({ SessionProvider, renderSlot }) => h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column' } },
      h(SessionProvider, {}, renderSlot('conversation.session', {}))))
    ctx.slots.register({ name: 'conversation.session', children: {
      'conversation.view': { kind: 'list', scope: 'session' }, 'conversation.composer': { kind: 'chain', scope: 'session' },
      'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
    } }, ({ renderSlot, renderSlotChain }) => {
      const shell = React.useSyncExternalStore(window.shell.subscribe, window.shell.getSnapshot)
      return h('div', { style: { display: 'flex', flex: 1, minHeight: 0 } },
        h('div', { 'data-conversation-scroll': '', style: { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto' } },
          h('div', { 'data-slot': 'conversation.session', style: { display: 'contents' } },
            h('div', { style: { display: 'flex', flexDirection: 'column', flex: '1 0 auto', minHeight: 'auto' } }, renderSlot('conversation.view', {}, { only: shell.view }))),
          h('div', { 'data-composer-seat': '' }, renderSlotChain('conversation.composer', { pending: shell.approval },
            { overlay: true, fallback: h('textarea', { 'aria-label': '宿主聊天输入' }) }))),
        shell.sidebar && h('aside', { style: { width: 340, minHeight: 0 } }, renderSlot('sidebar.right.pane.tab', {}, { entryKey: 'dsh-super-research' })))
    })
    ctx.slots.register({ name: 'conversation.view', id: 'chat' }, () => h('div', null, '原生对话记录'))
    ctx.slots.register({ name: 'conversation.composer', select: props => props.pending ? { approval: true } : null },
      () => h('div', { 'data-conversation-composer-overlay': '' }, h('button', null, '允许本次工具')))
    ctx.provide('sessions', { binding: bindingFor, list: window.sessionList })
    ctx.provide('uiSession', { adapter: { current: window.current } })
    // Match the host's fallback when a registered view disappears.
    ctx.effect(() => ctx.slots.subscribe('conversation.view', () => {
      if (!ctx.slots.entries('conversation.view').some(entry => entry.options.id === window.shell.getSnapshot().view)) {
        window.shell.update({ ...window.shell.getSnapshot(), view: 'chat' })
      }
    }))
    ctx.provide('configForms', { get: () => ({}), whileServed: (_names, start) => start() })
    ctx.provide('sidebarRightTabs', { register: () => () => {} })
    const plugin = window.modules.get('dsh-super-research')
    window.pluginFiber = ctx.plugin(plugin)
    await window.pluginFiber.inertia
    window.shell.update({ ...window.shell.getSnapshot(), view: 'dsh-super-research' })
    window.unmount = ctx.uiRenderer.mount(document.getElementById('root'))
  }, { ...visualStudy,
    report: { summary: '测试仅覆盖固定样本，现有结果不足以推广。', text: '# 研究结论\n\n## 方法与证据\n\n' + '长报告内容。\n\n'.repeat(500), limits: '测试范围', evidenceIds: [] } })
  await page.getByRole('region', { name: '研究工作台', exact: true }).waitFor()
  assert.equal(await page.getByRole('tab', { name: '概览', exact: true }).getAttribute('aria-selected'), 'true')
  assert.equal(await page.locator('.sr-report,.sr-canvas-world,.sr-record-row,.sr-activity').count(), 0)
  assert.ok((await page.locator('.sr-section-summary').innerText()).length < 500)
  assert.equal(await page.getByRole('heading', { name: '研究方法' }).count(), 0)
  await page.getByRole('tab', { name: '报告', exact: true }).click()
  assert.equal(await page.locator('.sr-report').count(), 0)
  await page.locator('.sr-inline-details > summary').getByText('报告全文', { exact: true }).click()
  await page.locator('.sr-report').waitFor()
  assert.equal(await page.getByRole('textbox', { name: '宿主聊天输入' }).isVisible(), false)
  assert.equal(await page.locator('[data-slot-error]').count(), 0)
  const geometry = await page.evaluate(() => {
    const content = document.querySelector('.sr-page-content'), toolbar = document.querySelector('.sr-viewbar').getBoundingClientRect()
    return { compactToolbar: toolbar.height < 75, contentMajority: content.clientHeight > innerHeight * .75, scrolls: content.scrollHeight > content.clientHeight, fits: document.documentElement.scrollHeight <= innerHeight }
  })
  assert.deepEqual(geometry, { compactToolbar: true, contentMajority: true, scrolls: true, fits: true })
  assert.equal(await page.getByText('快捷操作', { exact: true }).count(), 1)
  await page.getByRole('tabpanel').evaluate(element => { element.scrollTop = 800 })
  assert.equal(await page.getByRole('button', { name: '深入完善报告' }).isVisible(), true)
  await page.evaluate(() => { window.deferPrompt = true })
  await page.getByRole('button', { name: '深入完善报告' }).click()
  await page.getByRole('button', { name: '发送中', exact: true }).waitFor()
  await page.waitForFunction(() => window.prompts.length === 1)
  assert.equal(await page.evaluate(() => window.feedbackAtDispatch), 'sending')
  assert.equal(await page.getByRole('button', { name: '发送中', exact: true }).getAttribute('aria-busy'), 'true')
  const contentHeight = await page.locator('.sr-page-content').evaluate(element => element.clientHeight)
  await page.evaluate(() => window.hostSession.update({ running: true }))
  await page.getByRole('button', { name: '停止执行' }).waitFor()
  assert.equal(await page.getByRole('button', { name: '停止执行' }).isEnabled(), true)
  await page.getByRole('button', { name: '停止执行' }).click()
  assert.deepEqual(await page.evaluate(() => window.cancelled), ['real-a'])
  await page.evaluate(() => { window.resolvePrompt({ ok: true }); window.deferPrompt = false; window.hostSession.update({ running: false }) })
  await page.waitForFunction(() => document.querySelector('.sr-send')?.dataset.state === 'idle')
  assert.equal(await page.locator('.sr-controls [role=status],.sr-controls [role=alert]').count(), 0)
  assert.equal(await page.locator('.sr-page-content').evaluate(element => element.clientHeight), contentHeight)
  await page.evaluate(() => window.study.update({ ...window.study.getSnapshot(), revision: 4 }))
  await page.getByTitle('当前会话 · 修订 4', { exact: true }).waitFor()
  await page.evaluate(() => window.shell.update({ ...window.shell.getSnapshot(), approval: true }))
  await page.getByRole('button', { name: '允许本次工具' }).waitFor()
  assert.equal(await page.getByRole('textbox', { name: '宿主聊天输入' }).isVisible(), false)
  const out = join(root, '.development/v0.1.8/browser')
  await mkdir(out, { recursive: true })
  await page.evaluate(value => { window.hostSession.update({ running: false }); window.study.update({ ...value, revision: 4 }) }, visualStudy)
  await page.locator('.sr-report h1').getByText('检索策略的准确率与成本比较', { exact: true }).waitFor()
  assert.equal(await page.locator('.sr-report table tbody tr').count(), 2)
  await page.getByRole('complementary', { name: '报告目录' }).waitFor()
  await page.getByRole('tabpanel').evaluate(element => { element.scrollTop = 0 })
  await page.evaluate(() => window.shell.update({ ...window.shell.getSnapshot(), approval: false }))
  await page.screenshot({ path: join(out, 'installed-renderer-page.png') })
  await page.locator('.sr-inline-details > summary').getByText('报告全文', { exact: true }).click()
  await page.locator('.sr-report').waitFor({ state: 'detached' })
  assert.equal(await page.locator('.sr-report,.sr-outline').count(), 0)
  assert.equal(await page.locator('.sr-conclusion').innerText(), visualStudy.report.summary)
  await page.screenshot({ path: join(out, 'report-brief.png') })
  await page.getByRole('tab', { name: '概览', exact: true }).click()
  await page.screenshot({ path: join(out, 'overview-brief.png') })
  await page.setViewportSize({ width: 360, height: 850 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight), true)
  await page.screenshot({ path: join(out, 'overview-brief-narrow.png') })
  await page.setViewportSize({ width: 1160, height: 600 })
  assert.equal(await page.locator('.sr-inline-details > summary').getByText('研究方案', { exact: true }).evaluate(element => {
    const rect = element.getBoundingClientRect(), panel = element.closest('[role=tabpanel]').getBoundingClientRect()
    return rect.top >= panel.top && rect.bottom <= panel.bottom
  }), true)
  await page.screenshot({ path: join(out, 'overview-brief-short.png') })
  await page.evaluate(() => window.study.update({ ...window.study.getSnapshot(), status: 'running' }))
  await page.getByText('上一版结论', { exact: true }).waitFor()
  await page.evaluate(() => window.study.update({ ...window.study.getSnapshot(), status: 'report' }))
  await page.setViewportSize({ width: 1160, height: 850 })
  await page.getByRole('tab', { name: '探索', exact: true }).click()
  assert.equal(await page.locator('.sr-brief').count(), 0)
  assert.equal(await page.getByRole('button', { name: /查看探索图|返回摘要/ }).count(), 0)
  assert.equal(await page.locator('.sr-canvas-node').count(), 7)
  assert.equal(await page.locator('.sr-edge').count(), 7)
  assert.equal(await page.locator('.sr-board-lane').count(), 4)
  await page.getByText('已完成 3 / 7 项', { exact: true }).waitFor()
  assert.equal(await page.locator('.sr-canvas-node[data-stage=blocked]').count(), 1)
  assert.equal(await page.locator('.sr-canvas-node[data-stage=planned]').count(), 2)
  assert.equal(await page.locator('.sr-canvas-node[data-stage=completed][data-node-status=refuted]').count(), 1)
  const beforeZoom = await page.locator('.sr-canvas-world').getAttribute('style')
  await page.getByRole('button', { name: '放大探索图', exact: true }).click()
  assert.notEqual(await page.locator('.sr-canvas-world').getAttribute('style'), beforeZoom)
  const canvas = await page.getByLabel('可拖动缩放的探索画布', { exact: true }).boundingBox()
  const beforePan = await page.locator('.sr-canvas-world').getAttribute('style')
  await page.mouse.move(canvas.x + 20, canvas.y + 35)
  await page.mouse.down(); await page.mouse.move(canvas.x + 75, canvas.y + 65); await page.mouse.up()
  assert.notEqual(await page.locator('.sr-canvas-world').getAttribute('style'), beforePan)
  const readCamera = () => page.locator('.sr-canvas-world').evaluate(element => {
    const transform = new DOMMatrixReadOnly(getComputedStyle(element).transform)
    return { scale: transform.a, x: transform.e, y: transform.f }
  })
  const anchor = { x: Math.round(canvas.x + canvas.width * .35) - canvas.x, y: Math.round(canvas.y + canvas.height * .4) - canvas.y }
  const beforeWheel = await readCamera()
  await page.mouse.move(canvas.x + anchor.x, canvas.y + anchor.y)
  await page.mouse.wheel(0, -120)
  await page.waitForFunction(value => new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.sr-canvas-world')).transform).a > value, beforeWheel.scale)
  const wheelIn = await readCamera()
  assert.ok(Math.abs((anchor.x - beforeWheel.x) / beforeWheel.scale - (anchor.x - wheelIn.x) / wheelIn.scale) < .01, JSON.stringify({ anchor, beforeWheel, wheelIn }))
  assert.ok(Math.abs((anchor.y - beforeWheel.y) / beforeWheel.scale - (anchor.y - wheelIn.y) / wheelIn.scale) < .01, JSON.stringify({ anchor, beforeWheel, wheelIn }))
  await page.mouse.wheel(0, 120)
  await page.waitForFunction(value => new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.sr-canvas-world')).transform).a < value, wheelIn.scale)
  assert.ok(Math.abs((await readCamera()).scale - beforeWheel.scale) < .0001)
  const wheelLimit = async deltaY => {
    await page.getByLabel('可拖动缩放的探索画布', { exact: true }).evaluate((element, delta) => {
      for (let i = 0; i < 40; i++) element.dispatchEvent(new WheelEvent('wheel', { deltaY: delta, deltaMode: i % 3, bubbles: true, cancelable: true }))
    }, deltaY)
  }
  await wheelLimit(-1000)
  assert.equal((await readCamera()).scale, 2)
  await wheelLimit(1000)
  assert.equal((await readCamera()).scale, .25)
  assert.equal(await page.getByRole('tabpanel').evaluate(element => element.scrollTop), 0)
  await page.getByRole('button', { name: '适应画布', exact: true }).click()
  await page.screenshot({ path: join(out, 'exploration-canvas.png') })
  await page.locator('.sr-canvas-node').filter({ hasText: '排查重复片段带来的反例' }).click()
  await page.getByRole('complementary', { name: '节点详情' }).waitFor()
  await page.getByText('case-073: duplicate chunks occupy 6/10 results; expected source missing.', { exact: true }).waitFor()
  await page.waitForFunction(() => {
    const card = document.querySelector('.sr-canvas-node[aria-pressed=true]').getBoundingClientRect()
    const view = document.querySelector('.sr-canvas').getBoundingClientRect()
    return card.left >= view.left && card.right <= view.right && card.top >= view.top && card.bottom <= view.bottom
  })
  await page.screenshot({ path: join(out, 'node-inspector.png') })
  assert.equal(await page.locator('.sr-edge[data-focus=related]').count(), 1)
  assert.ok(await page.locator('.sr-edge[data-focus=muted]').count() > 0)
  const cameraBeforeProgress = await readCamera()
  await page.evaluate(() => window.study.update({ ...window.study.getSnapshot(), nodes: window.study.getSnapshot().nodes.map(node => node.id === 'N3'
    ? { ...node, progress: { stage: 'completed', summary: '融合检索对照已完成，保留额外延迟的限制。', nextStep: '' } } : node) }))
  await page.getByText('已完成 4 / 7 项', { exact: true }).waitFor()
  assert.equal(await page.locator('.sr-canvas-node[data-stage=completed]').count(), 4)
  assert.equal(await page.locator('.sr-canvas-node[aria-pressed=true]').count(), 1)
  assert.deepEqual(await readCamera(), cameraBeforeProgress)
  assert.equal(await page.locator('.sr-edge').count(), 7)
  await page.evaluate(() => window.study.update({ ...window.study.getSnapshot(), nodes: window.study.getSnapshot().nodes.map(node => node.id === 'N5'
    ? { ...node, progress: { stage: 'blocked', summary: '复核反例所用输入，等待补充样本。', nextStep: '补充样本后重查反例。' } } : node) }))
  await page.locator('.sr-canvas-node[data-stage=blocked][aria-pressed=true]').waitFor()
  await page.setViewportSize({ width: 1100, height: 850 })
  await page.waitForFunction(() => {
    const card = document.querySelector('.sr-canvas-node[aria-pressed=true]').getBoundingClientRect()
    const view = document.querySelector('.sr-canvas').getBoundingClientRect()
    return card.left >= view.left && card.right <= view.right && card.top >= view.top && card.bottom <= view.bottom
  })
  await page.setViewportSize({ width: 1160, height: 850 })
  await page.getByRole('button', { name: '关闭节点详情' }).click()
  await page.getByRole('tab', { name: /^证据/ }).click()
  assert.equal(await page.locator('.sr-brief').count(), 0)
  assert.equal(await page.locator('.sr-record-row').count(), 3)
  await page.getByRole('textbox', { name: '搜索证据' }).fill('反例')
  assert.equal(await page.locator('.sr-record-row').count(), 1)
  await page.locator('.sr-record-row summary').click()
  await page.getByText('case-073: duplicate chunks occupy 6/10 results; expected source missing.', { exact: true }).waitFor()
  await page.getByRole('textbox', { name: '搜索证据' }).fill('')
  await page.getByRole('combobox', { name: '证据类型' }).selectOption('measurement')
  assert.equal(await page.locator('.sr-record-row').count(), 1)
  await page.getByRole('combobox', { name: '证据类型' }).selectOption('all')
  await page.screenshot({ path: join(out, 'evidence-register.png') })
  await page.getByRole('tab', { name: /^实验/ }).click()
  assert.equal(await page.locator('.sr-brief').count(), 0)
  assert.equal(await page.locator('.sr-record-row').count(), 1)
  await page.getByRole('textbox', { name: '搜索实验' }).fill('不存在的实验')
  await page.getByText('没有匹配记录，试试其他关键词。').waitFor()
  await page.evaluate(() => window.study.update({ ...window.study.getSnapshot(), experiments: [] }))
  await page.getByText('暂无实验记录。验证方法、基线和测量结果会保留在这里。', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '查看实验记录' }).count(), 0)
  await page.getByRole('tab', { name: '报告', exact: true }).click()
  assert.equal(await page.locator('.sr-report').count(), 0)
  await page.evaluate(() => {
    const { summary, ...historicalReport } = window.study.getSnapshot().report
    window.study.update({ ...window.study.getSnapshot(), report: historicalReport })
  })
  await page.getByText('旧报告未附简要总结，可展开报告全文。', { exact: true }).waitFor()
  await page.locator('.sr-inline-details > summary').getByText('报告全文', { exact: true }).click()
  await page.locator('.sr-report').waitFor()
  await page.evaluate(() => window.study.update({ ...window.study.getSnapshot(), report: { ...window.study.getSnapshot().report, summary: '更新后的总结：仍需核查长尾查询。', text: '# 检查\n\n<script>window.untrustedRan=true</script>\n\n[危险链接](javascript:alert(1))\n\n```text\n<em>literal</em>\n```' } }))
  await page.getByText('更新后的总结：仍需核查长尾查询。', { exact: true }).waitFor()
  await page.locator('.sr-report h1').getByText('检查', { exact: true }).waitFor()
  assert.equal(await page.locator('.sr-report script,.sr-report a[href^="javascript:"]').count(), 0)
  assert.equal(await page.evaluate(() => !!window.untrustedRan), false)
  await page.evaluate(value => window.study.update({ ...value, revision: 4 }), visualStudy)
  await page.evaluate(() => { window.hostSession.update({ running: false }); window.shell.update({ view: 'chat', approval: false, sidebar: true }) })
  await page.getByText('原生对话记录').waitFor()
  assert.equal(await page.getByRole('textbox', { name: '宿主聊天输入' }).isVisible(), true)
  assert.equal(await page.locator('.sr-compact').count(), 1)
  assert.equal(await page.locator('[data-super-research-page]').count(), 0)
  await page.getByRole('button', { name: '深入完善报告' }).click()
  await page.waitForFunction(() => window.prompts.at(-1).id === 'real-a' && window.prompts.length === 2)
  assert.equal(await page.evaluate(() => window.prompts.at(-1).id), 'real-a')
  await page.evaluate(() => window.switchSession('real-b'))
  await page.getByRole('textbox', { name: '补充要求或修改方向' }).fill('补充验证')
  await page.getByRole('button', { name: '发送要求' }).click()
  await page.waitForFunction(() => window.prompts.at(-1).id === 'real-b')
  assert.equal(await page.evaluate(() => window.prompts.at(-1).id), 'real-b')
  await page.evaluate(() => window.shell.update({ view: 'dsh-super-research', approval: false, sidebar: true }))
  await page.getByRole('region', { name: '研究工作台', exact: true }).waitFor()
  assert.equal(await page.locator('.sr-compact').count(), 1)
  assert.equal(await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map(element => element.id)
    return new Set(ids).size === ids.length
  }), true)
  await page.evaluate(() => window.shell.update({ ...window.shell.getSnapshot(), sidebar: false }))
  const viewIdentity = await page.evaluate(() => {
    window.researchEntry = window.ctx.slots.entries('conversation.view').find(entry => entry.options.id === 'dsh-super-research')
    window.sessionList.update({ ...window.sessionList.getSnapshot() })
    return window.researchEntry === window.ctx.slots.entries('conversation.view').find(entry => entry.options.id === 'dsh-super-research')
  })
  assert.equal(viewIdentity, true)
  await page.evaluate(() => window.selectMode('plain-session', 'standard'))
  await page.getByText('原生对话记录').waitFor()
  assert.equal(await page.locator('[data-super-research-page]').count(), 0)
  assert.equal(await page.getByRole('textbox', { name: '宿主聊天输入' }).isVisible(), true)
  assert.equal(await page.evaluate(() => window.ctx.slots.entries('conversation.view').some(entry => entry.options.id === 'dsh-super-research')), false)
  // Selection alone must update availability even when the catalog doesn't change.
  await page.evaluate(() => window.switchBinding('real-b'))
  assert.equal(await page.evaluate(() => window.ctx.slots.entries('conversation.view').some(entry => entry.options.id === 'dsh-super-research')), true)
  await page.evaluate(() => window.switchBinding('plain-session'))
  assert.equal(await page.evaluate(() => window.ctx.slots.entries('conversation.view').some(entry => entry.options.id === 'dsh-super-research')), false)
  await page.evaluate(() => {
    window.study.update({ ...window.study.getSnapshot(), status: 'empty', proposal: null, report: null, nodes: [], evidence: [], experiments: [] })
    window.selectMode('blank-research', 'super-research')
    window.shell.update({ ...window.shell.getSnapshot(), view: 'dsh-super-research' })
  })
  await page.getByText('从一个值得追问的问题开始').waitFor()
  await page.evaluate(value => {
    window.selectMode('unresolved-session', undefined)
    window.study.update(value)
  }, visualStudy)
  assert.equal(await page.evaluate(() => window.ctx.slots.entries('conversation.view').some(entry => entry.options.id === 'dsh-super-research')), false)
  await page.evaluate(() => {
    window.switchSession('real-b')
    window.shell.update({ ...window.shell.getSnapshot(), view: 'dsh-super-research' })
  })
  await page.getByRole('tab', { name: '探索', exact: true }).click()
  await page.evaluate(() => window.study.update({ ...window.study.getSnapshot(), nodes: window.study.getSnapshot().nodes.map(({ progress, ...node }) => node) }))
  await page.getByText('旧记录未标注执行进度，保留原有验证结果。', { exact: true }).waitFor()
  assert.equal(await page.locator('.sr-board-lane[data-stage=untracked]').count(), 1)
  assert.equal(await page.locator('.sr-canvas-node[data-stage=completed]').count(), 0)
  await page.screenshot({ path: join(out, 'legacy-board.png') })
  await page.evaluate(() => window.study.update({ ...window.study.getSnapshot(), nodes: [] }))
  await page.getByText('暂无探索方案。研究中的候选方案与验证任务会在这里按进度展示，并保留依赖连线。', { exact: true }).waitFor()
  assert.equal(await page.locator('.sr-canvas-node,.sr-node-inspector').count(), 0)
  await page.evaluate(value => window.study.update(value), visualStudy)
  await page.getByText('已完成 3 / 7 项', { exact: true }).waitFor()
  await page.evaluate(() => {
    document.body.style.setProperty('--dsw-alias-bg-layer-1', '#181b20')
    document.body.style.setProperty('--dsw-alias-label-primary', '#e2e5eb')
    document.body.style.setProperty('--dsw-alias-label-tertiary', '#949ba8')
    document.body.style.setProperty('--dsw-alias-border-l3', '#343a45')
  })
  await page.screenshot({ path: join(out, 'exploration-dark.png') })
  await page.setViewportSize({ width: 1160, height: 600 })
  const short = await page.evaluate(() => ({ content: document.querySelector('.sr-page-content').clientHeight,
    dock: document.querySelector('.sr-dock').clientHeight, fits: document.documentElement.scrollHeight <= innerHeight }))
  assert.ok(short.content >= 420, JSON.stringify(short))
  assert.equal(short.fits, true)
  await page.screenshot({ path: join(out, 'exploration-short.png') })
  await page.setViewportSize({ width: 360, height: 850 })
  await page.screenshot({ path: join(out, 'installed-renderer-narrow-readable.png') })
  await page.getByRole('button', { name: '适应画布', exact: true }).click()
  await page.screenshot({ path: join(out, 'installed-renderer-narrow.png') })
  const narrow = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
    overflowing: [...document.querySelectorAll('body *')].filter(element => { const rect = element.getBoundingClientRect(); return rect.right > innerWidth && getComputedStyle(element).position !== 'absolute' }).map(element => ({ tag: element.tagName, className: String(element.className), width: element.getBoundingClientRect().width })).slice(0, 12) }))
  assert.equal(narrow.scrollWidth <= narrow.width && narrow.scrollHeight <= narrow.height, true, JSON.stringify(narrow))
  await page.evaluate(async () => { window.unmount(); await window.ctx.fiber.dispose() })
  assert.equal(await page.evaluate(() => window.study.size() + window.hostSession.size() + window.current.size() + window.sessionList.size()), 0)
  assert.deepEqual(errors, [])
  await writeFile(join(out, 'installed-renderer-result.json'), JSON.stringify({ geometry, errors,
    checked: ['actual rc.2 renderer and Markdown singletons', 'single toolbar and independent report scrolling', 'hybrid board lanes and dependency links', 'live progress moves keep camera and selection', 'completion separate from validation outcome', 'historical untracked progress and empty board', 'selected plan visible in resized viewport', 'direct graph and section-specific registries', 'model summary instead of report excerpt', 'historical missing summary and live update preserving expanded report', 'sending feedback before host admission', 'stop available while prompt pending', 'no success text/layout shift', 'rendered Markdown table and outline', 'untrusted report text', 'wheel pointer anchoring/limits/no page scroll', 'graph pan/zoom/fit and node evidence', 'evidence query and kind filters', 'empty experiment search', 'fallback composer isolation', 'native approval retained', 'compact sidebar with chat composer', 'mode-specific tab and blank research session', 'no registration churn', 'session switch', 'unique page/sidebar IDs', 'dark theme and short/360px viewport', 'subscription teardown'] }, null, 2))
})
