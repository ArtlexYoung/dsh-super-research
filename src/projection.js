import { pluginRecordOf } from '@deepseek-ai/dsh-session'
import { RECORD_TYPE, emptyState, stateSchema, eventSchema, digestOf, demand, transition } from './state.js'

export const researchProjection = {
  key: 'superResearch', stateVersion: 1, stateSchema, init: emptyState,
  apply(state, event) {
    if (event.type === 'session/end-seed' && state.status === 'running') {
      return { ...state, status: 'interrupted' }
    }
    const record = pluginRecordOf(event)
    if (record?.type !== RECORD_TYPE) return state
    try {
      const { state: snapshot, ...command } = eventSchema.parse(record.data)
      const next = transition(state, command, event.seq)
      demand(digestOf(next) === digestOf(snapshot), 'Research snapshot does not match its event')
      return snapshot
    }
    catch { return { ...state, status: 'invalid', error: '研究记录损坏或版本不兼容。请检查原始会话；执行已禁用。' } }
  },
  wire: { viewSchema: stateSchema, view: state => state },
}
