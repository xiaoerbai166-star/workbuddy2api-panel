// SPDX-FileCopyrightText: 2026 yreidev 与贡献者（见 NOTICE）
// SPDX-License-Identifier: AGPL-3.0-only
// 复制或改写本文件须保留以上声明，并按 NOTICE 的署名条款注明出处：https://github.com/yreidev/workbuddy2api-panel

// Package reqlog 记录脱敏的请求级指标与可选 JSONL 归档。
//
// 内存指标有界保存最近 100 条并维护进程级计数；磁盘归档（requests-<日期>.jsonl，见 logarchive）
// 只写请求元数据，不写提示词、响应正文、Authorization 或其它凭证。可选的调用来源（客户端 IP /
// User-Agent，见 Event.ClientIP/UserAgent）由 server 按配置开关决定是否填充。
// 归档队列满时丢弃并计数，不允许日志写盘阻塞模型请求。
package reqlog

import (
	"crypto/rand"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/yreidev/workbuddy2api-panel/internal/logarchive"
)

const (
	recentLimit    = 100
	defaultReadMax = 1000
	archivePrefix  = "requests"
)

// 测试可替换：随机数失败回退。
var randRead = rand.Read

// NewRequestID 生成不含用户信息的本地请求 ID。
func NewRequestID() string {
	var b [8]byte
	if _, err := randRead(b[:]); err == nil {
		return fmt.Sprintf("req-%x", b[:])
	}
	return fmt.Sprintf("req-%d", time.Now().UnixNano())
}

const (
	OutcomeSuccess     = "success"
	OutcomeHTTPError   = "http_error"
	OutcomeStreamError = "stream_error"
	OutcomeInterrupted = "interrupted"
)

// Config 归档参数。Enabled=false 时仍保留内存指标。RetentionDays=0 = 永久保留（仍受 MaxBytes 限制），
// MaxBytes<=0 回落 100 MiB。
type Config struct {
	Dir           string
	Enabled       bool
	RetentionDays int
	MaxBytes      int64
	FileMaxBytes  int64
	QueueSize     int
}

// Event 是一条脱敏请求记录。Account 只保存“昵称(uid8)”标签，不保存完整 UID。
//
// ClientIP / UserAgent 是**调用来源**：面板「运行日志」用它回答"这条请求是谁打进来的"。
// 二者由 server 侧按 logging.request_client_info 开关决定是否填充（关掉即保持空串，
// 归档里不会出现来源字段）——来源信息比 token 计数敏感，运营可自行决定是否落盘。
// 仍然不写提示词、响应正文、Authorization 或其它凭证。
type Event struct {
	Time      time.Time `json:"time"`
	RequestID string    `json:"request_id"`
	Path      string    `json:"path"`
	Account   string    `json:"account,omitempty"`
	// Proxy 最后选的号走的代理（代理名，没绑代理为空）。
	Proxy            string  `json:"proxy,omitempty"`
	Model            string  `json:"model,omitempty"`
	Status           int     `json:"status"`
	OK               bool    `json:"ok"`
	Outcome          string  `json:"outcome"`
	DurationMs       int64   `json:"duration_ms"`
	TTFBMs           int64   `json:"ttfb_ms,omitempty"`
	Attempts         int     `json:"attempts,omitempty"`
	PromptTokens     int64   `json:"prompt_tokens,omitempty"`
	CompletionTokens int64   `json:"completion_tokens,omitempty"`
	TotalTokens      int64   `json:"total_tokens,omitempty"`
	Credit           float64 `json:"credit,omitempty"`
	HasCredit        bool    `json:"credit_known"`
	// CacheHitTokens / CacheMissTokens 上游前缀缓存命中/未命中 token（issue #92）。
	// 上游未回该维度时两者皆零值省略；hit=0 + miss>0 即整段未命中。
	CacheHitTokens  int64  `json:"cache_hit_tokens,omitempty"`
	CacheMissTokens int64  `json:"cache_miss_tokens,omitempty"`
	ClientIP        string `json:"client_ip,omitempty"`
	UserAgent       string `json:"user_agent,omitempty"`
	// APIKey 请求带的密钥：客户端密钥记名字，管理员密钥记「管理员」，没开鉴权为空。不记原文。
	APIKey string `json:"api_key,omitempty"`
	// Error 失败原因：回给客户端的错误消息（流中途出错时是上游的错误帧），最多 200 字；成功的请求为空。
	Error string `json:"error,omitempty"`
}

