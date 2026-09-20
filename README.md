# Murder Mystery Backend

Socket.IO 后端服务，支持多个剧本杀线上游戏的房间管理与状态同步。

## 支持的游戏

- `stranger` - 陌生人
- `adventure-king` - 冒险王之投了个骰
- `taiwu` - 胎屋（预留）

## 功能

- 房间管理：DM 创建房间生成 6 位房间号，玩家加入
- 状态同步：DM 状态更新由服务器缓存并广播
- 断线重连：Socket.IO 自动重连 + 房间状态恢复
- 心跳检测：连接状态监控，离线玩家标记
- 多游戏支持：通过 gameId 区分不同剧本
- DM 密码验证：后端验证（通过环境变量 `DM_PASSWORD` 设置，请勿公开泄露）

## 本地运行

```bash
npm install
npm start
```

服务器默认运行在 `http://localhost:3000`

## 环境变量

- `PORT` - 服务器端口（默认 3000）
- `DM_PASSWORD` - DM 密码（必填，通过环境变量安全设置）
- `NODE_ENV` - 运行环境

## 部署到 Render.com

- Build Command: `npm install`
- Start Command: `npm start`
- 免费套餐会在 15 分钟无访问后休眠

## API

### HTTP

- `GET /` - 服务状态
- `GET /health` - 健康检查

### Socket.IO 事件

#### 客户端 -> 服务器

| 事件 | 发送者 | 说明 |
|------|--------|------|
| `create_room` | DM | 创建房间 { gameId, password } |
| `join_room` | 玩家 | 加入房间 { gameId, roomNumber, playerId, nickname, charId } |
| `reconnect_dm` | DM | DM 断线重连 { roomNumber, dmPlayerId, gameId } |
| `game_msg` | 任意 | 游戏消息中继（DM广播/玩家发给DM） |
| `state_update` | DM | 状态更新，服务器缓存并广播 |
| `pong` | 任意 | 心跳响应 |
| `kick_player` | DM | 踢出玩家 { playerId } |
| `end_room` | DM | 结束房间 |

#### 服务器 -> 客户端

| 事件 | 接收者 | 说明 |
|------|--------|------|
| `player_joined` | DM | 玩家加入/重连 |
| `player_left` | DM | 玩家离线 |
| `player_status` | 所有 | 玩家列表状态更新 |
| `game_msg` | 对应方 | 中继的游戏消息 { from, data } |
| `state_update` | 玩家 | 状态广播 |
| `dm_offline` | 玩家 | DM 断线 |
| `dm_online` | 玩家 | DM 重连 |
| `kicked` | 玩家 | 被踢 |
| `room_ended` | 所有 | 房间结束 |
