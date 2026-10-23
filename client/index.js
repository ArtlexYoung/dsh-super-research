/* DSH serves browser plugins as closure factories. React and session hooks belong to the host. */
;(globalThis.window || globalThis).__ModuleLoader__.load({ id: 'dsh-super-research', factory: require => {
const React = require('react')
const { MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives')
const h = React.createElement
const { useState, useEffect, useLayoutEffect, useRef, useMemo, useSyncExternalStore } = React
const STATUS = { empty: '等待研究问题', proposed: '方案待确认', running: '研究进行中', stopped: '已暂停',
  interrupted: '执行已中断', report: '报告待审阅', accepted: '已验收', invalid: '记录需要检查' }
const KINDS = { source: '来源', counterevidence: '反证', measurement: '测量', supplied: '用户材料' }
const NODE_STATUS = { open: '待验证', supported: '有支持证据', refuted: '已发现反例', inconclusive: '尚无定论' }
const PLAN_STAGES = { planned: '待开始', active: '进行中', blocked: '待解决', completed: '已完成', untracked: '未标注进度' }
const SECTIONS = [['overview', '概览'], ['exploration', '探索'], ['evidence', '证据'], ['experiments', '实验'], ['report', '报告']]
const identity = value => value
const selectRunning = value => !!value?.running
const TYPE_ID = 'dsh-super-research'
const SETTINGS_ID = 'super-research-workbench'
const SETTING_FIELDS = [
  ['maxToolCalls', '工具调用上限', 40, '每项研究可使用的外部工具调用次数，失败调用也计入。'],
  ['maxEvidence', '证据数量上限', 64, '保留来源、原文摘录、反证和测量记录。'],
  ['maxNodes', '探索节点上限', 48, '记录假设、验证路径及其依赖关系。'],
  ['maxExperiments', '实验数量上限', 24, '保存实验方法、输入、基线、指标和限制。'],
]
const defaults = { outputDirectory: '.super-research', ...Object.fromEntries(SETTING_FIELDS.map(([key, _label, value]) => [key, value])) }
const limitLabel = value => value === 0 ? '无限制' : Number(value).toLocaleString('zh-CN')
const MARKDOWN_LABELS = { code: { copyLabel: '复制', copiedLabel: '已复制' }, footnotes: '注释' }
const ICONS = {
  compass: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18', 'm16 8-3 5-5 3 3-5 5-3'],
  overview: ['M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z'],
  exploration: ['M5 7v10m0-10h14M5 17h14', 'M2 4h6v6H2zM16 4h6v6h-6zM16 14h6v6h-6z'],
  evidence: ['M9 4H5v16h14V4h-4', 'M9 2h6v5H9zM8 12h8M8 16h5'],
  experiments: ['M9 3h6m-5 0v6l-6 10a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2L14 9V3M8 14h8'],
  report: ['M6 3h8l4 4v14H6z', 'M14 3v5h4M9 12h6M9 16h6'],
  search: ['M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14m5 12 6 6'],
  arrow: ['m5 12 14 0m-6-6 6 6-6 6'],
  stop: ['M6 6h12v12H6z'],
  folder: ['M3 6h7l2 2h9v12H3z'],
  close: ['m6 6 12 12M6 18 18 6'],
  fit: ['M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5'],
}
function Icon({ name, ...props }) {
  return h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, ...props },
    (ICONS[name] || ICONS.compass).map((d, i) => h('path', { d, key: i })))
}
/** Paint the control feedback before the host's synchronous prompt admission work. */
function paintFeedback() {
  return new Promise(resolve => {
    if (document.visibilityState === 'hidden') { setTimeout(resolve, 0); return }
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true; clearTimeout(fallback); setTimeout(resolve, 0)
    }
    const fallback = setTimeout(finish, 100)
    requestAnimationFrame(finish)
  })
}
function ResearchSettings({ view, scope }) {
  const snapshot = useSyncExternalStore(listener => scope.subscribe(listener), () => scope.getSnapshot())
  const [draft, setDraft] = useState({}), [dirty, setDirty] = useState(false), [saving, setSaving] = useState(false), [notice, setNotice] = useState('')
  const revision = useRef(snapshot.revision), pending = useRef(false)
  const reset = (clearNotice = true) => {
    setDraft(Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, String(snapshot.value?.[key] ?? fallback)])))
    revision.current = snapshot.revision; setDirty(false); if (clearNotice) setNotice('')
  }
  useEffect(() => { if (!dirty) reset(false) }, [snapshot.revision, snapshot.status, dirty])
  if (view === 'summary') return '配置研究预算、记录上限与产物目录，支持大数值和无限制。'
  const edit = (key, value) => { setDraft(current => ({ ...current, [key]: value })); setDirty(true); setNotice('') }
  const save = async event => {
    event.preventDefault()
    if (pending.current) return
    const values = { outputDirectory: draft.outputDirectory, ...Object.fromEntries(SETTING_FIELDS.map(([key]) => [key, Number(draft[key])])) }
    if (!/^(?!\.{1,2}$|\.git$|node_modules$)[.a-zA-Z0-9_-]{1,64}$/.test(values.outputDirectory || '')
      || SETTING_FIELDS.some(([key]) => !String(draft[key] ?? '').trim() || !Number.isSafeInteger(values[key]) || values[key] < 0)) {
      setNotice('目录须为项目内的单个目录名；上限须为非负整数，0 表示无限制。'); return
    }
    pending.current = true; setSaving(true); setNotice('')
    try {
      const accepted = await scope.mutate(Object.entries(values).map(([key, value]) => ({ op: 'set', path: [key], value })), revision.current)
      if (accepted) { setDirty(false); setNotice('已保存。新研究自动使用；已有研究可在“研究实验”页应用这些上限。') }
      else setNotice('保存未成功。请点“重新载入”后重试；若刚更新插件，请先重启 DSH。')
    } catch { setNotice('保存失败，请检查连接后重试。') }
    finally { pending.current = false; setSaving(false) }
  }
  const disabled = !snapshot.writable || snapshot.status !== 'ready' || saving
  return h('form', { className: 'sr-settings', onSubmit: save, 'aria-label': 'Super Research 模式设置', 'aria-busy': saving },
    h('header', { className: 'sr-settings-header' }, h('h2', null, 'Super Research 模式'),
      h('p', null, '结合资料检索与实验验证，给出有据可查的结论。')),
    h('section', { className: 'sr-settings-group' }, h('h3', null, '研究预算'),
      h('p', { className: 'sr-hint' }, '按研究规模设置上限，或选择无限制。建议值适合日常研究，不是硬性限制。'),
      h('div', { className: 'sr-settings-grid' }, SETTING_FIELDS.map(([key, label, suggested, hint]) => h('div', { className: 'sr-settings-field', key },
        h('label', { htmlFor: `sr-setting-${key}` }, label, h('span', { className: 'sr-recommend' }, `建议 ${suggested}`)),
        h('div', { className: 'sr-limit-input' }, h('input', { id: `sr-setting-${key}`, name: key, type: 'number', min: 0, step: 1,
          'aria-label': label, 'aria-describedby': `sr-hint-${key}`, value: draft[key] ?? '', disabled,
          onChange: event => edit(key, event.target.value) }),
          h('button', { type: 'button', 'aria-label': `${label}设为无限制`, 'aria-pressed': draft[key] === '0', disabled, onClick: () => edit(key, draft[key] === '0' ? String(suggested) : '0') }, '无限制')),
        h('small', { id: `sr-hint-${key}` }, draft[key] === '0' ? '当前无限制。' : hint),
        h('small', null, '支持大整数；输入 0 或点击“无限制”。'))))),
    h('section', { className: 'sr-settings-group' }, h('h3', null, '研究产物'),
      h('div', { className: 'sr-settings-field' }, h('label', { htmlFor: 'sr-setting-directory' }, '项目内产物目录', h('span', { className: 'sr-recommend' }, '建议 .super-research')),
        h('input', { id: 'sr-setting-directory', name: 'outputDirectory', value: draft.outputDirectory ?? '', disabled, onChange: event => edit('outputDirectory', event.target.value) }),
        h('small', null, '每个会话使用独立子目录，自动忽略 Git。脚本、结果和临时文件集中保存。目录设置仅影响新研究。'))),
    h('div', { className: 'sr-settings-actions' },
      h('button', { type: 'button', disabled, onClick: () => { setDraft(Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, String(value)]))); setDirty(true); setNotice('已填入建议值，保存后生效。') } }, '使用建议值'),
      h('button', { type: 'button', disabled: saving, onClick: () => reset() }, '重新载入'),
      h('button', { type: 'submit', className: 'sr-primary', disabled: disabled || !dirty }, saving ? '保存中…' : '保存')),
    notice && h('p', { role: 'status', className: 'sr-hint' }, notice),
    snapshot.status !== 'ready' && h('p', { role: 'status' }, '正在读取研究配置…'))
}