// Filter 用于从归档中筛选最近记录。字符串字段一律「包含」匹配（大小写不敏感），
// 便于面板用一段 IP 前缀或 UA 片段捞请求；From/To 是闭区间（零值 = 该侧不设界），
// 供「今天 / 近 7 天 / 自定义区间」这类时间查询使用。
type Filter struct {
	Outcome   string
	Account   string
	Model     string
	ClientIP  string
	UserAgent string
	APIKey    string
	// Q 关键字：对 IP/UA/模型/账号/代理/密钥/失败原因/请求ID 做包含匹配，空格分词后逐个 AND。
	// 与前端 matchRequest 的 q 同语义（少了「账号现在显示名」这一列，其余一致）。
	Q    string
	From time.Time
	To   time.Time
}

// ArchiveStats 归档存储状态。
type ArchiveStats = logarchive.Stats

// Snapshot 一次面板读取的完整指标快照。
type Snapshot struct {
	StartedAt       time.Time    `json:"started_at"`
	Completed       int64        `json:"completed"`
	InFlight        int64        `json:"in_flight"`
	Succeeded       int64        `json:"succeeded"`
	Failed          int64        `json:"failed"`
	SuccessRate     float64      `json:"success_rate"`
	HTTPSuccessRate float64      `json:"http_success_rate"`
	AvgDurationMs   float64      `json:"avg_duration_ms"`
	Recent          []Event      `json:"recent"`
	Archive         ArchiveStats `json:"archive"`
}

// Recorder 并发安全的有界请求指标与归档记录器。
type Recorder struct {
	mu          sync.Mutex
	started     time.Time
	inFlight    int64
	completed   int64
	succeeded   int64
	httpSuccess int64
	durationSum int64
	recent      []Event
	archive     *logarchive.Store
}

// New 创建记录器；Dir 为空或 Enabled=false 时只启用内存指标。
func New(cfg Config) *Recorder {
	r := &Recorder{started: time.Now(), recent: make([]Event, 0, recentLimit)}
	r.archive = logarchive.New(logarchive.Config{
		Dir: cfg.Dir, Prefix: archivePrefix, Enabled: cfg.Enabled,
		RetentionDays: cfg.RetentionDays, MaxBytes: cfg.MaxBytes,
		FileMaxBytes: cfg.FileMaxBytes, QueueSize: cfg.QueueSize,
	})
	return r
}

// Begin 标记一个请求进入处理。
func (r *Recorder) Begin() {
	if r == nil {
		return
	}
	r.mu.Lock()
	r.inFlight++
	r.mu.Unlock()
}

// Record 记录一个请求完成事件并写入归档队列。
func (r *Recorder) Record(e Event) {
	if r == nil {
		return
	}
	if e.Time.IsZero() {
		e.Time = time.Now()
	}
	if e.Outcome == "" {
		if e.Status == 200 && e.OK {
			e.Outcome = OutcomeSuccess
		} else {
			e.Outcome = OutcomeHTTPError
		}
	}
	r.mu.Lock()
	if r.inFlight > 0 {
		r.inFlight--
	}
	r.completed++
	if e.OK {
		r.succeeded++
	}
	if e.Status >= 200 && e.Status < 300 {
		r.httpSuccess++
	}
	r.durationSum += e.DurationMs
	r.recent = append([]Event{e}, r.recent...)
	if len(r.recent) > recentLimit {
		r.recent = r.recent[:recentLimit]
	}
	r.mu.Unlock()
	r.archive.Append(e.Time, e)
}

