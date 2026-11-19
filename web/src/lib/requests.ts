// SPDX-FileCopyrightText: 2026 yreidev 与贡献者（见 NOTICE）
// SPDX-License-Identifier: AGPL-3.0-only
// 复制或改写本文件须保留以上声明，并按 NOTICE 的署名条款注明出处：https://github.com/yreidev/workbuddy2api-panel

// 请求指标（/panel/api/request_metrics、request_logs）的展示口径，与上游旧面板一致（见 requests.test.ts）。
import { fmtMs, fmtTok } from './format'
import type { RequestEvent } from './types'

export const OUTCOME_LABEL: Record<string, string> = {
  success: '成功', http_error: 'HTTP 错误', stream_error: '流错误', interrupted: '中断',
}

/** 结果的级别：HTTP 错误、流错误算错误，中断算警告 */
export function outcomeLevel(outcome: string): 'error' | 'warn' | 'ok' {
  if (outcome === 'http_error' || outcome === 'stream_error') return 'error'
  if (outcome === 'interrupted') return 'warn'
  return 'ok'
}

export function requestTokens(e: RequestEvent): number {
  return Number(e.total_tokens || 0) || Number(e.prompt_tokens || 0) + Number(e.completion_tokens || 0)
}

/** 积分：上游明确返回了才显示（没返回不等于扣了 0）。返回了 0 时后端省略 credit 字段（omitempty），按 0 显示 */
export function requestCredit(e: RequestEvent): string {
  if (!e.credit_known) return 'credit —'
  const v = Number(e.credit ?? 0)
  return Number.isFinite(v) ? String(Number(v.toFixed(2))) + ' credit' : 'credit —'
}

/** 缓存命中率 = 命中 / (命中 + 未命中)，百分数；上游没返回这一项时为 null */
export function cacheRate(hit?: number | null, miss?: number | null): number | null {
  const h = Number(hit || 0), total = h + Number(miss || 0)
  return total ? h / total * 100 : null
}

/** 缓存命中率文案：98.1%；没有样本时 — */
export function cacheRateText(hit?: number | null, miss?: number | null): string {
  const r = cacheRate(hit, miss)
  return r == null ? '—' : String(Math.round(r * 10) / 10) + '%'
}

/** 命中率的健康度：≥90% 好 / 80–90% 一般 / <80% 差（低命中意味着费用成倍放大） */
export function cacheLevel(rate: number): 'ok' | 'warn' | 'error' {
  return rate >= 90 ? 'ok' : rate >= 80 ? 'warn' : 'error'
}

/** 一行文字摘要（屏幕阅读器与悬停提示用；表格按列展示同样的内容） */
export function requestLogText(e: RequestEvent): string {
  const when = e.time ? new Date(e.time).toLocaleTimeString('zh-CN', { hour12: false }) : '—'
  const cache = cacheRateText(e.cache_hit_tokens, e.cache_miss_tokens)
  return [
    when,
    String(e.status || '—') + ' ' + (OUTCOME_LABEL[e.outcome] || e.outcome || '—'),
    e.error ? '原因 ' + e.error : '',
    e.model || '—',
    e.account || '—',
    e.proxy ? '代理 ' + e.proxy : '',
    e.api_key ? '密钥 ' + e.api_key : '',
    e.client_ip || '—',
    e.user_agent || '—',
    fmtMs(e.duration_ms),
    fmtTok(requestTokens(e)) + ' tok',
    requestCredit(e),
    cache === '—' ? '' : '命中 ' + cache,
    e.request_id || '—',
  ].filter(Boolean).join(' | ')
}

export interface RequestFilter {
  /** 对 IP / UA / 模型 / 账号 / 密钥 / 失败原因 / 请求 ID 做包含匹配，空格分词后逐个 AND */
  q: string
  /** 结果精确匹配，空 = 不筛 */
  outcome: string
}

/**
 * 请求记录筛选：只在已拉取的条目上做，不发新请求。account 是账号现在的显示名（记录里存的是当时的昵称，
 * 换成备注后的名字也要搜得到）。
 */
export function matchRequest(e: RequestEvent, f: RequestFilter, account = ''): boolean {
  if (f.outcome && e.outcome !== f.outcome) return false
  const kws = f.q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!kws.length) return true
  const text = [e.client_ip, e.user_agent, e.model, e.account, account, e.proxy, e.api_key, e.error, e.request_id].filter(Boolean).join(' ').toLowerCase()
  return kws.every((kw) => text.includes(kw))
}

// ---- 请求日志聚合（对齐 7864 sidecar 的「筛选汇总条」与「会话消耗 TOP」）----