function ResearchActions({ state, sessionId, inputId = sessionId, useSession, sendResearch, stopResearch, page = false }) {
  const running = useSession(selectRunning)
  const [input, setInput] = useState(''), [error, setError] = useState(''), [sending, setSending] = useState(''), [stopping, setStopping] = useState(false)
  const pending = useRef(false), cancelling = useRef(false), generation = useRef(0)
  useEffect(() => {
    generation.current++; setInput(''); setError(''); setSending(''); setStopping(false); pending.current = false; cancelling.current = false
    return () => { generation.current++ }
  }, [sessionId])
  if (!sendResearch) return null
  const act = async (text, label = '发送要求') => {
    if (pending.current || running) return
    const current = generation.current
    pending.current = true; setSending(label); setError('')
    try {
      const result = await sendResearch(text)
      if (current !== generation.current) return
      if (!result?.ok) { setError('发送失败，请检查会话连接后重试。'); return }
      setInput('')
    } catch { if (current === generation.current) setError('发送失败，请检查会话连接后重试。') }
    finally { if (current === generation.current) { pending.current = false; setSending('') } }
  }
  const stop = async () => {
    if (cancelling.current) return
    const current = generation.current
    cancelling.current = true; setStopping(true); setError('')
    try {
      const result = await stopResearch()
      if (current === generation.current && !result?.ok) setError('停止失败，请重试或使用对话停止按钮。')
    } catch { if (current === generation.current) setError('停止失败，请重试或使用对话停止按钮。') }
    finally { if (current === generation.current) { cancelling.current = false; setStopping(false) } }
  }
  const disabled = !!sending || running || stopping || !state || state.status === 'invalid'
  const button = (label, text, primary = false) => h('button', { type: 'button', key: label, disabled, 'aria-busy': sending === label,
    className: primary ? 'sr-primary' : '', onClick: () => act(text, label) }, label)
  const sendLabel = stopping ? '正在停止' : running ? '停止执行' : sending ? '发送中' : '发送要求'
  const sendControl = h('button', { type: running ? 'button' : 'submit', className: 'sr-primary sr-send',
    'aria-label': sendLabel, title: running ? '正在回答，点击停止' : sendLabel, 'aria-busy': !!sending || running || stopping,
    'data-state': stopping ? 'stopping' : running ? 'running' : sending ? 'sending' : 'idle',
    disabled: running ? stopping : disabled || !input.trim(), onClick: running ? stop : undefined },
    (sending || running || stopping) && h('span', { className: 'sr-spinner', 'aria-hidden': true }),
    running && !stopping ? h(Icon, { name: 'stop' }) : !sending && !stopping && page ? h(Icon, { name: 'arrow' }) : null,
    !page && h('span', null, sendLabel))
  return h('section', { className: `sr-controls ${page ? 'sr-dock' : ''}`, 'aria-label': '研究操作' },
    state?.proposal && h('div', { className: 'sr-shortcuts' }, h('span', { className: 'sr-shortcut-label' }, '快捷操作'), h('div', { className: 'sr-action-row' },
      state?.status === 'proposed' && button('确认并开始', '确认当前最新研究方案，请直接开始执行。', true),
      ['stopped', 'interrupted'].includes(state?.status) && button('继续研究', '继续当前研究，先核查未知操作结果，不重放已有操作，然后完成研究。', true),
      ['report', 'accepted'].includes(state?.status) && button('深入完善报告', '请继续深入研究并完善当前报告：补充证据、检查反例和论证缺口，必要时开展验证，直接执行并更新报告。', true),
      state?.proposal && ['running', 'stopped', 'report'].includes(state.status) && button('生成报告', '请根据已有证据生成并保存研究报告，明确尚未解决的问题和限制。'),
      state?.status === 'running' && !running && button('暂停研究', '请暂停当前研究，保留已有证据和结果。'),
      state?.status === 'report' && button('接受报告', '接受当前研究报告。'),
      state?.proposal && button('应用设置中的上限', '请将当前研究的四项上限更新为 configuredSettings 中的最新设置；只调整上限，暂不开展新的研究。'))),
    h('form', { className: 'sr-followup-form', onSubmit: event => { event.preventDefault(); if (input.trim() && !disabled) act(input.trim()) } },
      h('label', { htmlFor: `sr-followup-${inputId}` }, state?.proposal ? '补充要求或修改方向' : '研究问题'),
      h('textarea', { id: `sr-followup-${inputId}`, rows: page ? 1 : 2, value: input, maxLength: 16000, disabled, placeholder: page ? '补充研究方向，或提出报告修改要求…' : '例如：进一步比较边界情况，并把实验结果补进报告。', onChange: event => setInput(event.target.value) }),
      sendControl),
    error && h('p', { role: 'alert' }, error))
}

function safeUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : '' }
  catch { return '' }
}
function Empty({ children }) { return h('p', { className: 'sr-empty' }, children) }
function plainText(value) {
  return String(value || '').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)、]\s*)/gm, '')
    .replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim()
}
function briefText(value, limit = 150) {
  const text = plainText(value).split(/(?<=[。！？])|(?<=[.!?])\s+/u).map(part => part.trim()).filter(Boolean).slice(0, 2).join(' ')
  if (text.length <= limit) return text
  const prefix = text.slice(0, limit), end = Math.max(prefix.lastIndexOf('。'), prefix.lastIndexOf('；'), prefix.lastIndexOf(';'))
  return end >= limit / 2 ? prefix.slice(0, end + 1) + '…' : prefix.trimEnd() + '…'
}
function ResearchBrief({ state, reportOnly = false }) {
  const previous = state.report && !['report', 'accepted'].includes(state.status)
  const status = { proposed: '方案待确认，可以开始或调整研究方向。', running: '研究进行中，正在收集资料与验证。',
    stopped: '研究已暂停。', interrupted: '执行已中断，继续前需核对未知结果。', report: '报告已生成，等待审阅。', accepted: '报告已验收。' }[state.status] || STATUS[state.status]
  const conclusion = state.report ? state.report.summary || '旧报告未附简要总结，可展开报告全文。' : '尚未形成研究结论。'
  return h('dl', { className: 'sr-brief', 'aria-label': reportOnly ? '报告总结' : '研究摘要' },
    !reportOnly && h('div', { className: 'sr-brief-goal' }, h('dt', null, '目标'), h('dd', null, briefText(state.proposal?.question || state.proposal?.title, 120))),
    !reportOnly && h('div', null, h('dt', null, '当前状态'), h('dd', null, status,
      state.status === 'stopped' && state.statusNote && h('span', null, ` ${briefText(state.statusNote, 80)}`))),
    h('div', null, h('dt', null, previous ? '上一版结论' : '研究结论'), h('dd', null, h('div', { className: 'sr-conclusion' }, conclusion),
      state.report?.limits && h('p', { className: 'sr-brief-limits' }, `边界：${briefText(state.report.limits, 90)}`))))
}
function InlineDetails({ label, children }) {
  const [open, setOpen] = useState(false)
  return h('details', { className: 'sr-inline-details', onToggle: event => setOpen(event.currentTarget.open) },
    h('summary', null, label), open && h('div', { className: 'sr-inline-body' }, children))
}
function Card({ title, children, tone = '' }) {
  return h('section', { className: `sr-card ${tone}` }, title && h('h3', null, title), children)
}
function Evidence({ records }) {
  if (!records.length) return h(Empty, null, '暂无证据。研究取得的来源、反例和实验测量会保留在这里。')
  return records.map(item => h(Card, { key: item.id, title: `${item.id} · ${KINDS[item.kind]}` },
    h('p', null, item.claim), h('blockquote', null, item.quote),
    h('div', { className: 'sr-meta' }, `原始会话事件 #${item.sourceSeq}`),
    item.ref && (safeUrl(item.ref) ? h('a', { href: safeUrl(item.ref), target: '_blank', rel: 'noopener noreferrer' }, item.ref)
      : h('code', null, item.ref))))
}
/** Parents always precede children; stable layers do not need a graph dependency. */
function graphLayout(nodes) {
  const depths = new Map(), columns = new Map()
  return nodes.map(node => {
    const depth = node.parents.reduce((max, id) => Math.max(max, (depths.get(id) ?? 0) + 1), 0)
    const column = columns.get(depth) || 0
    depths.set(node.id, depth); columns.set(depth, column + 1)
    return { ...node, x: 20 + column * 190, y: 20 + depth * 100 }
  })
}
function Exploration({ nodes, evidence, focused, focus }) {
  if (!nodes.length) return h(Empty, null, '从问题出发，记录假设、验证路径和反例。探索节点会在研究中逐步出现。')
  const positions = graphLayout(nodes), byId = new Map(positions.map(node => [node.id, node]))
  const width = Math.max(320, ...positions.map(node => node.x + 170)), height = Math.max(...positions.map(node => node.y + 80))
  return h(React.Fragment, null,
    h('div', { className: 'sr-graph', 'aria-label': '研究探索关系图' },
      h('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': '从上到下展示假设及其依赖关系' },
        positions.flatMap(node => node.parents.map(parent => {
          const origin = byId.get(parent)
          return h('path', { key: `${parent}/${node.id}`, d: `M${origin.x + 75},${origin.y + 56} C${origin.x + 75},${origin.y + 80} ${node.x + 75},${node.y - 24} ${node.x + 75},${node.y}`, fill: 'none', stroke: 'currentColor', opacity: .3 })
        })), positions.map(node => h('g', { key: node.id, transform: `translate(${node.x},${node.y})` },
          h('rect', { width: 154, height: 56, rx: 10, fill: 'var(--sr-bg)', stroke: node.status === 'refuted' ? '#b65c50' : 'var(--sr-line)' }),
          h('text', { x: 10, y: 23, fill: 'var(--sr-text)', fontSize: 12 }, node.title.length > 15 ? `${node.title.slice(0, 14)}…` : node.title),
          h('text', { x: 10, y: 43, fill: 'var(--sr-muted)', fontSize: 10 }, NODE_STATUS[node.status]))))),
    nodes.map(node => h(Card, { key: node.id, title: `${node.id} · ${node.title}`, tone: node.status === 'refuted' ? 'sr-counter' : '' },
      h('span', { className: 'sr-badge' }, PLAN_STAGES[node.progress?.stage || 'untracked']),
      h('span', { className: 'sr-badge' }, NODE_STATUS[node.status]), h('p', null, node.progress?.summary || node.note),
      node.progress?.nextStep && h('p', null, `下一步：${node.progress.nextStep}`),
      node.parents.length > 0 && h('p', { className: 'sr-meta' }, `依赖：${node.parents.join('、')}`),
      node.evidenceIds.length > 0 && h('button', { className: 'sr-link', onClick: () => focus(node.id) }, focused === node.id ? '收起相关证据' : `查看证据 · ${node.evidenceIds.join('、')}`),
      focused === node.id && h('div', { className: 'sr-related' }, h(Evidence, { records: evidence.filter(item => node.evidenceIds.includes(item.id)) })))))
}
function Overview({ state }) {
  const proposal = state.proposal
  return h('div', { className: 'sr-section-summary' }, h(ResearchBrief, { state }),
    h('div', { className: 'sr-inline-group' },
      proposal && h(InlineDetails, { label: '研究方案' }, h(Card, { title: proposal.title },
        h('p', null, proposal.question), h('h4', null, '研究方法'), h('p', null, proposal.approach),
        h('h4', null, '验收标准'), h('ul', null, proposal.criteria.map((item, i) => h('li', { key: i }, item))),
        proposal.protocol && h(React.Fragment, null, h('h4', null, '固定评估协议'), h('pre', null, proposal.protocol)))),
      h(InlineDetails, { label: '执行记录' },
        h('div', { className: 'sr-metrics' }, [['证据', state.evidence.length, 'maxEvidence'], ['探索节点', state.nodes.length, 'maxNodes'], ['实验', state.experiments.length, 'maxExperiments']].map(([label, value, key]) =>
          h('div', { key: label }, h('strong', null, value), h('span', null, label), state.workspace?.settings && h('div', { className: 'sr-meta' }, `上限 ${limitLabel(state.workspace.settings[key])}`)))),
        proposal && h('p', { className: 'sr-meta' }, `${state.operations.length} / ${limitLabel(proposal.maxToolCalls)} 次工具调用`),
        h('ol', { className: 'sr-activity' }, state.operations.slice(-12).reverse().map(item => h('li', { key: item.id }, h('code', null, item.tool), h('span', null,
          ({ running: '执行中', completed: '已返回', failed: '失败', unknown: '结果未知' })[state.status === 'interrupted' && item.status === 'running' ? 'unknown' : item.status]))))),
      h(InlineDetails, { label: '研究产物' }, h(ResearchArtifacts, { workspace: state.workspace, hasStudy: !!proposal }))))
}
function Experiments({ records }) {
  if (!records.length) return h(Empty, null, '暂无实验。算法验证与离线量化实验会记录输入、方法、基线、指标和限制。')
  return records.map(item => h(Card, { key: item.id, title: `${item.id} · ${{ completed: '已完成', failed: '失败', inconclusive: '尚无定论' }[item.status]}` },
    [['方法', item.method], ['输入与环境', item.input], ['固定协议', item.protocol], ['基线', item.baseline], ['候选', item.candidate], ['指标', item.metrics], ['限制', item.limits], ['证据', item.evidenceIds.join('、')]].map(([label, value]) =>
      h('div', { key: label }, h('h4', null, label), h('pre', null, value)))))
}
function Report({ state }) {
  if (!state.report) return h(Empty, null, '研究报告将在收集证据和验证后生成。它会保留未解决的问题，并等待你审阅。')
  return h(React.Fragment, null, h(Card, { title: state.status === 'accepted' ? '已验收的研究报告' : '研究报告' },
    h('div', { className: 'sr-report' }, h(MarkdownText, { text: state.report.text, labels: MARKDOWN_LABELS })), h('h4', null, '限制与不确定性'), h('p', null, state.report.limits),
    h('p', { className: 'sr-meta' }, `引用证据：${state.report.evidenceIds.join('、')}`)),
    state.review && h('p', { className: 'sr-meta' }, `人工审阅来自会话事件 #${state.review.user.seq}：${state.review.user.quote}`))
}
function ResearchContent({ state, section, focused, setFocused, instanceId, compact = false }) {
  if (!state) return h(Empty, null, '正在读取当前会话的研究记录…')
  if (state.status === 'invalid') return h('div', { role: 'alert' }, state.error)
  if (state.status === 'empty') return h('div', { className: 'sr-welcome' },
    h('div', { className: 'sr-orbit', 'aria-hidden': true }, '⌕'), h('h3', null, '从一个值得追问的问题开始'),
    h('p', null, '新建会话并选择“Super Research 模式”，在这里提出要分析、比较或验证的问题。模型会先生成研究方案，点击“确认并开始”即可执行。'),
    h('p', { className: 'sr-meta' }, '无需特定关键词。只打开此工作台不会切换当前会话的模式。'),
    h('div', { className: 'sr-example' }, '例如：比较两种排序策略，寻找反例，并用可复现实验验证。'),
    h('p', { className: 'sr-meta' }, '通用研究 · 算法验证 · 离线量化'))
  if (section === 'overview') return h(Overview, { key: instanceId, state })
  if (section === 'exploration') return compact ? h(Exploration, { nodes: state.nodes, evidence: state.evidence, focused, focus: id => setFocused(focused === id ? '' : id) }) : h(ExplorationCanvas, { key: instanceId, state, instanceId })
  if (section === 'evidence') return h(ResearchCollection, { key: `${instanceId}-evidence`, records: state.evidence })
  if (section === 'experiments') return h(ResearchCollection, { key: `${instanceId}-experiments`, records: state.experiments, experiments: true })
  return h('div', { className: 'sr-section-summary sr-report-preview' }, h(ResearchBrief, { state, reportOnly: true }),
    state.report && h(InlineDetails, { key: `${instanceId}-report`, label: '报告全文' }, compact ? h(Report, { state }) : h(ReportDocument, { state })))
}
function ResearchArtifacts({ workspace, hasStudy }) {
  if (!workspace) return h('p', { className: 'sr-meta' }, hasStudy ? '旧研究尚未分配独立产物目录；下次继续研究时建立，已有文件保留原位。' : '研究创建后，产物将集中保存在项目内的独立目录。')
  return h('aside', { className: 'sr-artifacts', 'aria-label': '研究产物目录' },
    h('h4', null, '研究产物'), h('code', null, workspace.directory),
    h('p', { className: 'sr-meta' }, '报告、证据、实验脚本与结果集中保存。'))
}
function ResearchWorkbench({ useProjection, sessionId, useSession, sendResearch, stopResearch }) {
  const state = useProjection('superResearch', identity)
  const [section, setSection] = useState('overview'), [focused, setFocused] = useState('')
  const body = useRef(null), instanceId = `sidebar-${sessionId}`
  useEffect(() => { setSection('overview'); setFocused('') }, [sessionId])
  const choose = name => { setSection(name); setFocused(''); body.current?.scrollTo?.(0, 0) }
  const keys = event => {
    const index = SECTIONS.findIndex(([key]) => key === section)
    const target = event.key === 'ArrowRight' ? (index + 1) % SECTIONS.length
      : event.key === 'ArrowLeft' ? (index + SECTIONS.length - 1) % SECTIONS.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? SECTIONS.length - 1 : -1
    if (target < 0) return
    event.preventDefault(); choose(SECTIONS[target][0]); event.currentTarget.parentElement.children[target].focus()
  }
  const controls = h(ResearchActions, { state, sessionId, inputId: instanceId, useSession, sendResearch, stopResearch })
  const content = h('div', { className: 'sr-main' },
    h('nav', { className: 'sr-tabs', role: 'tablist', 'aria-label': '研究视图' }, SECTIONS.map(([key, label]) => h('button', {
      key, type: 'button', role: 'tab', id: `sr-tab-${instanceId}-${key}`, 'aria-selected': section === key,
      'aria-controls': `sr-body-${instanceId}`, tabIndex: section === key ? 0 : -1, onClick: () => choose(key), onKeyDown: keys,
    }, label))),
    h('div', { ref: body, className: 'sr-body', role: 'tabpanel', id: `sr-body-${instanceId}`, 'aria-labelledby': `sr-tab-${instanceId}-${section}`, tabIndex: 0 },
      h(ResearchContent, { state, section, focused, setFocused, instanceId, compact: true })))
  return h('section', { className: 'sr-workbench sr-compact', 'aria-label': 'Super Research' },
    h('header', { className: 'sr-header' },
      h('div', { className: 'sr-title' }, h('span', { className: 'sr-eyebrow' }, 'SUPER RESEARCH'),
        h('h2', null, 'Super Research')),
      h('span', { className: 'sr-badge', 'data-status': state?.status }, STATUS[state?.status] || '正在读取会话')),
    controls, content,
    h('footer', { className: 'sr-footer' }, '当前 DSH 会话', state && h('span', null, `修订 ${state.revision}`)))
}
function boardLayout(nodes) {
  const grouped = Object.fromEntries(Object.keys(PLAN_STAGES).map(stage => [stage, []]))
  for (const node of nodes) grouped[node.progress?.stage || 'untracked'].push(node)
  const tracked = nodes.length - grouped.untracked.length
  const stages = tracked ? Object.keys(PLAN_STAGES).filter(stage => stage !== 'untracked' || grouped.untracked.length) : ['untracked']
  let left = 24
  const positions = [], lanes = stages.map(stage => {
    const items = grouped[stage], columns = tracked ? 1 : Math.min(3, Math.max(1, Math.ceil(items.length / 4)))
    const lane = { stage, x: left, width: columns * 280 + 12, count: items.length }
    items.forEach((node, index) => positions.push({ ...node, stage, x: left + 16 + index % columns * 280, y: 86 + Math.floor(index / columns) * 228 }))
    left += lane.width + 32
    return lane
  })
  return { positions, lanes, tracked, completed: grouped.completed.length,
    width: Math.max(340, left - 8), height: positions.reduce((max, node) => Math.max(max, node.y + 248), 400) }
}
function boardEdge(origin, target) {
  if (origin.x === target.x) {
    const down = target.y > origin.y, startY = origin.y + (down ? 204 : 0), endY = target.y + (down ? 0 : 204)
    return `M${origin.x + 130},${startY} C${origin.x + 130},${(startY + endY) / 2} ${target.x + 130},${(startY + endY) / 2} ${target.x + 130},${endY}`
  }
  const right = target.x > origin.x, startX = origin.x + (right ? 260 : 0), endX = target.x + (right ? 0 : 260)
  const bend = Math.max(36, Math.abs(endX - startX) * .45) * (right ? 1 : -1)
  return `M${startX},${origin.y + 102} C${startX + bend},${origin.y + 102} ${endX - bend},${target.y + 102} ${endX},${target.y + 102}`
}
function ExplorationCanvas({ state, instanceId }) {
  const board = useMemo(() => boardLayout(state.nodes), [state.nodes])
  const { positions, lanes, width, height } = board
  const byId = useMemo(() => new Map(positions.map(node => [node.id, node])), [positions])
  const [selected, setSelected] = useState(''), [camera, setCamera] = useState({ scale: 1, x: 0, y: 0 }), [dragging, setDragging] = useState(false)
  const { scale } = camera
  const viewport = useRef(null), drag = useRef(null), viewSize = useRef(''), selection = useRef(false)
  const node = byId.get(selected)
  selection.current = node
  const related = new Set(node ? [node.id, ...node.parents, ...positions.filter(item => item.parents.includes(node.id)).map(item => item.id)] : [])
  const fit = (minimum = .25, focus = false) => {
    const rect = viewport.current?.getBoundingClientRect()
    if (!rect) return
    const next = Math.max(minimum, Math.min(1, (rect.width - 48) / width, (rect.height - 48) / height))
    setCamera({ scale: next,
      x: focus ? rect.width / 2 - (focus.x + 130) * next : Math.max(16, (rect.width - width * next) / 2),
      y: focus ? rect.height / 2 - (focus.y + 102) * next : Math.max(16, (rect.height - height * next) / 2) })
  }
  const zoom = (factor, point) => {
    const rect = viewport.current.getBoundingClientRect(), anchor = point || { x: rect.width / 2, y: rect.height / 2 }
    setCamera(current => {
      const next = Math.max(.25, Math.min(2, current.scale * factor)), ratio = next / current.scale
      return { scale: next, x: anchor.x - (anchor.x - current.x) * ratio, y: anchor.y - (anchor.y - current.y) * ratio }
    })
  }
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    const resize = () => {
      const size = `${element.clientWidth}/${element.clientHeight}`
      if (viewSize.current !== size) { viewSize.current = size; fit(.75, selection.current) }
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    // React's delegated wheel listener is passive; consume scrolling only inside the graph.
    const wheel = event => {
      if (!event.deltaY || event.target.closest('.sr-canvas-tools,.sr-minimap')) return
      event.preventDefault(); event.stopPropagation()
      const rect = element.getBoundingClientRect(), unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1
      const delta = Math.max(-240, Math.min(240, event.deltaY * unit))
      zoom(Math.exp(-delta * .0015), { x: event.clientX - rect.left, y: event.clientY - rect.top })
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => { observer.disconnect(); element.removeEventListener('wheel', wheel) }
  }, [width, height, !!positions.length])
  const start = event => {
    if (event.button !== 0 || event.target.closest('button')) return
    drag.current = { x: event.clientX, y: event.clientY, origin: camera }
    event.currentTarget.setPointerCapture(event.pointerId); setDragging(true)
  }
  if (!positions.length) return h(Empty, null, '暂无探索方案。研究中的候选方案与验证任务会在这里按进度展示，并保留依赖连线。')
  return h('div', { className: `sr-exploration-layout ${node ? 'sr-inspecting' : ''}` },
    h('div', { className: 'sr-canvas-card' },
      h('div', { className: 'sr-canvas-toolbar' },
        h('div', { className: 'sr-board-summary' }, board.tracked ? h(React.Fragment, null,
          h('span', null, `已完成 ${board.completed} / ${board.tracked} 项`),
          h('span', null, `进行中 ${lanes.find(lane => lane.stage === 'active').count}`),
          h('span', null, `待解决 ${lanes.find(lane => lane.stage === 'blocked').count}`),
          board.tracked < positions.length && h('span', null, `${positions.length - board.tracked} 项未标注进度`)) : '旧记录未标注执行进度，保留原有验证结果。'),
        h('span', { className: 'sr-meta' }, `${state.nodes.length} 个方案 · ${state.evidence.length} 份证据`)),
      h('div', { className: 'sr-canvas', ref: viewport, 'aria-label': '可拖动缩放的探索画布', title: '滚轮缩放 · 拖动画布 · 点击方案查看进展与依据', tabIndex: 0,
        'data-dragging': dragging, onPointerDown: start,
        onPointerMove: event => { if (drag.current) setCamera({ ...drag.current.origin, x: drag.current.origin.x + event.clientX - drag.current.x, y: drag.current.origin.y + event.clientY - drag.current.y }) },
        onPointerUp: () => { drag.current = null; setDragging(false) }, onPointerCancel: () => { drag.current = null; setDragging(false) },
        onKeyDown: event => {
          const delta = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }[event.key]
          if (event.target !== event.currentTarget || !delta) return
          event.preventDefault(); setCamera(current => ({ ...current, x: current.x + delta[0], y: current.y + delta[1] }))
        } },
        h('div', { className: 'sr-canvas-world', style: { width, height, transform: `translate(${camera.x}px,${camera.y}px) scale(${scale})` } },
          lanes.map(lane => h('section', { className: 'sr-board-lane', key: lane.stage, 'data-stage': lane.stage, 'aria-label': `${PLAN_STAGES[lane.stage]}方案`,
            style: { left: lane.x, top: 20, width: lane.width, height: height - 40 } },
            h('div', { className: 'sr-lane-heading' }, h('i'), h('span', null, PLAN_STAGES[lane.stage]), h('b', null, lane.count)),
            !lane.count && h('span', { className: 'sr-lane-empty' }, '暂无方案'))),
          h('svg', { className: 'sr-canvas-edges', width, height, role: 'img', 'aria-label': '研究方案之间的依赖关系' },
            h('defs', null, h('marker', { id: `sr-arrow-${instanceId}`, markerWidth: 7, markerHeight: 7, refX: 6, refY: 3, orient: 'auto' }, h('path', { d: 'M0 0 6 3 0 6', fill: 'none', stroke: 'currentColor' }))),
            positions.flatMap(item => item.parents.map(parent => {
              const origin = byId.get(parent)
              return h('path', { key: `${parent}/${item.id}`, d: boardEdge(origin, item),
                className: `sr-edge sr-edge-${item.status}`, 'data-focus': !node ? 'all' : item.id === node.id || parent === node.id ? 'related' : 'muted', fill: 'none', markerEnd: `url(#sr-arrow-${instanceId})` })
            }))),
          positions.map(item => h('button', { key: item.id, type: 'button', className: 'sr-canvas-node', 'data-node-status': item.status,
            'data-stage': item.stage, 'data-related': related.has(item.id),
            style: { left: item.x, top: item.y }, 'aria-pressed': selected === item.id, onClick: () => setSelected(item.id) },
            h('span', { className: 'sr-node-top' }, h('code', null, item.id), h('span', { className: 'sr-node-state', title: '验证结果，与执行进度分别记录' }, NODE_STATUS[item.status])),
            h('span', { className: 'sr-node-title' }, item.title),
            h('span', { className: 'sr-plan-summary' }, briefText(item.progress?.summary || item.note, 110)),
            item.progress?.nextStep && h('span', { className: 'sr-plan-next' }, '下一步 · ', item.progress.nextStep),
            h('span', { className: 'sr-node-bottom' }, h('small', null, `${item.evidenceIds.length} 份证据`), h('small', null, item.parents.length ? `${item.parents.length} 个前置方案` : '研究起点'))))),
        h('div', { className: 'sr-canvas-tools' },
          h('button', { type: 'button', 'aria-label': '放大探索图', onClick: () => zoom(1.2) }, '+'),
          h('button', { type: 'button', 'aria-label': '缩小探索图', onClick: () => zoom(1 / 1.2) }, '−'),
          h('button', { type: 'button', 'aria-label': '适应画布', onClick: () => fit() }, h(Icon, { name: 'fit' })), h('span', null, `${Math.round(scale * 100)}%`)),
        h('button', { type: 'button', className: 'sr-minimap', 'aria-label': '探索图缩略图，点击定位', onClick: event => {
          const rect = event.currentTarget.getBoundingClientRect(), view = viewport.current.getBoundingClientRect()
          setCamera({ scale, x: view.width / 2 - (event.clientX - rect.left) / rect.width * width * scale,
            y: view.height / 2 - (event.clientY - rect.top) / rect.height * height * scale })
        } }, h('svg', { viewBox: `0 0 ${width} ${height}` }, positions.map(item => h('rect', { key: item.id, x: item.x, y: item.y, width: 260, height: 204, rx: 8, 'data-node-status': item.status })))))),
    node && h('aside', { className: 'sr-node-inspector', 'aria-label': '节点详情' },
      h('header', null, h('h3', null, '节点详情'), h('button', { type: 'button', 'aria-label': '关闭节点详情', onClick: () => setSelected('') }, h(Icon, { name: 'close' }))),
      h('span', { className: 'sr-progress-label', 'data-stage': node.stage }, PLAN_STAGES[node.stage]),
      h('span', { className: 'sr-node-state', 'data-node-status': node.status }, NODE_STATUS[node.status]),
      h('h3', null, node.title), node.progress && h('p', null, node.progress.summary),
      node.progress?.nextStep && h('p', { className: 'sr-plan-next-detail' }, '下一步：', node.progress.nextStep), h('p', null, node.note),
      node.parents.length > 0 && h('p', { className: 'sr-meta' }, `上游节点 ${node.parents.join('、')}`),
      h('h4', null, '关联证据'), h(Evidence, { records: state.evidence.filter(item => node.evidenceIds.includes(item.id)) })))
}
function ResearchCollection({ records, experiments = false }) {
  const [query, setQuery] = useState(''), [kind, setKind] = useState('all')
  const shown = records.filter(item => (!query || JSON.stringify(item).toLowerCase().includes(query.toLowerCase())) && (kind === 'all' || item.kind === kind))
  return h('div', { className: 'sr-collection' },
    h('div', { className: 'sr-collection-toolbar' },
      h('label', { className: 'sr-search' }, h(Icon, { name: 'search' }), h('input', { 'aria-label': experiments ? '搜索实验' : '搜索证据', placeholder: experiments ? '搜索实验、方法或指标' : '搜索结论、原文或来源', value: query, onChange: event => setQuery(event.target.value) })),
      !experiments && h('select', { 'aria-label': '证据类型', value: kind, onChange: event => setKind(event.target.value) }, h('option', { value: 'all' }, '全部类型'), Object.entries(KINDS).map(([key, label]) => h('option', { key, value: key }, label))),
      h('span', { className: 'sr-meta' }, `${shown.length} / ${records.length} 条`)),
    h('div', { className: 'sr-record-head', 'aria-hidden': true }, h('span', null, experiments ? '状态' : '类型'), h('span', null, experiments ? '实验方法' : '结论摘要'), h('span', null, experiments ? '指标' : '来源')),
    shown.map(item => h('details', { className: 'sr-record-row', key: item.id },
      h('summary', null,
        h('span', { className: 'sr-record-kind', 'data-kind': experiments ? item.status : item.kind }, experiments ? ({ completed: '已完成', failed: '失败', inconclusive: '未定' })[item.status] : KINDS[item.kind]),
        h('span', { className: 'sr-record-title' }, h('strong', null, experiments ? item.method : item.claim), h('code', null, item.id)),
        h('span', { className: 'sr-record-source' }, experiments ? item.metrics : item.ref || `会话事件 #${item.sourceSeq}`)),
      h('div', { className: 'sr-record-detail' }, experiments ? h(Experiments, { records: [item] }) : h(Evidence, { records: [item] })))),
    !shown.length && h(Empty, null, records.length ? '没有匹配记录，试试其他关键词。' : experiments ? '暂无实验记录。验证方法、基线和测量结果会保留在这里。' : '暂无证据。来源原文、测量与反例会保留在这里。'))
}
function ReportDocument({ state }) {
  const document = useRef(null), [outline, setOutline] = useState([])
  useEffect(() => { setOutline([...document.current?.querySelectorAll('.sr-report h1,.sr-report h2,.sr-report h3') || []].map(element => ({ text: element.textContent, level: element.tagName, element }))) }, [state.report?.text])
  if (!state.report) return h(Empty, null, '报告尚未生成。研究中的结论、证据和限制将在这里汇总。')
  return h('div', { className: 'sr-document-layout' },
    h('article', { className: 'sr-document', ref: document },
      h('div', { className: 'sr-report' }, h(MarkdownText, { text: state.report.text, labels: MARKDOWN_LABELS })),
      h('section', { className: 'sr-document-limits' }, h('h3', null, '限制与不确定性'), h('p', null, state.report.limits), h('p', { className: 'sr-meta' }, `引用证据 ${state.report.evidenceIds.join('、') || '无'}`)),
      state.review && h('p', { className: 'sr-meta' }, `审阅记录 #${state.review.user.seq} · ${state.review.user.quote}`)),
    outline.length > 0 && h('aside', { className: 'sr-outline', 'aria-label': '报告目录' }, h('h3', null, '本页目录'), outline.map((item, index) => h('button', { type: 'button', key: index, 'data-level': item.level, onClick: () => item.element.scrollIntoView({ block: 'start', behavior: 'smooth' }) }, item.text))))
}
function ResearchPage({ useProjection, sessionId, useSession, sendResearch, stopResearch }) {
  const state = useProjection('superResearch', identity)
  const [section, setSection] = useState('overview')
  const body = useRef(null), instanceId = `page-${sessionId}`
  useEffect(() => { setSection('overview') }, [sessionId])
  const choose = name => { setSection(name); body.current?.scrollTo(0, 0) }
  const keys = event => {
    const index = SECTIONS.findIndex(([key]) => key === section)
    const next = event.key === 'ArrowRight' ? (index + 1) % SECTIONS.length : event.key === 'ArrowLeft' ? (index + SECTIONS.length - 1) % SECTIONS.length : event.key === 'Home' ? 0 : event.key === 'End' ? SECTIONS.length - 1 : -1
    if (next < 0) return
    event.preventDefault(); choose(SECTIONS[next][0]); event.currentTarget.parentElement.children[next].focus()
  }
  return h('section', { className: 'sr-workbench sr-page', 'data-super-research-page': '', 'aria-label': '研究工作台' },
    h('div', { className: 'sr-viewbar' },
      h('nav', { className: 'sr-segments', role: 'tablist', 'aria-label': '研究视图' }, SECTIONS.map(([key, label]) => h('button', { type: 'button', role: 'tab', key,
        id: `sr-tab-${instanceId}-${key}`, 'aria-selected': section === key, 'aria-controls': `sr-body-${instanceId}`, tabIndex: section === key ? 0 : -1, onClick: () => choose(key), onKeyDown: keys },
        h(Icon, { name: key }), label, ['evidence', 'experiments'].includes(key) && h('span', { className: 'sr-count' }, (key === 'evidence' ? state?.evidence : state?.experiments)?.length || 0)))),
      h('div', { className: 'sr-view-status' }, state?.proposal && h('span', { className: 'sr-resource' }, `${state.operations.length} / ${limitLabel(state.proposal.maxToolCalls)} 次工具调用`),
        h('span', { className: 'sr-status', 'data-status': state?.status, 'aria-label': STATUS[state?.status] || '读取中', title: state ? `当前会话 · 修订 ${state.revision}` : '读取中' }, h('i'), h('span', { className: 'sr-status-label' }, STATUS[state?.status] || '读取中')))),
    h('div', { ref: body, className: `sr-page-content sr-view-${section}`, role: 'tabpanel', tabIndex: 0, id: `sr-body-${instanceId}`, 'aria-labelledby': `sr-tab-${instanceId}-${section}` },
      h(ResearchContent, { state, section, instanceId })),
    h(ResearchActions, { state, sessionId, inputId: instanceId, useSession, sendResearch, stopResearch, page: true }))
}

