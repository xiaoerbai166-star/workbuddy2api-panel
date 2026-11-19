// SPDX-FileCopyrightText: 2026 yreidev 与贡献者（见 NOTICE）
// SPDX-License-Identifier: AGPL-3.0-only
// 复制或改写本文件须保留以上声明，并按 NOTICE 的署名条款注明出处：https://github.com/yreidev/workbuddy2api-panel

// DSH 对话：从请求归档聚合 DeepSeekRuntime 客户端（ua=deepseek-harness）的消耗（小特定制）。
// DSH 会话正文存 Electron 内部，无法像 WorkBuddy jsonl 那样直接扫，这里从消耗维度回答「DSH 烧了多少分」。
import { Table } from '@heroui/react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAccountNames } from '../../lib/queries'
import { BusyButton, Empty, Loaded } from '../../components/Feedback'
import { Panel, Stat } from '../../components/Panel'

interface DshUsageRow {
  uid8: string
  nick: string
  model: string
  credit: number
  n: number
  tokens: number
  first: number
  last: number
}
interface DshResp {
  entries: DshUsageRow[]
  total_credit: number
  window_hours: number
  generated_at: number
}

const num = (n: number) => (n || 0).toLocaleString('zh-CN')
const fmtMs = (ms: number) => (ms ? new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—')

function Acc({ uid8, nick }: { uid8: string; nick: string }) {
  const names = useAccountNames()
  return (
    <div className="flex flex-col">
      <span className="font-medium">{names.name(uid8, nick)}</span>
      <span className="font-mono text-xs text-muted">{uid8}</span>
    </div>
  )
}

export function DshPage() {
  const query = useQuery({ queryKey: ['dsh'], queryFn: () => api<DshResp>('dsh'), refetchInterval: 60_000 })

  return (
    <>
      <Panel
        title="DSH 对话"
        desc="DeepSeekRuntime 客户端经本网关的模型消耗（ua=deepseek-harness），按 (账号, 模型) 聚合。"
        actions={<BusyButton size="sm" variant="secondary" busy={query.isFetching} onPress={() => void query.refetch()}>刷新</BusyButton>}
        contentClassName="flex flex-col gap-4"
      >
        <Loaded query={query} rows={3}>
          {(d) => (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="总消耗" value={num(d.total_credit)} tone="success" />
              <Stat label="窗口" value={`${d.window_hours} 小时`} />
              <Stat label="组合数" value={num(d.entries.length)} sub="账号 × 模型" />
            </div>
          )}
        </Loaded>
      </Panel>

      <Panel title="消耗明细" desc="按消耗从高到低">
        {query.data?.entries.length ? (
          <Table variant="secondary">
            <Table.ScrollContainer className="max-h-[65dvh] overflow-x-auto">
              <Table.Content aria-label="DSH 对话消耗" className="min-w-[720px]">
                <Table.Header className="sticky top-0 z-10 bg-surface">
                  <Table.Column isRowHeader>账号</Table.Column>
                  <Table.Column>模型</Table.Column>
                  <Table.Column className="text-right">消耗</Table.Column>
                  <Table.Column className="text-right">笔数</Table.Column>
                  <Table.Column className="text-right">Token</Table.Column>
                  <Table.Column>首次</Table.Column>
                  <Table.Column>最近</Table.Column>
                </Table.Header>
                <Table.Body>
                  {query.data.entries.map((r) => (
                    <Table.Row key={r.uid8 + r.model} id={r.uid8 + r.model}>
                      <Table.Cell><Acc uid8={r.uid8} nick={r.nick} /></Table.Cell>
                      <Table.Cell className="font-mono text-xs">{r.model}</Table.Cell>
                      <Table.Cell className="text-right font-mono tabular-nums text-success">{num(r.credit)}</Table.Cell>
                      <Table.Cell className="text-right font-mono tabular-nums">{num(r.n)}</Table.Cell>
                      <Table.Cell className="text-right font-mono tabular-nums">{num(r.tokens)}</Table.Cell>
                      <Table.Cell className="whitespace-nowrap font-mono tabular-nums text-xs">{fmtMs(r.first)}</Table.Cell>
                      <Table.Cell className="whitespace-nowrap font-mono tabular-nums text-xs">{fmtMs(r.last)}</Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        ) : (
          <Empty title="近 24 小时没有 DSH 消耗" />
        )}
      </Panel>
    </>
  )
}
