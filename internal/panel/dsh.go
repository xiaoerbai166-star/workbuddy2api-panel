// SPDX-FileCopyrightText: 2026 yreidev 与贡献者（见 NOTICE）
// SPDX-License-Identifier: AGPL-3.0-only
// 复制或改写本文件须保留以上声明，并按 NOTICE 的署名条款注明出处：https://github.com/yreidev/workbuddy2api-panel

package panel

import (
	"net/http"
	"sort"
	"time"

	"github.com/yreidev/workbuddy2api-panel/internal/reqlog"
)

// dshUsageRow 单个 (账号, 模型) 的 DSH 消耗。
type dshUsageRow struct {
	UID8   string  `json:"uid8"`
	Nick   string  `json:"nick"`
	Model  string  `json:"model"`
	Credit float64 `json:"credit"`
	N      int     `json:"n"`
	Tokens int64   `json:"tokens"`
	First  int64   `json:"first"` // epoch ms
	Last   int64   `json:"last"`  // epoch ms
}

// dshUsage 面板「DSH 对话消耗」：从请求归档聚合 DeepSeekRuntime 客户端的消耗。
//
// 背景：DSH 的会话正文存 Electron 内部（leveldb / IndexedDB，Chromium 私有格式，
// 不公开且随版本变），无法像 WorkBuddy 的 jsonl 那样直接扫。但 DSH 的每次模型调用
// 都经本网关，落在 request-logs 的 ua=deepseek-harness 行里，所以这里从消耗维度
// 回答「DSH 烧了多少分」，与「按项目消耗」（WorkBuddy 客户端）互补。
func (p *Panel) dshUsage(w http.ResponseWriter, r *http.Request) {
	if p.cfg.RequestLog == nil {
		writeErr(w, http.StatusNotImplemented, "request logger not available")
		return
	}
	const winHours = 24.0
	now := time.Now()
	rows, err := p.cfg.RequestLog.ReadArchive(1000, reqlog.Filter{
		UserAgent: "deepseek-harness",
		From:      now.Add(-time.Duration(winHours) * time.Hour),
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	type agg struct {
		nick   string
		uid8   string
		model  string
		credit float64
		n      int
		tokens int64
		first  int64
		last   int64
	}
	usage := map[string]*agg{}
	total := 0.0
	for _, e := range rows {
		nick, uid8 := splitAccount(e.Account)
		model := stripRealm(e.Model)
		key := uid8 + "\x1f" + model
		a := usage[key]
		if a == nil {
			a = &agg{nick: nick, uid8: uid8, model: model, first: e.Time.UnixMilli()}
			usage[key] = a
		}
		a.credit += e.Credit
		a.n++
		a.tokens += e.TotalTokens
		if t := e.Time.UnixMilli(); t < a.first {
			a.first = t
		}
		if t := e.Time.UnixMilli(); t > a.last {
			a.last = t
		}
		total += e.Credit
	}

	out := make([]dshUsageRow, 0, len(usage))
	for _, a := range usage {
		out = append(out, dshUsageRow{
			UID8: a.uid8, Nick: a.nick, Model: a.model,
			Credit: a.credit, N: a.n, Tokens: a.tokens,
			First: a.first, Last: a.last,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Credit > out[j].Credit })
	if out == nil {
		out = []dshUsageRow{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"entries":      out,
		"total_credit": total,
		"window_hours": winHours,
		"generated_at": now.UnixMilli(),
	})
}
