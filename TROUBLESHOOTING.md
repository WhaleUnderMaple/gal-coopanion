# 故障排查

按"症状 → 查什么 → 怎么修"排。

## 没有台词（`gal_now` 返回空）

1. `curl http://127.0.0.1:18996/health` —— 桥活着吗？
   * 连不上 → 桥没跑：`python bridge/luna-bridge.py`，看 `luna-bridge.log`
2. `curl http://127.0.0.1:2333/api/list/translator` —— Luna 的网络服务在听吗？
   * 连不上 → Luna 里 `设置 → 网络服务` 没勾"开启"，或端口不是 2333
3. 都通但还是空 → **Luna 没有 hook 到这个游戏**：
   在 Luna 里 `选择文本` 挑到会出字的那条，然后 `游戏设置` 存下来
4. 有台词但名字是空的 → 正常。很多引擎不把说话人单独给出来，按语气判断即可

## 画面推不过来（`gal_peek` 报 `capture failed`）

| 报错 | 原因 | 修法 |
|---|---|---|
| `NOPROC` | 进程名不对 | `gal_games()` 看真实进程名，再 `gal_use(...)` |
| `BADSIZE 158x26` | 窗口最小化，且还原失败 | 手动把窗口恢复一次；确认脚本有 `SW_SHOWNOACTIVATE` 分支 |
| `PRINTFAIL` | 该引擎不接受 `PrintWindow` | 试试 `flag=0`；仍不行只能截整屏（会有桌宠入镜） |
| 图是黑的/半张 | 抓到"还没画完"的帧 | 已内置强制重画 + 3 次重试；仍出现就调大 `everySec` |

## 点击没反应（`gal_advance` 返回 DONE 但剧情不动）

* 有的引擎只认前台输入：确认不是"独占全屏 + 原始输入"模式（改窗口化/无边框窗口）
* 试试点别的坐标：改 `advance.ps1` 里的中心点比例
* 有些游戏需要点击**特定控件**（不是渲染窗口）：用 `gal_games()` 找到子窗口再试

## 窗口标题乱码（`process` 对、`title` 是问号方块）

PowerShell 用系统 ANSI 输出、宿主按 UTF-8 读。`scripts/list-games.ps1` 首行已设：

```powershell
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

自己写的 `.ps1` 也要加这一行；并且**脚本内容保持纯 ASCII**（PS 5.1 读无 BOM 的非 ASCII 会直接语法错误）。

## 推图太碎 / 太吵

```
everySec      调大（8 → 15）
bigChangeRatio 调小（0.35 → 0.2）：更多变化会被当成"小变化"只推裁块
pushImage     关掉：只在她主动 gal_peek 时给图
maxPushesPerHour 限流
```

## 真的抓不到画面怎么办

退一步：`gal_peek` 不可用也不影响"读台词 + 点继续"。
画面只是锦上添花；先把台词跑通再折腾截图。