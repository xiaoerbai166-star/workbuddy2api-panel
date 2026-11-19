// SPDX-FileCopyrightText: 2026 yreidev 与贡献者（见 NOTICE）
// SPDX-License-Identifier: AGPL-3.0-only
// 复制或改写本文件须保留以上声明，并按 NOTICE 的署名条款注明出处：https://github.com/yreidev/workbuddy2api-panel

// 今日获取积分 + 今日使用·消耗：对齐 7864 总览的两张卡片（本地零点起算）。
// 数据源直接复用网关已有接口：credit_log（积分账本，区间内全量合计不受 limit 限制）+ usage（本地 usage.json 聚合），
// 无需后端新增聚合。5 秒一刷，跟随账号池 overview 的节奏。
import { useMemo, type ReactNode } from 'react'
import { fmtCredit, fmtMs, fmtTok } from '../../lib/format'
import { useCreditLog, useUsage } from '../../lib/queries'
import type { TimeRange } from '../../lib/timerange'
import type { CreditLogResp, UsageResp } from '../../lib/types'
import { InfoTip, Panel } from '../../components/Panel'

const TODAY: TimeRange = { preset: 'today', from: null, to: null }

// 积分来源 → 中文（对齐 7864 归并后的口径；7863 来源更细，逐个映射）
const SOURCE_LABEL: Record<string, string> = {
  checkin: '签到',
  task: '成长任务',
  compensation: '活动补偿',
  travel: '旅行',
  gift: '新手礼包',
  redeem: '连登兑换',
}

/** 今日获取积分 + 今日使用·消耗，两张并排卡片 */
export function DailySummary() {
  const credit = useCreditLog(TODAY, '', '', 1, 5000)
  const usage = useUsage(TODAY, '', 5000)
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      <Panel
        title={
          <span className="flex items-center gap-1">
            今日获取积分
            <InfoTip label="今日获取说明">本地零点起算；分类口径与「积分账本」页一致。签到、成长任务、活动补偿、旅行、新手礼包、连登兑换的进账都会归到这里。</InfoTip>
          </span>
        }
        desc="本地零点起 · 任务引擎每 9 / 21 点自动跑"
      >
        <Earn data={credit.data} />
      </Panel>
      <Panel
        title={
          <span className="flex items-center gap-1">
            今日使用·消耗
            <InfoTip label="今日使用说明">本地零点起算；来自本地 usage.json + 请求日志，扣积分按请求时生效的倍率折算。</InfoTip>
          </span>
        }
        desc="本地零点起 · 消耗 / 请求 / 模型"
      >
        <Use data={usage.data} />
      </Panel>
    </div>
  )
}

function EmptyText({ children }: { children: ReactNode }) {
  return <div className="py-2 text-sm text-muted">{children}</div>
}

/** 今日获取：总积分 + 笔数 + 来源构成 */
function Earn({ data }: { data: CreditLogResp | undefined }) {
  const sources = useMemo(
    () => (data?.by_source ?? []).slice().sort((a, b) => b.credit - a.credit),
    [data],
  )
  if (!data || data.count === 0) return <EmptyText>今日暂无进账</EmptyText>
  const accounts = data.by_account?.length ?? 0
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums text-success">+{fmtCredit(data.total)}</span>
        <span className="text-xs text-muted">
          {data.count} 笔 · {accounts} 个账号
        </span>
      </div>
      {sources.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {sources.map((s) => (
            <span key={s.key} className="text-muted">
              {SOURCE_LABEL[s.key] ?? s.key} <b className="font-mono tabular-nums text-foreground">+{fmtCredit(s.credit)}</b>
              <span> · {s.count} 笔</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

/** 今日使用：总消耗 + 请求 / 成功率 / tokens / 平均耗时 + 模型 top6 */
function Use({ data }: { data: UsageResp | undefined }) {
  const models = useMemo(
    () =>
      (data?.by_model ?? [])
        .filter((m) => (m.credits ?? 0) !== 0)
        .sort((a, b) => Math.abs(b.credits ?? 0) - Math.abs(a.credits ?? 0))
        .slice(0, 6),
    [data],
  )
  const t = data?.totals
  if (!t || t.requests === 0) return <EmptyText>今日还没有使用</EmptyText>
  const ok = t.requests > 0 ? Math.round((1 - t.errors / t.requests) * 1000) / 10 : 100
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">{fmtCredit(t.credits)}</span>
        <span className="text-xs text-muted">
          {t.requests} 请求 · 成功率 {ok}% · {fmtTok(t.total_tokens)} tokens · 平均 {fmtMs(t.avg_latency_ms)}
        </span>
      </div>
      {models.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {models.map((m) => (
            <span key={m.key} className="text-muted">
              {m.key} <b className="font-mono tabular-nums text-foreground">{fmtCredit(m.credits)}</b>
              <span> · {m.requests} 请求</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
