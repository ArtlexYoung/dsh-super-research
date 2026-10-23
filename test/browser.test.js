import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { installedClient } from './host-client.js'
import { chromium } from 'playwright-core'
import { emptyState } from '../src/state.js'
import { proposal } from './helpers.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const browserPath = process.env.BROWSER_EXECUTABLE

test('browser: native registration, view navigation, session changes, provenance, theme and teardown', { timeout: 30000 }, async t => {
  const out = join(root, '.development/v0.1.8/browser')
  await mkdir(out, { recursive: true })
  const host = await installedClient()
  let browser
  try { browser = await chromium.launch({ ...(browserPath ? { executablePath: browserPath } : {}), headless: true }) }
  catch (error) {
    if (!browserPath && /Executable doesn't exist/.test(error.message)) { t.skip('Install Chromium or set BROWSER_EXECUTABLE'); return }
    throw error
  }
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 480, height: 950 } })
  page.setDefaultTimeout(5000)
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  await page.setContent('<!doctype html><html lang="zh-CN"><head><style>html,body,#root{height:100%;margin:0}body{background:var(--dsw-alias-bg-layer-1,#fff)}</style></head><body><main id="root"></main></body></html>')
  await page.addScriptTag({ content: host.seed })
  await page.evaluate(() => { window.TestReact = { React: window.HostModules.react, createRoot: window.HostModules['react-dom/client'].createRoot, flushSync: window.HostModules['react-dom'].flushSync } })
  await page.evaluate(() => {
    window.__ModuleLoader__ = { load({ factory }) { window.plugin = factory(name => {
      if (name in window.HostModules) return window.HostModules[name]
      throw new Error(`Unexpected client import: ${name}`)
    }) } }
  })
  await page.addScriptTag({ content: await readFile(join(root, 'client/index.js'), 'utf8') })
  await page.evaluate(() => {
    window.disposers = []; window.types = new Map(); window.bodies = new Map()
    window.settingsPages = new Map(); window.views = new Map(); window.viewDefinitions = new Map(); window.promptLog = []; window.cancelLog = []; window.bindings = new Map(); window.hostSnapshot = { running: false }
    window.settingSnapshot = { status: 'ready', value: { outputDirectory: '.super-research', maxToolCalls: 40, maxEvidence: 64, maxNodes: 48, maxExperiments: 24 }, revision: 1, writable: true }
    window.settingListeners = new Set(); window.savedSettings = []
    window.settingScope = {
      getSnapshot: () => window.settingSnapshot,
      subscribe(listener) { window.settingListeners.add(listener); return () => window.settingListeners.delete(listener) },
      async mutate(ops, revision) {
        window.savedSettings.push({ ops, revision })
        if (window.settingFailure) throw new Error('offline')
        if (revision !== window.settingSnapshot.revision) return false
        window.settingSnapshot = { ...window.settingSnapshot, value: Object.fromEntries(ops.map(op => [op.path[0], op.value])), revision: revision + 1 }
        window.settingListeners.forEach(listener => listener()); return true
      },
    }
    window.sessionBinding = id => {
      if (!window.bindings.has(id)) window.bindings.set(id, { session: {
        getSnapshot: () => window.hostSnapshot,
        async prompt(content, mode) { window.promptLog.push({ sessionId: id, content, mode }); if (window.deferPrompt) return new Promise(resolve => { window.resolvePrompt = resolve }); return { ok: !window.promptFailure } },
        async cancel() { window.cancelLog.push(id); return { ok: true } },
      } })
      return window.bindings.get(id)
    }
    window.sessionList = { byId: { 'study-a': { projectionValues: { agentPreset: 'super-research' } } } }
    window.currentSession = { key: 'study-a' }
    window.listListeners = new Set(); window.currentListeners = new Set()
    window.selectMode = (id, preset) => {
      window.currentSession = { key: id }; window.currentListeners.forEach(listener => listener())
      window.sessionList = { byId: { ...window.sessionList.byId, [id]: { projectionValues: { agentPreset: preset } } } }
      window.listListeners.forEach(listener => listener())
    }
    const ctx = {
      uiSession: { adapter: { current: { getSnapshot: () => window.currentSession,
        subscribe(listener) { window.currentListeners.add(listener); return () => window.currentListeners.delete(listener) } } } },
      sessions: { binding: id => window.sessionBinding(id), list: { getSnapshot: () => window.sessionList,
        subscribe(listener) { window.listListeners.add(listener); return () => window.listListeners.delete(listener) } } },
      effect(start) { const remove = start(); window.disposers.push(remove); return remove },
      configForms: { get() { return window.settingScope }, whileServed(_names, start) { start(); return () => {} } },
      sidebarRightTabs: { register(definition) { window.types.set(definition.id, definition); return () => window.types.delete(definition.id) } },
      slots: { inject(_name, start) { window.disposers.push(start()) },
        register(definition, component) {
          const map = definition.name === 'settings.section' ? window.settingsPages : definition.name === 'conversation.view' ? window.views : window.bodies
          if (definition.name === 'conversation.view') window.viewDefinitions.set(definition.id, definition)
          const key = definition.key || definition.id; map.set(key, component); return () => map.delete(key)
        } },
    }
    window.plugin.apply(ctx)
    const { React, createRoot } = window.TestReact
    const Component = window.bodies.get('dsh-super-research')
    window.root = createRoot(document.getElementById('root'))
    window.renderResearch = (value, sessionId = 'study-a') => {
      window.stateValue = value
      window.TestReact.flushSync(() => window.root.render(React.createElement(Component, { useProjection: (key, selector) => { if (key !== 'superResearch' || typeof selector !== 'function') throw new Error('Projection requires key and selector'); return selector(value) }, useSession: selector => { if (typeof selector !== 'function') throw new Error('Session requires selector'); return selector(window.hostSnapshot) }, sessionId, ...window.viewDefinitions.get('dsh-super-research').inject(sessionId) })))
    }
  })
  const clickAndSend = async name => {
    const previous = await page.evaluate(() => window.promptLog.length)
    await page.getByRole('button', { name, exact: true }).click()
    await page.waitForFunction(count => window.promptLog.length === count + 1, previous)
    await page.waitForFunction(() => document.querySelector('.sr-send')?.dataset.state === 'idle')
  }
  assert.equal(await page.evaluate(() => window.types.get('dsh-super-research').guide[0].title()), 'Super Research')
  assert.equal(await page.evaluate(() => window.views.has('dsh-super-research')), true)
  await page.evaluate(() => window.selectMode('plain', 'standard'))
  assert.equal(await page.evaluate(() => window.views.has('dsh-super-research')), false)
  await page.evaluate(() => window.selectMode('unknown', undefined))
  assert.equal(await page.evaluate(() => window.views.has('dsh-super-research')), false)
  await page.evaluate(() => window.selectMode('study-a', 'super-research'))
  await page.evaluate(state => window.renderResearch(state), emptyState())
  await page.getByText('从一个值得追问的问题开始').waitFor()
  await page.getByText('无需特定关键词。只打开此工作台不会切换当前会话的模式。').waitFor()
  await page.screenshot({ path: join(out, 'welcome.png') })
  const state = { ...emptyState(), status: 'proposed', proposal, proposalRevision: 2, revision: 2,
    workspace: { directory: '/project/.super-research/study-a' } }
  await page.evaluate(value => window.renderResearch(value), state)
  await page.getByText('尚未形成研究结论。', { exact: true }).waitFor()
  assert.equal(await page.getByRole('heading', { name: '研究方法' }).count(), 0)
  assert.equal(await page.getByText('/project/.super-research/study-a', { exact: true }).count(), 0)
  await page.locator('.sr-inline-details > summary').getByText('研究方案', { exact: true }).click()
  await page.getByRole('heading', { name: '研究方法' }).waitFor()
  await page.locator('.sr-inline-details > summary').getByText('研究产物', { exact: true }).click()
  await page.getByText('/project/.super-research/study-a', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.viewDefinitions.get('dsh-super-research').label()), '研究实验')
  await clickAndSend('确认并开始')
  assert.equal(await page.locator('.sr-controls [role=status]').count(), 0)
  assert.deepEqual(await page.evaluate(() => window.promptLog.map(item => ({ id: item.sessionId, mode: item.mode }))), [{ id: 'study-a', mode: 'queue' }])
  await page.screenshot({ path: join(out, 'proposal.png') })
  await page.locator('.sr-inline-details > summary').getByText('研究方案', { exact: true }).click()
  await page.locator('.sr-inline-details > summary').getByText('研究产物', { exact: true }).click()
  const completed = { ...state, status: 'report', evidence: [
    { id: 'e1', kind: 'measurement', claim: '固定输入通过验证', sourceSeq: 15, quote: 'sorted=true, n=128', ref: 'https://example.org/results' },
    { id: 'e2', kind: 'counterevidence', claim: '重复元素场景存在反例', sourceSeq: 19, quote: '[2, 2, 1] produced a mismatch', ref: '' },
  ], nodes: [
    { id: 'n1', title: '排序正确性', parents: [], evidenceIds: ['e1'], status: 'supported', note: '固定输入符合参考结果。' },
    { id: 'n2', title: '重复元素的反例', parents: ['n1'], evidenceIds: ['e2'], status: 'refuted', note: '保留负结果，进一步核查稳定性。' },
  ], operations: [{ id: 'op1', tool: 'bash', status: 'completed' }],
  experiments: [{ id: 'run1', method: 'python compare.py --seed 42', input: 'seed 42; deterministic fixture', protocol: 'fixed inputs and reference oracle',
    baseline: 'reference sort', candidate: 'candidate A', metrics: '128 cases', status: 'inconclusive', evidenceIds: ['e1', 'e2'], limits: '存在反例，不可宣称全面正确。' }],
  report: { summary: '排序策略在固定输入上通过，但重复元素有反例；目前不能认定全面正确。', text: '固定输入通过，但重复元素存在反例 [e2]。\n结论保留不确定性。', evidenceIds: ['e1', 'e2'], limits: '尚未完成全面基准。' } }
  await page.evaluate(value => window.renderResearch(value), completed)
  await page.getByRole('tab', { name: '探索' }).click()
  await page.getByRole('img', { name: '从上到下展示假设及其依赖关系' }).waitFor()
  assert.equal(await page.locator('svg path').count(), 1)
  await page.getByRole('button', { name: '查看证据 · e2' }).click()
  await page.getByText('[2, 2, 1] produced a mismatch').waitFor()
  await page.screenshot({ path: join(out, 'exploration.png') })
  await page.getByRole('tab', { name: '证据', exact: true }).click()
  assert.equal(await page.locator('.sr-record-row').count(), 2)
  await page.locator('.sr-record-row summary').first().click()
  assert.equal(await page.locator('a[href="https://example.org/results"]').count(), 1)
  assert.equal(await page.getByText('原始会话事件 #15', { exact: true }).count(), 1)
  await page.getByRole('tab', { name: '实验', exact: true }).click()
  await page.locator('.sr-record-row summary').click()
  await page.locator('.sr-record-detail pre').filter({ hasText: 'python compare.py --seed 42' }).waitFor()
  await page.getByRole('tab', { name: '报告', exact: true }).click()
  assert.equal(await page.locator('.sr-report').count(), 0)
  await page.getByText('排序策略在固定输入上通过，但重复元素有反例；目前不能认定全面正确。', { exact: true }).waitFor()
  await page.locator('.sr-inline-details > summary').getByText('报告全文', { exact: true }).click()
  await page.screenshot({ path: join(out, 'report.png') })
  await clickAndSend('深入完善报告')
  assert.match(await page.evaluate(() => window.promptLog.at(-1).content[0].text), /补充证据/)
  await page.getByRole('textbox', { name: '补充要求或修改方向' }).fill('请增加边界情况实验，完善第二节。')
  await clickAndSend('发送要求')
  assert.equal(await page.evaluate(() => window.promptLog.at(-1).content[0].text), '请增加边界情况实验，完善第二节。')
  await clickAndSend('接受报告')
  assert.equal(await page.evaluate(() => window.promptLog.at(-1).content[0].text), '接受当前研究报告。')
  await clickAndSend('应用设置中的上限')
  assert.match(await page.evaluate(() => window.promptLog.at(-1).content[0].text), /只调整上限/)
  await page.evaluate(() => { window.hostSnapshot = { running: true }; window.renderResearch(window.stateValue) })
  assert.equal(await page.getByRole('button', { name: '深入完善报告' }).isDisabled(), true)
  await page.getByRole('button', { name: '停止执行' }).click()
  assert.deepEqual(await page.evaluate(() => window.cancelLog), ['study-a'])
  await page.evaluate(() => { window.hostSnapshot = { running: false }; window.promptFailure = true; window.renderResearch(window.stateValue) })
  await page.getByRole('button', { name: '深入完善报告' }).click()
  await page.getByText('发送失败，请检查会话连接后重试。').waitFor()
  await page.evaluate(() => { window.promptFailure = false; window.deferPrompt = true })
  await page.evaluate(() => { const button = [...document.querySelectorAll('button')].find(item => item.textContent === '深入完善报告'); button.click(); button.click() })
  await page.waitForFunction(() => typeof window.resolvePrompt === 'function')
  const pendingCount = await page.evaluate(() => window.promptLog.length)
  assert.equal(await page.evaluate(async () => {
    const actions = window.viewDefinitions.get('dsh-super-research').inject('study-a')
    try { await actions.sendResearch('duplicate from another pane'); return false } catch { return true }
  }), true)

  assert.equal(await page.getByRole('button', { name: '深入完善报告' }).isDisabled(), true)
  await page.evaluate(() => { window.resolvePrompt({ ok: true }); window.deferPrompt = false })
  await page.waitForFunction(() => document.querySelector('.sr-send')?.dataset.state === 'idle')
  assert.equal(await page.locator('.sr-controls [role=status]').count(), 0)
  assert.equal(await page.evaluate(() => window.promptLog.length), pendingCount)
  await page.getByRole('tab', { name: '报告', exact: true }).press('Home')
  await page.getByRole('tab', { name: '概览' }).waitFor({ state: 'visible' })
  assert.equal(await page.getByRole('tab', { name: '概览' }).getAttribute('aria-selected'), 'true')
  await page.evaluate(() => {
    document.body.style.setProperty('--dsw-alias-bg-layer-1', '#202522')
    document.body.style.setProperty('--dsw-alias-label-primary', '#e1e7e2')
    document.body.style.setProperty('--dsw-alias-label-tertiary', '#a2b0a6')
    document.body.style.setProperty('--dsw-alias-border-l3', '#3b4740')
  })
  await page.screenshot({ path: join(out, 'dark.png') })
  for (const width of [360, 480, 900]) {
    await page.setViewportSize({ width, height: 950 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  }
  await page.getByRole('tab', { name: '报告', exact: true }).click()
  await page.evaluate(value => window.renderResearch(value, 'study-b'), { ...emptyState(), status: 'running', proposal, revision: 1 })
  await page.getByText('研究进行中，正在收集资料与验证。', { exact: true }).waitFor()
  assert.equal(await page.getByRole('heading', { name: '研究方法' }).count(), 0)
  assert.equal(await page.getByText('原始会话事件 #15', { exact: true }).count(), 0)
  await page.getByRole('textbox', { name: '补充要求或修改方向' }).fill('研究会话 B 的边界情况')
  await clickAndSend('发送要求')
  assert.equal(await page.evaluate(() => window.promptLog.at(-1).sessionId), 'study-b')
  const stale = await page.evaluate(async () => {
    const actions = window.viewDefinitions.get('dsh-super-research').inject('study-c')
    window.bindings.delete('study-c')
    try { await actions.sendResearch('stale'); return false } catch { return true }
  })
  assert.equal(stale, true)
  assert.equal(await page.evaluate(() => window.plugin.safeUrl('javascript:alert(1)')), '')
  await page.evaluate(() => {
    const Card = window.settingsPages.get('super-research')
    window.root.render(window.TestReact.React.createElement(Card, { view: 'page', scope: window.settingScope }))
  })
  await page.getByRole('textbox', { name: '项目内产物目录' }).waitFor()
  await page.getByRole('textbox', { name: '项目内产物目录' }).fill('../src')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByText('目录须为项目内的单个目录名；上限须为非负整数，0 表示无限制。').waitFor()
  assert.equal(await page.evaluate(() => window.savedSettings.length), 0)
  await page.getByRole('textbox', { name: '项目内产物目录' }).fill('.studies')
  await page.getByRole('spinbutton', { name: '工具调用上限' }).fill('12')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByText('已保存。新研究自动使用；已有研究可在“研究实验”页应用这些上限。').waitFor()
  assert.equal(await page.evaluate(() => window.settingSnapshot.value.maxToolCalls), 12)
  await page.getByRole('spinbutton', { name: '证据数量上限', exact: true }).fill('1000000000')
  await page.getByRole('button', { name: '工具调用上限设为无限制', exact: true }).click()
  await page.getByRole('button', { name: '探索节点上限设为无限制', exact: true }).click()
  await page.getByRole('button', { name: '实验数量上限设为无限制', exact: true }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByText('已保存。新研究自动使用；已有研究可在“研究实验”页应用这些上限。').waitFor()
  assert.deepEqual(await page.evaluate(() => window.settingSnapshot.value), { outputDirectory: '.studies', maxToolCalls: 0, maxEvidence: 1000000000, maxNodes: 0, maxExperiments: 0 })
  assert.equal(await page.getByText('建议 40', { exact: true }).count(), 1)
  assert.equal(await page.getByText('建议 64', { exact: true }).count(), 1)
  await page.setViewportSize({ width: 900, height: 950 })
  await page.screenshot({ path: join(out, 'settings.png') })
  await page.setViewportSize({ width: 360, height: 1000 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: join(out, 'settings-narrow.png') })
  await page.getByRole('spinbutton', { name: '工具调用上限' }).fill('8')
  await page.evaluate(() => {
    window.settingSnapshot = { ...window.settingSnapshot, revision: window.settingSnapshot.revision + 1 }
    window.settingListeners.forEach(listener => listener())
  })
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByText('保存未成功。请点“重新载入”后重试；若刚更新插件，请先重启 DSH。').waitFor()
  assert.equal(await page.getByRole('spinbutton', { name: '工具调用上限' }).inputValue(), '8')
  await page.getByRole('button', { name: '重新载入' }).click()
  assert.equal(await page.getByRole('spinbutton', { name: '工具调用上限' }).inputValue(), '0')
  await page.getByRole('spinbutton', { name: '证据数量上限' }).fill('10')
  await page.evaluate(() => { window.settingFailure = true })
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByText('保存失败，请检查连接后重试。').waitFor()
  assert.equal(await page.evaluate(() => window.settingSnapshot.value.maxEvidence), 1000000000)
  await page.evaluate(() => {
    window.settingSnapshot = { ...window.settingSnapshot, writable: false }
    window.settingListeners.forEach(listener => listener())
  })
  assert.equal(await page.getByRole('button', { name: '保存', exact: true }).isDisabled(), true)
  await page.evaluate(() => { window.root.unmount(); window.disposers.reverse().forEach(remove => remove()) })
  assert.deepEqual(await page.evaluate(() => ({ types: window.types.size, bodies: window.bodies.size, settings: window.settingsPages.size, views: window.views.size, styles: document.querySelectorAll('[data-super-research]').length })),
    { types: 0, bodies: 0, settings: 0, views: 0, styles: 0 })
  assert.deepEqual(errors, [])
  assert.equal(await page.evaluate(() => window.listListeners.size + window.currentListeners.size), 0)
  await writeFile(join(out, 'result.json'), JSON.stringify({ checked: ['guide registration', 'proposal', 'graph and counterevidence', 'original source references', 'experiments', 'report review', 'keyboard tabs', 'dark theme', '360/480/900 pane widths', 'session switch', 'safe URLs', 'settings validation and save', 'settings conflicts and connection errors', 'read-only settings', 'unload'], errors }, null, 2))
})
