/**
 * Murder Mystery Backend - Socket.IO Server
 * 支持多游戏（陌生人 / 冒险王 / 胎屋）的房间管理与状态同步
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

// ==================== 全局错误保护（防止单个异常导致进程崩溃） ====================
process.on('uncaughtException', (err) => {
  console.error(`[FATAL][${new Date().toISOString()}] uncaughtException: ${err.message}`);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error(`[FATAL][${new Date().toISOString()}] unhandledRejection: ${reason}`);
  if (reason && reason.stack) console.error(reason.stack);
});

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  // Socket.IO 内置心跳配置
  pingInterval: 10000,
  pingTimeout: 15000
});

// ==================== 配置 ====================
const DM_PASSWORD = process.env.DM_PASSWORD || '1314520';
const VALID_GAME_IDS = ['stranger', 'adventure-king', 'taiwu'];
const PORT = process.env.PORT || 3000;
const ROOM_CLEANUP_INTERVAL = 60000; // 1分钟清理一次空房间
const EMPTY_ROOM_TTL = 30 * 60 * 1000; // 空房间30分钟后清除

// ==================== 内存数据 ====================
/**
 * rooms: {
 *   [roomNumber]: {
 *     gameId: string,
 *     dmSocketId: string | null,
 *     dmPlayerId: string,
 *     players: { [playerId]: { playerId, nickname, charId, socketId, online, lastSeen, isDM } },
 *     state: any,  // DM 缓存的最新完整状态（用于新玩家加入/断线重连）
 *     createdAt: number,
 *     lastActivity: number
 *   }
 * }
 */
const rooms = {};

// socketId -> { roomNumber, playerId, gameId }
const socketMap = {};

// ==================== 房间状态持久化（崩溃重启后自动恢复） ====================
const DATA_DIR = path.join(__dirname, 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
let _saveTimer = null;

function ensureDataDir() {
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch(e) { console.error('[Persist] mkdir error:', e.message); }
}

function saveRooms() {
  try {
    ensureDataDir();
    const snapshot = {};
    for (const num in rooms) {
      const room = rooms[num];
      const players = {};
      for (const pid in room.players) {
        const p = room.players[pid];
        players[pid] = {
          playerId: p.playerId, nickname: p.nickname,
          charId: p.charId || null, socketId: null, online: false,
          lastSeen: p.lastSeen, isDM: p.isDM || false, seat: p.seat || null
        };
      }
      snapshot[num] = {
        gameId: room.gameId, dmSocketId: null, dmPlayerId: room.dmPlayerId,
        players, state: room.state, createdAt: room.createdAt, lastActivity: room.lastActivity
      };
    }
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(snapshot), 'utf-8');
  } catch (e) { console.error('[Persist] save error:', e.message); }
}

// 防抖保存：状态变化后1秒落盘，避免频繁IO
function scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => { _saveTimer = null; saveRooms(); }, 1000);
}

function loadRooms() {
  try {
    if (!fs.existsSync(ROOMS_FILE)) { console.log('[Persist] No saved rooms file, starting fresh'); return; }
    const data = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf-8'));
    let count = 0;
    for (const num in data) {
      // 只恢复最近24小时内有活动的房间
      if (Date.now() - (data[num].lastActivity || 0) > 24 * 60 * 60 * 1000) continue;
      rooms[num] = data[num];
      count++;
    }
    if (count > 0) console.log(`[Persist] Restored ${count} room(s) from disk`);
    else console.log('[Persist] No rooms to restore (all expired)');
  } catch (e) { console.error('[Persist] load error:', e.message); }
}
loadRooms();

// ==================== 工具函数 ====================
function genRoomNumber() {
  let num;
  do {
    num = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms[num]);
  return num;
}

function getRoom(roomNumber) {
  return rooms[roomNumber] || null;
}

function getRoomBySocket(socketId) {
  const info = socketMap[socketId];
  if (!info) return null;
  return { room: getRoom(info.roomNumber), info };
}

function broadcastToRoom(roomNumber, event, data, excludeSocketId) {
  const room = getRoom(roomNumber);
  if (!room) return;
  for (const pid in room.players) {
    const p = room.players[pid];
    if (p.socketId && p.socketId !== excludeSocketId) {
      io.to(p.socketId).emit(event, data);
    }
  }
}

function sendToDM(roomNumber, event, data) {
  const room = getRoom(roomNumber);
  if (!room || !room.dmSocketId) return false;
  io.to(room.dmSocketId).emit(event, data);
  return true;
}

function getPublicPlayers(room) {
  const list = [];
  for (const pid in room.players) {
    const p = room.players[pid];
    list.push({
      playerId: p.playerId,
      nickname: p.nickname,
      charId: p.charId || null,
      online: p.online,
      isDM: p.isDM || false,
      seat: p.seat || null
    });
  }
  return list;
}

