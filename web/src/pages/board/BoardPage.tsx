// SPDX-FileCopyrightText: 2026 yreidev 与贡献者（见 NOTICE）
// SPDX-License-Identifier: AGPL-3.0-only
// 复制或改写本文件须保留以上声明，并按 NOTICE 的署名条款注明出处：https://github.com/yreidev/workbuddy2api-panel

// 账号总表：把池状态与凭证 JWT 档案合并成「一行一账号」的宽表（小特定制）。
// 后端 /panel/api/board 恒给全量字段，本页只挑关键列渲染，支持状态筛选 / 关键字搜索 / CSV 导出。
import { useMemo, useState } from 'react'
import { Chip, ListBox, SearchField, Select, Table } from '@heroui/react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAccountNames } from '../../lib/queries'
import { BusyButton, Empty, Loaded } from '../../components/Feedback'
import { Panel, Stat } from '../../components/Panel'

interface BoardRow {
  seq: number
  uid: string
  uid8: string
  nick: string
  phone: string
  enterprise: boolean
  realm: string
  domain: string
  login_time: number
  at_exp: number
  rt_exp: number
  status: 'disabled' | 'cooling' | 'paused' | 'normal'
  cool_remaining_sec: number
  cool_kind: string
  disabled_reason: string
  sdf: number
  cf: number
  soft_streak: number
  credits: number
  credits_total: number
  expiring: number
  earliest_expiry: number
  checkin: boolean
  succ: number
  err: number
  req: number
  ptok: number
  ctok: number
  ttok: number
  last_model: string
  last_latency: number
  last_tps?: number
  last_success: number
  last_err: number
}

interface BoardResp { generated_at: number; accounts: BoardRow[] }

const STATUS: Record<string, { label: string; color: 'danger' | 'warning' | 'default' | 'success' }> = {
  disabled: { label: '禁用', color: 'danger' },
  cooling: { label: '冷却', color: 'warning' },
  paused: { label: '暂停', color: 'default' },
  normal: { label: '正常', color: 'success' },
}

