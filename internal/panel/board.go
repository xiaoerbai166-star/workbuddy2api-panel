// SPDX-FileCopyrightText: 2026 yreidev 与贡献者（见 NOTICE）
// SPDX-License-Identifier: AGPL-3.0-only
// 复制或改写本文件须保留以上声明，并按 NOTICE 的署名条款注明出处：https://github.com/yreidev/workbuddy2api-panel

// board.go 账号总表：把池状态（pool）与凭证 JWT 档案（auth）合并成
// 「一行一账号」的宽表视图，供面板「账号总表」页渲染。
//
// 设计约束：
//   - 纯本地数据（池快照 + 本地 token 解码），不打任何上游请求。
//   - 时间戳统一 Unix 毫秒（0 = 无该值）：与前端 Date 直读对齐，避免
//     RFC3339 / 时区解析在两侧分叉。
//   - 序号（seq）= 登录时间（accessToken.auth_time）升序——「账号池」页与
//     「账号总表」页看到的序号永远一致。
package panel

import (
	"net/http"
	"sort"
	"time"

	"github.com/yreidev/workbuddy2api-panel/internal/pool"
)

// boardRow 账号总表一行：身份（auth 文件/JWT）+ 运行状态（pool）。
// JSON 键与前端列定义一一对应（精简列/完整列由前端按组显隐，后端恒给全量）。
type boardRow struct {
	Seq        int    `json:"seq"`
	UID        string `json:"uid"`
	UID8       string `json:"uid8"`
	Nick       string `json:"nick"`
	Phone      string `json:"phone"`
	Enterprise bool   `json:"enterprise"`
	Realm      string `json:"realm"`
	Domain     string `json:"domain"`

	LoginTime int64 `json:"login_time"` // JWT auth_time（登录时刻），ms
	ATExp     int64 `json:"at_exp"`     // accessToken 到期，ms
	RTExp     int64 `json:"rt_exp"`     // refreshToken 到期，ms

	Status           string `json:"status"` // disabled / cooling / paused / normal
	CoolRemainingSec int64  `json:"cool_remaining_sec"`
	CoolKind         string `json:"cool_kind"`
	DisabledReason   string `json:"disabled_reason"`
	SDF              int    `json:"sdf"`         // 连续会话失效（12153）计数，≥2 = P1 异常
	CF               int    `json:"cf"`          // 连续失败计数（连败降权），≥3 = P3 异常
	SoftStreak       int    `json:"soft_streak"` // 连续软冷却次数

	Credits        int64 `json:"credits"`
	CreditsTotal   int64 `json:"credits_total"`
	Expiring       int64 `json:"expiring"`        // 快过期积分（配置窗口内）
	EarliestExpiry int64 `json:"earliest_expiry"` // 最早到期批次时刻，ms
	Checkin        bool  `json:"checkin"`         // 今日已签到

	// 成长状态（体检 5 项，签到排程快照，global/企业号零值）：
	StreakDays  int  `json:"streak_days"`  // 连登天数
	Chances     int  `json:"chances"`      // 抽奖次数
	Energy      int  `json:"energy"`       // 能量
	Affordable  bool `json:"affordable"`   // 能量够开盒
	Cards       int  `json:"cards"`        // 补签卡数
	CompActive  bool `json:"comp_active"`  // 活动补偿可领
	CompClaimed bool `json:"comp_claimed"` // 活动补偿已领

	Succ        int64    `json:"succ"`
	Err         int64    `json:"err"`
	Req         int64    `json:"req"`
	PTok        int64    `json:"ptok"`
	CTok        int64    `json:"ctok"`
	TTok        int64    `json:"ttok"`
	LastModel   string   `json:"last_model"`
	LastLatency int64    `json:"last_latency"`
	LastTPS     *float64 `json:"last_tps,omitempty"`
	LastSuccess int64    `json:"last_success"` // ms
	LastErr     int64    `json:"last_err"`     // ms
}

