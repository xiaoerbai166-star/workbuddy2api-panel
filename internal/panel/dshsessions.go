// SPDX-FileCopyrightText: 2026 yreidev 与贡献者（见 NOTICE）
// SPDX-License-Identifier: AGPL-3.0-only
// 复制或改写本文件须保留以上声明，并按 NOTICE 的署名条款注明出处：https://github.com/yreidev/workbuddy2api-panel

package panel

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/klauspost/compress/zstd"

	"github.com/yreidev/workbuddy2api-panel/internal/reqlog"
)

// 面板「按项目消耗」的 DSH 侧：DSH（DeepSeek）把每个会话写成
// sessions/<工作区>/<session-id>/session.v4.jsonl.zstd，首行带 cwd，
// 之后每个 assistant/message 事件带 usage（input/output/total/cacheRead）。
// 这里按 cwd（工作区=项目）聚合会话数与 token，供「按项目消耗」页与
// WorkBuddy 客户端项目并列展示。
//
// 积分（credit）DSH 自身不记录：用本网关 request-logs 里 ua=deepseek-harness
// 的实测「积分/token」比例按模型折算，属估算，前端标注「估」。

const (
	dshSessionFile   = "session.v4.jsonl.zstd"
	dshFile          = "dsh-sessions-cache.json"
	dshMemTTL        = 60 * time.Second
	dshDiskTTL       = 10 * time.Minute
	dshMaxAge        = 30 * 24 * time.Hour
	dshArchiveWindow = 30 * 24 * time.Hour
	dshArchiveLimit  = 50000
)

// dshProject 一个 DSH 工作区（=项目）的聚合结果。
type dshProject struct {
	Project   string           `json:"project"`
	Cwd       string           `json:"cwd"`
	Sessions  int              `json:"sessions"`
	Tokens    int64            `json:"tokens"`
	In        int64            `json:"in_tokens"`
	Out       int64            `json:"out_tokens"`
	Cache     int64            `json:"cache_tokens"`
	Models    string           `json:"models"`
	First     int64            `json:"first"`
	Last      int64            `json:"last"`
	Credit    float64          `json:"credit"`
	Estimated bool             `json:"estimated"`
	ByModel   map[string]int64 `json:"-"`
}

// dshSessionStat 单个会话文件的解析结果（进磁盘缓存，避免每次重解压 400+MB）。
type dshSessionStat struct {
	Size   int64            `json:"size"`
	Mtime  int64            `json:"mtime"`
	Cwd    string           `json:"cwd"`
	First  int64            `json:"first"`
	Last   int64            `json:"last"`
	In     int64            `json:"in"`
	Out    int64            `json:"out"`
	Cache  int64            `json:"cache"`
	Total  int64            `json:"total"`
	Msgs   int              `json:"msgs"`
	Models map[string]int64 `json:"models,omitempty"`
}

type dshCacheFile struct {
	At    int64                      `json:"at"`
	Files map[string]*dshSessionStat `json:"files"`
	Rows  []dshProject               `json:"rows"`
}

var (
	dshCacheMu     sync.Mutex
	dshCacheRows   []dshProject
	dshCacheAt     time.Time
	dshScanning    atomic.Bool
	dshRatesMu     sync.Mutex
	dshRatesAt     time.Time
	dshRatesByMdl  map[string]float64
	dshRatesGlobal float64
)

// dshSessionsDir DSH 会话根目录：DSH_HOME 优先，默认 ~/.dsh/sessions。
func dshSessionsDir() string {
	if v := strings.TrimSpace(os.Getenv("DSH_HOME")); v != "" {
		return filepath.Join(v, "sessions")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".dsh", "sessions")
}

