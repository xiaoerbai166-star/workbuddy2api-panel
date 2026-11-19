// SPDX-FileCopyrightText: 2026 yreidev 与贡献者（见 NOTICE）
// SPDX-License-Identifier: AGPL-3.0-only
// 复制或改写本文件须保留以上声明，并按 NOTICE 的署名条款注明出处：https://github.com/yreidev/workbuddy2api-panel

// WorkBuddy 对话：扫本机 WorkBuddy 客户端会话 jsonl，列出每个会话的消耗（小特定制）。
import { Chip, Table } from '@heroui/react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { BusyButton, Empty, Loaded } from '../../components/Feedback'
import { Panel, Stat } from '../../components/Panel'

interface WBchat {
  cid: string
  project: string
  title: string
  start: number
  end: number
  n_req: number
  credit: number
  tokens: number
  models: string
}
interface WbchatsResp {
  entries: WBchat[]
  count: number
  total: number
  scanning: boolean
}

const num = (n: number) => (n || 0).toLocaleString('zh-CN')
const fmtMs = (ms: number) => (ms ? new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—')

export function WbchatsPage() {
  const query = useQuery({ queryKey: ['wbchats'], queryFn: () => api<WbchatsResp>('wbchats?limit=1000'), refetchInterval: 60_000 })

  return (
    <>
      <Panel
        title="WorkBuddy 对话"
        desc="扫本机 ~/.workbuddy/projects 下的会话 jsonl；只列消耗最高的前 1000 个会话。"
        actions={<BusyButton size="sm" variant="secondary" busy={query.isFetching} onPress={() => void query.refetch()}>刷新</BusyButton>}
        contentClassName="flex flex-col gap-4"
      >
        <Loaded query={query} rows={3}>
          {(d) => (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="会话数" value={num(d.count)} sub={`共 ${num(d.total)} 个`} />
              <Stat label="总消耗" value={num(d.entries.reduce((s, r) => s + r.credit, 0))} tone="success" />
              <Stat label="状态" value={d.scanning ? '扫描中' : '已就绪'} sub={d.scanning ? '首次扫描可能较慢' : '结果缓存 60 秒'} />
            </div>
          )}
        </Loaded>
      </Panel>

      <Panel title="会话明细" desc="按消耗从高到低">
        {query.data?.entries.length ? (
          <Table variant="secondary">
            <Table.ScrollContainer className="max-h-[65dvh] overflow-x-auto">
              <Table.Content aria-label="WorkBuddy 对话" className="min-w-[760px]">
                <Table.Header className="sticky top-0 z-10 bg-surface">
                  <Table.Column isRowHeader>标题</Table.Column>
                  <Table.Column>项目</Table.Column>
                  <Table.Column className="text-right">请求</Table.Column>
                  <Table.Column className="text-right">消耗</Table.Column>
                  <Table.Column className="text-right">Token</Table.Column>
                  <Table.Column>模型</Table.Column>
                  <Table.Column>时间</Table.Column>
                </Table.Header>
                <Table.Body>
                  {query.data.entries.map((r) => (
                    <Table.Row key={r.cid} id={r.cid}>
                      <Table.Cell className="max-w-[320px]"><span className="block truncate" title={r.title}>{r.title}</span></Table.Cell>
                      <Table.Cell><Chip size="sm" variant="soft">{r.project}</Chip></Table.Cell>
                      <Table.Cell className="text-right font-mono tabular-nums">{num(r.n_req)}</Table.Cell>
                      <Table.Cell className="text-right font-mono tabular-nums text-success">{num(r.credit)}</Table.Cell>
                      <Table.Cell className="text-right font-mono tabular-nums">{num(r.tokens)}</Table.Cell>
                      <Table.Cell className="font-mono text-xs text-muted">{r.models}</Table.Cell>
                      <Table.Cell className="whitespace-nowrap font-mono tabular-nums text-xs">{fmtMs(r.start)}</Table.Cell>
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
    </>
  )
}
