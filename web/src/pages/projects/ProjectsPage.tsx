// SPDX-FileCopyrightText: 2026 yreidev 与贡献者（见 NOTICE）
// SPDX-License-Identifier: AGPL-3.0-only
// 复制或改写本文件须保留以上声明，并按 NOTICE 的署名条款注明出处：https://github.com/yreidev/workbuddy2api-panel

// 按项目消耗：聚合 WorkBuddy 客户端各项目（~/.workbuddy/projects）与
// DSH 各工作区（~/.dsh/sessions，按 cwd 归并）的会话消耗（小特定制）。
import { Table } from '@heroui/react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { BusyButton, Empty, Loaded } from '../../components/Feedback'
import { Panel, Stat } from '../../components/Panel'

interface ProjectRow {
  project: string
  sessions: number
  credit: number
  tokens: number
  share: number
  avg: number
  models: string
}
interface DshRow {
  project: string
  cwd: string
  sessions: number
  tokens: number
  in_tokens: number
  out_tokens: number
  cache_tokens: number
  models: string
  first: number
  last: number
  credit: number
  estimated: boolean
}
interface DshResp {
  entries: DshRow[]
  total_credit: number
  total_sessions: number
  total_tokens: number
  scanning: boolean
}
interface ProjectsResp {
  entries: ProjectRow[]
  total_credit: number
  total_sessions: number
  scanning: boolean
  dsh?: DshResp
}

const num = (n: number) => (n || 0).toLocaleString('zh-CN')
const money = (n: number) => (n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const shortDate = (ms: number) => {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const EMPTY_DSH: DshResp = { entries: [], total_credit: 0, total_sessions: 0, total_tokens: 0, scanning: false }

export function ProjectsPage() {
  const query = useQuery({ queryKey: ['projects'], queryFn: () => api<ProjectsResp>('projects'), refetchInterval: 60_000 })

  const dsh = query.data?.dsh ?? EMPTY_DSH

  return (
    <>
      <Panel
        title="按项目消耗"
        desc="WorkBuddy 客户端项目 + DSH 工作区两个来源；WorkBuddy 扫本地 ~/.workbuddy/projects，DSH 扫 ~/.dsh/sessions 并按工作区归并、只计入有用量记录的会话，结果缓存 60 秒。DSH 自身不记积分，消耗按本网关实测费率折算，属估算值。"
        actions={<BusyButton size="sm" variant="secondary" busy={query.isFetching} onPress={() => void query.refetch()}>刷新</BusyButton>}
        contentClassName="flex flex-col gap-4"
      >
        <Loaded query={query} rows={3}>
          {(d) => (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <Stat label="WorkBuddy 消耗" value={money(d.total_credit)} tone="success" />
              <Stat label="DSH 消耗（估）" value={money(d.dsh?.total_credit ?? 0)} />
              <Stat label="合计（含估）" value={money((d.total_credit || 0) + (d.dsh?.total_credit ?? 0))} />
              <Stat label="会话数（WB + DSH）" value={`${num(d.total_sessions)} + ${num(d.dsh?.total_sessions ?? 0)}`} />
              <Stat label="项目 / 工作区" value={`${num(d.entries.length)} / ${num(d.dsh?.entries.length ?? 0)}`} />
            </div>
          )}
        </Loaded>
      </Panel>

      <Panel title="WorkBuddy 项目" desc={query.data?.scanning ? '扫描中…' : `按消耗从高到低，共 ${query.data?.entries.length ?? 0} 个项目`}>
        {query.data?.entries.length ? (
          <Table variant="secondary">
            <Table.ScrollContainer className="max-h-[55dvh] overflow-x-auto">
              <Table.Content aria-label="WorkBuddy 按项目消耗" className="min-w-[720px]">
                <Table.Header className="sticky top-0 z-10 bg-surface">
                  <Table.Column isRowHeader>项目</Table.Column>
                  <Table.Column className="text-right">会话</Table.Column>
                  <Table.Column className="text-right">消耗</Table.Column>
                  <Table.Column className="text-right">占比</Table.Column>
                  <Table.Column className="text-right">平均</Table.Column>
                  <Table.Column className="text-right">Token</Table.Column>
                  <Table.Column>模型</Table.Column>
                </Table.Header>
                <Table.Body>
                  {query.data.entries.map((r) => (
                    <Table.Row key={r.project} id={r.project}>
                      <Table.Cell className="font-medium">{r.project}</Table.Cell>
                      <Table.Cell className="text-right font-mono tabular-nums">{num(r.sessions)}</Table.Cell>
                      <Table.Cell className="text-right font-mono tabular-nums text-success">{num(r.credit)}</Table.Cell>
                      <Table.Cell className="text-right font-mono tabular-nums">{r.share.toFixed(1)}%</Table.Cell>
                      <Table.Cell className="text-right font-mono tabular-nums text-muted">{num(r.avg)}</Table.Cell>
                      <Table.Cell className="text-right font-mono tabular-nums">{num(r.tokens)}</Table.Cell>
                      <Table.Cell className="font-mono text-xs text-muted">{r.models}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        ) : (
          <Empty title="没有扫描到会话">确认 WorkBuddy 客户端有对话记录。</Empty>
        )}
      </Panel>

      <Panel
        title="DSH 工作区"
        desc={
          dsh.scanning
            ? '扫描中…（首次扫描 400+MB 会话语料，约需十几秒）'
            : `按 Token 从高到低，共 ${dsh.entries.length} 个工作区、${num(dsh.total_tokens)} token`
        }
      >
        {dsh.entries.length ? (
          <Table variant="secondary">
            <Table.ScrollContainer className="max-h-[55dvh] overflow-x-auto">
              <Table.Content aria-label="DSH 按工作区消耗" className="min-w-[760px]">
                <Table.Header className="sticky top-0 z-10 bg-surface">
                  <Table.Column isRowHeader>工作区</Table.Column>
                  <Table.Column className="text-right">会话</Table.Column>
                  <Table.Column className="text-right">消耗（估）</Table.Column>
                  <Table.Column className="text-right">Token</Table.Column>
                  <Table.Column className="text-right">输入 / 输出</Table.Column>
                  <Table.Column className="text-right">最近活动</Table.Column>
                  <Table.Column>模型</Table.Column>
                </Table.Header>
                <Table.Body>
                  {dsh.entries.map((r) => (
                    <Table.Row key={r.cwd} id={r.cwd}>
                      <Table.Cell className="font-medium">
                        {r.project}
                        <div className="font-mono text-[11px] text-muted">{r.cwd}</div>
                      </Table.Cell>
                      <Table.Cell className="text-right font-mono tabular-nums">{num(r.sessions)}</Table.Cell>
                      <Table.Cell className="text-right font-mono tabular-nums text-success">
                        {r.estimated ? `~${num(r.credit)}` : '—'}
                      </Table.Cell>
                      <Table.Cell className="text-right font-mono tabular-nums">{num(r.tokens)}</Table.Cell>
                      <Table.Cell className="text-right font-mono tabular-nums text-muted">
                        {num(r.in_tokens)} / {num(r.out_tokens)}
                      </Table.Cell>
                      <Table.Cell className="text-right font-mono tabular-nums text-muted">{shortDate(r.last)}</Table.Cell>
                      <Table.Cell className="font-mono text-xs text-muted">{r.models}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        ) : (
          <Empty title={dsh.scanning ? '正在扫描 DSH 会话' : '没有扫描到 DSH 会话'}>确认本机 ~/.dsh/sessions 下有会话记录。</Empty>
        )}
      </Panel>
    </>
  )
}
