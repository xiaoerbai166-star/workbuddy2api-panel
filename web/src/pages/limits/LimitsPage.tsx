// SPDX-FileCopyrightText: 2026 yreidev 与贡献者（见 NOTICE）
// SPDX-License-Identifier: AGPL-3.0-only
// 复制或改写本文件须保留以上声明，并按 NOTICE 的署名条款注明出处：https://github.com/yreidev/workbuddy2api-panel

// 限流预算：模型级冷却明细 + 5 小时滚动窗口消耗跟踪（小特定制）。
// 数据源：pool.ModelLockView（冷却）+ reqlog 归档（消耗），全部只读。
import { Chip, Table } from '@heroui/react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAccountNames } from '../../lib/queries'
import { BusyButton, Empty, Loaded } from '../../components/Feedback'
import { Panel, Stat } from '../../components/Panel'

interface ModelLockRow {
  model: string
  realm: string
  total: number
  servable: number
  locked: number
  state: string
  unlock_at: string
  fully_unlock_at: string
  reason?: string
}
interface BudgetRow {
  uid8: string
  nick: string
  model: string
  credit: number
  n: number
  recent: number
  first_at: number
  status: string
  eta_min: number
}
interface LimitsResp {
  window_hours: number
  safe_line: number
  generated_at: number
  locks: ModelLockRow[]
  budget: BudgetRow[]
  total_credit: number
  over: number
  near: number
}

const num = (n: number) => (n || 0).toLocaleString('zh-CN')
const fmtT = (t: string) => (!t || t.startsWith('0001')) ? '—' : new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })

const LOCK_STATE: Record<string, { label: string; color: 'danger' | 'warning' | 'default' }> = {
  locked: { label: '全锁', color: 'danger' },
  starved: { label: '无可用号', color: 'warning' },
  partial: { label: '部分锁', color: 'default' },
}
const BUDGET_STATUS: Record<string, { label: string; color: 'danger' | 'warning' | 'success' }> = {
  bad: { label: '超额', color: 'danger' },
  warn: { label: '近线', color: 'warning' },
  ok: { label: '正常', color: 'success' },
}

function Acc({ uid8, nick }: { uid8: string; nick: string }) {
  const names = useAccountNames()
  return (
    <div className="flex flex-col">
      <span className="font-medium">{nick || uid8}</span>
      <span className="font-mono text-xs text-muted">{names.note(uid8) ? names.note(uid8) : ''}</span>
    </div>
  )
}

export function LimitsPage() {
  const query = useQuery({ queryKey: ['limits'], queryFn: () => api<LimitsResp>('limits'), refetchInterval: 30_000 })

  return (
    <>
      <Panel
        title="限流预算"
        desc="5 小时滚动窗口消耗 vs 安全线；模型级冷却列出当前被限流的 (域, 模型)。"
        actions={<BusyButton size="sm" variant="secondary" busy={query.isFetching} onPress={() => void query.refetch()}>刷新</BusyButton>}
        contentClassName="flex flex-col gap-4"
      >
        <Loaded query={query} rows={3}>
          {(d) => (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="超额" value={num(d.over)} tone="danger" sub={`≥ ${num(d.safe_line)} 分`} />
              <Stat label="近线" value={num(d.near)} tone="warning" sub="≥ 80% 安全线" />
              <Stat label="窗口消耗" value={num(d.total_credit)} sub={`${d.window_hours} 小时窗口`} />
              <Stat label="安全线" value={num(d.safe_line)} />
            </div>
          )}
        </Loaded>
      </Panel>

      <Panel title="模型冷却明细" desc={`${query.data?.locks.length ?? 0} 个 (域, 模型) 当前被限流`}>
        {query.data?.locks.length ? (
          <Table variant="secondary">
            <Table.ScrollContainer className="max-h-[50dvh] overflow-x-auto">
              <Table.Content aria-label="模型冷却明细" className="min-w-[720px]">
                <Table.Header className="sticky top-0 z-10 bg-surface">
                  <Table.Column isRowHeader>模型</Table.Column>
                  <Table.Column>域</Table.Column>
                  <Table.Column className="text-right">可选</Table.Column>
                  <Table.Column className="text-right">锁定</Table.Column>
                  <Table.Column>状态</Table.Column>
                  <Table.Column>最早解锁</Table.Column>
                  <Table.Column>原因</Table.Column>
                </Table.Header>
                <Table.Body>
                  {query.data.locks.map((r) => (
                    <Table.Row key={r.realm + r.model} id={r.realm + r.model}>
                      <Table.Cell className="font-mono text-xs">{r.model}</Table.Cell>
                      <Table.Cell className="text-xs">{r.realm}</Table.Cell>
                      <Table.Cell className="text-right font-mono tabular-nums">{r.servable}/{r.total}</Table.Cell>
                      <Table.Cell className="text-right font-mono tabular-nums text-danger">{r.locked}</Table.Cell>
                      <Table.Cell>
                        {(() => { const s = LOCK_STATE[r.state]; return s ? <Chip size="sm" variant="soft" color={s.color}>{s.label}</Chip> : <span className="text-muted">{r.state}</span> })()}
                      </Table.Cell>
                      <Table.Cell className="whitespace-nowrap font-mono tabular-nums text-xs">{fmtT(r.unlock_at)}</Table.Cell>
                      <Table.Cell className="break-all text-xs text-muted">{r.reason || '—'}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        ) : (
          <Empty title="当前没有模型被限流" />
        )}
      </Panel>

      <Panel title="窗口消耗" desc="按 (账号, 模型) 聚合的 5 小时消耗，按消耗从高到低">
        {query.data?.budget.length ? (
          <Table variant="secondary">
            <Table.ScrollContainer className="max-h-[60dvh] overflow-x-auto">
              <Table.Content aria-label="窗口消耗" className="min-w-[720px]">
                <Table.Header className="sticky top-0 z-10 bg-surface">
                  <Table.Column isRowHeader>账号</Table.Column>
                  <Table.Column>模型</Table.Column>
                  <Table.Column className="text-right">窗口消耗</Table.Column>
                  <Table.Column className="text-right">笔数</Table.Column>
                  <Table.Column className="text-right">近 1h</Table.Column>
                  <Table.Column>状态</Table.Column>
                  <Table.Column className="text-right">外推</Table.Column>
                </Table.Header>
                <Table.Body>
                  {query.data.budget.map((r) => (
                    <Table.Row key={r.uid8 + r.model} id={r.uid8 + r.model}>
                      <Table.Cell><Acc uid8={r.uid8} nick={r.nick} /></Table.Cell>
                      <Table.Cell className="font-mono text-xs">{r.model}</Table.Cell>
                      <Table.Cell className="text-right font-mono tabular-nums">{num(r.credit)}</Table.Cell>
                      <Table.Cell className="text-right font-mono tabular-nums">{r.n}</Table.Cell>
                      <Table.Cell className="text-right font-mono tabular-nums text-muted">{num(r.recent)}</Table.Cell>
                      <Table.Cell>
                        {(() => { const s = BUDGET_STATUS[r.status]; return s ? <Chip size="sm" variant="soft" color={s.color}>{s.label}</Chip> : <span className="text-muted">{r.status}</span> })()}
                      </Table.Cell>
                      <Table.Cell className="text-right font-mono tabular-nums text-xs">{r.eta_min >= 0 ? `约 ${r.eta_min} 分` : '—'}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        ) : (
          <Empty title="5 小时窗口内没有请求记录" />
        )}
      </Panel>
    </>
  )
}