// Snapshot 返回进程内指标和归档状态。
func (r *Recorder) Snapshot() Snapshot {
	if r == nil {
		return Snapshot{}
	}
	r.mu.Lock()
	s := Snapshot{
		StartedAt: r.started,
		Completed: r.completed,
		InFlight:  r.inFlight,
		Succeeded: r.succeeded,
		Recent:    append([]Event(nil), r.recent...),
	}
	if r.completed > 0 {
		s.Failed = r.completed - r.succeeded
		s.SuccessRate = round1(float64(r.succeeded) / float64(r.completed) * 100)
		s.HTTPSuccessRate = round1(float64(r.httpSuccess) / float64(r.completed) * 100)
		s.AvgDurationMs = float64(r.durationSum) / float64(r.completed)
	}
	r.mu.Unlock()
	s.Archive = r.archive.Stats()
	return s
}

// ReadArchive 返回最近的归档事件（按时间倒序）。limit<=0 时回落 200，最大 1000。
// 归档关着时返回空（面板改用内存里的最近 100 条），即使磁盘上还留着关之前的文件。
func (r *Recorder) ReadArchive(limit int, filter Filter) ([]Event, error) {
	if r == nil || !r.archive.Enabled() {
		return nil, nil
	}
	if limit <= 0 {
		limit = 200
	}
	if limit > defaultReadMax {
		limit = defaultReadMax
	}
	rows, _, err := logarchive.Read(r.archive, logarchive.Query[Event]{
		Limit: limit, From: filter.From, To: filter.To,
		Time: func(e Event) time.Time { return e.Time },
		Keep: filter.match,
	})
	return rows, err
}

// ArchiveStats 归档的存储状态（不带内存指标，面板「日志留存」用）。
func (r *Recorder) ArchiveStats() ArchiveStats {
	if r == nil {
		return ArchiveStats{}
	}
	return r.archive.Stats()
}

// SetArchive 运行中改归档的开关、保留天数（0 = 永久）和容量上限，面板保存配置即生效。
func (r *Recorder) SetArchive(enabled bool, days int, maxBytes int64) {
	if r == nil {
		return
	}
	r.archive.Reconfigure(enabled, days, maxBytes)
}

// ClearArchive 删掉全部请求归档文件（内存里的指标和最近 100 条不动）。
func (r *Recorder) ClearArchive() error {
	if r == nil {
		return nil
	}
	return r.archive.Clear()
}

// Close 刷盘并停止后台归档。
func (r *Recorder) Close() {
	if r == nil {
		return
	}
	r.archive.Close()
}

// clusterReadMax 会话聚类读近 N 天的归档条数上限：本机日请求量几百到几千，3 天远够；
// 上限兜底防极端情况把几十 MiB 归档整个读进内存。
const clusterReadMax = 100000

// Summary 按筛选条件聚合的请求统计（对应面板「请求记录」的筛选汇总条与 7864 sidecar 的 fsum）。
// 统计全部命中行，不受 ReadArchive 的条数上限影响。
type Summary struct {
	N             int64   `json:"n"`
	Credit        float64 `json:"credit"`
	Prompt        int64   `json:"prompt"`
	Completion    int64   `json:"completion"`
	Total         int64   `json:"total"`
	CacheHit      int64   `json:"cacheHit"`
	Failed        int64   `json:"failed"`
	Interrupted   int64   `json:"interrupted"`
	AvgDurationMs float64 `json:"avgDurationMs"`
	AvgTtfbMs     float64 `json:"avgTtfbMs"`
}

// Turn 会话级消耗聚合（启发式，见 ClusterTurns）。
type Turn struct {
	Model          string    `json:"model"`
	First          time.Time `json:"first"`
	Last           time.Time `json:"last"`
	Credit         float64   `json:"credit"`
	N              int       `json:"n"`
	Tokens         int64     `json:"tokens"`
	PeakDurationMs int64     `json:"peakDurationMs"`
	Accounts       []string  `json:"accounts"`
}