/** 筛选汇总：对一组请求做聚合。credit 只累计上游明确返回的（字段缺失按 0，与 7864 口径一致）。 */
export interface RequestSummary {
  n: number
  credit: number
  prompt: number
  completion: number
  total: number
  cacheHit: number
  failed: number
  interrupted: number
  avgDurationMs: number
  avgTtfbMs: number
}

export function summarizeRequests(es: RequestEvent[]): RequestSummary {
  const s: RequestSummary = {
    n: 0, credit: 0, prompt: 0, completion: 0, total: 0, cacheHit: 0,
    failed: 0, interrupted: 0, avgDurationMs: 0, avgTtfbMs: 0,
  }
  let durSum = 0, ttfbSum = 0, ttfbN = 0
  for (const e of es) {
    s.n++
    s.credit += Number(e.credit || 0)
    s.prompt += Number(e.prompt_tokens || 0)
    s.completion += Number(e.completion_tokens || 0)
    s.total += Number(e.total_tokens || 0)
    s.cacheHit += Number(e.cache_hit_tokens || 0)
    if (e.outcome === 'http_error' || e.outcome === 'stream_error') s.failed++
    else if (e.outcome === 'interrupted') s.interrupted++
    durSum += Number(e.duration_ms || 0)
    if (e.ttfb_ms != null && e.ttfb_ms > 0) { ttfbSum += e.ttfb_ms; ttfbN++ }
  }
  s.avgDurationMs = s.n ? durSum / s.n : 0
  s.avgTtfbMs = ttfbN ? ttfbSum / ttfbN : 0
  return s
}

/** 会话级消耗聚合（启发式）：同模型 + 间隔≤gapSec + 上下文链，估算一次对话的总消耗。
 *  对应 WorkBuddy 客户端一个项目/会话跑完全程的消耗——Agent 任务工具循环耗时长，
 *  窗口放宽到 30 分钟级；相邻对话上下文相似时可能粘连，结果为估算。 */
export interface TurnCluster {
  model: string
  first: number
  last: number
  credit: number
  n: number
  tokens: number
  peakDurationMs: number
  accounts: string[]
}

export function clusterTurns(es: RequestEvent[], gapSec = 1800): TurnCluster[] {
  type Row = {
    epoch: number
    model: string
    acc: string
    credit: number
    prompt: number
    completion: number
    tokens: number
    duration: number
  }
  const rows: Row[] = []
  for (const e of es) {
    const epoch = e.time ? new Date(e.time).getTime() : 0
    if (!Number.isFinite(epoch) || epoch <= 0) continue
    rows.push({
      epoch,
      model: e.model || '?',
      acc: (e.account || '?').split('(')[0],
      credit: Number(e.credit || 0),
      prompt: Number(e.prompt_tokens || 0),
      completion: Number(e.completion_tokens || 0),
      tokens: Number(e.total_tokens || 0),
      duration: Number(e.duration_ms || 0),
    })
  }
  rows.sort((a, b) => a.epoch - b.epoch)

  type Turn = {
    model: string
    lastT: number
    lastP: number
    lastC: number
    credit: number
    tokens: number
    peak: number
    reqs: Row[]
  }
  const turns: Turn[] = []
  for (const r of rows) {
    let placed = false
    for (let i = turns.length - 1; i >= Math.max(0, turns.length - 20); i--) {
      const t = turns[i]
      if (t.model !== r.model || r.epoch - t.lastT > gapSec * 1000 || !t.lastP) continue
      const lo = t.lastP * 0.1
      const hi = t.lastP + t.lastC * 3 + 50000
      if (r.prompt < lo || r.prompt > hi) continue
      t.reqs.push(r)
      t.lastT = r.epoch
      t.lastP = r.prompt
      t.lastC = r.completion
      t.credit += r.credit
      t.tokens += r.tokens
      t.peak = Math.max(t.peak, r.duration)
      placed = true
      break
    }
    if (!placed) {
      turns.push({
        model: r.model, lastT: r.epoch, lastP: r.prompt, lastC: r.completion,
        credit: r.credit, tokens: r.tokens, peak: r.duration, reqs: [r],
      })
    }
  }

  return turns
    .map((t) => ({
      model: t.model,
      first: t.reqs[0].epoch,
      last: t.reqs[t.reqs.length - 1].epoch,
      credit: t.credit,
      n: t.reqs.length,
      tokens: t.tokens,
      peakDurationMs: t.peak,
      accounts: Array.from(new Set(t.reqs.map((r) => r.acc))).sort(),
    }))
    .sort((a, b) => b.credit - a.credit)
}
