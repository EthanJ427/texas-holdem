/*
 * 房间控制器 —— 联机模式的核心逻辑
 *
 * 刻意不碰任何平台 API：没有 WebSocket、没有 setTimeout、没有 Date.now()。
 * 时间从外面传进来（handle/tick 的 now 参数），消息只进 outbox 不直接发送。
 *
 * 这么写有两个好处：
 *   1. 能在浏览器测试框架里跑，不需要 Node
 *   2. 超时测试可以直接把时钟快进，不用真等六十秒
 *
 * Cloudflare 那层只是个薄壳：收到帧调 handle()，定时调 tick()，把 outbox 发出去。
 */
(function (root) {
  'use strict';

  const Engine = root.PokerEngine || (typeof require !== 'undefined' ? require('./engine.js') : null);
  const AI = root.PokerAI || (typeof require !== 'undefined' ? require('./ai.js') : null);
  const HoldemEngine = Engine.HoldemEngine;

  const SEATS = 6;
  const BOT_NAMES = ['老陈', '阿杰', '王姐', '小林', '高博'];

  const DEFAULTS = {
    smallBlind: 10,
    bigBlind: 20,
    startingChips: 1000,
    turnSeconds: 60,
    graceMs: 1500,          // 到点后再宽限一下，留出网络往返
    handGapMs: 3000,        // 两手之间的间隔
    botThinkMs: [400, 1100],
    fillWithBots: true,
    botLevels: ['intermediate', 'novice', 'expert', 'novice', 'intermediate'],
    maxMissedHands: 3,      // 连续这么多手没连上就请下座位
  };

  class Room {
    constructor(config) {
      this.config = Object.assign({}, DEFAULTS, config || {});
      this.rng = this.config.rng || Math.random;
      this.seats = new Array(SEATS).fill(null);
      this.engine = null;
      this.actionSeq = 0;
      this.deadline = null;       // 当前行动人的截止时刻
      this.botActAt = null;       // 机器人假装思考到什么时候
      this.nextHandAt = null;     // 下一手什么时候开
      this.outbox = [];
      this.handNumber = 0;

      if (this.config.fillWithBots) this.fillBots();
    }

    // ---------- 座位 ----------

    fillBots() {
      for (let i = 0; i < SEATS; i++) {
        if (this.seats[i]) continue;
        const botIndex = this.seats.filter((s) => s && s.isBot).length;
        this.seats[i] = {
          seat: i,
          name: BOT_NAMES[botIndex % BOT_NAMES.length],
          isBot: true,
          level: this.config.botLevels[botIndex % this.config.botLevels.length],
          chips: this.config.startingChips,
          connected: true,
          token: null,
          connId: null,
          missedHands: 0,
          leaveAfterHand: false,
        };
      }
    }

    humanSeats() {
      return this.seats.filter((s) => s && !s.isBot);
    }

    seatByToken(token) {
      return this.seats.find((s) => s && s.token && s.token === token) || null;
    }

    seatByConn(connId) {
      return this.seats.find((s) => s && s.connId === connId) || null;
    }

    makeToken() {
      let out = '';
      for (let i = 0; i < 4; i++) {
        out += Math.floor(this.rng() * 0xffffffff).toString(36);
      }
      return out;
    }

    // ---------- 消息出口 ----------

    send(connId, type, data, re) {
      const msg = { t: type, d: data };
      if (re !== undefined) msg.re = re;
      this.outbox.push({ to: connId, msg });
    }

    /**
     * 状态必须一人一份 —— 每个人的视图裁剪结果不同，
     * 所以这里没有真正意义上的「广播」。
     */
    pushState() {
      if (!this.engine) return;
      for (const s of this.seats) {
        if (!s || s.isBot || !s.connId) continue;
        this.send(s.connId, 'state', {
          view: this.engine.viewFor(s.seat),
          actionSeq: this.actionSeq,
          seats: this.seatSummary(),
        });
      }
    }

    /** 事件是所有人一样的（已经裁掉牌面数据），可以真广播 */
    pushEvents() {
      if (!this.engine) return;
      const raw = this.engine.drainEvents();
      if (raw.length === 0) return;
      const safe = this.engine.eventsFor(null, raw);
      for (const s of this.seats) {
        if (!s || s.isBot || !s.connId) continue;
        this.send(s.connId, 'events', { events: safe });
      }
    }

    pushTurn() {
      if (!this.engine || this.engine.handOver) return;
      const actor = this.engine.currentActor();
      if (!actor) return;
      const seat = this.seats[actor.id];
      if (!seat || seat.isBot || !seat.connId) return;
      this.send(seat.connId, 'turn', {
        seat: actor.id,
        actionSeq: this.actionSeq,
        deadline: this.deadline,
        legalActions: this.engine.legalActions(actor),
      });
    }

    seatSummary() {
      return this.seats.map((s, i) => (s ? {
        seat: i, name: s.name, isBot: s.isBot,
        connected: s.isBot ? true : !!s.connId,
        chips: s.chips,
      } : { seat: i, name: null, isBot: false, connected: false, chips: 0 }));
    }

    // ---------- 收消息 ----------

    /** 处理一条客户端消息，返回这次产生的待发消息 */
    handle(connId, msg, now) {
      this.outbox = [];
      try {
        switch (msg && msg.t) {
          case 'join': this.onJoin(connId, msg, now); break;
          case 'stand': this.onStand(connId, msg); break;
          case 'action': this.onAction(connId, msg, now); break;
          default:
            this.send(connId, 'error', { code: 'bad_message', message: '不认识的消息类型' }, msg && msg.id);
        }
      } catch (e) {
        this.send(connId, 'error', { code: 'internal', message: e.message }, msg && msg.id);
      }
      return this.outbox;
    }

    onJoin(connId, msg, now) {
      const d = msg.d || {};
      let seat = d.token ? this.seatByToken(d.token) : null;

      if (!seat) {
        // 新玩家：优先坐空位，没有空位就顶掉一个机器人
        let index = this.seats.findIndex((s) => !s);
        if (index < 0) index = this.seats.findIndex((s) => s && s.isBot);
        if (index < 0) {
          this.send(connId, 'error', { code: 'room_full', message: '六个座位都满了' }, msg.id);
          return;
        }
        seat = {
          seat: index,
          name: (d.name || '玩家').slice(0, 12),
          isBot: false,
          level: null,
          chips: this.config.startingChips,
          connected: true,
          token: this.makeToken(),
          connId,
          missedHands: 0,
          leaveAfterHand: false,
        };
        this.seats[index] = seat;
      } else {
        // 重连：拿回原座位和筹码
        seat.connId = connId;
        seat.connected = true;
        seat.missedHands = 0;
      }

      this.send(connId, 'welcome', {
        you: seat.seat,
        token: seat.token,
        serverTime: now,
        config: {
          smallBlind: this.config.smallBlind,
          bigBlind: this.config.bigBlind,
          startingChips: this.config.startingChips,
          turnSeconds: this.config.turnSeconds,
          fillWithBots: this.config.fillWithBots,
        },
      }, msg.id);

      if (this.engine) {
        // 重连的人立刻拿一份完整状态，不需要重放历史
        this.send(connId, 'state', {
          view: this.engine.viewFor(seat.seat),
          actionSeq: this.actionSeq,
          seats: this.seatSummary(),
        });
        this.pushTurn();
      } else if (this.nextHandAt === null) {
        this.nextHandAt = now;      // 人齐了就可以开牌
      }
    }

    onStand(connId, msg) {
      const seat = this.seatByConn(connId);
      if (!seat) return;
      seat.leaveAfterHand = true;
      this.send(connId, 'ok', { standing: true }, msg.id);
    }

    /** 连接断开。不立刻弃牌，但计时照走 —— 否则拔网线就是无限思考时间。 */
    disconnect(connId) {
      this.outbox = [];
      const seat = this.seatByConn(connId);
      if (seat) {
        seat.connId = null;
        seat.connected = false;
      }
      return this.outbox;
    }

    onAction(connId, msg, now) {
      const d = msg.d || {};
      const seat = this.seatByConn(connId);

      if (!seat) {
        this.send(connId, 'error', { code: 'bad_token', message: '你不在这张桌子上' }, msg.id);
        return;
      }
      if (!this.engine || this.engine.handOver) {
        this.send(connId, 'error', { code: 'not_your_turn', message: '现在不在牌局中' }, msg.id);
        return;
      }
      // 防重放的序号校验必须排在「是不是轮到你」前面。
      // 顺序反了的话，重复提交多半会先撞上 not_your_turn，看起来也拦住了 ——
      // 但那是巧合：加注会让行动权绕回同一个人，那时唯一挡得住重发的就是序号。
      // 序号才是真正的防线，也是更准确的错误信息。
      if (d.handNumber !== this.engine.handNumber || d.actionSeq !== this.actionSeq) {
        this.send(connId, 'error', { code: 'stale_action', message: '这一手已经推进了' }, msg.id);
        return;
      }
      const actor = this.engine.currentActor();
      if (!actor || actor.id !== seat.seat) {
        this.send(connId, 'error', { code: 'not_your_turn', message: '还没轮到你' }, msg.id);
        return;
      }

      try {
        this.engine.act(d.type, d.amount);
      } catch (e) {
        this.send(connId, 'error', { code: 'illegal_action', message: e.message }, msg.id);
        return;
      }

      this.actionSeq++;
      this.afterEngineStep(now);
    }

    // ---------- 推进时间 ----------

    /** 由外部定时调用（比如每 250ms 一次），处理超时和机器人行动 */
    tick(now) {
      this.outbox = [];
      if (!this.engine) {
        if (this.nextHandAt !== null && now >= this.nextHandAt) this.startHand(now);
        return this.outbox;
      }
      if (this.engine.handOver) {
        if (this.nextHandAt !== null && now >= this.nextHandAt) this.startHand(now);
        return this.outbox;
      }

      const actor = this.engine.currentActor();
      if (!actor) return this.outbox;
      const seat = this.seats[actor.id];
      if (!seat) return this.outbox;

      if (seat.isBot) {
        if (this.botActAt !== null && now >= this.botActAt) this.botAct(now);
        return this.outbox;
      }

      // 真人超时：能过牌就过牌，否则弃牌
      if (this.deadline !== null && now >= this.deadline + this.config.graceMs) {
        const legal = this.engine.legalActions(actor);
        const canCheck = legal.some((a) => a.type === 'check');
        this.engine.act(canCheck ? 'check' : 'fold');
        this.actionSeq++;
        this.afterEngineStep(now);
      }
      return this.outbox;
    }

    botAct(now) {
      const actor = this.engine.currentActor();
      const view = this.engine.viewFor(actor.id);
      const move = AI.decide(view);
      this.engine.act(move.type, move.amount);
      this.actionSeq++;
      this.afterEngineStep(now);
    }

    /** 引擎前进一步之后统一处理：发事件、发状态、安排下一个行动人 */
    afterEngineStep(now) {
      this.pushEvents();
      this.pushState();

      if (this.engine.handOver) {
        this.endHand(now);
        return;
      }
      this.scheduleActor(now);
      this.pushTurn();
    }

    scheduleActor(now) {
      const actor = this.engine.currentActor();
      this.deadline = null;
      this.botActAt = null;
      if (!actor) return;
      const seat = this.seats[actor.id];
      if (!seat) return;

      if (seat.isBot) {
        const [lo, hi] = this.config.botThinkMs;
        this.botActAt = now + lo + Math.floor(this.rng() * (hi - lo));
      } else {
        this.deadline = now + this.config.turnSeconds * 1000;
      }
    }

    // ---------- 一手牌的开始与结束 ----------

    startHand(now) {
      // 先处理上一手结束时该走的人
      for (let i = 0; i < SEATS; i++) {
        const s = this.seats[i];
        if (!s) continue;
        if (s.leaveAfterHand || (!s.isBot && s.missedHands >= this.config.maxMissedHands)) {
          this.seats[i] = null;
        }
      }
      if (this.config.fillWithBots) this.fillBots();

      const playable = this.seats.filter((s) => s && s.chips > 0);
      if (playable.length < 2) {
        this.nextHandAt = null;
        return;
      }

      // 每手重建引擎，座位变动只在手与手之间生效
      this.engine = new HoldemEngine({
        players: this.seats.map((s) => ({
          name: s ? s.name : '空位',
          isHuman: s ? !s.isBot : false,
          level: s ? s.level : null,
          chips: s ? s.chips : 0,
        })),
        smallBlind: this.config.smallBlind,
        bigBlind: this.config.bigBlind,
        startingChips: this.config.startingChips,
        rng: this.rng,
      });
      this.engine.handNumber = this.handNumber;
      this.engine.buttonIndex = this.buttonSeat === undefined ? 0 : this.buttonSeat;

      this.actionSeq = 0;
      this.nextHandAt = null;

      if (!this.engine.startHand()) {
        this.engine = null;
        return;
      }
      this.handNumber = this.engine.handNumber;
      this.buttonSeat = this.engine.buttonIndex;

      // 断线的人这一手记一次缺席
      for (const s of this.seats) {
        if (s && !s.isBot && !s.connId) s.missedHands++;
      }

      this.pushEvents();
      this.pushState();
      this.scheduleActor(now);
      this.pushTurn();
    }

    endHand(now) {
      // 把筹码写回座位记录 —— 引擎每手重建，筹码得存在座位上
      for (const s of this.seats) {
        if (!s) continue;
        s.chips = this.engine.players[s.seat].chips;
      }
      this.deadline = null;
      this.botActAt = null;
      this.nextHandAt = now + this.config.handGapMs;
    }
  }

  const api = { Room, SEATS, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PokerRoom = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