function cleanupEmptyRooms() {
  const now = Date.now();
  for (const num in rooms) {
    const room = rooms[num];
    const hasOnline = Object.values(room.players).some(p => p.online);
    if (!hasOnline && now - room.lastActivity > EMPTY_ROOM_TTL) {
      console.log(`[Cleanup] Removing empty room ${num} (game: ${room.gameId})`);
      delete rooms[num];
    }
  }
}

setInterval(cleanupEmptyRooms, ROOM_CLEANUP_INTERVAL);
setInterval(saveRooms, 30000); // 每30秒强制保存一次

// ==================== Express 路由 ====================
app.get('/', (req, res) => {
  res.json({
    service: 'murder-mystery-backend',
    status: 'running',
    activeRooms: Object.keys(rooms).length,
    games: VALID_GAME_IDS,
    uptime: process.uptime()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', rooms: Object.keys(rooms).length });
});

// ==================== Socket.IO 连接处理 ====================
io.on('connection', (socket) => {
  console.log(`[Connect] socket=${socket.id}`);

  // ---------- DM 创建房间 ----------
  socket.on('create_room', (data, ack) => {
    try {
      const { gameId, password } = data || {};

      // 验证 gameId
      if (!VALID_GAME_IDS.includes(gameId)) {
        return ack && ack({ success: false, error: `无效的游戏ID: ${gameId}` });
      }

      // 验证 DM 密码（后端验证）
      if (password !== DM_PASSWORD) {
        return ack && ack({ success: false, error: 'DM密码错误' });
      }

      // 如果此 socket 已在其他房间，先离开
      leaveCurrentRoom(socket);

      const roomNumber = genRoomNumber();
      const dmPlayerId = 'dm_' + Date.now().toString(36);

      rooms[roomNumber] = {
        gameId,
        dmSocketId: socket.id,
        dmPlayerId,
        players: {},
        state: null,
        createdAt: Date.now(),
        lastActivity: Date.now()
      };

      // DM 自己作为玩家加入
      rooms[roomNumber].players[dmPlayerId] = {
        playerId: dmPlayerId,
        nickname: '主持人',
        charId: null,
        socketId: socket.id,
        online: true,
        lastSeen: Date.now(),
        isDM: true
      };

      socketMap[socket.id] = { roomNumber, playerId: dmPlayerId, gameId, isDM: true };

      console.log(`[CreateRoom] room=${roomNumber} game=${gameId} dm=${socket.id}`);
      scheduleSave();

      ack && ack({
        success: true,
        roomNumber,
        dmPlayerId,
        gameId
      });
    } catch (e) {
      console.error('[create_room error]', e);
      ack && ack({ success: false, error: '服务器内部错误' });
    }
  });

  // ---------- 玩家加入房间 ----------
  socket.on('join_room', (data, ack) => {
    try {
      const { gameId, roomNumber, playerId, nickname, charId } = data || {};

      if (!roomNumber || !rooms[roomNumber]) {
        return ack && ack({ success: false, error: '房间不存在或已结束' });
      }

      const room = rooms[roomNumber];

      if (room.gameId !== gameId) {
        return ack && ack({ success: false, error: `该房间属于其他游戏（${room.gameId}）` });
      }

      // 如果此 socket 已在其他房间，先离开
      leaveCurrentRoom(socket);

      const pid = playerId || ('p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
      const existingPlayer = room.players[pid];

      if (existingPlayer) {
        // 断线重连：更新 socketId，恢复在线状态
        existingPlayer.socketId = socket.id;
        existingPlayer.online = true;
        existingPlayer.lastSeen = Date.now();
        if (nickname) existingPlayer.nickname = nickname;
        if (charId) existingPlayer.charId = charId;
      } else {
        // 新玩家加入
        room.players[pid] = {
          playerId: pid,
          nickname: nickname || '玩家',
          charId: charId || null,
          socketId: socket.id,
          online: true,
          lastSeen: Date.now(),
          isDM: false
        };
      }

      socketMap[socket.id] = { roomNumber, playerId: pid, gameId, isDM: false };
      room.lastActivity = Date.now();

      console.log(`[JoinRoom] room=${roomNumber} player=${pid} nickname=${nickname} reconnect=${!!existingPlayer}`);
      scheduleSave();

      // 通知 DM 有玩家加入/重连
      sendToDM(roomNumber, 'player_joined', {
        playerId: pid,
        nickname: room.players[pid].nickname,
        charId: room.players[pid].charId,
        online: true,
        isReconnect: !!existingPlayer
      });

      // 通知房间内其他玩家
      broadcastToRoom(roomNumber, 'player_status', {
        players: getPublicPlayers(room)
      }, socket.id);

      ack && ack({
        success: true,
        roomNumber,
        playerId: pid,
        gameId: room.gameId,
        players: getPublicPlayers(room),
        fullState: room.state, // 返回缓存的完整状态供断线重连
        isReconnect: !!existingPlayer
      });
    } catch (e) {
      console.error('[join_room error]', e);
      ack && ack({ success: false, error: '服务器内部错误' });
    }
  });

  // ---------- 游戏消息中继 ----------
  // DM 发送: 广播给所有玩家
  // 玩家发送: 只发给 DM
  socket.on('game_msg', (data) => {
    try {
    const info = socketMap[socket.id];
    if (!info) return;
    const { roomNumber, isDM } = info;
    const room = getRoom(roomNumber);
    if (!room) return;

    room.lastActivity = Date.now();

    if (isDM) {
      // DM -> 所有玩家
      broadcastToRoom(roomNumber, 'game_msg', { from: 'dm', data }, socket.id);
    } else {
      // 玩家 -> DM
      const player = room.players[info.playerId];
      sendToDM(roomNumber, 'game_msg', {
        from: info.playerId,
        fromNickname: player ? player.nickname : null,
        data
      });
    }
    } catch (e) { console.error('[game_msg error]', e.message); }
  });

  // ---------- 私聊消息（DM -> 指定玩家，不广播） ----------
  socket.on('private_msg', (data) => {
    try {
    const info = socketMap[socket.id];
    if (!info || !info.isDM) return;
    const { toPlayerId, data: msgData } = data || {};
    if (!toPlayerId) return;
    const room = getRoom(info.roomNumber);
    if (!room) return;
    const targetPlayer = room.players[toPlayerId];
    if (targetPlayer && targetPlayer.socketId) {
      io.to(targetPlayer.socketId).emit('private_msg', { from: 'dm', data: msgData });
    }
    } catch (e) { console.error('[private_msg error]', e.message); }
  });

  // ---------- 状态更新（DM 发送，服务器缓存并广播） ----------
  socket.on('state_update', (data) => {
    try {
    const info = socketMap[socket.id];
    if (!info || !info.isDM) return;
    const room = getRoom(info.roomNumber);
    if (!room) return;

    room.state = data;
    room.lastActivity = Date.now();
    scheduleSave();

    // 广播给所有玩家
    broadcastToRoom(info.roomNumber, 'state_update', data, socket.id);
    } catch (e) { console.error('[state_update error]', e.message); }
  });

  // ---------- 心跳 pong ----------
  socket.on('pong', () => {
    try {
    const info = socketMap[socket.id];
    if (!info) return;
    const room = getRoom(info.roomNumber);
    if (!room) return;
    const player = room.players[info.playerId];
    if (player) {
      player.lastSeen = Date.now();
      if (!player.online) {
        player.online = true;
        broadcastToRoom(info.roomNumber, 'player_status', { players: getPublicPlayers(room) });
      }
    }
    } catch (e) { console.error('[pong error]', e.message); }
  });

  // ---------- DM 踢人 ----------
  socket.on('kick_player', (data) => {
    try {
    const info = socketMap[socket.id];
    if (!info || !info.isDM) return;
    const room = getRoom(info.roomNumber);
    if (!room) return;

    const { playerId } = data || {};
    const player = room.players[playerId];
    if (player && player.socketId) {
      io.to(player.socketId).emit('kicked', { reason: '被主持人移出房间' });
      player.online = false;
      player.socketId = null;
    }
    broadcastToRoom(info.roomNumber, 'player_status', { players: getPublicPlayers(room) });
    } catch (e) { console.error('[kick_player error]', e.message); }
  });

  // ---------- DM 结束房间 ----------
  socket.on('end_room', () => {
    try {
    const info = socketMap[socket.id];
    if (!info || !info.isDM) return;
    const roomNumber = info.roomNumber;
    const room = getRoom(roomNumber);
    if (!room) return;

    console.log(`[EndRoom] room=${roomNumber} game=${room.gameId}`);

    // 通知所有玩家房间结束
    broadcastToRoom(roomNumber, 'room_ended', { reason: '主持人已结束房间' });

    // 清理 socketMap
    for (const pid in room.players) {
      const p = room.players[pid];
      if (p.socketId) delete socketMap[p.socketId];
    }

    delete rooms[roomNumber];
    scheduleSave();
    } catch (e) { console.error('[end_room error]', e.message); }
  });

  // ---------- 断开连接 ----------
  socket.on('disconnect', (reason) => {
    console.log(`[Disconnect] socket=${socket.id} reason=${reason}`);
    handleDisconnect(socket, reason);
  });
});

// ==================== 断开处理 ====================
function handleDisconnect(socket, reason) {
  const info = socketMap[socket.id];
  if (!info) return;

  const { roomNumber, playerId, isDM } = info;
  const room = getRoom(roomNumber);
  if (!room) {
    delete socketMap[socket.id];
    return;
  }

  if (isDM) {
    // DM 断线：标记 DM 离线，但保留房间（等待重连）
    room.dmSocketId = null;
    const dmPlayer = room.players[room.dmPlayerId];
    if (dmPlayer) {
      dmPlayer.online = false;
      dmPlayer.socketId = null;
    }
    // 通知所有玩家 DM 离线
    broadcastToRoom(roomNumber, 'dm_offline', { message: '主持人连接中断，等待重连…' });
    console.log(`[DM Disconnect] room=${roomNumber}, room kept for reconnect`);
  } else {
    // 玩家断线：标记离线（不立即删除，等待重连）
    const player = room.players[playerId];
    if (player) {
      player.online = false;
      player.socketId = null;
      // 通知 DM
      sendToDM(roomNumber, 'player_left', { playerId, nickname: player.nickname });
    }
    broadcastToRoom(roomNumber, 'player_status', { players: getPublicPlayers(room) });
  }

  room.lastActivity = Date.now();
  delete socketMap[socket.id];
  scheduleSave();
}

function leaveCurrentRoom(socket) {
  const info = socketMap[socket.id];
  if (!info) return;
  handleDisconnect(socket, 'manual_leave');
}

// ==================== DM 重连恢复 ----------
// DM 断线后重连：通过 create_room 重新创建会生成新房间号
// 更好的方式：DM 用 reconnect_dm 恢复原房间
// 但为了简化，DM 刷新页面后用 localStorage 保存的 roomNumber + dmPlayerId 重新 join_room
// 服务器检测到 dmPlayerId 匹配时恢复 DM 身份
// 这个逻辑在 join_room 中已部分支持（通过 playerId 重连）
// 额外处理：如果 join 的 playerId 等于 room.dmPlayerId，提升为 DM

// 在 join_room 后检查是否为 DM 重连
io.engine.on('connection', (socket) => {
  // 这个钩子在 io.on('connection') 之前触发，不需要额外处理
});

// 增强 join_room 的 DM 重连逻辑（通过中间件包装）
// 实际上在 join_room 中，如果 playerId === room.dmPlayerId，应该恢复 DM 身份
// 让我们在连接后通过一个特殊事件处理
io.on('connection', (socket) => {
  socket.on('reconnect_dm', (data, ack) => {
    try {
    const { roomNumber, dmPlayerId, gameId } = data || {};
    const room = getRoom(roomNumber);
    if (!room) {
      return ack && ack({ success: false, error: '房间不存在或已被清理' });
    }
    if (room.dmPlayerId !== dmPlayerId) {
      return ack && ack({ success: false, error: 'DM身份验证失败' });
    }
    if (room.gameId !== gameId) {
      return ack && ack({ success: false, error: '游戏ID不匹配' });
    }

    leaveCurrentRoom(socket);

    room.dmSocketId = socket.id;
    const dmPlayer = room.players[dmPlayerId];
    if (dmPlayer) {
      dmPlayer.socketId = socket.id;
      dmPlayer.online = true;
      dmPlayer.lastSeen = Date.now();
    }

    socketMap[socket.id] = { roomNumber, playerId: dmPlayerId, gameId, isDM: true };
    room.lastActivity = Date.now();

    // 通知玩家 DM 回来了
    broadcastToRoom(roomNumber, 'dm_online', { message: '主持人已重新连接' }, socket.id);
    broadcastToRoom(roomNumber, 'player_status', { players: getPublicPlayers(room) }, socket.id);

    console.log(`[DM Reconnect] room=${roomNumber} dm=${socket.id}`);
    scheduleSave();

    ack && ack({
      success: true,
      roomNumber,
      gameId: room.gameId,
      players: getPublicPlayers(room),
      fullState: room.state
    });
    } catch (e) { console.error('[reconnect_dm error]', e.message); ack && ack({ success: false, error: '服务器内部错误' }); }
  });
});

// ==================== 启动服务器 ====================
server.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`  Murder Mystery Backend`);
  console.log(`  Port: ${PORT}`);
  console.log(`  Games: ${VALID_GAME_IDS.join(', ')}`);
  console.log(`  DM Password: ${DM_PASSWORD ? '***' : '(not set)'}`);
  console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`========================================`);
});

module.exports = { app, server, io, rooms };
