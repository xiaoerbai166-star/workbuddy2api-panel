// SPDX-FileCopyrightText: 2026 yreidev 与贡献者（见 NOTICE）
// SPDX-License-Identifier: AGPL-3.0-only
// 复制或改写本文件须保留以上声明，并按 NOTICE 的署名条款注明出处：https://github.com/yreidev/workbuddy2api-panel

package panel

import (
	"bufio"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// WBchat 一个 WorkBuddy 客户端会话的聚合消耗（读本地 ~/.workbuddy/projects/*.jsonl）。
type WBchat struct {
	CID     string  `json:"cid"`
	Project string  `json:"project"`
	Title   string  `json:"title"`
	Start   int64   `json:"start"` // epoch ms
	End     int64   `json:"end"`   // epoch ms
	Req     int     `json:"n_req"`
	Credit  float64 `json:"credit"`
	Tokens  int64   `json:"tokens"`
	Models  string  `json:"models"`
}

// wbchatProjectsDir 返回 WorkBuddy 客户端会话根目录；找不到用户主目录返回空。
func wbchatProjectsDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".workbuddy", "projects")
}

// wbchatLine 单行解析所需的宽松结构（只取消耗/模型/首问相关字段）。
type wbchatLine struct {
	Timestamp    float64 `json:"timestamp"`
	Type         string  `json:"type"`
	Role         string  `json:"role"`
	ProviderData struct {
		Model                string `json:"model"`
		StartsNewUserRequest bool   `json:"startsNewUserRequest"`
		RawUsage             struct {
			Credit      float64 `json:"credit"`
			TotalTokens int64   `json:"total_tokens"`
		} `json:"rawUsage"`
	} `json:"providerData"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

// firstInputText 从消息内容里取第一条 input_text 文本（去掉工具注入的纯命令行）。
func firstInputText(contents []struct {
	Type string `json:"type"`
	Text string `json:"text"`
}) string {
	for _, c := range contents {
		if c.Type != "input_text" {
			continue
		}
		t := strings.TrimSpace(c.Text)
		if t == "" {
			continue
		}
		// 跳过工具调用/注入形态（与 sidecar _real_user_text 同口径的宽松版）。
		if strings.HasPrefix(t, "<") || strings.HasPrefix(t, "cmd:") || strings.HasPrefix(t, "tool:") {
			continue
		}
		return truncateRunes(t, 90)
	}
	return ""
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

// parseWBchat 解析单个会话 jsonl，聚合 credit / tokens / models / 首问；无消耗无提问返回 nil。
//
// 性能要点：会话文件动辄几十 MB，逐行 json.Unmarshal 是灾难。这里只对两处做完整解析：
//   - 含 "rawUsage" 的行（消耗汇总，占比极低）—— 聚合计费；
//   - 前 200 行内的 input_text —— 提取首问作标题。
// 其余行靠行级子串预过滤直接跳过，不做反射解析。
func parseWBchat(fp, project string) *WBchat {
	f, err := os.Open(fp)
	if err != nil {
		return nil
	}
	defer f.Close()

	c := &WBchat{CID: strings.TrimSuffix(filepath.Base(fp), ".jsonl"), Project: project}
	modelSet := map[string]bool{}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	lineNo := 0
	for sc.Scan() {
		line := sc.Bytes()
		ls := string(line)
		lineNo++
		if strings.Contains(ls, "rawUsage") {
			var d wbchatLine
			if json.Unmarshal(line, &d) != nil {
				continue
			}
			ts := int64(d.Timestamp)
			if ts > 0 {
				if c.Start == 0 || ts < c.Start {
					c.Start = ts
				}
				if ts > c.End {
					c.End = ts
				}
			}
			ru := d.ProviderData.RawUsage
			if ru.Credit != 0 || ru.TotalTokens != 0 {
				c.Credit += ru.Credit
				c.Tokens += ru.TotalTokens
				c.Req++
				if m := d.ProviderData.Model; m != "" {
					modelSet[m] = true
				}
			}
			continue
		}
		// 标题：只在开头 200 行内找第一条真实用户提问，之后不再看。
		if c.Title == "" && lineNo <= 200 {
			if t := jsonMaybeUserText(line); t != "" {
				c.Title = t
			}
		}
	}
	if c.Req == 0 && c.Title == "" {
		return nil
	}
	models := make([]string, 0, len(modelSet))
	for m := range modelSet {
		models = append(models, m)
	}
	sort.Strings(models)
	c.Models = strings.Join(models, "、")
	if c.Models == "" {
		c.Models = "?"
	}
	if c.Title == "" {
		c.Title = "（未识别首问）"
	}
	return c
}

// jsonMaybeUserText 尝试从一行里提取 user 消息的首条 input_text；非 user 消息或解析失败返回空。
// 只对标题候选行调用（前 200 行），次数受控。
func jsonMaybeUserText(line []byte) string {
	if !strings.Contains(string(line), "input_text") {
		return ""
	}
	var d struct {
		Role    string `json:"role"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if json.Unmarshal(line, &d) != nil || d.Role != "user" {
		return ""
	}
	for _, c := range d.Content {
		if c.Type == "input_text" {
			t := strings.TrimSpace(c.Text)
			if t != "" && !strings.HasPrefix(t, "<") && !strings.HasPrefix(t, "cmd:") && !strings.HasPrefix(t, "tool:") {
				return truncateRunes(t, 90)
			}
		}
	}
	return ""
}

