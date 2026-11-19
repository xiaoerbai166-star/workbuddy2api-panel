// SPDX-FileCopyrightText: 2026 yreidev 与贡献者（见 NOTICE）
// SPDX-License-Identifier: AGPL-3.0-only
// 复制或改写本文件须保留以上声明，并按 NOTICE 的署名条款注明出处：https://github.com/yreidev/workbuddy2api-panel

// WorkBuddy 对话：扫本机 WorkBuddy 客户端会话 jsonl，按 7864 v4 布局展示（小特定制）。
import { useMemo, useState } from 'react'
import { Button, Chip, Table } from '@heroui/react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { BusyButton, Empty, Loaded } from '../../components/Feedback'
import { Hint } from '../../components/Hint'
import { Panel, Stat } from '../../components/Panel'
import { useNow } from '../../lib/hooks'
import { dateTime, fmtCredit, fmtTok } from '../../lib/format'

interface TurnModel { m: string; cr: number; tok: number }
interface WBTurn { q: string; cr: number; n: number; t0: number; t1: number; tok: number; ms?: TurnModel[] }
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
  n_turns: number
  turns?: WBTurn[]
  last_q?: string
  last_cr?: number
}
interface WbchatsResp {
  entries: WBchat[]
  count: number
  total: number
  scanning: boolean
}

const num = (n: number) => (n || 0).toLocaleString('zh-CN')

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 */
function relTime(ms: number, now = Date.now()): string {
  const d = now - ms
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return Math.floor(d / 60_000) + ' 分钟前'
  if (d < 86_400_000) return Math.floor(d / 3_600_000) + ' 小时前'
  return Math.floor(d / 86_400_000) + ' 天前'
}

type Range = 'today' | 'week' | 'month' | 'all'
const RANGES: { k: Range; label: string }[] = [
  { k: 'today', label: '今天' },
  { k: 'week', label: '本周' },
  { k: 'month', label: '本月' },
  { k: 'all', label: '全部' },
]
function rangeStart(r: Range, now = new Date()): number {
  if (r === 'all') return 0
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  if (r === 'today') return d.getTime()
  if (r === 'week') { d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime() }
  d.setDate(1) // month
  return d.getTime()
}

type SortKey = 'credit' | 'time' | 'req'