const num = (n: number) => (n || 0).toLocaleString('zh-CN')
const fmtMs = (ms: number) => (ms ? new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—')

function Acc({ uid, nick, realm }: { uid: string; nick: string; realm: string }) {
  const names = useAccountNames()
  return (
    <div className="flex flex-col">
      <span className="font-medium">{names.name(uid, nick)}</span>
      <span className="font-mono text-xs text-muted">{[realm, uid.slice(0, 8)].filter(Boolean).join(' · ')}</span>
    </div>
  )
}

function StatusChip({ s }: { s: string }) {
  const c = STATUS[s] ?? { label: s, color: 'default' as const }
  return <Chip size="sm" variant="soft" color={c.color}>{c.label}</Chip>
}

/** P1（连续会话失效）与 P3（连续失败）异常标记 */
function Badges({ sdf, cf }: { sdf: number; cf: number }) {
  return (
    <div className="flex gap-1">
      {sdf >= 2 && <Chip size="sm" variant="soft" color="danger">P1</Chip>}
      {cf >= 3 && <Chip size="sm" variant="soft" color="warning">P3</Chip>}
      {sdf < 2 && cf < 3 && <span className="text-muted">—</span>}
    </div>
  )
}

function exportCsv(rows: BoardRow[]) {
  const cols: [keyof BoardRow, string][] = [
    ['seq', '序号'], ['nick', '昵称'], ['uid8', 'UID8'], ['realm', '域'], ['status', '状态'],
    ['credits', '积分'], ['credits_total', '积分总额'], ['expiring', '快过期'], ['sdf', '会话失效'], ['cf', '连败'],
    ['succ', '成功'], ['err', '失败'], ['req', '请求'], ['ttok', '总Token'], ['last_model', '最后模型'],
    ['login_time', '登录时间'], ['at_exp', 'AT到期'],
  ]
  const head = cols.map(([, l]) => l).join(',')
  const line = (r: BoardRow) => cols.map(([k]) => {
    const v = r[k]
    if (k === 'login_time' || k === 'at_exp') return fmtMs(Number(v))
    return typeof v === 'boolean' ? (v ? '是' : '') : String(v ?? '')
  }).join(',')
  const csv = '\ufeff' + [head, ...rows.map(line)].join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = '账号总表.csv'
  a.click()
  URL.revokeObjectURL(a.href)
}

export function BoardPage() {
  const query = useQuery({ queryKey: ['board'], queryFn: () => api<BoardResp>('board'), refetchInterval: 30_000 })
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const rows = useMemo(() => {
    const all = query.data?.accounts ?? []
    return all.filter((r) => {
      if (status && r.status !== status) return false
      const k = q.trim().toLowerCase()
      if (k && !(r.nick.toLowerCase().includes(k) || r.uid8.toLowerCase().includes(k) || r.uid.toLowerCase().includes(k))) return false
      return true
    })
  }, [query.data, status, q])

  return (
    <>
      <Panel
        title="账号总表"
        desc="池状态 + 凭证 JWT 档案合并的宽表视图；序号按登录时间升序。P1 = 连续会话失效 ≥2，P3 = 连续失败 ≥3。"
        actions={
          <>
            <SearchField aria-label="搜索账号" value={q} onChange={setQ} className="w-44">
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder="搜索昵称或 UID" />
                <SearchField.ClearButton />
              </SearchField.Group>
            </SearchField>
            <Select aria-label="按状态筛选" value={status || 'all'} onChange={(k) => setStatus(k == null || k === 'all' ? '' : String(k))} className="w-32">
              <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
              <Select.Popover>
                <ListBox>
                  <ListBox.Item id="all" textValue="全部状态">全部状态<ListBox.ItemIndicator /></ListBox.Item>
                  <ListBox.Item key="normal" id="normal" textValue="正常">正常<ListBox.ItemIndicator /></ListBox.Item>
                  <ListBox.Item key="cooling" id="cooling" textValue="冷却">冷却<ListBox.ItemIndicator /></ListBox.Item>
                  <ListBox.Item key="paused" id="paused" textValue="暂停">暂停<ListBox.ItemIndicator /></ListBox.Item>
                  <ListBox.Item key="disabled" id="disabled" textValue="禁用">禁用<ListBox.ItemIndicator /></ListBox.Item>
                </ListBox>
              </Select.Popover>
            </Select>
            <BusyButton size="sm" variant="secondary" busy={query.isFetching} onPress={() => void query.refetch()}>刷新</BusyButton>
            <BusyButton size="sm" variant="primary" onPress={() => exportCsv(rows)}>导出 CSV</BusyButton>
          </>
        }
        contentClassName="flex flex-col gap-4"
      >
        <Loaded query={query} rows={4}>
          {(d) => (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="账号数" value={num(d.accounts.length)} />
              <Stat label="积分合计" value={num(d.accounts.reduce((s, r) => s + r.credits, 0))} tone="success" />
              <Stat label="P1 异常" value={num(d.accounts.filter((r) => r.sdf >= 2).length)} tone="danger" sub="连续会话失效 ≥2" />
              <Stat label="P3 异常" value={num(d.accounts.filter((r) => r.cf >= 3).length)} tone="warning" sub="连续失败 ≥3" />
            </div>
          )}
        </Loaded>
      </Panel>

      <Panel title="账号明细" desc={`${rows.length} 个账号`}>
        {rows.length === 0 ? (
          <Empty title="没有匹配的账号">换一个状态或关键字试试。</Empty>
        ) : (
          <Table variant="secondary">
            <Table.ScrollContainer className="max-h-[70dvh] overflow-x-auto">
              <Table.Content aria-label="账号明细" className="min-w-[1440px]">
                <Table.Header>
              <Table.Column className="text-right" isRowHeader>序号</Table.Column>
              <Table.Column>账号</Table.Column>
              <Table.Column>状态</Table.Column>
              <Table.Column className="text-right">积分</Table.Column>
              <Table.Column className="text-right">总额</Table.Column>
              <Table.Column className="text-right">快过期</Table.Column>
              <Table.Column>异常</Table.Column>
              <Table.Column className="text-right">成功</Table.Column>
              <Table.Column className="text-right">失败</Table.Column>
              <Table.Column className="text-right">请求</Table.Column>
              <Table.Column className="text-right">Token</Table.Column>
              <Table.Column>最后模型</Table.Column>
              <Table.Column>登录时间</Table.Column>
            </Table.Header>
            <Table.Body>
              {rows.map((r) => (
                <Table.Row key={r.uid} id={r.uid}>
                  <Table.Cell className="text-right font-mono tabular-nums text-muted">{r.seq}</Table.Cell>
                  <Table.Cell><Acc uid={r.uid} nick={r.nick} realm={r.realm} /></Table.Cell>
                  <Table.Cell><StatusChip s={r.status} /></Table.Cell>
                  <Table.Cell className="text-right font-mono tabular-nums">{num(r.credits)}</Table.Cell>
                  <Table.Cell className="text-right font-mono tabular-nums text-muted">{num(r.credits_total)}</Table.Cell>
                  <Table.Cell className="text-right font-mono tabular-nums text-warning">{r.expiring ? num(r.expiring) : '—'}</Table.Cell>
                  <Table.Cell><Badges sdf={r.sdf} cf={r.cf} /></Table.Cell>
                  <Table.Cell className="text-right font-mono tabular-nums text-success">{num(r.succ)}</Table.Cell>
                  <Table.Cell className="text-right font-mono tabular-nums text-danger">{num(r.err)}</Table.Cell>
                  <Table.Cell className="text-right font-mono tabular-nums">{num(r.req)}</Table.Cell>
                  <Table.Cell className="text-right font-mono tabular-nums">{num(r.ttok)}</Table.Cell>
                  <Table.Cell className="font-mono text-xs">{r.last_model || '—'}</Table.Cell>
                  <Table.Cell className="whitespace-nowrap font-mono tabular-nums text-xs">{fmtMs(r.login_time)}</Table.Cell>
                </Table.Row>
              ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        )}
      </Panel>
    </>
  )
}
