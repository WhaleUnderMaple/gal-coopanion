# Changelog

## v0.1.0 — 2026-10-29

首个可发布版本：把 LunaTranslator 与桌面宠物（Coopanion）接起来的框架。

**台词**

- `bridge/luna-bridge.py`：读 Luna 的 `/api/ws/text/origin`，解析出 `{name, text}`
- 名字去重 + 从正文剥离（Luna 会把说话人附在台词后、且可能重复两次）
- 半句合并（低刷新延迟下同一句被分多次推）
- 精确去重；历史 500 条并落盘，重启不丢上下文
- HTTP：`/health` `/current` `/history` `/wait`（长轮询）

**画面**

- `scripts/capture-window.ps1`：`PrintWindow(flag=2)` 抓指定进程的窗口
- 最小化也能抓：`SW_SHOWNOACTIVATE` 无焦点还原 → 抓 → `SW_MINIMIZE` 缩回
- 强制重画 + 空图检测 + 3 次重试（解决"只画了上半部分"）
- 差分只推变化区域；变化 ≥ 35% 改推整幅（避免"放大局部"的观感）
- 每 8 秒一次、每小时上限 120 张

**推进**

- `scripts/advance.ps1`：`PostMessage` 到最大子窗口，后台点击不抢焦点

**插件**

- `plugin/`：`cortico-world-gal` 参考实现，9 个工具
  （`gal_now/wait/history/advance/peek/games/use/luna/status`）
- 选定游戏写入 `gal-target.json`，台词/画面/点击三处共用
- `gal_luna()` 可在游戏已运行时自动拉起 LunaTranslator 并等端口

**已知限制**

- 只支持 Windows（依赖 `PrintWindow` / `PostMessage`）
- 选项分支还不能自动选（需要按键/坐标，见 TROUBLESHOOTING）
- 独占全屏 + 原始输入的引擎可能收不到后台点击