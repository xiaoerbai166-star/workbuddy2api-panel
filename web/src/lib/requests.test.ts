// SPDX-FileCopyrightText: 2026 yreidev 与贡献者（见 NOTICE）
// SPDX-License-Identifier: AGPL-3.0-only
// 复制或改写本文件须保留以上声明，并按 NOTICE 的署名条款注明出处：https://github.com/yreidev/workbuddy2api-panel

// 从上游 internal/panel/frontend_test.go 的 TestAppJSRequestLogFormatting / TestAppJSRequestMatch 平移（期望值原样保留）。
import { describe, expect, it } from 'vitest'
import { cacheLevel, cacheRateText, clusterTurns, matchRequest, outcomeLevel, requestCredit, requestLogText, summarizeRequests, type RequestFilter } from './requests'
import type { RequestEvent } from './types'

describe('请求指标', () => {
  it('摘要行紧凑可读，带调用来源与缓存命中；来源缺失时以 — 兜底', () => {
    const time = new Date(2026, 8, 28, 14, 5, 6).toISOString()
    const good: RequestEvent = {
      time, status: 200, ok: true, outcome: 'success', path: '/v1/chat/completions', model: 'glm-5.3', account: '账号(uid8)',
      duration_ms: 1250, total_tokens: 2300, credit_known: true, credit: 0.12, request_id: 'req-1',
      client_ip: '203.0.113.7', user_agent: 'python-requests/2.31.0',
    }
    const noSource: RequestEvent = { ...good, request_id: 'req-3', client_ip: '', user_agent: '' }
    const cached: RequestEvent = { ...good, request_id: 'req-2', cache_hit_tokens: 2257, cache_miss_tokens: 43 }
    const keyed: RequestEvent = { ...good, request_id: 'req-4', api_key: '张三' }
    expect(requestLogText(good)).toBe('14:05:06 | 200 成功 | glm-5.3 | 账号(uid8) | 203.0.113.7 | python-requests/2.31.0 | 1.25s | 2.3k tok | 0.12 credit | req-1')
    expect(requestLogText(noSource)).toBe('14:05:06 | 200 成功 | glm-5.3 | 账号(uid8) | — | — | 1.25s | 2.3k tok | 0.12 credit | req-3')
    expect(requestLogText(cached)).toBe('14:05:06 | 200 成功 | glm-5.3 | 账号(uid8) | 203.0.113.7 | python-requests/2.31.0 | 1.25s | 2.3k tok | 0.12 credit | 命中 98.1% | req-2')
    expect(requestLogText({ ...good, status: 400, ok: false, outcome: 'http_error', error: 'prompt is too long' }))
      .toBe('14:05:06 | 400 HTTP 错误 | 原因 prompt is too long | glm-5.3 | 账号(uid8) | 203.0.113.7 | python-requests/2.31.0 | 1.25s | 2.3k tok | 0.12 credit | req-1')
    expect(requestLogText(keyed)).toBe('14:05:06 | 200 成功 | glm-5.3 | 账号(uid8) | 密钥 张三 | 203.0.113.7 | python-requests/2.31.0 | 1.25s | 2.3k tok | 0.12 credit | req-4')
    expect(requestLogText({ ...keyed, proxy: '香港1' }))
      .toBe('14:05:06 | 200 成功 | glm-5.3 | 账号(uid8) | 代理 香港1 | 密钥 张三 | 203.0.113.7 | python-requests/2.31.0 | 1.25s | 2.3k tok | 0.12 credit | req-4')
    expect(outcomeLevel('success')).toBe('ok')
    expect(outcomeLevel('http_error')).toBe('error')
    expect(outcomeLevel('interrupted')).toBe('warn')
  })

  it('没返回积分时不显示成 0', () => {
    const e: RequestEvent = { time: '', request_id: '', path: '', status: 200, ok: true, outcome: 'success', duration_ms: 0, prompt_tokens: 3, completion_tokens: 4, credit_known: false }
    expect(requestLogText(e)).toBe('— | 200 成功 | — | — | — | — | — | 7 tok | credit — | —')
    // 扣了 0 积分：后端 omitempty 省掉 credit 字段，但 credit_known 为真
    expect(requestCredit({ ...e, credit_known: true })).toBe('0 credit')
  })

  it('缓存命中率：没有样本显示 —，按 90% / 80% 分级', () => {
    expect(cacheRateText(0, 0)).toBe('—')
    expect(cacheRateText(9, 1)).toBe('90%')
    expect([cacheLevel(95), cacheLevel(85), cacheLevel(50)]).toEqual(['ok', 'warn', 'error'])
  })

  it('筛选：IP / UA / 模型 / 账号 / 代理 / 密钥 / 失败原因 / 请求 ID 包含匹配（空格分词 AND），结果精确匹配', () => {
    const base = { outcome: 'success', client_ip: '203.0.113.7', user_agent: 'python-requests/2.31.0', model: 'cn:glm-5.3', account: '示例(uid8)', proxy: '香港1', api_key: '张三', request_id: 'req-1' } as RequestEvent
    const other = { outcome: 'http_error', client_ip: '198.51.100.4', user_agent: 'Mozilla/5.0 Chrome/120', model: 'global:hy3', account: '甲(uid9)', error: 'Prompt too long: 200000 tokens', request_id: 'req-2' } as RequestEvent
    const pick = (f: RequestFilter) => [base, other].filter((e) => matchRequest(e, f)).map((e) => e.request_id)
    expect(pick({ q: '', outcome: '' })).toEqual(['req-1', 'req-2'])
    expect(pick({ q: '203.0.113', outcome: '' })).toEqual(['req-1'])
    expect(pick({ q: 'chrome/120', outcome: '' })).toEqual(['req-2'])
    expect(pick({ q: 'glm', outcome: '' })).toEqual(['req-1'])
    expect(pick({ q: '张三', outcome: '' })).toEqual(['req-1'])
    expect(pick({ q: '香港', outcome: '' })).toEqual(['req-1'])
    // q 不匹配结果（结果有独立的下拉）
    expect(pick({ q: 'glm success', outcome: '' })).toEqual([])
    expect(pick({ q: 'glm chrome', outcome: '' })).toEqual([])
    expect(pick({ q: '', outcome: 'http_error' })).toEqual(['req-2'])
    expect(pick({ q: '198.51', outcome: 'http_error' })).toEqual(['req-2'])
    expect(pick({ q: 'prompt too', outcome: '' })).toEqual(['req-2'])
    // 账号现在的显示名（换成了备注）也能搜到，记录里的旧昵称照样能搜
    expect([base, other].filter((e) => matchRequest(e, { q: '主力', outcome: '' }, e === base ? '主力(uid8)' : '')).map((e) => e.request_id)).toEqual(['req-1'])
    expect(matchRequest(base, { q: '示例', outcome: '' }, '主力(uid8)')).toBe(true)
  })
})

