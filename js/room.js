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
  const BOT_NAMES = ['Chen', 'Marcus', 'Nadia', 'Priya', 'Tobias'];

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
    rebuyChips: null,       // 补码金额，null 表示按 startingChips 买满
    botRebuy: true,         // 机器人破产后自动补码。关掉的话桌子会慢慢空掉
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
      // 牌局进行中来的人先排队，下一手开始时才真正入座
      this.pending = [];
      // 房间自己发的事件（补码之类）。引擎每手重建，这些发生在建引擎之前，
      // 挂不到引擎的事件流上，所以单独排一队，下次 pushEvents 一起送出去。
      this.roomEvents = [];
      this.rebuyChipsAdded = 0;   // 补码一共往桌上加了多少，记账用

      if (this.config.fillWithBots) this.fillBots();
    }

    // ---------- 座位 ----------

    fillBots() {
      for (let i = 0; i < SEATS; i++) {
        if (this.seats[i]) continue;
        // 取一个当前没人用的名字。
        // 不能按「现有机器人数量」当索引：真人顶掉中间某个机器人后，
        // 数量会和还留在桌上的某个名字撞上，于是出现两个「高博」。
        const used = new Set(this.seats.filter(Boolean).map((s) => s.name));
        const name = BOT_NAMES.find((n) => !used.has(n)) || `Bot ${i}`;
        const botIndex = Math.max(0, BOT_NAMES.indexOf(name));
        this.seats[i] = {
          seat: i,
          name,
          isBot: true,
          level: this.config.botLevels[botIndex % this.config.botLevels.length],
          chips: this.config.startingChips,
          connected: true,
          token: null,
          connId: null,
          missedHands: 0,
          leaveAfterHand: false,
          wantsRebuy: false,
          rebuys: 0,
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

    /**
     * 事件是所有人一样的（已经裁掉牌面数据），可以真广播。
     * 房间自己的事件排在引擎事件前面：补码发生在这一手的引擎建起来之前，
     * 顺序上也确实早于「第 N 手开始」。
     */
    pushEvents() {
      const raw = this.engine ? this.engine.drainEvents() : [];
      const safe = this.roomEvents.concat(this.engine ? this.engine.eventsFor(null, raw) : []);
      this.roomEvents = [];
      if (safe.length === 0) return;
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
        rebuyPending: !!s.wantsRebuy,
      } : { seat: i, name: null, isBot: false, connected: false, chips: 0, rebuyPending: false }));
    }

    // ---------- 收消息 ----------

    /** 处理一条客户端消息，返回这次产生的待发消息 */
    handle(connId, msg, now) {
      this.outbox = [];
      try {
        switch (msg && msg.t) {
          case 'join': this.onJoin(connId, msg, now); break;
          case 'stand': this.onStand(connId, msg); break;
          case 'rebuy': this.onRebuy(connId, msg, now); break;
          case 'action': this.onAction(connId, msg, now); break;
          default:
            this.send(connId, 'error', { code: 'bad_message', message: 'unknown message type' }, msg && msg.id);
        }
      } catch (e) {
        this.send(connId, 'error', { code: 'internal', message: e.message }, msg && msg.id);
      }
      return this.outbox;
    }

    onJoin(connId, msg, now) {
      const d = msg.d || {};
      let seat = d.token ? this.seatByToken(d.token) : null;

      // 排队中的人重连
      if (!seat) {
        const waiting = this.pending.find((p) => d.token && p.token === d.token);
        if (waiting) waiting.connId = connId;
      }

      if (!seat) {
        // 牌局进行中绝不动座位 —— 否则新来的人会当场接手别人这一手的底牌，
        // 既看得见也能行动，筹码记账还会错乱。先排队，下一手开始时入座。
        if (this.engine && !this.engine.handOver) {
          let waiting = this.pending.find((p) => p.connId === connId);
          if (!waiting) {
            waiting = {
              connId,
              name: (d.name || 'Player').slice(0, 12),
              token: d.token || this.makeToken(),
            };
            this.pending.push(waiting);
          }
          this.send(connId, 'welcome', {
            you: null,
            token: waiting.token,
            serverTime: now,
            waiting: true,
            config: this.publicConfig(),
          }, msg.id);
          // 旁观视角：谁的底牌都看不到
          this.send(connId, 'state', {
            view: this.engine.viewFor(null),
            actionSeq: this.actionSeq,
            seats: this.seatSummary(),
          });
          return;
        }

        // 没在牌局中：优先坐空位，没有空位就顶掉一个机器人
        let index = this.seats.findIndex((s) => !s);
        if (index < 0) index = this.seats.findIndex((s) => s && s.isBot);
        if (index < 0) {
          this.send(connId, 'error', { code: 'room_full', message: 'all six seats are taken' }, msg.id);
          return;
        }
        seat = {
          seat: index,
          name: (d.name || 'Player').slice(0, 12),
          isBot: false,
          level: null,
          chips: this.config.startingChips,
          connected: true,
          token: this.makeToken(),
          connId,
          missedHands: 0,
          leaveAfterHand: false,
          wantsRebuy: false,
          rebuys: 0,
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
        waiting: false,
        config: this.publicConfig(),
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

    rebuyAmount() {
      return this.config.rebuyChips || this.config.startingChips;
    }

    /** 座位此刻真实的筹码。牌局进行中要看引擎，座位上那份是这一手开始时的快照。 */
    liveChips(seat) {
      if (this.engine && !this.engine.handOver) {
        const p = this.engine.players[seat.seat];
        if (p) return p.chips;
      }
      return seat.chips;
    }

    /**
     * 补码。这里只记下意愿，筹码一律等到下一手开始才到账 ——
     * 牌局中途给人加筹码，这一手的边池就算错了。
     *
     * 全下的人此刻筹码同样是 0，但他还在争池子，所以「到底给不给」
     * 要留到开牌前由 grantRebuys() 判断，那时胜负已定。
     */
    onRebuy(connId, msg, now) {
      const seat = this.seatByConn(connId);
      if (!seat) {
        this.send(connId, 'error', { code: 'bad_token', message: 'you are not seated at this table' }, msg.id);
        return;
      }
      if (this.liveChips(seat) > 0) {
        this.send(connId, 'error', { code: 'not_busted', message: 'you still have chips' }, msg.id);
        return;
      }

      seat.wantsRebuy = true;
      this.send(connId, 'ok', { rebuy: true, chips: this.rebuyAmount() }, msg.id);

      // 桌上不够两个人时房间是停着的（nextHandAt 被清成 null），补码要把它叫醒，
      // 否则最后一个还有筹码的人只能干等
      if (this.nextHandAt === null && (!this.engine || this.engine.handOver)) {
        this.nextHandAt = now + this.config.handGapMs;
      }
      this.pushState();
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
        this.send(connId, 'error', { code: 'bad_token', message: 'you are not seated at this table' }, msg.id);
        return;
      }
      if (!this.engine || this.engine.handOver) {
        this.send(connId, 'error', { code: 'not_your_turn', message: 'no hand in progress' }, msg.id);
        return;
      }
      // 防重放的序号校验必须排在「是不是轮到你」前面。
      // 顺序反了的话，重复提交多半会先撞上 not_your_turn，看起来也拦住了 ——
      // 但那是巧合：加注会让行动权绕回同一个人，那时唯一挡得住重发的就是序号。
      // 序号才是真正的防线，也是更准确的错误信息。
      if (d.handNumber !== this.engine.handNumber || d.actionSeq !== this.actionSeq) {
        this.send(connId, 'error', { code: 'stale_action', message: 'this hand has already moved on' }, msg.id);
        return;
      }
      const actor = this.engine.currentActor();
      if (!actor || actor.id !== seat.seat) {
        this.send(connId, 'error', { code: 'not_your_turn', message: 'not your turn' }, msg.id);
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
      this.seatPending();
      if (this.config.fillWithBots) this.fillBots();
      this.grantRebuys();

      const playable = this.seats.filter((s) => s && s.chips > 0);
      if (playable.length < 2) {
        this.nextHandAt = null;
        this.pushEvents();      // 补码的消息该发还是要发，哪怕这一手开不起来
        return;
      }

      // 每手重建引擎，座位变动只在手与手之间生效
      this.engine = new HoldemEngine({
        players: this.seats.map((s) => ({
          name: s ? s.name : 'Empty',
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

    publicConfig() {
      return {
        smallBlind: this.config.smallBlind,
        bigBlind: this.config.bigBlind,
        startingChips: this.config.startingChips,
        turnSeconds: this.config.turnSeconds,
        fillWithBots: this.config.fillWithBots,
        rebuyChips: this.rebuyAmount(),
      };
    }

    /**
     * 发放补码。只在一手牌开始前调用，是筹码唯一凭空增加的地方。
     *
     * 判断标准是「此刻筹码是不是 0」，不是「当初申请时是不是 0」——
     * 全下的人申请时也是 0，赢回来了就不该再白拿一份。
     */
    grantRebuys() {
      const amount = this.rebuyAmount();
      for (const s of this.seats) {
        if (!s) continue;
        if (s.chips > 0) { s.wantsRebuy = false; continue; }

        if (s.isBot) {
          if (!this.config.botRebuy) continue;
        } else if (!s.wantsRebuy) {
          continue;
        } else if (!s.connId) {
          continue;      // 人不在，先把这个意愿留着，等他重连回来那一手再补
        }

        s.chips = amount;
        s.wantsRebuy = false;
        s.rebuys++;
        this.rebuyChipsAdded += amount;
        this.roomEvents.push({
          type: 'rebuy',
          player: s.seat,
          amount,
          text: `${s.name} buys back in for ${amount}`,
        });
      }
    }

    /** 把等候队列里的人安置到座位上。只在一手牌开始前调用。 */
    seatPending() {
      while (this.pending.length) {
        let index = this.seats.findIndex((s) => !s);
        if (index < 0) index = this.seats.findIndex((s) => s && s.isBot);
        if (index < 0) break;                       // 满了，继续等
        const waiting = this.pending.shift();
        this.seats[index] = {
          seat: index,
          name: waiting.name,
          isBot: false,
          level: null,
          chips: this.config.startingChips,
          connected: true,
          token: waiting.token,
          connId: waiting.connId,
          missedHands: 0,
          leaveAfterHand: false,
          wantsRebuy: false,
          rebuys: 0,
        };
        // 告诉他坐到了几号位
        this.send(waiting.connId, 'welcome', {
          you: index,
          token: waiting.token,
          serverTime: Date.now(),
          waiting: false,
          config: this.publicConfig(),
        });
      }
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