// board 账号总表数据：池内全部账号一行一条，序号按登录时间升序。
// 响应带 generated_at（服务端当前时刻，ms）：前端所有「x 天前 / 剩余 x 天」
// 都以它为基准，避免浏览器与服务端时钟不一致时相对时间漂移。
func (p *Panel) board(w http.ResponseWriter, r *http.Request) {
	list := p.cfg.Pool.List()
	now := time.Now()
	rows := make([]boardRow, 0, len(list))
	for _, s := range list {
		rows = append(rows, boardRowOf(s, p.cfg.Pool))
	}
	// 序号 = 登录时间升序（auth_time 缺失 = 0 排最前，uid 字典序保底稳定）。
	sort.SliceStable(rows, func(i, j int) bool {
		if rows[i].LoginTime != rows[j].LoginTime {
			return rows[i].LoginTime < rows[j].LoginTime
		}
		return rows[i].UID < rows[j].UID
	})
	for i := range rows {
		rows[i].Seq = i + 1
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"generated_at": now.UnixMilli(),
		"accounts":     rows,
	})
}

// boardRowOf 把一条池状态投影成总表行，并用凭证 JWT 档案补齐身份/有效期字段。
func boardRowOf(s pool.Status, pl *pool.Pool) boardRow {
	row := boardRow{
		UID:        s.UID,
		Nick:       s.Nickname,
		Enterprise: s.Enterprise,
		Realm:      s.Realm,
		// 状态四态互斥口径与账号池页一致：禁用 > 冷却 > 暂停 > 正常。
		Status:           boardStatus(s),
		CoolRemainingSec: s.CoolRemaining,
		CoolKind:         s.CoolKind,
		DisabledReason:   s.DisabledReason,
		SDF:              s.SessionDeadFails,
		CF:               s.ConsecutiveFails,
		SoftStreak:       s.SoftStreak,
		Credits:          s.Credits,
		CreditsTotal:     s.CreditsTotal,
		Expiring:         s.CreditsExpiring,
		Checkin:          s.CheckinDone,
		StreakDays:       s.StreakDays,
		Chances:          s.Chances,
		Energy:           s.Energy,
		Cards:            s.Cards,
		CompActive:       s.CompActive,
		CompClaimed:      s.CompClaimed,
		Succ:             s.SuccessCount,
		Err:              s.ErrTotal,
		Req:              s.TokenUsage.RequestCount,
		PTok:             s.TokenUsage.PromptTokens,
		CTok:             s.TokenUsage.CompletionTokens,
		TTok:             s.TokenUsage.TotalTokens,
		LastModel:        s.TokenUsage.LastModel,
		LastLatency:      s.TokenUsage.LastLatencyMs,
		LastTPS:          s.TokenUsage.LastTokensPerSecond,
	}
	row.UID8 = row.UID
	if len(row.UID8) > 8 {
		row.UID8 = row.UID8[:8]
	}
	if !s.CreditsEarliestExpiry.IsZero() {
		row.EarliestExpiry = s.CreditsEarliestExpiry.UnixMilli()
	}
	if !s.LastSuccessTime.IsZero() {
		row.LastSuccess = s.LastSuccessTime.UnixMilli()
	}
	if !s.LastErrTime.IsZero() {
		row.LastErr = s.LastErrTime.UnixMilli()
	}
	if a := pl.AuthByUID(s.UID); a != nil {
		tp := a.TokenProfile()
		row.LoginTime = tp.AuthTime * 1000
		row.Phone = tp.Username
		row.ATExp = tp.ATExp * 1000
		row.RTExp = tp.RTExp * 1000
		row.Domain = a.DomainValue()
	}
	return row
}

// boardStatus 四态归并：与账号池页判定优先级一致（禁用 > 冷却 > 暂停 > 正常）。
func boardStatus(s pool.Status) string {
	switch {
	case s.Disabled:
		return "disabled"
	case s.Cooling:
		return "cooling"
	case s.Paused:
		return "paused"
	}
	return "normal"
}
