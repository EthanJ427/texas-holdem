# 当前进度

最后更新：2026-08-11

## 线上地址

| | |
|---|---|
| 游戏 | https://ethanj427.github.io/texas-holdem/ （注意结尾斜杠，全小写） |
| 联机服务器 | https://holdem.ethan-poker.workers.dev/health |
| 测试页 | https://ethanj427.github.io/texas-holdem/tests/ |

## 已完成

**单机**：六人桌无限注，三档 AI（新手/进阶/高手），实测高手对新手约 222 BB/100。
第一人称 3D 牌桌、真实筹码柱、Web Audio 合成音效、本地存档。

**联机**：房间号进桌，空位由机器人补齐，两人也能开打。
断线重连回原座位，超时 60 秒自动过牌/弃牌，中途进来的人排到下一手入座。

**测试**：258 项，浏览器里跑（这台机器上 Node 只用来装 wrangler，测试不依赖它）。

## 架构要点

- `js/engine.js` `js/cards.js` `js/ai.js` `js/room.js` 不依赖浏览器，服务器直接复用
- **状态离开引擎只有两个出口**，各有一道白名单闸：
  - `viewFor(id)` → `VIEW_KEYS`
  - `eventsFor(id, events)` → `EVENT_KEYS`
- 渲染层统一读「视图」，单机也走同一套裁剪 —— 界面不决定露什么牌，视图给什么画什么
- 服务器每次发全量状态，不做增量（1~2KB，压缩后约 556 字节）
- 防重放靠「手牌号 + 动作序号」，序号校验排在「是不是轮到你」之前
- 洗牌在服务器用 `crypto.getRandomValues`

## 下一步候选（按建议优先级）

1. **输光后重新买入** —— 联机局现在输光只能干看着，桌子越打越空
2. **显示谁掉线了** —— 服务器已在发 `connected`，界面还没用上
3. **等人齐再开局** —— 现在一个人进房就开打，朋友晚来会错过几手
4. **CI 自动跑测试** —— 现在要手动开浏览器跑测试页

暂不做：观战入口、聊天、防串通、盲注上涨、真钱。

## 常用命令

```bash
cd /Users/ethan/texas-holdem
npx wrangler deploy      # 部署联机服务器
npx wrangler whoami      # 确认 Cloudflare 授权还在
git push origin main     # 推送后 GitHub Pages 约一分钟自动更新
```

改完记得**两边都要发**：网页端走 git push，服务器端走 wrangler deploy。
只推一边会出现界面和服务器版本不一致。
