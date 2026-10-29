# Contributing

欢迎 PR / issue。这个项目很小，保持小是它的优点。

## 改之前

1. 先读 `README.md` 的「踩过的坑」和 `TROUBLESHOOTING.md` —— 你的问题大多在里面
2. 只改你需要的部分：`bridge/`（Python）、`scripts/`（PowerShell）、`plugin/`（TypeScript）

## 硬规矩

- **`.ps1` 保持纯 ASCII**。PS 5.1 读无 BOM 的非 ASCII 脚本会直接语法报错。
  需要输出中文时用 `$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8`。
- **不要引入平台特定的路径**。一切都走配置（`config.json` / `worlds.gal`）。
- **不要往桥里塞内容过滤**。判断权交给宿主/角色，桥只负责把话说清楚。
- 抓图逻辑改动后，请附一张"最小化 + 被遮挡"状态下的实测截图。

## 适配其它宿主

`plugin/` 只是参考。移植需要三样能力：

```
① 发 HTTP → 拿 JSON      （/current /history /wait）
② 收图片事件             （把 PNG 交给模型看）
③ 注册工具给模型调用      （9 个 gal_* 的语义照搬即可）
```

桥和脚本与宿主无关，可直接复用。

## 提交信息

```
area: what changed

bridge: collapse duplicated name markers
scripts: keep ps1 ascii-only
```