describe('请求日志聚合', () => {
  const mk = (o: Partial<RequestEvent>): RequestEvent => ({
    time: '', request_id: '', path: '', status: 200, ok: true, outcome: 'success',
    duration_ms: 0, credit_known: true, ...o,
  })

  it('筛选汇总：命中/积分/发→回/缓存/失败中断/平均耗时与首字', () => {
    const rows: RequestEvent[] = [
      mk({ request_id: 'a', credit: 1.5, prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, cache_hit_tokens: 90, cache_miss_tokens: 10, duration_ms: 1000, ttfb_ms: 200 }),
      mk({ request_id: 'b', credit: 2.5, prompt_tokens: 200, completion_tokens: 100, total_tokens: 300, duration_ms: 3000, ttfb_ms: 800 }),
      mk({ request_id: 'c', outcome: 'http_error', ok: false, duration_ms: 500 }),
      mk({ request_id: 'd', outcome: 'interrupted', ok: false, duration_ms: 500 }),
    ]
    const s = summarizeRequests(rows)
    expect(s.n).toBe(4)
    expect(s.credit).toBeCloseTo(4.0)
    expect(s.prompt).toBe(300)
    expect(s.completion).toBe(150)
    expect(s.total).toBe(450)
    expect(s.cacheHit).toBe(90)
    expect(s.failed).toBe(1)
    expect(s.interrupted).toBe(1)
    expect(s.avgDurationMs).toBeCloseTo((1000 + 3000 + 500 + 500) / 4)
    expect(s.avgTtfbMs).toBeCloseTo((200 + 800) / 2)
  })

  it('会话聚类：同模型+间隔≤30分+上下文链聚成一个，不同模型分开，按总积分降序', () => {
    const t0 = Date.parse('2026-01-01T00:00:00Z')
    const min = 60_000
    const rows: RequestEvent[] = [
      mk({ request_id: 'a1', model: 'glm', time: new Date(t0).toISOString(), credit: 1, prompt_tokens: 100, completion_tokens: 100, total_tokens: 200, duration_ms: 1000, account: '甲(uid1)' }),
      mk({ request_id: 'a2', model: 'glm', time: new Date(t0 + 10 * min).toISOString(), credit: 2, prompt_tokens: 200, completion_tokens: 200, total_tokens: 400, duration_ms: 2000, account: '乙(uid2)' }),
      mk({ request_id: 'a3', model: 'glm', time: new Date(t0 + 20 * min).toISOString(), credit: 3, prompt_tokens: 300, completion_tokens: 300, total_tokens: 600, duration_ms: 3000, account: '甲(uid1)' }),
      mk({ request_id: 'b1', model: 'kimi', time: new Date(t0 + 5 * min).toISOString(), credit: 10, prompt_tokens: 100, completion_tokens: 100, total_tokens: 200, duration_ms: 500 }),
    ]
    const turns = clusterTurns(rows)
    expect(turns.map((t) => t.model)).toEqual(['kimi', 'glm'])
    const glm = turns.find((t) => t.model === 'glm')!
    expect(glm.n).toBe(3)
    expect(glm.credit).toBeCloseTo(6)
    expect(glm.tokens).toBe(1200)
    expect(glm.peakDurationMs).toBe(3000)
    expect(glm.accounts).toEqual(['乙', '甲'])
  })

  it('会话聚类：间隔超过 30 分钟或上下文链断裂会拆成新会话', () => {
    const t0 = Date.parse('2026-01-01T00:00:00Z')
    const min = 60_000
    const rows: RequestEvent[] = [
      mk({ request_id: 'x1', model: 'glm', time: new Date(t0).toISOString(), prompt_tokens: 100, completion_tokens: 100, total_tokens: 200, duration_ms: 0 }),
      // 间隔 31 分钟 → 拆开
      mk({ request_id: 'x2', model: 'glm', time: new Date(t0 + 31 * min).toISOString(), prompt_tokens: 200, completion_tokens: 200, total_tokens: 400, duration_ms: 0 }),
    ]
    expect(clusterTurns(rows)).toHaveLength(2)

    // 间隔 5 分钟但 prompt 暴涨（超出上下文链上界）→ 拆开
    const rows2: RequestEvent[] = [
      mk({ request_id: 'y1', model: 'glm', time: new Date(t0).toISOString(), prompt_tokens: 100, completion_tokens: 100, total_tokens: 200, duration_ms: 0 }),
      mk({ request_id: 'y2', model: 'glm', time: new Date(t0 + 5 * min).toISOString(), prompt_tokens: 999999, completion_tokens: 100, total_tokens: 1000099, duration_ms: 0 }),
    ]
    expect(clusterTurns(rows2)).toHaveLength(2)
  })
})
