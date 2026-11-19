// SPDX-FileCopyrightText: 2026 yreidev 与贡献者（见 NOTICE）
// SPDX-License-Identifier: AGPL-3.0-only
// 复制或改写本文件须保留以上声明，并按 NOTICE 的署名条款注明出处：https://github.com/yreidev/workbuddy2api-panel

// 积分包存档留账：对齐 7864 的 package_archive.json 兜底。上游 /panel/api/packages
// 只返回「未用完」的包——积分一旦用光，包就从接口消失。这里把见过的包留快照，
// 用完/过期后仍保留在逐包明细里（Remain 恒 0、Used == Size、Arch 标记），供「积分构成」页
// 追查历史包。每查一次刷新 live 快照，接口已消失的补回为归档包。
package panel

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"

	"github.com/yreidev/workbuddy2api-panel/internal/upstream"
)

const pkgArchiveFile = "package-archive.json"

type archivedPkg struct {
	UID string                `json:"uid"`
	Pkg upstream.CreditPackage `json:"pkg"`
}

// pkgArchive 包存档（内存 map + 磁盘 JSON，与 7864 同口径：见过包留快照）。
type pkgArchive struct {
	mu   sync.Mutex
	path string
	m    map[string]archivedPkg
}

// pkgArchivePath 从 AuthDir 推导 data 目录下的存档路径；AuthDir 为空返回空。
func (p *Panel) pkgArchivePath() string {
	if p.cfg.AuthDir == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(p.cfg.AuthDir), "data", pkgArchiveFile)
}

// packageKey 积分包唯一键：同号 + 同名 + 同到账时间（到秒）视为同一笔（对齐 7864 _pkg_key）。
func packageKey(uid string, p upstream.CreditPackage) string {
	created := p.CreatedAt
	if len(created) > 19 {
		created = created[:19]
	}
	return uid + "|" + p.Name + "|" + created
}

// loadPkgArchive 读磁盘存档；不存在或损坏返回空存档。
func loadPkgArchive(path string) *pkgArchive {
	a := &pkgArchive{path: path, m: make(map[string]archivedPkg)}
	if path == "" {
		return a
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return a
	}
	_ = json.Unmarshal(b, &a.m)
	return a
}

// merge 把某号当前 live 包刷进存档，并返回 live + 该号已归档包的合并列表（live 在前）。
func (a *pkgArchive) merge(uid string, packs []upstream.CreditPackage) []upstream.CreditPackage {
	a.mu.Lock()
	defer a.mu.Unlock()
	live := make(map[string]bool, len(packs))
	out := make([]upstream.CreditPackage, 0, len(packs))
	for _, p := range packs {
		k := packageKey(uid, p)
		live[k] = true
		a.m[k] = archivedPkg{UID: uid, Pkg: p}
		out = append(out, p)
	}
	for k, ap := range a.m {
		if ap.UID == uid && !live[k] {
			p := ap.Pkg
			p.Arch = true
			out = append(out, p)
		}
	}
	return out
}

// save 写回磁盘（尽力而为；82 账号逐包量级远小于截断上限，不做截断）。
func (a *pkgArchive) save() error {
	if a.path == "" {
		return nil
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	b, err := json.Marshal(a.m)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(a.path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(a.path, b, 0o644)
}
