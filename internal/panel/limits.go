// SPDX-FileCopyrightText: 2026 yreidev 与贡献者（见 NOTICE）
// SPDX-License-Identifier: AGPL-3.0-only
// 复制或改写本文件须保留以上声明，并按 NOTICE 的署名条款注明出处：https://github.com/yreidev/workbuddy2api-panel

package panel

import (
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/yreidev/workbuddy2api-panel/internal/pool"
	"github.com/yreidev/workbuddy2api-panel/internal/reqlog"
)

// accUID8RE 从「昵称(uid8)」标签里提取 8 位十六进制 uid（与 sidecar 同口径）。
var accUID8RE = regexp.MustCompile(`\(([0-9a-f]{8})\)`)

// splitAccount 把「昵称(uid8)」标签拆成昵称与 uid8；无括号时 uid8 为空、昵称为原串。
func splitAccount(s string) (nick, uid8 string) {
	if m := accUID8RE.FindStringSubmatch(s); m != nil {
		return strings.TrimSpace(strings.TrimSuffix(s, "("+m[1]+")")), m[1]
	}
	return strings.TrimSpace(s), ""
}

// stripRealm 去掉模型名的 cn:/global: 前缀，得裸模型名。
func stripRealm(model string) string {
	model = strings.TrimPrefix(model, "cn:")
	model = strings.TrimPrefix(model, "global:")
	return model
}

// limitsBudgetRow 单个 (账号, 模型) 的滚动窗口消耗。
type limitsBudgetRow struct {
	UID8    string  `json:"uid8"`
	Nick    string  `json:"nick"`
	Model   string  `json:"model"`
	Credit  float64 `json:"credit"`  // 窗口内总消耗
	N       int     `json:"n"`       // 笔数
	Recent  float64 `json:"recent"`  // 近 1 小时消耗（触线预测用）
	FirstAt int64   `json:"first_at"` // 窗口内首笔 epoch ms
	Status  string  `json:"status"`  // bad / warn / ok
	EtaMin  int     `json:"eta_min"` // 按近 1 小时速率外推到安全线的分钟数（-1 = 不可估）
}

// limits 限流预算仪表：模型级冷却明细 + 5 小时滚动窗口消耗跟踪。
// 数据源：pool.ModelLockView（冷却）+ reqlog 归档（消耗），全部只读。
// 口径与 sidecar /limits 一致：窗口 5 小时、安全线 300 分。
func (p *Panel) limits(w http.ResponseWriter, r *http.Request) {
	const (
		winHours = 5.0
		safe     = 300.0
	)
	now := time.Now()

	// 1. 模型级冷却明细（现成；nil 回空数组，前端统一按空态渲染）。
	locks := p.cfg.Pool.ModelLockView()
	if locks == nil {
		locks = []pool.ModelLockRow{}
	}

	// 2. 滚动窗口消耗聚合。
	type agg struct {
		nick   string
		uid8   string
		model  string
		credit float64
		n      int
		recent float64
		first  time.Time
	}
	usage := map[string]*agg{}
	total := 0.0
	if p.cfg.RequestLog != nil {
		rows, err := p.cfg.RequestLog.ReadArchive(1000, reqlog.Filter{
			From: now.Add(-time.Duration(winHours) * time.Hour),
		})
		if err == nil {
			for _, e := range rows {
				nick, uid8 := splitAccount(e.Account)
				model := stripRealm(e.Model)
				key := uid8 + "\x1f" + model
				a := usage[key]
				if a == nil {
					a = &agg{nick: nick, uid8: uid8, model: model, first: e.Time}
					usage[key] = a
				}
				a.credit += e.Credit
				a.n++
				if e.Time.After(now.Add(-time.Hour)) {
					a.recent += e.Credit
				}
				total += e.Credit
			}
		}
	}

	budget := make([]limitsBudgetRow, 0, len(usage))
	for _, a := range usage {
		status := "ok"
		eta := -1
		switch {
		case a.credit >= safe:
			status = "bad"
		case a.credit >= safe*0.8:
			status = "warn"
		}
		if status != "bad" && a.recent > 0 {
			eta = int((safe - a.credit) / a.recent * 60)
		}
		budget = append(budget, limitsBudgetRow{
			UID8:    a.uid8,
			Nick:    a.nick,
			Model:   a.model,
			Credit:  a.credit,
			N:       a.n,
			Recent:  a.recent,
			FirstAt: a.first.UnixMilli(),
			Status:  status,
			EtaMin:  eta,
		})
	}
	sort.Slice(budget, func(i, j int) bool { return budget[i].Credit > budget[j].Credit })

	over := 0
	near := 0
	for _, b := range budget {
		switch b.Status {
		case "bad":
			over++
		case "warn":
			near++
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"window_hours": winHours,
		"safe_line":    safe,
		"generated_at": now.UnixMilli(),
		"locks":        locks,
		"budget":       budget,
		"total_credit": total,
		"over":         over,
		"near":         near,
	})
}
