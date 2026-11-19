// SPDX-FileCopyrightText: 2026 yreidev 与贡献者（见 NOTICE）
// SPDX-License-Identifier: AGPL-3.0-only
// 复制或改写本文件须保留以上声明，并按 NOTICE 的署名条款注明出处：https://github.com/yreidev/workbuddy2api-panel

// 账号体检：对齐 7864 的 /health 页 —— 异常速览横幅 + 8 张 KPI 卡 + 风险优先明细表（7 列）。
// 数据来自 /panel/api/overview 的 accounts（体检字段由签到排程落盘成快照，5 秒轮询只读内存）。
import { Card, Chip, Table } from '@heroui/react'
import { accountName } from '../../lib/accounts'
import { Loaded } from '../../components/Feedback'
import { Panel, Stat } from '../../components/Panel'
import { useOverview } from '../../lib/queries'
import { useNow } from '../../lib/hooks'
import type { Account, Overview } from '../../lib/types'

const DAY = 86400000

interface Row {
  acct: Account
  at: number | null
  rt: number | null
  checked: boolean | undefined
  streak: number
  chances: number
  energy: number
  affordable: boolean
  cards: number
  compActive: boolean
  compClaimed: boolean
}

export function HealthPage() {
  const query = useOverview(5000)
  return (
    <Loaded query={query} rows={6}>
      {(d) => <Health data={d} />}
    </Loaded>
  )
}