// Summarize 流式扫描归档，按 filter 聚合全部命中行（O(1) 内存，不受条数上限影响）。
// 归档关着时返回零值 Summary。
func (r *Recorder) Summarize(filter Filter) (Summary, error) {
	if r == nil || !r.archive.Enabled() {
		return Summary{}, nil
	}
	type acc struct {
		n, prompt, completion, total, cacheHit, failed, interrupted int64
		credit                                                        float64
		durSum, ttfbSum, ttfbN                                        int64
	}
	a, err := logarchive.Reduce(r.archive, logarchive.Query[Event]{
		From: filter.From, To: filter.To,
		Time: func(e Event) time.Time { return e.Time },
		Keep: filter.match,
	}, acc{}, func(a acc, e Event) acc {
		a.n++
		a.credit += e.Credit
		a.prompt += e.PromptTokens
		a.completion += e.CompletionTokens
		a.total += e.TotalTokens
		a.cacheHit += e.CacheHitTokens
		if e.Outcome == OutcomeHTTPError || e.Outcome == OutcomeStreamError {
			a.failed++
		} else if e.Outcome == OutcomeInterrupted {
			a.interrupted++
		}
		a.durSum += e.DurationMs
		if e.TTFBMs > 0 {
			a.ttfbSum += e.TTFBMs
			a.ttfbN++
		}
		return a
	})
	if err != nil {
		return Summary{}, err
	}
	s := Summary{
		N: a.n, Credit: a.credit, Prompt: a.prompt, Completion: a.completion,
		Total: a.total, CacheHit: a.cacheHit, Failed: a.failed, Interrupted: a.interrupted,
	}
	if a.n > 0 {
		s.AvgDurationMs = float64(a.durSum) / float64(a.n)
	}
	if a.ttfbN > 0 {
		s.AvgTtfbMs = float64(a.ttfbSum) / float64(a.ttfbN)
	}
	return s, nil
}