/** 模型占比条：多段堆叠（按 tokens，跟随筛选；多模型按模型数均摊）+ 图例 */
function ModelBar({ modelTok, total }: { modelTok: Map<string, number>; total: number }) {
  if (!total) return null
  const sorted = [...modelTok.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  const palette = ['bg-(--viz-1)', 'bg-(--viz-2)', 'bg-(--viz-3)', 'bg-(--viz-4)', 'bg-(--viz-5)', 'bg-(--viz-6)', 'bg-(--viz-7)', 'bg-(--viz-8)']
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-secondary" aria-hidden="true">
        {sorted.map(([m, v], i) => (
          <span key={m} className={palette[i % palette.length]} style={{ width: (v / total * 100) + '%' }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
        {sorted.map(([m, v], i) => (
          <span key={m} className="inline-flex items-center gap-1">
            <span className={`size-2 rounded-full ${palette[i % palette.length]}`} />
            {m} · {fmtTok(v)}
          </span>
        ))}
      </div>
    </div>
  )
}

/** 回合明细：每轮 q / cr / n / tok / 起止，hover 看逐模型拆分 */
function Turns({ turns }: { turns: WBTurn[] }) {
  if (!turns.length) return <p className="text-sm text-muted">无回合明细（该会话无 startsNewUserRequest 标记或已清空）。</p>
  return (
    <div className="flex flex-col divide-y divide-surface">
      {turns.map((t, i) => (
        <Hint
          key={i}
          className="flex cursor-default items-baseline gap-2 py-1.5 text-sm"
          tip={
            <div className="flex flex-col gap-0.5 py-1 text-xs">
              <span className="font-medium">逐模型</span>
              {(t.ms || []).map((m) => (
                <span key={m.m} className="tabular-nums">{m.m} · {fmtCredit(m.cr)} · {fmtTok(m.tok)}</span>
              ))}
              {!(t.ms || []).length && <span>—</span>}
            </div>
          }
        >
          <span className="w-14 shrink-0 font-mono text-xs text-muted tabular-nums">{t.t0 ? new Date(t.t0 * 1000).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' }) : '—'}</span>
          <span className="min-w-0 flex-1 truncate" title={t.q}>{t.q}</span>
          <span className="shrink-0 font-mono text-xs tabular-nums text-success">{fmtCredit(t.cr)}</span>
          <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums text-muted">{t.n} 次</span>
          <span className="w-16 shrink-0 text-right font-mono text-xs tabular-nums text-muted">{fmtTok(t.tok)}</span>
        </Hint>
      ))}
    </div>
  )
}

export function WbchatsPage() {
  const [range, setRange] = useState<Range>('all')
  const [q, setQ] = useState('')
  const [project, setProject] = useState('')
  const [sort, setSort] = useState<SortKey>('credit')
  const [live, setLive] = useState(true)
  const [sel, setSel] = useState<WBchat | null>(null)

  const query = useQuery({
    queryKey: ['wbchats'],
    queryFn: () => api<WbchatsResp>('wbchats?limit=1000'),
    refetchInterval: live ? 5000 : false,
  })

  const entries = useMemo(() => query.data?.entries ?? [], [query.data])
  const now = useNow(5000)
  const rs = rangeStart(range)

  // 时间分段过滤（按最近活跃时间 end）
  const ranged = useMemo(() => (rs ? entries.filter((e) => e.end >= rs) : entries), [entries, rs])

  // 进行中的对话：会话文件 15 分钟内有写入
  const running = useMemo(() => ranged.filter((e) => now - e.end < 15 * 60_000), [ranged, now])

  // 搜索 + 项目筛选
  const ql = q.trim().toLowerCase()
  const filtered = useMemo(() => ranged.filter((e) => {
    if (project && e.project !== project) return false
    if (ql) {
      const hay = (e.title + ' ' + e.project + ' ' + e.models).toLowerCase()
      if (!hay.includes(ql)) return false
    }
    return true
  }), [ranged, ql, project])

  // 排序
  const sorted = useMemo(() => {
    const a = [...filtered]
    if (sort === 'credit') a.sort((x, y) => y.credit - x.credit)
    else if (sort === 'time') a.sort((x, y) => y.end - x.end)
    else a.sort((x, y) => y.n_req - x.n_req)
    return a
  }, [filtered, sort])
  const shown = sorted.slice(0, 100)

  // 今日 KPI
  const today = rangeStart('today')
  const todayList = useMemo(() => entries.filter((e) => e.end >= today), [entries, today])
  const todayCredit = todayList.reduce((s, e) => s + e.credit, 0)
  const histCredit = entries.reduce((s, e) => s + e.credit, 0)
  const topToday = todayList.reduce<WBchat | null>((m, e) => (e.credit > (m?.credit ?? 0) ? e : m), null)

  // 模型占比（tokens 均摊）
  const modelTok = useMemo(() => {
    const map = new Map<string, number>()
    for (const e of filtered) {
      const ms = e.models.split('、').filter(Boolean)
      if (!ms.length) continue
      const per = e.tokens / ms.length
      for (const m of ms) map.set(m, (map.get(m) ?? 0) + per)
    }
    return map
  }, [filtered])
  const modelTot = [...modelTok.values()].reduce((s, v) => s + v, 0)

  // 工作区 chips（归一化 Top8）
  const projTop = useMemo(() => {
    const cnt = new Map<string, number>()
    for (const e of ranged) cnt.set(e.project, (cnt.get(e.project) ?? 0) + 1)
    return [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([p]) => p)
  }, [ranged])

  // 选中会话（删掉后回退）
  const selChat = sel && shown.find((e) => e.cid === sel.cid) ? sel : null

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="WorkBuddy 对话"
        desc="扫本机 ~/.workbuddy/projects 下的会话 jsonl；回合明细对齐 7864（一次提问→执行→完成 = 一个回合）。"
        actions={
          <>
            <div className="flex gap-1">
              {RANGES.map((r) => (
                <Button key={r.k} size="sm" variant={range === r.k ? 'primary' : 'ghost'} onPress={() => setRange(r.k)}>{r.label}</Button>
              ))}
            </div>
            <Button size="sm" variant={live ? 'primary' : 'ghost'} onPress={() => setLive((v) => !v)}>{live ? '实时 5s' : '已暂停'}</Button>
            <BusyButton size="sm" variant="secondary" busy={query.isFetching} onPress={() => void query.refetch()}>刷新</BusyButton>
          </>
        }
        contentClassName="flex flex-col gap-4"
      >
        <Loaded query={query} rows={3}>
          {(d) => (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Stat label="今日会话" value={num(todayList.length)} sub={`历史共 ${num(d.total)} 个 · ${d.scanning ? '扫描中' : '已就绪'}`} />
              <Stat label="今日累计消耗" value={fmtCredit(todayCredit)} tone="success" sub={`历史累计 ${fmtCredit(histCredit)}`} />
              <Stat label="今日最贵会话" value={topToday ? fmtCredit(topToday.credit) : '—'} sub={topToday ? (topToday.title.length > 20 ? topToday.title.slice(0, 20) + '…' : topToday.title) : '今日暂无消耗'} />
            </div>
          )}
        </Loaded>
      </Panel>

      <Panel title="模型用量占比" desc="按 tokens，跟随筛选；多模型会话按模型数均摊" contentClassName="flex flex-col gap-2">
        <Loaded query={query} rows={0}>
          {() => <ModelBar modelTok={modelTok} total={modelTot} />}
        </Loaded>
      </Panel>

      {running.length > 0 && (
        <Panel title={`进行中的对话 · ${running.length}`} desc="会话文件 15 分钟内有写入" contentClassName="flex flex-wrap gap-2">
          {running.map((e) => (
            <Button key={e.cid} size="sm" variant="secondary" onPress={() => setSel(e)}>{e.title.length > 24 ? e.title.slice(0, 24) + '…' : e.title}</Button>
          ))}
        </Panel>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_380px]">
        <Panel
          title="会话明细"
          desc={`${filtered.length} 个 · 按${sort === 'credit' ? '消耗' : sort === 'time' ? '时间' : '请求数'}排序 · 超阈值（消耗≥4000 · 请求≥1000）标红`}
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="h-8 rounded-lg border border-surface bg-surface px-2 text-sm outline-none focus:border-primary"
                placeholder="搜索标题 / 项目 / 模型"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              <div className="flex gap-1">
                <Button size="sm" variant="secondary" onPress={() => setProject('')}>全部项目</Button>
                {projTop.map((p) => (
                  <Button key={p} size="sm" variant={project === p ? 'primary' : 'secondary'} onPress={() => setProject(project === p ? '' : p)}>{p}</Button>
                ))}
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant={sort === 'credit' ? 'primary' : 'ghost'} onPress={() => setSort('credit')}>消耗</Button>
                <Button size="sm" variant={sort === 'time' ? 'primary' : 'ghost'} onPress={() => setSort('time')}>时间</Button>
                <Button size="sm" variant={sort === 'req' ? 'primary' : 'ghost'} onPress={() => setSort('req')}>请求</Button>
              </div>
            </div>
          }
        >
          {shown.length ? (
            <Table variant="secondary">
              <Table.ScrollContainer className="max-h-[60dvh] overflow-x-auto">
                <Table.Content aria-label="WorkBuddy 对话" className="min-w-[820px]">
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
                    {shown.map((r) => {
                      const hot = r.credit >= 4000 || r.n_req >= 1000
                      return (
                        <Table.Row
                          key={r.cid}
                          id={r.cid}
                          className={selChat?.cid === r.cid ? 'bg-primary/10' : ''}
                          onClick={() => setSel(selChat?.cid === r.cid ? null : r)}
                        >
                          <Table.Cell className="max-w-[300px]">
                            <span className="block truncate" title={r.title}>
                              {hot && <Chip size="sm" color="danger" className="mr-1">热</Chip>}
                              {r.title}
                            </span>
                          </Table.Cell>
                          <Table.Cell><Chip size="sm" variant="soft">{r.project}</Chip></Table.Cell>
                          <Table.Cell className="text-right font-mono tabular-nums">{num(r.n_req)}</Table.Cell>
                          <Table.Cell className={`text-right font-mono tabular-nums ${hot ? 'text-danger' : 'text-success'}`}>{num(r.credit)}</Table.Cell>
                          <Table.Cell className="text-right font-mono tabular-nums">{num(r.tokens)}</Table.Cell>
                          <Table.Cell className="font-mono text-xs text-muted">{r.models}</Table.Cell>
                          <Table.Cell className="whitespace-nowrap font-mono tabular-nums text-xs"><span title={dateTime(r.end)}>{relTime(r.end, now)}</span></Table.Cell>
                        </Table.Row>
                      )
                    })}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          ) : (
            <Empty title="没有匹配的会话">换个筛选条件，或确认 WorkBuddy 客户端有对话记录。</Empty>
          )}
        </Panel>

        <Panel
          title="回合明细"
          desc={selChat ? `${selChat.title.length > 24 ? selChat.title.slice(0, 24) + '…' : selChat.title} · 共 ${selChat.n_turns} 回合 · 最近 ${selChat.turns?.length ?? 0} 轮` : '点击左侧会话查看'}
          contentClassName="max-h-[60dvh] overflow-y-auto"
        >
          {selChat ? (
            <Turns turns={selChat.turns ?? []} />
          ) : (
            <p className="text-sm text-muted">选择左侧一个会话，这里展示它的回合明细（每轮消耗 / 请求数 / token / 起止时间，悬停看逐模型拆分）。</p>
          )}
        </Panel>
      </div>
    </div>
  )
}
