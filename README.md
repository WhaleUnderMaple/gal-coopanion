# gal-companion

把 **LunaTranslator + 桌面宠物（Coopanion）** 接起来，让桌面宠物真正"陪你玩 galgame"：

* **读台词** — 从 LunaTranslator 的原文流拿到每一句（说话人分离、重复名折叠）
* **看画面** — 定点抓游戏窗口（`PrintWindow`，最小化/被遮挡也能抓），只推"变了的那块"
* **推进会话** — 后台 `PostMessage` 点"继续"，**不抢前台焦点**（宠物可以在后面自己玩）

> 这不是"脚本自动化"，而是给桌宠加了三样感官。它们原本都缺。

---

## 组成

```
bridge/luna-bridge.py      LunaTranslator 文本流 → 本地 HTTP（/current /history /wait）
scripts/capture-window.ps1 抓窗口（含最小化还原、强制重画、空图重试）
scripts/advance.ps1        后台点击（PostMessage，不抢焦点）
scripts/list-games.ps1     列出像游戏的窗口（进程名 / 标题 / 尺寸）
plugin/                    Coopanion 世界插件（cortico-world-gal，参考实现）
```

`plugin/` 只是**一个参考实现**：任何能发 HTTP、能收图片事件的 agent 宿主都能接同样的 bridge。

---

## 环境要求

| 项 | 说明 |
|---|---|
| 系统 | Windows 10/11（用到 `PrintWindow` / `PostMessage`） |
| Python | 3.9+（`pip install websockets`） |
| Node | 22+（仅插件需要） |
| LunaTranslator | v12.x，**必须开启「网络服务」并记住端口** |
| ffmpeg | 做画面差分用（在 PATH 里，或在插件配置里写绝对路径） |
| Coopanion | 0.2.x（插件宿主；其他宿主看 `plugin/src/index.ts` 自行移植） |

---

## 安装

### 1. LunaTranslator

1. 打开 LunaTranslator，`设置 → 网络服务`，勾选**开启**，端口填 `2333`（任意空闲端口）。
2. 玩你的 galgame，用 `选择文本` 挑到能出原文的那条 hook。
3. 点 `游戏设置 / 游戏管理` **把这个游戏存下来** —— 下次同一个 exe 启动，Luna 会自动套用这套 hook。
4. 浏览器打开 `http://127.0.0.1:2333/` 能看到菜单页，说明服务好了。

### 2. 文本桥

```powershell
cd bridge
copy config.example.json config.json     # 按需改端口
pip install websockets
python luna-bridge.py
```

自检：

```powershell
curl http://127.0.0.1:18996/health
curl http://127.0.0.1:18996/current
```

游戏里点两句对话，`/current` 应该开始返回 `{"name": "...", "text": "..."}`。

### 3. 插件（Coopanion）

```powershell
# 把 plugin/ 放进 Coopanion 的 data/extensions 并安装（与你平时装插件的方式一致）
```

在 `config.json` 的 `worlds.gal` 里配置：

```json
{
  "enabled": true,
  "bridgeUrl": "http://127.0.0.1:18996",
  "process": "YourGame",
  "scriptsDir": "D:/gal-companion/scripts",
  "ffmpegPath": "",
  "everySec": 8,
  "diffMode": true,
  "diffMinVal": 25,
  "bigChangeRatio": 0.35,
  "maxWidth": 1280,
  "pushImage": true,
  "maxPushesPerHour": 120
}
```

重启宿主，世界 `gal` 会出现在工具列表里。

---

## 用法

```
gal_games()                    列出像游戏的窗口
gal_use(process="YourGame")  选定要陪的游戏（文本/画面/点击都跟它走）
gal_now()                      现在这一句
gal_wait(45)                   等下一句（他点一下就有）
gal_history(10)                刚才十句
gal_advance(1)                 后台点一下"继续"
gal_peek()                     立刻看一眼整幅画面
gal_luna()                     检查/自动拉起 LunaTranslator
gal_status()                   当前配置与计数
```

画面推送策略：

* 每 `everySec` 秒抓一次窗口，与上一帧做差分
* 变化区域 < `bigChangeRatio`（默认 35%）→ **只推变化的那块**（对话、表情微动）
* 变化区域 ≥ 35% → **推整幅**（换场景 / 出 CG，构图完整）
* 没变化 → 什么都不推；每小时上限 `maxPushesPerHour`

---

## 踩过的坑（都已写进代码，改之前先读）

1. **Luna 的原文里名字在台词后面，而且可能重复两次**
   `「台词」\n【 Name 】【 Name 】` — 与翻译开关无关，是 hook 本身如此。
   桥里用正则抽名字、去重、再把名字从正文剥掉。

2. **最小化窗口的 `GetWindowRect` 只有几十像素**
   必须 `IsIconic` → `SW_SHOWNOACTIVATE` 还原（不抢焦点）→ 抓 → `SW_MINIMIZE` 缩回。

3. **刚还原那一瞬只画了上面一小块**
   抓图前 `RedrawWindow(RDW_INVALIDATE|ALLCHILDREN|UPDATENOW)` + 重试，
   并用 PNG 体积判空图（小于面积 6% 就当没画完）。

4. **`PrintWindow` 要 `flag=2`（PW_RENDERFULLCONTENT）**
   否则 DirectX 渲染的游戏拿不到画面。

5. **后台点击需要 `PostMessage` 到"接收输入的那个子窗口"**
   枚举子窗口取面积最大的那个，比直接发给主窗口可靠。

6. **Windows PowerShell 5.1 读不了无 BOM 的非 ASCII 脚本**
   所有 `.ps1` 保持纯 ASCII；需要中文输出时在脚本第一行设
   `$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8`。

7. **B 站等站点取流和本工具无关**
   这里只管本地游戏窗口；网络视频请另找方案。

---

## 许可

MIT（见 `LICENSE`）。

**依赖声明**：本项目通过 WebSocket/HTTP 与 [LunaTranslator](https://github.com/HIllya51/LunaTranslator) 通信，
不包含其任何代码。LunaTranslator 自身为 GPL-3.0，分发/修改它请遵守其许可。

`plugin/` 是针对 [Coopanion](https://github.com/) 的参考实现；其插件 API 由该宿主定义。
