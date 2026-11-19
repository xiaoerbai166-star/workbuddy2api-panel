// SPDX-FileCopyrightText: 2026 yreidev 与贡献者（见 NOTICE）
// SPDX-License-Identifier: AGPL-3.0-only
// 复制或改写本文件须保留以上声明，并按 NOTICE 的署名条款注明出处：https://github.com/yreidev/workbuddy2api-panel

// 按项目消耗：聚合 WorkBuddy 客户端各项目（~/.workbuddy/projects）的会话消耗（小特定制）。
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
interface ProjectsResp {
  entries: ProjectRow[]
  total_credit: number
  total_sessions: number
  scanning: boolean
}

const num = (n: number) => (n || 0).toLocaleString('zh-CN')

export function ProjectsPage() {
  const query = useQuery({ queryKey: ['projects'], queryFn: () => api<ProjectsResp>('projects'), refetchInterval: 60_000 })

  return (
    <>
      <Panel
        title="按项目消耗"
        desc="按 WorkBuddy 客户端的项目维度聚合会话消耗；数据扫本地 ~/.workbuddy/projects，结果缓存 60 秒。"
        actions={<BusyButton size="sm" variant="secondary" busy={query.isFetching} onPress={() => void query.refetch()}>刷新</BusyButton>}
        contentClassName="flex flex-col gap-4"
      >
        <Loaded query={query} rows={3}>
          {(d) => (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="总消耗" value={num(d.total_credit)} tone="success" />
              <Stat label="总会话" value={num(d.total_sessions)} />
              <Stat label="项目数" value={num(d.entries.length)} />
            </div>
          )}
        </Loaded>
      </Panel>

      <Panel title="项目明细" desc={query.data?.scanning ? '扫描中…' : `按消耗从高到低，共 ${query.data?.entries.length ?? 0} 个项目`}>
        {query.data?.entries.length ? (
          <Table variant="secondary">
            <Table.ScrollContainer className="max-h-[65dvh] overflow-x-auto">
              <Table.Content aria-label="按项目消耗" className="min-w-[720px]">
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
    </>
  )
}