// wbchat 扫描结果缓存：projects 与 wbchats 共用，60 秒内复用避免重复全量扫描
// （2400+ 个会话 jsonl、近 2GB 的读取解析是 IO 密集，逐请求重扫会拖垮面板）。
// 另落磁盘缓存 data/wbchat-cache.json：进程重启后 5 分钟内仍能秒开。
var (
	wbchatCacheMu sync.Mutex
	wbchatCache   []WBchat
	wbchatCacheAt time.Time
)

const (
	wbchatMemTTL  = 60 * time.Second
	wbchatDiskTTL = 5 * time.Minute
	wbchatFile    = "wbchat-cache.json"
)

// wbchatCachePath 从 AuthDir 推导 data 目录下的缓存文件路径；AuthDir 为空返回空。
func (p *Panel) wbchatCachePath() string {
	if p.cfg.AuthDir == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(p.cfg.AuthDir), "data", wbchatFile)
}

// loadWBchatCache 读磁盘缓存；不存在或过期返回 nil。
func loadWBchatCache(path string) []WBchat {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var c struct {
		At   int64    `json:"at"`
		Rows []WBchat `json:"rows"`
	}
	if json.Unmarshal(b, &c) != nil {
		return nil
	}
	if time.Since(time.UnixMilli(c.At)) > wbchatDiskTTL {
		return nil
	}
	return c.Rows
}

// saveWBchatCache 写磁盘缓存（尽力而为，失败不影响主流程）。
func saveWBchatCache(path string, rows []WBchat) {
	b, err := json.Marshal(struct {
		At   int64    `json:"at"`
		Rows []WBchat `json:"rows"`
	}{time.Now().UnixMilli(), rows})
	if err != nil {
		return
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	_ = os.WriteFile(path, b, 0o644)
}

// wbchatScanning 标记是否正在后台扫描（幂等触发，避免并发请求重复扫）。
var wbchatScanning atomic.Bool

// scanWBchats 返回缓存的会话列表；缓存过期或不存在时触发后台扫描并立即返回旧缓存
// （首次可能为 nil，前端按「扫描中」渲染并轮询）。扫描结果落内存 + 磁盘两级缓存。
func scanWBchats(root string, maxAge time.Duration, cachePath string) []WBchat {
	if root == "" {
		return nil
	}
	wbchatCacheMu.Lock()
	if wbchatCache != nil && time.Since(wbchatCacheAt) < wbchatMemTTL {
		rows := wbchatCache
		wbchatCacheMu.Unlock()
		return rows
	}
	wbchatCacheMu.Unlock()

	if cachePath != "" {
		if rows := loadWBchatCache(cachePath); rows != nil {
			wbchatCacheMu.Lock()
			wbchatCache, wbchatCacheAt = rows, time.Now()
			wbchatCacheMu.Unlock()
			return rows
		}
	}

	if wbchatScanning.CompareAndSwap(false, true) {
		go func() {
			defer wbchatScanning.Store(false)
			rows := doScanWBchats(root, maxAge)
			if cachePath != "" {
				saveWBchatCache(cachePath, rows)
			}
			wbchatCacheMu.Lock()
			wbchatCache = rows
			wbchatCacheAt = time.Now()
			wbchatCacheMu.Unlock()
		}()
	}
	wbchatCacheMu.Lock()
	rows := wbchatCache
	wbchatCacheMu.Unlock()
	return rows
}

// doScanWBchats 同步扫描（16 路并发解析），后台 goroutine 调用。
func doScanWBchats(root string, maxAge time.Duration) []WBchat {
	cutoff := time.Now().Add(-maxAge)
	type job struct {
		fp      string
		project string
	}
	var jobs []job
	projs, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	for _, proj := range projs {
		if !proj.IsDir() {
			continue
		}
		pname := proj.Name()
		if len(pname) >= 2 && (pname[:2] == "d-" || pname[:2] == "D-") {
			pname = pname[2:]
		}
		pdir := filepath.Join(root, proj.Name())
		files, err := os.ReadDir(pdir)
		if err != nil {
			continue
		}
		for _, fn := range files {
			name := fn.Name()
			if fn.IsDir() || !strings.HasSuffix(name, ".jsonl") || strings.Contains(name, "rollback") {
				continue
			}
			if info, err := fn.Info(); err == nil && info.ModTime().Before(cutoff) {
				continue
			}
			jobs = append(jobs, job{fp: filepath.Join(pdir, name), project: pname})
		}
	}

	rows := make([]WBchat, 0, len(jobs))
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 16)
	for _, j := range jobs {
		wg.Add(1)
		go func(j job) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if c := parseWBchat(j.fp, j.project); c != nil {
				mu.Lock()
				rows = append(rows, *c)
				mu.Unlock()
			}
		}(j)
	}
	wg.Wait()
	sort.Slice(rows, func(i, j int) bool { return rows[i].Credit > rows[j].Credit })
	return rows
}