// ClusterTurns 读最近 days 天归档，做会话级启发式聚类（同模型 + 间隔≤30 分钟 + 上下文链），
// 返回按总积分降序的前 top 个会话。对应 7864 sidecar 的 _cluster_turns 与前端 lib/requests.ts
// 的 clusterTurns；Agent 任务工具循环耗时长，窗口放宽到 30 分钟级，相邻对话上下文相似时可能
// 粘连，结果为估算。
func (r *Recorder) ClusterTurns(days, top int) ([]Turn, error) {
	if r == nil || !r.archive.Enabled() {
		return nil, nil
	}
	if days <= 0 {
		days = 3
	}
	if top <= 0 {
		top = 20
	}
	from := time.Now().AddDate(0, 0, -days)
	rows, _, err := logarchive.Read(r.archive, logarchive.Query[Event]{
		Limit: clusterReadMax,
		From:  from,
		Time:  func(e Event) time.Time { return e.Time },
	})
	if err != nil {
		return nil, err
	}
	// 聚类要求按时间正序（Read 返回倒序）。
	sort.Slice(rows, func(i, j int) bool { return rows[i].Time.Before(rows[j].Time) })

	type row struct {
		epoch      int64
		model      string
		acc        string
		credit     float64
		prompt     int64
		completion int64
		tokens     int64
		duration   int64
	}
	rs := make([]row, 0, len(rows))
	for _, e := range rows {
		rs = append(rs, row{
			epoch: e.Time.UnixMilli(), model: e.Model, acc: accountShort(e.Account),
			credit: e.Credit, prompt: e.PromptTokens, completion: e.CompletionTokens,
			tokens: e.TotalTokens, duration: e.DurationMs,
		})
	}

	type turn struct {
		model  string
		lastT  int64
		lastP  int64
		lastC  int64
		credit float64
		tokens int64
		peak   int64
		reqs   []row
	}
	const gapMs = 1800 * 1000
	turns := make([]turn, 0)
	for _, rr := range rs {
		placed := false
		start := len(turns) - 20
		if start < 0 {
			start = 0
		}
		for i := len(turns) - 1; i >= start; i-- {
			t := &turns[i]
			if t.model != rr.model || rr.epoch-t.lastT > gapMs || t.lastP == 0 {
				continue
			}
			lo := float64(t.lastP) * 0.1
			hi := float64(t.lastP) + float64(t.lastC)*3 + 50000
			if float64(rr.prompt) < lo || float64(rr.prompt) > hi {
				continue
			}
			t.reqs = append(t.reqs, rr)
			t.lastT, t.lastP, t.lastC = rr.epoch, rr.prompt, rr.completion
			t.credit += rr.credit
			t.tokens += rr.tokens
			if rr.duration > t.peak {
				t.peak = rr.duration
			}
			placed = true
			break
		}
		if !placed {
			turns = append(turns, turn{
				model: rr.model, lastT: rr.epoch, lastP: rr.prompt, lastC: rr.completion,
				credit: rr.credit, tokens: rr.tokens, peak: rr.duration, reqs: []row{rr},
			})
		}
	}

	out := make([]Turn, 0, len(turns))
	for _, t := range turns {
		seen := make(map[string]bool, len(t.reqs))
		accs := make([]string, 0)
		for _, rr := range t.reqs {
			if !seen[rr.acc] {
				seen[rr.acc] = true
				accs = append(accs, rr.acc)
			}
		}
		sort.Strings(accs)
		out = append(out, Turn{
			Model: t.model, First: time.UnixMilli(t.reqs[0].epoch), Last: time.UnixMilli(t.reqs[len(t.reqs)-1].epoch),
			Credit: t.credit, N: len(t.reqs), Tokens: t.tokens,
			PeakDurationMs: t.peak, Accounts: accs,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Credit > out[j].Credit })
	if len(out) > top {
		out = out[:top]
	}
	return out, nil
}

// accountShort 账号显示名去 uid 后缀：昵称(uid8) → 昵称；空账号回「?」。与前端 clusterTurns
// 的 acc = (account||'?').split('(')[0] 同口径。
func accountShort(acc string) string {
	if acc == "" {
		return "?"
	}
	if i := strings.IndexByte(acc, '('); i >= 0 {
		return acc[:i]
	}
	return acc
}

func round1(v float64) float64 {
	return float64(int(v*10+0.5)) / 10
}

func (f Filter) match(e Event) bool {
	if f.Outcome != "" && e.Outcome != f.Outcome {
		return false
	}
	if f.Q != "" {
		text := strings.Join([]string{e.ClientIP, e.UserAgent, e.Model, e.Account, e.Proxy, e.APIKey, e.Error, e.RequestID}, " ")
		for _, kw := range strings.Fields(strings.ToLower(f.Q)) {
			if !strings.Contains(strings.ToLower(text), kw) {
				return false
			}
		}
	}
	if !containsFold(e.Account, f.Account) {
		return false
	}
	if !containsFold(e.Model, f.Model) {
		return false
	}
	if !containsFold(e.ClientIP, f.ClientIP) {
		return false
	}
	if !containsFold(e.UserAgent, f.UserAgent) {
		return false
	}
	if !containsFold(e.APIKey, f.APIKey) {
		return false
	}
	if !f.From.IsZero() && e.Time.Before(f.From) {
		return false
	}
	if !f.To.IsZero() && e.Time.After(f.To) {
		return false
	}
	return true
}

// containsFold 大小写不敏感的子串匹配；needle 为空视为命中（不筛该字段）。
func containsFold(haystack, needle string) bool {
	if needle == "" {
		return true
	}
	return strings.Contains(strings.ToLower(haystack), strings.ToLower(needle))
}