const inject = ['slots', 'sidebarRightTabs', 'configForms', 'sessions', 'uiSession']
function apply(ctx) {
  const settings = ctx.configForms.get(SETTINGS_ID)
  ctx.effect(() => ctx.configForms.whileServed([SETTINGS_ID], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'super-research', order: 125, label: () => 'Super Research 模式', inject: () => ({ scope: settings }),
  }, ResearchSettings))), 'super-research: settings')
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.superResearch = 'true'
    style.textContent = `
.sr-workbench{--sr-bg:var(--dsw-alias-bg-layer-1,#fff);--sr-text:var(--dsw-alias-label-primary,#202124);--sr-muted:var(--dsw-alias-label-tertiary,#8a8e98);--sr-line:var(--dsw-alias-border-l3,#e8e9ed);--sr-accent:#3b82f6;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--sr-bg);color:var(--sr-text);font:13px/1.65 system-ui,-apple-system,sans-serif}
.sr-artifacts{border-top:1px solid var(--sr-line);padding:14px 0;margin-top:20px;overflow-wrap:anywhere}.sr-artifacts h4{font-size:12px;margin:0 0 8px}.sr-artifacts code{font-size:11px}
.sr-settings{--sr-bg:var(--dsw-alias-bg-layer-1,#fff);--sr-text:var(--dsw-alias-label-primary,#202824);--sr-muted:var(--dsw-alias-label-tertiary,#717c76);--sr-line:var(--dsw-alias-border-l3,#dde5df);--sr-accent:var(--dsw-alias-label-primary,#202824);box-sizing:border-box;container-type:inline-size;display:flex;flex-direction:column;gap:24px;max-width:820px;padding:24px;font:13px/1.65 system-ui,-apple-system,sans-serif;color:var(--sr-text)}
.sr-settings *{box-sizing:border-box}.sr-settings-header{padding-bottom:20px;border-bottom:1px solid var(--sr-line)}.sr-settings-header h2{margin:0 0 6px;font-size:20px;font-weight:600}.sr-settings-header p,.sr-hint{margin:0;font-size:12px;line-height:1.65;color:var(--sr-muted)}.sr-settings-group{display:flex;flex-direction:column;gap:16px;min-width:0}.sr-settings-group+.sr-settings-group{border-top:1px solid var(--sr-line);padding-top:24px}.sr-settings h3{margin:0;font-size:14px;font-weight:600}.sr-settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:22px 20px}.sr-settings-field{display:flex;flex-direction:column;gap:7px;min-width:0}.sr-settings-field label{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;font-weight:500}.sr-recommend{font-size:12px;font-weight:400;color:var(--sr-muted)}.sr-settings-field small{font-size:12px;color:var(--sr-muted)}.sr-settings input,.sr-controls textarea{width:100%;min-width:0;background:var(--sr-bg);color:inherit;border:1px solid var(--sr-line);border-radius:8px;padding:9px 11px;font:inherit}.sr-limit-input{display:flex;gap:6px}.sr-limit-input button{flex:none}.sr-settings button,.sr-controls button{font:inherit;padding:7px 12px;border:1px solid var(--sr-line);border-radius:8px;background:var(--sr-bg);color:inherit;cursor:pointer;white-space:nowrap}.sr-settings button[aria-pressed=true]{background:var(--sr-text);color:var(--sr-bg);border-color:var(--sr-text)}.sr-settings-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;border-top:1px solid var(--sr-line);padding-top:16px}.sr-settings .sr-primary,.sr-controls .sr-primary{background:var(--sr-text);color:var(--sr-bg);border-color:var(--sr-text)}.sr-settings button:disabled,.sr-controls button:disabled,.sr-controls textarea:disabled{opacity:.5;cursor:default}.sr-settings input:focus-visible,.sr-settings button:focus-visible,.sr-controls textarea:focus-visible{outline:2px solid var(--sr-accent);outline-offset:2px}
.sr-controls{padding:0 22px 18px;display:flex;flex-direction:column;gap:12px;flex-shrink:0}.sr-action-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.sr-action-row:empty{display:none}.sr-controls form{display:flex;flex-direction:column;gap:8px}.sr-controls label{font-size:12px;font-weight:500}.sr-controls textarea{resize:vertical;min-height:68px;max-height:180px;line-height:1.6}.sr-controls small{font-size:11px;color:var(--sr-muted);flex:1;min-width:160px}.sr-controls p{font-size:12px;color:var(--sr-muted);margin:0}.sr-action-row button{font-size:12px}.sr-body>.sr-card,.sr-body>.sr-artifacts{max-width:1040px}.sr-body>.sr-metrics{max-width:1040px}@container(max-width:520px){.sr-settings-grid{grid-template-columns:1fr}}

.sr-workbench *{box-sizing:border-box}.sr-header{padding:24px 22px 18px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}.sr-eyebrow{font-size:10px;font-weight:650;letter-spacing:2px;color:var(--sr-accent)}.sr-workbench h2{font-size:20px;letter-spacing:-.5px;margin:6px 0 0;font-weight:600}.sr-badge{display:inline-block;border:1px solid var(--sr-line);border-radius:20px;padding:3px 9px;font-size:11px;color:var(--sr-muted)}.sr-badge[data-status=running]{color:var(--sr-accent);background:color-mix(in srgb,var(--sr-accent) 7%,transparent)}.sr-tabs{display:flex;gap:4px;border-bottom:1px solid var(--sr-line);padding:0 18px;flex-shrink:0;overflow:auto}.sr-tabs button{border:0;background:none;color:var(--sr-muted);padding:10px 12px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;border-bottom:2px solid transparent}.sr-tabs button[aria-selected=true]{color:var(--sr-accent);border-bottom-color:var(--sr-accent)}.sr-workbench button:focus-visible,.sr-workbench a:focus-visible{outline:2px solid var(--sr-accent);outline-offset:2px}.sr-body{overflow:auto;overscroll-behavior:contain;padding:20px;flex:1;min-height:0}.sr-body:focus-visible{outline:1px solid var(--sr-line);outline-offset:-2px}.sr-card{border:1px solid var(--sr-line);border-radius:12px;margin-bottom:14px;padding:17px;overflow-wrap:anywhere}.sr-card h3{font-size:14px;line-height:1.5;margin:0 0 12px;font-weight:600}.sr-card h4{font-size:11px;color:var(--sr-muted);margin:18px 0 5px;font-weight:500}.sr-card p{margin:8px 0}.sr-card ul{margin:6px 0;padding-left:20px}.sr-card pre,.sr-card code{font:12px/1.7 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.sr-card pre{margin:0}.sr-card .sr-report{font-family:inherit;font-size:13px}.sr-card blockquote{margin:12px 0;padding:8px 12px;border-left:2px solid var(--sr-line);color:var(--sr-muted);white-space:pre-wrap}.sr-card a{color:var(--sr-accent)}.sr-callout{background:color-mix(in srgb,var(--sr-accent) 5%,transparent);border-color:color-mix(in srgb,var(--sr-accent) 25%,var(--sr-line))}.sr-counter{border-left:3px solid #b65c50}.sr-meta{font-size:11px;color:var(--sr-muted)}.sr-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:0 0 16px}.sr-metrics>div{border:1px solid var(--sr-line);border-radius:10px;padding:14px}.sr-metrics strong{display:block;font-size:23px;font-weight:500}.sr-metrics span{font-size:11px;color:var(--sr-muted)}.sr-budget{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.sr-budget progress{flex:1;height:5px;accent-color:var(--sr-accent)}.sr-budget span{font-size:11px;color:var(--sr-muted)}.sr-activity{padding:0;list-style:none}.sr-activity li{display:flex;justify-content:space-between;gap:12px;border-top:1px solid var(--sr-line);padding:7px 0}.sr-activity span{color:var(--sr-muted);font-size:11px}.sr-footer{display:flex;justify-content:space-between;border-top:1px solid var(--sr-line);padding:10px 20px;color:var(--sr-muted);font-size:10px}.sr-welcome{max-width:360px;margin:45px auto;text-align:center}.sr-welcome h3{font-size:18px;font-weight:500}.sr-welcome p{color:var(--sr-muted)}.sr-orbit{display:grid;place-items:center;border:1px solid var(--sr-line);border-radius:50%;width:64px;height:64px;margin:0 auto 24px;font-size:32px;color:var(--sr-accent)}.sr-example{text-align:left;border:1px solid var(--sr-line);border-radius:10px;padding:15px;font-size:12px;margin:24px 0}.sr-empty{color:var(--sr-muted);padding:35px 14px;max-width:360px;margin:auto;text-align:center}.sr-graph{overflow:auto;border:1px solid var(--sr-line);border-radius:12px;margin-bottom:16px;max-height:400px}.sr-link{border:0;padding:5px 0;background:none;color:var(--sr-accent);font:inherit;font-size:12px;cursor:pointer}.sr-related{margin-top:12px}.sr-related .sr-card{margin:0}.sr-related blockquote{font-size:12px}
/* Only the research view replaces the generic composer; native interactions stay mounted. */
[data-conversation-scroll]:has([data-super-research-page]){overflow:hidden!important;scrollbar-gutter:auto}
[data-conversation-scroll]:has([data-super-research-page])>[data-slot="conversation.session"]>div:has([data-super-research-page]){flex:1 1 0!important;min-height:0!important;overflow:hidden}
[data-conversation-scroll]:has([data-super-research-page]) [data-chain-overlay-fallback="conversation.composer"]{display:none!important}
.sr-visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.sr-main{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;overflow:hidden}
.sr-page{--sr-accent:#3b82f6;--sr-soft:color-mix(in srgb,var(--sr-text) 3%,var(--sr-bg));--sr-blue:#3b82f6;--sr-green:#10b981;--sr-orange:#f59e0b;--sr-red:#f05f77;container-type:inline-size;flex:1;min-width:0;height:100%;overflow:hidden;font-size:13px;line-height:1.6}
.sr-status{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:6px;background:var(--sr-soft);color:var(--sr-muted);font-size:11px;white-space:nowrap;flex:none}.sr-status i{width:5px;height:5px;border-radius:50%;background:currentColor}.sr-status[data-status=running],.sr-status[data-status=proposed]{color:var(--sr-blue);background:color-mix(in srgb,var(--sr-blue) 9%,var(--sr-bg))}.sr-status[data-status=report],.sr-status[data-status=stopped]{color:#bf821c;background:color-mix(in srgb,var(--sr-orange) 10%,var(--sr-bg))}.sr-status[data-status=accepted]{color:var(--sr-green);background:color-mix(in srgb,var(--sr-green) 10%,var(--sr-bg))}
.sr-viewbar{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 20px;border-bottom:1px solid var(--sr-line);flex:none}.sr-segments{display:flex;gap:2px;padding:3px;background:var(--sr-soft);border-radius:9px;max-width:100%;overflow:auto}.sr-segments button{display:flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid transparent;background:transparent;color:var(--sr-muted);font:inherit;font-size:12px;white-space:nowrap;cursor:pointer;border-radius:6px;line-height:20px}.sr-segments button[aria-selected=true]{background:var(--sr-bg);border-color:color-mix(in srgb,var(--sr-line) 75%,transparent);box-shadow:0 1px 3px #11182708;color:var(--sr-text);font-weight:550}.sr-count{font-size:10px;line-height:16px;min-width:16px;border-radius:4px;padding:0 4px;background:color-mix(in srgb,var(--sr-text) 5%,transparent);color:var(--sr-muted);text-align:center}.sr-resource{font-size:11px;color:var(--sr-muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.sr-page-content{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:16px 20px;background:var(--sr-bg)}.sr-page-content:focus-visible{outline:1px solid var(--sr-line);outline-offset:-1px}.sr-page .sr-welcome{max-width:440px;margin:60px auto}.sr-page .sr-orbit{width:44px;height:44px;font-size:24px;margin-bottom:20px;border-radius:12px;color:var(--sr-blue)}.sr-page .sr-welcome h3{font-size:21px}.sr-page .sr-welcome p{font-size:12px}.sr-page .sr-example{background:var(--sr-soft);border:0;text-align:center}.sr-overview-layout{display:grid;grid-template-columns:minmax(0,1fr) 240px;gap:30px;max-width:1150px;margin:auto}.sr-page .sr-card{padding:20px;border-radius:10px;margin-bottom:16px;box-shadow:none}.sr-page .sr-card h3{font-size:14px}.sr-page .sr-metrics{gap:10px}.sr-page .sr-metrics>div{padding:12px 16px;border-radius:8px}.sr-page .sr-metrics strong{font-size:20px}.sr-page .sr-callout{background:var(--sr-soft);border-color:var(--sr-line)}.sr-overview-aside{padding:0 8px;min-width:0}.sr-page .sr-artifacts{padding:0;border:0;margin:0}.sr-artifacts code{display:block;overflow-wrap:anywhere}
.sr-shortcuts{display:flex;align-items:flex-start;gap:12px;min-width:0}.sr-shortcut-label{flex:none;color:var(--sr-muted);font-size:11px;line-height:28px}.sr-shortcuts>.sr-action-row{min-width:0;flex:1}.sr-send{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:32px}.sr-spinner{display:inline-block;flex:none;width:14px;height:14px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:sr-spin .8s linear infinite}.sr-send[data-state=running]>.sr-spinner{position:absolute;width:23px;height:23px;opacity:.65}.sr-send[data-state=running]>svg{width:10px;height:10px;fill:currentColor;stroke:none}.sr-send[data-state=running]>span:not(.sr-spinner){margin-left:25px}.sr-controls .sr-send[data-state=sending],.sr-controls .sr-send[data-state=stopping]{opacity:.8}@keyframes sr-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.sr-spinner{animation:none;border-style:dotted}}
.sr-page .sr-dock{padding:10px 20px 12px;gap:10px;border-top:1px solid var(--sr-line);background:var(--sr-bg);flex:none}.sr-dock .sr-shortcuts{align-items:center}.sr-dock .sr-shortcuts>.sr-action-row{gap:6px;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:thin;padding:1px 2px}.sr-page .sr-dock button{font-size:11px;line-height:18px;border-radius:6px;padding:4px 9px}.sr-dock .sr-shortcuts button:not(.sr-primary){border-color:transparent;color:var(--sr-muted);background:transparent}.sr-dock .sr-shortcuts button:not(.sr-primary):hover{background:var(--sr-soft);color:var(--sr-text)}.sr-page .sr-dock form{display:flex;flex-direction:row;align-items:center;border:1px solid var(--sr-line);border-radius:10px;padding:5px 6px 5px 12px;gap:8px;background:var(--sr-bg)}.sr-dock form:focus-within{border-color:color-mix(in srgb,var(--sr-blue) 45%,var(--sr-line));box-shadow:0 0 0 2px color-mix(in srgb,var(--sr-blue) 5%,transparent)}.sr-dock label{position:absolute;width:1px;min-width:0;height:1px;overflow:hidden;clip:rect(0,0,0,0)}.sr-page .sr-dock textarea{font-size:12px;border:0;background:transparent;resize:none;min-height:32px;max-height:110px;height:32px;padding:6px 0;outline:none;flex:1}.sr-dock textarea:focus-visible{outline:0}.sr-dock textarea::placeholder{color:var(--sr-muted)}.sr-page .sr-dock form button{width:32px;height:32px;padding:6px;flex:none;background:var(--sr-text);color:var(--sr-bg)}.sr-dock p[role=alert]{font-size:11px}.sr-view-status{display:flex;align-items:center;gap:16px;flex:none;margin-left:auto}
/* Progress lanes and evidence outcomes are independent; links preserve plan dependencies. */
.sr-view-exploration{display:flex;overflow:hidden}.sr-exploration-layout{display:flex;gap:18px;flex:1;min-width:0;min-height:0}.sr-canvas-card{display:flex;flex-direction:column;border:1px solid var(--sr-line);border-radius:12px;overflow:hidden;flex:1;min-width:0;min-height:0}.sr-canvas-toolbar{display:flex;justify-content:space-between;gap:16px;align-items:center;padding:9px 12px;background:var(--sr-bg);border-bottom:1px solid var(--sr-line);font-size:10px;flex:none}.sr-legend{display:flex;gap:14px;flex-wrap:wrap;color:var(--sr-muted)}.sr-legend>span{display:flex;align-items:center;gap:6px}.sr-legend i{width:7px;height:7px;border-radius:2px;background:var(--sr-node-color)}.sr-page [data-node-status=open]{--sr-node-color:var(--sr-blue)}.sr-page [data-node-status=supported]{--sr-node-color:var(--sr-green)}.sr-page [data-node-status=refuted]{--sr-node-color:var(--sr-red)}.sr-page [data-node-status=inconclusive]{--sr-node-color:var(--sr-orange)}.sr-canvas{position:relative;overflow:hidden;flex:1;min-height:180px;touch-action:none;cursor:grab;background-color:color-mix(in srgb,var(--sr-text) 5%,var(--sr-bg));background-image:radial-gradient(color-mix(in srgb,var(--sr-muted) 30%,transparent) .7px,transparent .7px);background-size:16px 16px}.sr-canvas[data-dragging=true]{cursor:grabbing}.sr-canvas-world{position:absolute;top:0;left:0;transform-origin:0 0;will-change:transform}.sr-canvas-edges{position:absolute;inset:0;overflow:visible;color:#a9b6cb;pointer-events:none}.sr-edge{stroke:#a9b6cb;stroke-width:1.5}.sr-edge-supported{stroke:#74ccb0}.sr-edge-refuted{stroke:#f29bab}.sr-edge-inconclusive{stroke:#eec077}.sr-canvas-node{position:absolute;width:260px;height:204px;padding:13px 14px;border:1px solid color-mix(in srgb,var(--sr-node-color) 22%,var(--sr-line));border-radius:10px;background:var(--sr-bg);color:var(--sr-text);box-shadow:0 2px 5px #15213c06;text-align:left;display:flex;flex-direction:column;gap:9px;cursor:pointer;font:inherit}.sr-canvas-node:hover{box-shadow:0 3px 12px #15213c12;border-color:var(--sr-node-color)}.sr-canvas-node[aria-pressed=true]{border-color:var(--sr-node-color);box-shadow:0 0 0 2px color-mix(in srgb,var(--sr-node-color) 12%,transparent)}.sr-node-top{display:flex;align-items:center;gap:7px;font-size:10px}.sr-node-top i{width:19px;height:19px;display:grid;place-items:center;border-radius:5px;background:color-mix(in srgb,var(--sr-node-color) 12%,var(--sr-bg));color:var(--sr-node-color)}.sr-node-top i svg{width:12px;height:12px}.sr-node-top strong{font-weight:550;color:var(--sr-muted)}.sr-node-top code{font-size:10px;color:var(--sr-muted);max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sr-node-top .sr-node-state{margin-left:auto;white-space:nowrap}.sr-node-title{font-size:13px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-weight:600;line-height:1.55;flex:none}.sr-node-bottom{display:flex;justify-content:space-between;align-items:center;gap:6px;margin-top:auto}.sr-node-bottom small{font-size:9px;color:var(--sr-muted)}.sr-node-state{font-size:9px;display:inline-flex;align-items:center;gap:4px;color:var(--sr-node-color);background:color-mix(in srgb,var(--sr-node-color) 9%,var(--sr-bg));padding:1px 5px;border-radius:4px}.sr-node-state:before{content:'';width:4px;height:4px;border-radius:50%;background:currentColor}.sr-canvas-tools{position:absolute;bottom:16px;left:16px;display:flex;align-items:center;border:1px solid var(--sr-line);border-radius:7px;background:var(--sr-bg);box-shadow:0 2px 5px #11182706;overflow:hidden}.sr-canvas-tools button{display:grid;place-items:center;width:29px;height:30px;border:0;border-right:1px solid var(--sr-line);background:transparent;color:var(--sr-text);font:18px system-ui;cursor:pointer}.sr-canvas-tools button:hover{background:var(--sr-soft)}.sr-canvas-tools span{min-width:43px;text-align:center;font-size:9px;color:var(--sr-muted)}.sr-minimap{position:absolute;bottom:16px;right:16px;width:130px;height:82px;background:color-mix(in srgb,var(--sr-bg) 90%,transparent);border:1px solid var(--sr-line);border-radius:7px;padding:8px;cursor:crosshair}.sr-minimap svg{width:100%;height:100%}.sr-minimap rect{fill:var(--sr-node-color);opacity:.7}.sr-node-inspector{width:280px;flex:none;overflow:auto;border:1px solid var(--sr-line);border-radius:10px;padding:16px}.sr-node-inspector>header{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}.sr-node-inspector>header h3{margin:0;font-size:12px}.sr-node-inspector>header button{border:0;background:none;color:var(--sr-muted);padding:2px;cursor:pointer}.sr-node-inspector>h3{font-size:14px;margin:12px 0 10px}.sr-node-inspector>p{font-size:12px;line-height:1.85}.sr-node-inspector>h4{font-size:11px;color:var(--sr-muted);font-weight:500;margin-top:26px}.sr-node-inspector .sr-card{padding:12px;font-size:11px;border-radius:8px}.sr-node-inspector .sr-card h3{font-size:11px}.sr-node-inspector .sr-card blockquote{font-size:10px;margin:10px 0;padding:4px 8px}.sr-node-inspector .sr-card a{word-break:break-all}
/* Each connected card stays readable while the canvas is panned or zoomed. */
.sr-page [data-stage=planned],.sr-page [data-stage=untracked]{--sr-stage-color:var(--sr-muted)}.sr-page [data-stage=active]{--sr-stage-color:var(--sr-blue)}.sr-page [data-stage=blocked]{--sr-stage-color:var(--sr-orange)}.sr-page [data-stage=completed]{--sr-stage-color:var(--sr-green)}
.sr-board-summary{display:flex;gap:14px;flex-wrap:wrap;color:var(--sr-muted);min-width:0}.sr-board-summary>span:first-child{color:var(--sr-text);font-weight:550}.sr-canvas-toolbar>.sr-meta{white-space:nowrap}.sr-board-lane{position:absolute;background:color-mix(in srgb,var(--sr-bg) 62%,transparent);border:1px solid color-mix(in srgb,var(--sr-line) 75%,transparent);border-radius:12px;pointer-events:none}.sr-lane-heading{height:48px;display:flex;align-items:center;gap:8px;padding:0 16px;font-size:12px;font-weight:600;color:var(--sr-text)}.sr-lane-heading i{width:7px;height:7px;border-radius:50%;background:var(--sr-stage-color)}.sr-lane-heading b{margin-left:auto;min-width:21px;text-align:center;font:10px/20px system-ui;color:var(--sr-muted);background:var(--sr-bg);border-radius:5px}.sr-lane-empty{display:block;padding:24px 16px;font-size:11px;color:var(--sr-muted)}
.sr-canvas-edges{z-index:1}.sr-edge{opacity:.55}.sr-edge[data-focus=muted]{opacity:.12}.sr-edge[data-focus=related]{opacity:1;stroke:var(--sr-blue);stroke-width:2.2}.sr-canvas-node{z-index:2;gap:7px;border-color:var(--sr-line);border-left:3px solid var(--sr-stage-color)}.sr-canvas-node[data-related=true]{border-color:color-mix(in srgb,var(--sr-blue) 40%,var(--sr-line));border-left-color:var(--sr-stage-color)}.sr-canvas-node[aria-pressed=true]{border-color:var(--sr-blue);box-shadow:0 0 0 2px color-mix(in srgb,var(--sr-blue) 14%,transparent)}.sr-plan-summary{color:var(--sr-muted);font-size:11px;line-height:1.7;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.sr-plan-next{display:block;font-size:10px;color:var(--sr-text);white-space:nowrap;text-overflow:ellipsis;overflow:hidden;line-height:1.6}.sr-progress-label{display:inline-block;margin-right:8px;color:var(--sr-stage-color);font-size:11px;font-weight:550}.sr-plan-next-detail{padding:10px;background:var(--sr-soft);border-radius:6px}.sr-node-inspector>p{overflow-wrap:anywhere}
/* Evidence remains a browsable register, with original material one click away. */
.sr-collection{border:1px solid var(--sr-line);border-radius:11px;overflow:hidden;max-width:1400px;margin:auto}.sr-collection-toolbar{display:flex;align-items:center;gap:10px;padding:16px}.sr-search{display:flex;align-items:center;gap:7px;border:1px solid var(--sr-line);border-radius:7px;padding:6px 10px;color:var(--sr-muted);width:320px;max-width:65%}.sr-search input{border:0;background:transparent;font:inherit;font-size:12px;color:var(--sr-text);outline:none;width:100%;min-width:0}.sr-search input::placeholder{color:var(--sr-muted)}.sr-search:focus-within{border-color:var(--sr-blue)}.sr-collection select{font:inherit;font-size:11px;padding:7px 10px;border:1px solid var(--sr-line);border-radius:6px;background:var(--sr-bg);color:var(--sr-text);min-width:0}.sr-collection-toolbar>.sr-meta{margin-left:auto;white-space:nowrap}.sr-record-head,.sr-record-row>summary{display:grid;grid-template-columns:90px minmax(0,1fr) minmax(100px,25%);align-items:center;gap:20px;padding:13px 20px}.sr-record-head{border-top:1px solid var(--sr-line);background:var(--sr-soft);font-size:11px;color:var(--sr-muted);padding-block:10px}.sr-record-row{border-top:1px solid var(--sr-line)}.sr-record-row>summary{list-style:none;cursor:pointer;min-height:68px}.sr-record-row>summary::-webkit-details-marker{display:none}.sr-record-row>summary:hover{background:var(--sr-soft)}.sr-record-kind{font-size:10px;border-radius:5px;background:var(--sr-soft);padding:2px 7px;justify-self:start;white-space:nowrap;color:var(--sr-muted)}.sr-record-kind[data-kind=counterevidence],.sr-record-kind[data-kind=failed]{color:#d34d67;background:color-mix(in srgb,var(--sr-red) 9%,var(--sr-bg))}.sr-record-kind[data-kind=measurement],.sr-record-kind[data-kind=completed]{color:#169775;background:color-mix(in srgb,var(--sr-green) 9%,var(--sr-bg))}.sr-record-kind[data-kind=source]{color:var(--sr-blue);background:color-mix(in srgb,var(--sr-blue) 8%,var(--sr-bg))}.sr-record-title{min-width:0}.sr-record-title strong{display:block;font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sr-record-title code{font-size:10px;color:var(--sr-muted)}.sr-record-source{color:var(--sr-muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sr-record-detail{padding:0 20px 16px 130px;background:var(--sr-soft)}.sr-record-detail .sr-card{border:0;margin:0;background:var(--sr-bg);border-radius:8px;padding:16px}.sr-collection>.sr-empty{padding:60px 20px}
/* Reports use the host Markdown renderer, with a quiet document outline. */
.sr-view-report{padding:0}.sr-document-layout{display:flex;align-items:flex-start;gap:50px;max-width:1180px;margin:auto;padding:26px 32px}.sr-document{min-width:0;flex:1;max-width:820px;margin:auto}.sr-page .sr-report{font:13px/1.95 system-ui,-apple-system,sans-serif;color:var(--sr-text);overflow-wrap:anywhere}.sr-page .sr-report h1{font-size:24px;font-weight:600;line-height:1.55;letter-spacing:-.5px;margin:0 0 28px}.sr-page .sr-report h2{font-size:17px;font-weight:600;margin:32px 0 14px;line-height:1.6;letter-spacing:0}.sr-page .sr-report h3{font-size:14px;font-weight:600;margin:26px 0 12px}.sr-page .sr-report p{margin:0 0 16px}.sr-page .sr-report ul,.sr-page .sr-report ol{padding-left:22px;margin:12px 0 20px}.sr-page .sr-report li+li{margin-top:7px}.sr-page .sr-report pre{font:11px/1.8 ui-monospace,monospace;background:var(--sr-soft);border:1px solid var(--sr-line);border-radius:8px;padding:16px;overflow:auto;white-space:pre-wrap}.sr-page .sr-report :not(pre)>code{font:11px ui-monospace,monospace;background:var(--sr-soft);border-radius:4px;padding:2px 5px}.sr-page .sr-report blockquote{margin:16px 0;border-left:2px solid var(--sr-line);padding:0 16px;color:var(--sr-muted)}.sr-page .sr-report a{color:var(--sr-blue)}.sr-page .sr-report table{border-collapse:collapse;font-size:11px;width:100%;display:block;overflow:auto}.sr-page .sr-report th,.sr-page .sr-report td{padding:9px 12px;border:1px solid var(--sr-line);text-align:left;min-width:80px}.sr-page .sr-report th{background:var(--sr-soft)}.sr-page .sr-report hr{border:0;border-top:1px solid var(--sr-line);margin:28px 0}.sr-document-limits{border-top:1px solid var(--sr-line);margin-top:36px;padding-top:20px;font-size:12px;color:var(--sr-muted)}.sr-document-limits h3{font-size:12px;color:var(--sr-text);font-weight:550}.sr-outline{width:170px;flex:none;position:sticky;top:24px;padding-left:20px;border-left:1px solid var(--sr-line)}.sr-outline h3{font-size:10px;font-weight:500;color:var(--sr-muted);margin:0 0 14px}.sr-outline button{display:block;width:100%;border:0;text-align:left;background:none;padding:5px 0;font:11px/1.7 system-ui;color:var(--sr-muted);cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sr-outline button:hover{color:var(--sr-blue)}.sr-outline button[data-level=H3]{padding-left:10px}.sr-outline button[data-level=H1]{display:none}
@container(max-width:900px){.sr-resource{display:none}.sr-inspecting .sr-minimap{display:none}.sr-node-inspector{width:240px}.sr-outline{display:none}.sr-document-layout{padding:24px 28px}.sr-overview-layout{grid-template-columns:minmax(0,1fr)}.sr-overview-aside{border-top:1px solid var(--sr-line);padding-top:16px}.sr-legend{gap:10px}.sr-canvas-toolbar>.sr-meta{display:none}}
@container(max-width:620px){.sr-status{font-size:9px;gap:4px}.sr-viewbar{padding:10px 12px;gap:8px}.sr-segments{flex:1;justify-content:space-between}.sr-segments button{padding:4px 7px;font-size:11px;gap:4px}.sr-segments button>svg{display:none}.sr-count{font-size:9px;min-width:14px}.sr-page-content{padding:14px 12px}.sr-page .sr-dock{padding:8px 12px 10px;gap:8px}.sr-dock .sr-shortcuts{gap:8px}.sr-page .sr-dock button{font-size:11px;padding:4px 8px}.sr-status-label{display:none}.sr-status{padding:6px}.sr-dock .sr-shortcut-label{font-size:10px}.sr-view-report{padding:0}.sr-document-layout{padding:22px 20px}.sr-page .sr-report{font-size:12px}.sr-page .sr-report h1{font-size:20px}.sr-page .sr-report h2{font-size:15px}.sr-page .sr-report h3{font-size:13px}.sr-canvas-toolbar{padding:9px 10px}.sr-legend{gap:7px;font-size:9px}.sr-minimap{width:86px;height:57px;right:10px;bottom:10px}.sr-canvas-tools{left:10px;bottom:10px}.sr-exploration-layout{position:relative}.sr-node-inspector{position:absolute;right:0;top:0;bottom:0;z-index:2;width:min(270px,90%);background:var(--sr-bg);box-shadow:-8px 0 25px #1118270b}.sr-collection-toolbar{padding:12px;gap:6px;flex-wrap:wrap}.sr-search{width:auto;max-width:none;flex:1;min-width:120px;padding:5px 8px}.sr-search input{font-size:10px}.sr-collection select{font-size:10px;padding:5px}.sr-collection-toolbar>.sr-meta{font-size:9px}.sr-record-head,.sr-record-row>summary{grid-template-columns:58px minmax(0,1fr);gap:10px;padding:12px}.sr-record-head>span:last-child,.sr-record-source{display:none}.sr-record-title strong{font-size:11px}.sr-record-detail{padding:0 12px 12px}.sr-record-kind{font-size:9px;padding:2px 5px}.sr-page .sr-welcome{margin:28px 14px}.sr-page .sr-welcome h3{font-size:18px}}

/* Overview/report stay concise; other tabs display their own content directly. */
.sr-section-summary{width:100%;max-width:760px;margin:clamp(12px,4vh,40px) auto;padding:0 16px 24px}.sr-brief{margin:0;display:flex;flex-direction:column;gap:24px;overflow-wrap:anywhere}.sr-brief>div{margin:0}.sr-brief dt{font-size:11px;color:var(--sr-muted);margin-bottom:7px}.sr-brief dd{margin:0;font-size:14px;line-height:1.85;white-space:pre-line}.sr-brief .sr-brief-goal dd{font-size:19px;line-height:1.75;font-weight:550;letter-spacing:-.25px}.sr-brief-limits{font-size:12px;line-height:1.8;color:var(--sr-muted);margin:10px 0 0}.sr-inline-group{margin-top:28px}.sr-inline-details{border-top:1px solid var(--sr-line);margin-top:12px}.sr-inline-details>summary{padding:14px 0;cursor:pointer;font-size:12px;color:var(--sr-muted)}.sr-inline-details>summary:focus-visible{outline:2px solid var(--sr-accent);outline-offset:2px}.sr-inline-details[open]>summary{color:var(--sr-text)}.sr-inline-body{padding:4px 0 16px}.sr-inline-body>.sr-card{border:0;padding:0}.sr-inline-body>.sr-artifacts{border:0;margin:0;padding:0}.sr-inline-body .sr-document-layout{padding:0}.sr-report-preview:has(>.sr-inline-details[open]){max-width:1180px}.sr-report-preview{max-width:900px}.sr-report-preview>.sr-inline-details{margin-top:28px}.sr-compact .sr-section-summary{padding:0;margin:8px auto 24px}.sr-compact .sr-brief{gap:18px}.sr-compact .sr-brief dd{font-size:12px}.sr-compact .sr-brief .sr-brief-goal dd{font-size:15px}.sr-compact .sr-brief-limits{font-size:11px}.sr-compact .sr-collection-toolbar{padding:10px;flex-wrap:wrap}.sr-compact .sr-search{width:100%;max-width:100%}.sr-compact .sr-record-head,.sr-compact .sr-record-row>summary{grid-template-columns:55px minmax(0,1fr);gap:8px;padding:12px 10px}.sr-compact .sr-record-source,.sr-compact .sr-record-head>span:last-child{display:none}.sr-compact .sr-record-detail{padding:0 10px 10px}
@container(max-width:620px){.sr-section-summary{margin:12px auto;padding:0 4px 20px}.sr-brief{gap:20px}.sr-brief .sr-brief-goal dd{font-size:16px}.sr-brief dd{font-size:13px}.sr-brief-limits{font-size:11px}.sr-inline-group{margin-top:22px}}

`
    document.head.appendChild(style)
    return () => style.remove()
  }, 'super-research: styles')
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: TYPE_ID, kind: 'super-research', title: () => 'Super Research',
    guide: [{ order: 45, title: () => 'Super Research', description: () => '研究问题、探索路径、证据与可复现实验' }],
  }), 'super-research: tab type')
  const submissions = new WeakSet()
  const actions = sessionId => {
    const binding = ctx.sessions.binding(sessionId)
    if (!binding) throw new Error('Research session is unavailable')
    const current = () => {
      if (ctx.sessions.binding(sessionId) !== binding) throw new Error('Research session changed; reopen this page')
      return binding.session
    }
    return {
      sendResearch: async text => {
        const session = current()
        if (session.getSnapshot().running || submissions.has(session)) throw new Error('Wait for the active research turn')
        submissions.add(session)
        try {
          await paintFeedback()
          // Recheck after yielding so navigation and a newly started turn cannot route stale work.
          if (current() !== session || session.getSnapshot().running) throw new Error('Research session changed or is busy')
          return await session.prompt([{ type: 'text', text }], 'queue')
        }
        finally { submissions.delete(session) }
      },
      stopResearch: () => current().cancel(),
    }
  }
  ctx.slots.inject('conversation.view', () => {
    let removeView
    // The host owns selection in the UI binding; its catalog need not carry `current`.
    const current = ctx.uiSession.adapter.current
    const refresh = () => {
      const list = ctx.sessions.list.getSnapshot()
      const research = list.byId[current.getSnapshot().key]?.projectionValues?.agentPreset === 'super-research'
      if (research && !removeView) removeView = ctx.slots.register({
        name: 'conversation.view', id: TYPE_ID, order: 10, label: () => '研究实验', inject: actions,
      }, ResearchPage)
      else if (!research && removeView) { removeView(); removeView = undefined }
    }
    const unsubscribeList = ctx.sessions.list.subscribe(refresh)
    const unsubscribeCurrent = current.subscribe(refresh)
    refresh()
    return () => { unsubscribeList(); unsubscribeCurrent(); removeView?.() }
  })
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TYPE_ID, inject: actions }, ResearchWorkbench))
}
return { inject, apply, ResearchPage, ResearchWorkbench, ResearchSettings, ResearchActions, graphLayout, boardLayout, safeUrl, briefText }
} })