function Health({ data }: { data: Overview }) {
  const now = useNow(5000)
  const rows = (data.accounts ?? []).map((a) => ({
    acct: a,
    at: a.at_exp ? (a.at_exp - now) / DAY : null,
    rt: a.rt_exp ? (a.rt_exp - now) / DAY : null,
    checked: a.checkin_done,
    streak: a.streak_days ?? 0,
    chances: a.chances ?? 0,
    energy: a.energy ?? 0,
    affordable: !!a.affordable,
    cards: a.cards ?? 0,
    compActive: !!a.comp_active,
    compClaimed: !!a.comp_claimed,
  }))

  if (!rows.length) {
    return (
      <Panel title="账号体检" desc="还没有账号。先在「账号池」添加账号，签到排程跑完后这里会出现体检数据。">
        <Card className="p-8 text-center text-sm text-muted">暂无体检数据</Card>
      </Panel>
    )
  }

  // ---- 8 张 KPI 卡 ----
  const atBad = rows.filter((r) => r.at !== null && r.at < 1)
  const rtBad = rows.filter((r) => r.rt !== null && r.rt <= 7)
  const signed = rows.filter((r) => r.checked === true).length
  const unsigned = rows.filter((r) => r.checked === false).length
  const unknown = rows.filter((r) => r.checked === undefined).length
  const lotAcc = rows.filter((r) => r.chances > 0)
  const lotCnt = lotAcc.reduce((s, r) => s + r.chances, 0)
  const boxAcc = rows.filter((r) => r.affordable)
  const compAcc = rows.filter((r) => r.compActive && !r.compClaimed)
  const cardAcc = rows.filter((r) => r.cards > 0)
  const cardCnt = cardAcc.reduce((s, r) => s + r.cards, 0)
  // 今日全清号：AT≥1 天 且 已签到 且 无盲盒机会 且 无能量盒可开 且 无补偿可领（对齐 7864 clear_cnt）
  const clearCnt = rows.filter((r) => {
    if (r.at !== null && r.at < 1) return false
    if (r.checked === false || r.chances > 0 || r.affordable || (r.compActive && !r.compClaimed)) return false
    return true
  }).length
  const n = rows.length

  // ---- 风险优先排序：AT 危险(<1) → RT 预警(≤7) → 其余登录序 ----
  const sorted = [...rows].sort((a, b) => {
    const key = (r: Row): [number, number] => {
      if (r.at !== null && r.at < 1) return [0, r.at]
      if (r.rt !== null && r.rt <= 7) return [1, r.rt]
      return [2, 0]
    }
    return key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1]
  })

  const dayText = (d: number | null) => (d === null ? '?' : d < 0 ? '已过期' : `${Math.floor(d)} 天`)
  const atTone = (d: number | null) => (d === null ? '' : d > 7 ? 'text-success' : d > 1 ? 'text-warning' : 'text-danger')
  const rtTone = atTone

  return (
    <div className="flex flex-col gap-4">
      {/* 异常速览横幅 */}
      {atBad.length || rtBad.length ? (
        <Card className="gap-2 p-4">
          <b className="text-sm">⚠ 异常速览</b>
          <span className="text-xs text-muted">有掉线风险的账号已自动排到明细表最前</span>
          {atBad.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <b className="text-xs text-danger">AT 快失效（≤1 天）</b>
              {atBad.slice(0, 15).map((r) => (
                <Chip key={r.acct.uid} size="sm" color="danger" variant="soft">{accountName(r.acct)} · {dayText(r.at)}</Chip>
              ))}
              {atBad.length > 15 && <Chip size="sm" variant="soft">…等 {atBad.length} 个</Chip>}
            </div>
          )}
          {rtBad.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <b className="text-xs text-warning">RT 预警（≤7 天）</b>
              {rtBad.slice(0, 15).map((r) => (
                <Chip key={r.acct.uid} size="sm" color="warning" variant="soft">{accountName(r.acct)} · {dayText(r.rt)}</Chip>
              ))}
              {rtBad.length > 15 && <Chip size="sm" variant="soft">…等 {rtBad.length} 个</Chip>}
            </div>
          )}
        </Card>
      ) : (
        <Card className="gap-1 p-4">
          <span className="flex items-center gap-2"><Chip size="sm" color="success" variant="soft">✓ {n} 个账号凭证全部正常</Chip></span>
          <span className="text-xs text-muted">无 AT 快失效、无 RT 预警</span>
        </Card>
      )}

      {/* 8 KPI 卡 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="AT 快失效" value={`${atBad.length} 个`} tone={atBad.length ? 'danger' : 'success'} sub="登录凭证 ≤1 天即掉线" />
        <Stat label="RT 预警" value={`${rtBad.length} 个`} tone={rtBad.length ? 'warning' : 'success'} sub="续期钥匙 ≤7 天，盯 22 点保活" />
        <Stat label="今日签到" value={`${signed} / ${n}`} tone={unsigned ? 'warning' : 'success'} sub={`未签 ${unsigned} · 未探测 ${unknown}`} />
        <Stat label="今日全清号" value={`${clearCnt} 个`} sub="签到+盲盒+能量盒+补偿全办完" />
        <Stat label="盲盒可抽" value={`${lotAcc.length} 号 · ${lotCnt} 次`} tone={lotAcc.length ? 'success' : undefined} sub="免费积分，任务中心可办" />
        <Stat label="能量盒可开" value={`${boxAcc.length} 个`} tone={boxAcc.length ? 'success' : undefined} sub="能量够开盒的账号" />
        <Stat label="补偿可领" value={`${compAcc.length} 个`} tone={compAcc.length ? 'warning' : undefined} sub="活动补偿，注意截止时间" />
        <Stat label="补签卡" value={`${cardAcc.length} 号 · ${cardCnt} 张`} tone={cardAcc.length ? 'success' : undefined} sub="断签可补，攒着不用也行" />
      </div>

      {/* 明细表 */}
      <Panel title="明细" desc={`${n} 个账号 · 风险优先（AT 快失效 → RT 预警 → 其余登录序）`}>
        <Table variant="secondary">
          <Table.Content aria-label="账号体检明细">
            <Table.Header>
              <Table.Column>账号</Table.Column>
              <Table.Column>登录凭证(AT)</Table.Column>
              <Table.Column>续期钥匙(RT)</Table.Column>
              <Table.Column>今日签到</Table.Column>
              <Table.Column>盲盒机会</Table.Column>
              <Table.Column>能量</Table.Column>
              <Table.Column>补签卡</Table.Column>
            </Table.Header>
            <Table.Body>
              {sorted.map((r) => (
                <Table.Row key={r.acct.uid}>
                  <Table.Cell><b>{accountName(r.acct)}</b></Table.Cell>
                  <Table.Cell className={atTone(r.at)}>{dayText(r.at)}</Table.Cell>
                  <Table.Cell className={rtTone(r.rt)}>{dayText(r.rt)}</Table.Cell>
                  <Table.Cell>
                    {r.checked === undefined ? '?' : r.checked ? '✅' : '⬜'}
                    {r.streak > 0 ? ` 连签${r.streak}天` : ''}
                  </Table.Cell>
                  <Table.Cell>{r.chances}</Table.Cell>
                  <Table.Cell>{r.energy}</Table.Cell>
                  <Table.Cell>{r.cards}</Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Content>
        </Table>
      </Panel>

      <Card className="gap-1 p-4">
        <span className="text-xs text-muted">
          说明：RT 由 API2 每晚 22 点自动续期，本面板只读不动它；RT 剩 ≤7 天时请留意 22 点保活是否成功。
          体检数据是签到排程落盘的快照，跑完一轮签到/任务后自动更新。
        </span>
      </Card>
    </div>
  )
}