// dshProjectName 把 cwd 变成面板上的项目名：去盘符，取末三段，点换空格，
// 与 WorkBuddy 项目名（如「龙虾空间-llm ingest-16 ✅AI自动化任务」）同风格。
func dshProjectName(cwd string) string {
	p := strings.TrimSpace(cwd)
	if p == "" {
		return "（未知工作区）"
	}
	p = strings.TrimSuffix(p, `\`)
	p = strings.TrimSuffix(p, "/")
	parts := strings.FieldsFunc(p, func(r rune) bool { return r == '\\' || r == '/' })
	if len(parts) > 0 && len(parts[0]) == 2 && parts[0][1] == ':' {
		parts = parts[1:]
	}
	if len(parts) > 3 {
		parts = parts[len(parts)-3:]
	}
	name := strings.Join(parts, "-")
	name = strings.ReplaceAll(name, ".", " ")
	return strings.TrimSpace(name)
}

// parseDshSession 解压并解析一个会话文件；失败返回 nil（坏文件跳过，不影响整表）。
func parseDshSession(path string) *dshSessionStat {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	dec, err := zstd.NewReader(f)
	if err != nil {
		return nil
	}
	defer dec.Close()

	st := &dshSessionStat{Models: map[string]int64{}}
	sc := bufio.NewScanner(dec)
	sc.Buffer(make([]byte, 0, 1<<20), 32<<20)
	for sc.Scan() {
		raw := sc.Bytes()
		// 多数事件很大（工具结果/推理正文），先做廉价过滤再解 JSON。
		if !strings.Contains(string(raw), `"usage"`) && !strings.Contains(string(raw), `"type":"session"`) {
			continue
		}
		var ev struct {
			Type      string `json:"type"`
			Time      int64  `json:"time"`
			Cwd       string `json:"cwd"`
			CreatedAt int64  `json:"createdAt"`
			Data      struct {
				Usage *struct {
					InputTokens     int64 `json:"inputTokens"`
					OutputTokens    int64 `json:"outputTokens"`
					TotalTokens     int64 `json:"totalTokens"`
					CacheReadTokens int64 `json:"cacheReadTokens"`
				} `json:"usage"`
				Message struct {
					Source struct {
						Model string `json:"model"`
					} `json:"source"`
				} `json:"message"`
			} `json:"data"`
		}
		if json.Unmarshal(raw, &ev) != nil {
			continue
		}
		switch ev.Type {
		case "session":
			if ev.Cwd != "" {
				st.Cwd = ev.Cwd
			}
			if st.First == 0 || (ev.CreatedAt > 0 && ev.CreatedAt < st.First) {
				if ev.CreatedAt > 0 {
					st.First = ev.CreatedAt
				}
			}
			continue
		}
		if ev.Data.Usage == nil {
			continue
		}
		u := ev.Data.Usage
		total := u.TotalTokens
		if total <= 0 {
			total = u.InputTokens + u.OutputTokens + u.CacheReadTokens
		}
		st.In += u.InputTokens
		st.Out += u.OutputTokens
		st.Cache += u.CacheReadTokens
		st.Total += total
		st.Msgs++
		model := stripRealm(ev.Data.Message.Source.Model)
		if model == "" {
			model = "unknown"
		}
		st.Models[model] += total
		if ev.Time > st.Last {
			st.Last = ev.Time
		}
		if st.First == 0 || (ev.Time > 0 && ev.Time < st.First) {
			st.First = ev.Time
		}
	}
	if st.Total <= 0 {
		return nil
	}
	return st
}

// doScanDshSessions 同步扫描（复用磁盘缓存里未变化的文件），后台 goroutine 调用。
func doScanDshSessions(root, cachePath string, maxAge time.Duration) ([]dshProject, map[string]*dshSessionStat) {
	old := loadDshCache(cachePath)
	files := map[string]*dshSessionStat{}
	cutoff := time.Now().Add(-maxAge)

	entries, err := os.ReadDir(root)
	if err == nil {
		for _, ws := range entries {
			if !ws.IsDir() {
				continue
			}
			wsDir := filepath.Join(root, ws.Name())
			sess, err := os.ReadDir(wsDir)
			if err != nil {
				continue
			}
			for _, sd := range sess {
				if !sd.IsDir() {
					continue
				}
				fp := filepath.Join(wsDir, sd.Name(), dshSessionFile)
				info, err := os.Stat(fp)
				if err != nil || info.IsDir() {
					continue
				}
				if info.ModTime().Before(cutoff) {
					continue
				}
				key := ws.Name() + `\` + sd.Name()
				var st *dshSessionStat
				if old != nil {
					if c, ok := old[key]; ok && c != nil && c.Size == info.Size() && c.Mtime == info.ModTime().UnixMilli() {
						st = c
					}
				}
				if st == nil {
					st = parseDshSession(fp)
					if st == nil {
						continue
					}
					st.Size = info.Size()
					st.Mtime = info.ModTime().UnixMilli()
				}
				files[key] = st
			}
		}
	}

	agg := map[string]*dshProject{}
	for _, st := range files {
		cwd := st.Cwd
		if cwd == "" {
			continue
		}
		p := agg[cwd]
		if p == nil {
			p = &dshProject{Cwd: cwd, Project: dshProjectName(cwd), ByModel: map[string]int64{}}
			agg[cwd] = p
		}
		p.Sessions++
		p.Tokens += st.Total
		p.In += st.In
		p.Out += st.Out
		p.Cache += st.Cache
		if st.First > 0 && (p.First == 0 || st.First < p.First) {
			p.First = st.First
		}
		if st.Last > p.Last {
			p.Last = st.Last
		}
		names := make([]string, 0, len(st.Models))
		for m, t := range st.Models {
			p.ByModel[m] += t
			names = append(names, m)
		}
		sort.Strings(names)
	}
	rows := make([]dshProject, 0, len(agg))
	for _, p := range agg {
		// 模型列：按 token 取前三个，逗号分隔。
		type mv struct {
			m string
			t int64
		}
		list := make([]mv, 0, len(p.ByModel))
		for m, t := range p.ByModel {
			list = append(list, mv{m, t})
		}
		sort.Slice(list, func(i, j int) bool {
			if list[i].t != list[j].t {
				return list[i].t > list[j].t
			}
			return list[i].m < list[j].m
		})
		names := make([]string, 0, 3)
		for i, x := range list {
			if i >= 3 {
				break
			}
			names = append(names, x.m)
		}
		p.Models = strings.Join(names, "、")
		rows = append(rows, *p)
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].Tokens > rows[j].Tokens })

	if cachePath != "" {
		saveDshCache(cachePath, &dshCacheFile{At: time.Now().UnixMilli(), Files: files, Rows: rows})
	}
	return rows, files
}

func loadDshCache(path string) map[string]*dshSessionStat {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var c dshCacheFile
	if json.Unmarshal(b, &c) != nil {
		return nil
	}
	if c.Files == nil {
		return nil
	}
	return c.Files
}

// loadDshRows 读磁盘缓存里的聚合结果（进程刚启动时先出旧表，后台再刷）。
func loadDshRows(path string) []dshProject {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var c dshCacheFile
	if json.Unmarshal(b, &c) != nil {
		return nil
	}
	if time.Since(time.UnixMilli(c.At)) > dshDiskTTL {
		return nil
	}
	return c.Rows
}

func saveDshCache(path string, c *dshCacheFile) {
	b, err := json.Marshal(c)
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	_ = os.WriteFile(path, b, 0o644)
}

func (p *Panel) dshCachePath() string {
	if p.cfg.AuthDir == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(p.cfg.AuthDir), "data", dshFile)
}

// scanDshSessions 返回缓存的工作区聚合；缓存过期时后台重扫并立即返回旧值。
func scanDshSessions(root, cachePath string) []dshProject {
	if root == "" {
		return nil
	}
	dshCacheMu.Lock()
	if dshCacheRows != nil && time.Since(dshCacheAt) < dshMemTTL {
		rows := dshCacheRows
		dshCacheMu.Unlock()
		return rows
	}
	dshCacheMu.Unlock()

	if rows := loadDshRows(cachePath); rows != nil {
		dshCacheMu.Lock()
		if dshCacheRows == nil {
			dshCacheRows, dshCacheAt = rows, time.Now()
		}
		dshCacheMu.Unlock()
	}

	if dshScanning.CompareAndSwap(false, true) {
		go func() {
			defer dshScanning.Store(false)
			rows, _ := doScanDshSessions(root, cachePath, dshMaxAge)
			dshCacheMu.Lock()
			dshCacheRows, dshCacheAt = rows, time.Now()
			dshCacheMu.Unlock()
		}()
	}
	dshCacheMu.Lock()
	rows := dshCacheRows
	dshCacheMu.Unlock()
	return rows
}

// dshCreditRates 用 request-logs 里 ua=deepseek-harness 的实测数据算「每 token 积分」：
// 返回按模型的费率表与全局兜底费率。样本不足时返回 0（前端显示 0 并标「估」）。
func (p *Panel) dshCreditRates() (map[string]float64, float64) {
	dshRatesMu.Lock()
	if dshRatesByMdl != nil && time.Since(dshRatesAt) < 5*time.Minute {
		m, g := dshRatesByMdl, dshRatesGlobal
		dshRatesMu.Unlock()
		return m, g
	}
	dshRatesMu.Unlock()

	if p.cfg.RequestLog == nil {
		return nil, 0
	}
	rows, err := p.cfg.RequestLog.ReadArchive(dshArchiveLimit, reqlog.Filter{
		UserAgent: "deepseek-harness",
		From:      time.Now().Add(-dshArchiveWindow),
	})
	if err != nil {
		return nil, 0
	}
	credits := map[string]float64{}
	tokens := map[string]int64{}
	var gCredits float64
	var gTokens int64
	for _, e := range rows {
		if e.Credit <= 0 || e.TotalTokens <= 0 {
			continue
		}
		m := stripRealm(e.Model)
		credits[m] += e.Credit
		tokens[m] += e.TotalTokens
		gCredits += e.Credit
		gTokens += e.TotalTokens
	}
	byModel := map[string]float64{}
	for m, t := range tokens {
		if t > 0 {
			byModel[m] = credits[m] / float64(t)
		}
	}
	global := 0.0
	if gTokens > 0 {
		global = gCredits / float64(gTokens)
	}
	// 读不到样本（归档刚轮转/被锁）不缓存，下次请求重试，避免整页长期显示 0。
	if global <= 0 && len(byModel) == 0 {
		return nil, 0
	}
	dshRatesMu.Lock()
	dshRatesByMdl, dshRatesGlobal, dshRatesAt = byModel, global, time.Now()
	dshRatesMu.Unlock()
	return byModel, global
}

// applyDshCredit 给工作区行填估算积分（按模型费率，缺模型用全局兜底）。
func (p *Panel) applyDshCredit(rows []dshProject) ([]dshProject, float64) {
	rates, global := p.dshCreditRates()
	var total float64
	for i := range rows {
		var credit float64
		for m, t := range rows[i].ByModel {
			r := rates[m]
			if r <= 0 {
				r = global
			}
			credit += float64(t) * r
		}
		credit = round2(credit)
		rows[i].Credit = credit
		rows[i].Estimated = credit > 0
		total += credit
	}
	return rows, round2(total)
}
