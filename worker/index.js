/*
 * Cloudflare Worker 入口 —— 联机服务器的外壳
 *
 * 真正的游戏逻辑在 js/room.js 里，那部分不依赖任何平台、已经有 247 项测试。
 * 这里只做三件事：
 *   1. 把 WebSocket 帧解析成消息交给 room.handle()
 *   2. 定时调 room.tick() 推进超时和机器人
 *   3. 把 room 产出的 outbox 发回对应的连接
 *
 * 一张桌子 = 一个 Durable Object。DO 天生单线程，两个请求不会真正并发进入，
 * 所以这里不需要任何锁。
 */

/*
 * js/ 下那几个文件同时支持浏览器和 CommonJS：末尾会判断有没有 module.exports。
 * 打包时 esbuild 会注入 module，于是它们走 CommonJS 分支导出，
 * 而不是挂到 globalThis 上 —— 所以这里必须按模块导入，不能靠副作用。
 * room.js 会通过 require 自己拉起 engine / ai / cards，依赖链不用在这里重复。
 */
import RoomModule from '../js/room.js';

const { Room } = RoomModule;

/**
 * 加密级随机数。
 * Math.random 是可预测的 —— 在服务器上用它洗牌，等于把牌堆泄给了
 * 任何愿意观察足够多手牌的人。
 */
function cryptoRandom() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 4294967296;
}

const TICK_MS = 250;

export class TableDO {
  constructor(state, env) {
    this.state = state;
    this.conns = new Map();      // connId -> WebSocket
    this.nextConnId = 1;
    this.timer = null;
    this.room = new Room({ rng: cryptoRandom });
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('This endpoint accepts WebSocket connections only', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.accept(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  accept(ws) {
    ws.accept();
    const connId = 'c' + this.nextConnId++;
    this.conns.set(connId, ws);

    ws.addEventListener('message', (event) => {
      let msg = null;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        this.sendTo(connId, { t: 'error', d: { code: 'bad_message', message: 'not valid JSON' } });
        return;
      }
      this.flush(this.room.handle(connId, msg, Date.now()));
    });

    const bye = () => {
      this.conns.delete(connId);
      this.flush(this.room.disconnect(connId));
      if (this.conns.size === 0) this.stopTimer();
    };
    ws.addEventListener('close', bye);
    ws.addEventListener('error', bye);

    this.startTimer();
  }

  startTimer() {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      try {
        this.flush(this.room.tick(Date.now()));
      } catch (e) {
        // 单次 tick 出错不该让整张桌子停摆
        console.error('tick failed:', e && e.message);
      }
    }, TICK_MS);
  }

  stopTimer() {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  sendTo(connId, msg) {
    const ws = this.conns.get(connId);
    if (!ws) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {
      this.conns.delete(connId);
    }
  }

  /** outbox 里的每条消息都指明了收件人 —— 状态是一人一份的，没有真正的广播 */
  flush(outbox) {
    if (!outbox) return;
    for (const entry of outbox) this.sendTo(entry.to, entry.msg);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, service: 'holdem' }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.pathname === '/ws') {
      const code = (url.searchParams.get('room') || 'default')
        .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'DEFAULT';
      // 同一个房间号永远落到同一个 Durable Object 上
      const id = env.TABLE.idFromName(code);
      return env.TABLE.get(id).fetch(request);
    }

    return new Response("Texas Hold'em server. Connect a room at /ws?room=CODE", { status: 404 });
  },
};