// wbchats 面板「WorkBuddy 对话」数据：扫本机会话，返回会话列表。
// 默认只回消耗最高的前 200 个（全量会话 JSON 过大，逐个传输会拖垮面板），
// 前端按 limit 分页拉取。
func (p *Panel) wbchats(w http.ResponseWriter, r *http.Request) {
	rows := scanWBchats(wbchatProjectsDir(), 30*24*time.Hour, p.wbchatCachePath())
	if rows == nil {
		rows = []WBchat{}
	}
	total := len(rows)
	limit := 200
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			limit = n
		}
	}
	if limit > 1000 {
		limit = 1000
	}
	if len(rows) > limit {
		rows = rows[:limit]
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": rows, "count": len(rows), "total": total, "scanning": wbchatScanning.Load()})
}

// projects 面板「按项目消耗」报表：聚合会话的 project 字段。
func (p *Panel) projects(w http.ResponseWriter, r *http.Request) {
	rows := scanWBchats(wbchatProjectsDir(), 30*24*time.Hour, p.wbchatCachePath())
	type prjAgg struct {
		Project  string  `json:"project"`
		Sessions int     `json:"sessions"`
		Credit   float64 `json:"credit"`
		Tokens   int64   `json:"tokens"`
		Models   string  `json:"models"`
	}
	agg := map[string]*prjAgg{}
	var total float64
	for _, c := range rows {
		a := agg[c.Project]
		if a == nil {
			a = &prjAgg{Project: c.Project, Models: c.Models}
			agg[c.Project] = a
		}
		a.Sessions++
		a.Credit += c.Credit
		a.Tokens += c.Tokens
		total += c.Credit
	}
	out := make([]struct {
		Project  string  `json:"project"`
		Sessions int     `json:"sessions"`
		Credit   float64 `json:"credit"`
		Tokens   int64   `json:"tokens"`
		Share    float64 `json:"share"`
		Avg      float64 `json:"avg"`
		Models   string  `json:"models"`
	}, 0, len(agg))
	for _, a := range agg {
		share := 0.0
		avg := 0.0
		if total > 0 {
			share = a.Credit / total * 100
		}
		if a.Sessions > 0 {
			avg = a.Credit / float64(a.Sessions)
		}
		out = append(out, struct {
			Project  string  `json:"project"`
			Sessions int     `json:"sessions"`
			Credit   float64 `json:"credit"`
			Tokens   int64   `json:"tokens"`
			Share    float64 `json:"share"`
			Avg      float64 `json:"avg"`
			Models   string  `json:"models"`
		}{a.Project, a.Sessions, a.Credit, a.Tokens, share, avg, a.Models})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Credit > out[j].Credit })
	if out == nil {
		out = []struct {
			Project  string  `json:"project"`
			Sessions int     `json:"sessions"`
			Credit   float64 `json:"credit"`
			Tokens   int64   `json:"tokens"`
			Share    float64 `json:"share"`
			Avg      float64 `json:"avg"`
			Models   string  `json:"models"`
		}{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": out, "total_credit": total, "total_sessions": len(rows), "scanning": wbchatScanning.Load()})
}
