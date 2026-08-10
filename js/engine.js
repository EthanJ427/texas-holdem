/*
 * 德州扑克规则引擎
 *
 * 只负责规则，不碰界面、不碰 AI。用法：
 *   const g = new HoldemEngine({ players: [...], startingChips, smallBlind, bigBlind });
 *   g.startHand();
 *   g.currentActor();     // 该谁行动
 *   g.legalActions();     // 他能做什么
 *   g.act('raise', 120);  // 行动（raise/bet 的 amount 是「加注到」的总额）
 *
 * 每一步产生的事件都进 g.events，界面自己按节奏播放。
 */
(function (root) {
  'use strict';

  const Cards = root.PokerCards || (typeof require !== 'undefined' ? require('./cards.js') : null);

  const STREETS = ['preflop', 'flop', 'turn', 'river'];
  const STREET_NAMES = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌' };

  class HoldemEngine {
    constructor(config) {
      // 洗牌用的随机源。单机用 Math.random 足够；服务器必须传入
      // crypto 级别的发生器 —— Math.random 是可预测的，联机时等于把牌堆泄了。
      this.rng = config.rng || Math.random;

      this.smallBlind = config.smallBlind || 10;
      this.bigBlind = config.bigBlind || 20;
      this.startingChips = config.startingChips || 1000;

      this.players = config.players.map((p, i) => ({
        id: i,
        name: p.name,
        isHuman: !!p.isHuman,
        level: p.level || null,
        chips: p.chips !== undefined ? p.chips : this.startingChips,
        bet: 0,
        committed: 0,
        hole: [],
        folded: false,
        allIn: false,
        busted: false,
        hasActed: false,
        canRaise: true,
        lastAction: null,
        wonThisHand: 0,
      }));

      this.buttonIndex = 0;
      this.handNumber = 0;
      this.street = null;
      this.board = [];
      this.deck = [];
      this.currentBet = 0;
      this.minRaise = this.bigBlind;
      this.actorIndex = -1;
      this.events = [];
      this.handOver = true;
      this.result = null;
    }

    // ---------- 查询 ----------

    get pot() {
      return this.players.reduce((sum, p) => sum + p.committed, 0);
    }

    /** 还坐在牌桌上、没破产的玩家 */
    seatedPlayers() {
      return this.players.filter((p) => !p.busted);
    }

    /** 本手牌还没弃牌的玩家 */
    livePlayers() {
      return this.players.filter((p) => !p.busted && !p.folded);
    }

    /** 还有筹码、还能做决定的玩家 */
    actablePlayers() {
      return this.livePlayers().filter((p) => !p.allIn);
    }

    currentActor() {
      if (this.handOver || this.actorIndex < 0) return null;
      return this.players[this.actorIndex];
    }

    toCall(player) {
      return Math.max(0, this.currentBet - player.bet);
    }

    /** 当前行动玩家的合法动作。raise 的 min/max 都是「加注到」的总额。 */
    legalActions(player) {
      const p = player || this.currentActor();
      if (!p) return [];

      const toCall = this.toCall(p);
      const actions = [];

      actions.push({ type: 'fold', label: '弃牌' });

      if (toCall === 0) {
        actions.push({ type: 'check', label: '过牌' });
      } else {
        const amount = Math.min(toCall, p.chips);
        actions.push({
          type: 'call',
          label: amount >= p.chips ? `全下跟注 ${amount}` : `跟注 ${amount}`,
          amount,
        });
      }

      // 还有筹码能压过当前注额，才谈得上下注/加注
      if (p.chips > toCall && p.canRaise) {
        const maxTo = p.bet + p.chips;
        const minTo = Math.min(this.currentBet + this.minRaise, maxTo);
        actions.push({
          type: this.currentBet === 0 ? 'bet' : 'raise',
          label: this.currentBet === 0 ? '下注' : '加注',
          min: minTo,
          max: maxTo,
        });
      }

      return actions;
    }

    // ---------- 一手牌的流程 ----------

    startHand() {
      // 上一手结束后先清算破产的人
      for (const p of this.players) {
        if (!p.busted && p.chips <= 0) {
          p.busted = true;
          this.emit('busted', { player: p.id, text: `${p.name} 筹码输光，离开牌桌` });
        }
      }

      const seated = this.seatedPlayers();
      if (seated.length < 2) {
        this.handOver = true;
        this.emit('game-over', {
          winner: seated.length ? seated[0].id : null,
          text: seated.length ? `${seated[0].name} 赢下了全部筹码` : '牌局结束',
        });
        return false;
      }

      this.handNumber++;
      this.handOver = false;
      this.result = null;
      this.board = [];
      this.street = 'preflop';
      this.currentBet = 0;
      this.minRaise = this.bigBlind;

      for (const p of this.players) {
        p.bet = 0;
        p.committed = 0;
        p.hole = [];
        p.folded = p.busted;
        p.allIn = false;
        p.hasActed = false;
        p.canRaise = true;
        p.lastAction = null;
        p.wonThisHand = 0;
      }

      // 移动庄家按钮到下一个还在场的人
      this.buttonIndex = this.nextSeated(this.buttonIndex);

      this.deck = Cards.shuffle(Cards.makeDeck(), this.rng);
      this.emit('hand-start', {
        handNumber: this.handNumber,
        button: this.buttonIndex,
        text: `第 ${this.handNumber} 手 · ${this.players[this.buttonIndex].name} 是庄家`,
      });

      this.postBlinds();
      this.dealHoleCards();

      this.actorIndex = this.firstActorPreflop();
      this.checkForAutoAdvance();
      return true;
    }

    postBlinds() {
      const seated = this.seatedPlayers();
      const headsUp = seated.length === 2;

      // 单挑时庄家下小盲；三人以上按钮左手边是小盲
      const sbIndex = headsUp ? this.buttonIndex : this.nextSeated(this.buttonIndex);
      const bbIndex = this.nextSeated(sbIndex);

      this.postBlind(this.players[sbIndex], this.smallBlind, '小盲');
      this.postBlind(this.players[bbIndex], this.bigBlind, '大盲');

      this.currentBet = this.bigBlind;
      this.minRaise = this.bigBlind;
      this.sbIndex = sbIndex;
      this.bbIndex = bbIndex;
    }

    postBlind(player, amount, label) {
      const actual = Math.min(amount, player.chips);
      player.chips -= actual;
      player.bet += actual;
      player.committed += actual;
      if (player.chips === 0) player.allIn = true;
      this.emit('blind', {
        player: player.id, amount: actual, label,
        text: `${player.name} 下${label} ${actual}`,
      });
    }

    dealHoleCards() {
      // 从小盲开始，一人一张发两轮，和真实牌桌一致
      const order = [];
      let idx = this.sbIndex;
      const seatedCount = this.seatedPlayers().length;
      for (let i = 0; i < seatedCount; i++) {
        order.push(idx);
        idx = this.nextSeated(idx);
      }
      for (let round = 0; round < 2; round++) {
        for (const seat of order) this.players[seat].hole.push(this.deck.pop());
      }
      this.emit('deal-hole', { text: '发底牌' });
    }

    firstActorPreflop() {
      const seated = this.seatedPlayers();
      if (seated.length === 2) {
        // 单挑：小盲（也就是庄家）先说话。但盲注可能已经把他打成全下，
        // 这种情况下要跳给下一个还能行动的人。
        const sb = this.players[this.sbIndex];
        return (!sb.folded && !sb.allIn) ? this.sbIndex : this.nextActable(this.sbIndex);
      }
      // 三人以上：大盲左手边的枪口位
      return this.nextActable(this.bbIndex);
    }

    firstActorPostflop() {
      // 按钮左手边先说话。单挑时按钮是小盲，左手边正好是大盲，规则天然吻合。
      return this.nextActable(this.buttonIndex);
    }

    // ---------- 行动 ----------

    act(type, amount) {
      const p = this.currentActor();
      if (!p) throw new Error('现在没有人可以行动');

      const legal = this.legalActions(p);
      const match = legal.find((a) => a.type === type);
      if (!match) throw new Error(`${p.name} 现在不能 ${type}`);

      switch (type) {
        case 'fold': this.doFold(p); break;
        case 'check': this.doCheck(p); break;
        case 'call': this.doCall(p); break;
        case 'bet':
        case 'raise': this.doRaise(p, amount, match); break;
        default: throw new Error('未知动作：' + type);
      }

      this.afterAction();
    }

    doFold(p) {
      p.folded = true;
      p.hasActed = true;
      p.lastAction = '弃牌';
      this.emit('action', { player: p.id, action: 'fold', text: `${p.name} 弃牌` });
    }

    doCheck(p) {
      p.hasActed = true;
      p.lastAction = '过牌';
      this.emit('action', { player: p.id, action: 'check', text: `${p.name} 过牌` });
    }

    doCall(p) {
      const amount = Math.min(this.toCall(p), p.chips);
      p.chips -= amount;
      p.bet += amount;
      p.committed += amount;
      p.hasActed = true;
      if (p.chips === 0) p.allIn = true;
      p.lastAction = p.allIn ? '全下' : `跟注 ${amount}`;
      this.emit('action', {
        player: p.id, action: 'call', amount,
        text: p.allIn ? `${p.name} 全下 ${amount}` : `${p.name} 跟注 ${amount}`,
      });
    }

    doRaise(p, rawTo, legalEntry) {
      // amount 是「加注到」的总额，不是增量
      let target = Math.round(rawTo);
      if (!Number.isFinite(target)) throw new Error('加注金额无效');
      target = Math.max(legalEntry.min, Math.min(legalEntry.max, target));

      const previousBet = this.currentBet;
      const delta = target - p.bet;
      p.chips -= delta;
      p.bet = target;
      p.committed += delta;
      if (p.chips === 0) p.allIn = true;

      const raiseSize = target - previousBet;
      const isFullRaise = raiseSize >= this.minRaise;

      this.currentBet = target;
      p.hasActed = true;

      if (isFullRaise) {
        this.minRaise = raiseSize;
        // 完整加注重新打开行动权
        for (const other of this.players) {
          if (other !== p && !other.folded && !other.allIn && !other.busted) {
            other.hasActed = false;
            other.canRaise = true;
          }
        }
      } else {
        // 全下金额不足一个完整加注：已经跟平的人只能跟或弃，不能再加注
        for (const other of this.players) {
          if (other !== p && !other.folded && !other.allIn && !other.busted) {
            if (other.bet === previousBet && other.hasActed) other.canRaise = false;
          }
        }
      }

      const verb = previousBet === 0 ? '下注' : '加注到';
      p.lastAction = p.allIn ? '全下' : `${verb} ${target}`;
      this.emit('action', {
        player: p.id, action: legalEntry.type, amount: target,
        text: p.allIn ? `${p.name} 全下 ${target}` : `${p.name} ${verb} ${target}`,
      });
    }

    afterAction() {
      if (this.livePlayers().length === 1) return this.endHandByFold();

      if (this.bettingRoundComplete()) {
        this.nextStreet();
      } else {
        this.actorIndex = this.nextActable(this.actorIndex);
      }
    }

    bettingRoundComplete() {
      const live = this.livePlayers();
      if (live.length <= 1) return true;
      const actable = live.filter((p) => !p.allIn);
      if (actable.length === 0) return true;
      return actable.every((p) => p.hasActed && p.bet === this.currentBet);
    }

    nextStreet() {
      // 没人还能继续下注了，直接把公共牌发完去摊牌
      if (this.actablePlayers().length <= 1) {
        while (this.board.length < 5) this.dealNextBoardCards();
        return this.showdown();
      }

      if (this.street === 'river') return this.showdown();

      const next = STREETS[STREETS.indexOf(this.street) + 1];
      this.street = next;
      this.dealNextBoardCards();

      this.currentBet = 0;
      this.minRaise = this.bigBlind;
      for (const p of this.players) {
        p.bet = 0;
        p.hasActed = false;
        p.canRaise = true;
        p.lastAction = null;
      }

      this.actorIndex = this.firstActorPostflop();
      this.emit('street', {
        street: next, board: this.board.slice(),
        text: `${STREET_NAMES[next]}：${this.board.map(Cards.cardName).join(' ')}`,
      });

      this.checkForAutoAdvance();
    }

    dealNextBoardCards() {
      this.deck.pop(); // 烧牌
      const count = this.board.length === 0 ? 3 : 1;
      for (let i = 0; i < count; i++) this.board.push(this.deck.pop());
    }

    /** 发完牌后可能已经没人需要行动了（比如全都全下），这里兜底推进。 */
    checkForAutoAdvance() {
      if (this.handOver) return;
      if (this.bettingRoundComplete()) this.nextStreet();
    }

    // ---------- 结算 ----------

    endHandByFold() {
      const winner = this.livePlayers()[0];
      const amount = this.pot;
      winner.chips += amount;
      winner.wonThisHand = amount;
      this.handOver = true;
      this.actorIndex = -1;
      this.result = {
        showdown: false,
        pots: [{ amount, winners: [winner.id] }],
        hands: [],
      };
      this.emit('hand-end', {
        text: `其他人都弃牌，${winner.name} 赢得 ${amount}`,
        result: this.result,
      });
      return this.result;
    }

    /**
     * 按每个人投入的筹码分层建池。投得少的人只能赢到自己那一层，
     * 弃牌者的筹码留在池里但没有分配资格。
     */
    buildPots() {
      const levels = [...new Set(
        this.players.filter((p) => p.committed > 0).map((p) => p.committed)
      )].sort((a, b) => a - b);

      const pots = [];
      let previous = 0;
      let orphaned = 0;   // 只有弃牌者投过、没人有资格认领的那部分

      for (const level of levels) {
        let amount = 0;
        for (const p of this.players) {
          amount += Math.min(p.committed, level) - Math.min(p.committed, previous);
        }
        previous = level;
        if (amount <= 0) continue;

        const eligible = this.players.filter((p) => !p.folded && p.committed >= level);
        if (eligible.length === 0) {
          // 弃牌的人投得比所有还在牌里的人都多，多出来的是死钱。
          // 资格集合随层数递增只会变小，所以这种层必定都在最顶上，先攒着。
          orphaned += amount;
        } else {
          pots.push({ amount, eligible: eligible.map((p) => p.id) });
        }
      }

      // 死钱并入最高的那个有人争的池，一分都不能丢
      if (orphaned > 0) {
        if (pots.length > 0) {
          pots[pots.length - 1].amount += orphaned;
        } else {
          const live = this.players.filter((p) => !p.folded);
          if (live.length > 0) pots.push({ amount: orphaned, eligible: live.map((p) => p.id) });
        }
      }

      // 分配资格相同的相邻层合并，显示上更清爽
      const merged = [];
      for (const pot of pots) {
        const last = merged[merged.length - 1];
        if (last && last.eligible.join(',') === pot.eligible.join(',')) {
          last.amount += pot.amount;
        } else {
          merged.push({ ...pot });
        }
      }
      return merged;
    }

    showdown() {
      this.street = 'showdown';
      const live = this.livePlayers();

      const hands = live.map((p) => {
        const score = Cards.evaluate(p.hole.concat(this.board));
        return {
          player: p.id,
          score,
          description: Cards.describe(score),
          best: Cards.bestFive(p.hole.concat(this.board)),
        };
      });
      const scoreOf = (id) => hands.find((h) => h.player === id).score;

      const pots = this.buildPots();
      const awarded = [];

      for (let i = 0; i < pots.length; i++) {
        const pot = pots[i];
        const contenders = pot.eligible.filter((id) => !this.players[id].folded);
        if (contenders.length === 0) continue;

        const best = Math.max(...contenders.map(scoreOf));
        const winners = contenders.filter((id) => scoreOf(id) === best);

        const share = Math.floor(pot.amount / winners.length);
        let remainder = pot.amount - share * winners.length;

        // 零头按规矩给按钮左手边最近的赢家
        const ordered = this.orderFromButton(winners);
        for (const id of ordered) {
          let amount = share;
          if (remainder > 0) { amount += 1; remainder--; }
          this.players[id].chips += amount;
          this.players[id].wonThisHand += amount;
        }

        awarded.push({
          amount: pot.amount,
          winners,
          label: i === 0 ? '主池' : `边池 ${i}`,
          eligible: pot.eligible,
        });
      }

      this.handOver = true;
      this.actorIndex = -1;
      this.result = { showdown: true, pots: awarded, hands };

      const summary = awarded.map((pot) => {
        const names = pot.winners.map((id) => this.players[id].name).join('、');
        return `${pot.label} ${pot.amount} → ${names}`;
      }).join('；');

      this.emit('showdown', { hands, text: '摊牌' });
      this.emit('hand-end', { text: summary, result: this.result });
      return this.result;
    }

    // ---------- 座位工具 ----------

    /** 按顺时针方向，从 index 之后找下一个还在场的座位 */
    nextSeated(index) {
      const n = this.players.length;
      for (let step = 1; step <= n; step++) {
        const i = (index + step) % n;
        if (!this.players[i].busted) return i;
      }
      return index;
    }

    /** 从 index 之后找下一个还能行动的人（没弃牌、没全下） */
    nextActable(index) {
      const n = this.players.length;
      for (let step = 1; step <= n; step++) {
        const i = (index + step) % n;
        const p = this.players[i];
        if (!p.busted && !p.folded && !p.allIn) return i;
      }
      return -1;
    }

    /** 把一组玩家按「从按钮左手边开始」的顺序排列，用于分零头 */
    orderFromButton(ids) {
      const n = this.players.length;
      const out = [];
      for (let step = 1; step <= n; step++) {
        const i = (this.buttonIndex + step) % n;
        if (ids.includes(i)) out.push(i);
      }
      return out;
    }

    // ---------- 按人裁剪的视图 ----------

    /** 这张底牌，viewerId 看得到吗？ */
    canSeeHole(player, viewerId) {
      if (player.hole.length === 0) return false;
      if (player.id === viewerId) return true;          // 自己的牌永远看得见
      // 摊牌时亮出来的只有还在牌里的人；中途弃牌的人的牌不该被翻出来
      const showdown = this.handOver && this.result && this.result.showdown;
      return !!showdown && !player.folded;
    }

    /**
     * 生成只属于某个玩家的状态快照。别人的底牌一律是 null。
     *
     * 这是状态离开引擎的唯一出口 —— 联机时服务器绝不能直接序列化引擎本身，
     * 因为引擎手里有整副牌和所有人的底牌。凡是要发给客户端（或交给 AI）的，
     * 都必须先过这里。viewerId 传 null 表示旁观者视角。
     */
    viewFor(viewerId) {
      const me = typeof viewerId === 'number' ? this.players[viewerId] : null;

      const players = this.players.map((p) => ({
        id: p.id,
        name: p.name,
        isHuman: p.isHuman,
        level: p.level,
        chips: p.chips,
        bet: p.bet,
        committed: p.committed,
        folded: p.folded,
        allIn: p.allIn,
        busted: p.busted,
        lastAction: p.lastAction,
        wonThisHand: p.wonThisHand,
        holeCount: p.hole.length,                       // 手里有几张牌是公开信息
        hole: this.canSeeHole(p, viewerId) ? p.hole.slice() : null,
      }));

      return {
        you: me ? me.id : null,
        handNumber: this.handNumber,
        street: this.street,
        board: this.board.slice(),
        pot: this.pot,
        currentBet: this.currentBet,
        minRaise: this.minRaise,
        smallBlind: this.smallBlind,
        bigBlind: this.bigBlind,
        startingChips: this.startingChips,
        buttonIndex: this.buttonIndex,
        sbIndex: this.sbIndex,
        bbIndex: this.bbIndex,
        actorIndex: this.actorIndex,
        handOver: this.handOver,
        players,
        // 只有轮到自己时才给出可选动作和需要跟注的金额
        toCall: me && this.actorIndex === me.id ? this.toCall(me) : 0,
        legalActions: me && this.actorIndex === me.id && !this.handOver
          ? this.legalActions(me)
          : [],
        result: this.resultView(),
      };
    }

    /** 结算信息也要裁剪：只有摊牌才公开牌型，弃牌收池不亮牌。 */
    resultView() {
      if (!this.result) return null;
      return {
        showdown: this.result.showdown,
        pots: this.result.pots.map((pot) => ({
          amount: pot.amount,
          winners: pot.winners.slice(),
          label: pot.label,
        })),
        // hands 里只有摊牌时还在牌局中的人，这些牌本来就该亮出来
        hands: this.result.hands.map((h) => ({
          player: h.player,
          description: h.description,
          best: h.best.slice(),
        })),
      };
    }

    /**
     * 裁剪事件流。
     *
     * 事件是状态之外的第二条出口，很容易被忽略：showdown / hand-end 事件里
     * 直接挂着 hands 和 result，其中的 best 含底牌。现在它恰好只包含没弃牌的人，
     * 但那是 showdown() 内部实现的巧合，不是被守住的约束 ——
     * 有人改了构造方式，牌就会绕过 viewFor 从这里漏出去。
     *
     * 所以规则很简单：事件只负责「播动画」，一律不携带牌面数据。
     * 公共牌是公开的可以留；摊牌要亮的牌，客户端从 state 里拿（那份已经裁剪过）。
     */
    eventsFor(viewerId, events) {
      return (events || []).map((e) => {
        const out = {};
        for (const key of Object.keys(e)) {
          if (key === 'hands' || key === 'result') continue;   // 含底牌，不走这条通道
          out[key] = e[key];
        }
        return out;
      });
    }

    /** 事件里允许出现的字段名，同样是白名单。 */
    static get EVENT_KEYS() {
      return [
        'type', 'text', 'player', 'action', 'amount', 'label',
        'handNumber', 'button', 'street', 'board', 'winner',
      ];
    }

    /** 视图里允许出现的字段名。新增字段必须先登记在这里，否则测试会失败。 */
    static get VIEW_KEYS() {
      return [
        'you', 'handNumber', 'street', 'board', 'pot', 'currentBet', 'minRaise',
        'smallBlind', 'bigBlind', 'startingChips', 'buttonIndex', 'sbIndex',
        'bbIndex', 'actorIndex', 'handOver', 'players', 'toCall', 'legalActions',
        'result',
        // players[] 里的
        'id', 'name', 'isHuman', 'level', 'chips', 'bet', 'committed', 'folded',
        'allIn', 'busted', 'lastAction', 'wonThisHand', 'holeCount', 'hole',
        // legalActions[] 里的
        'type', 'label', 'amount', 'min', 'max',
        // result 里的
        'showdown', 'pots', 'winners', 'hands', 'player', 'description', 'best',
      ];
    }

    emit(type, payload) {
      this.events.push({ type, ...payload });
    }

    /** 取走累积的事件，交给界面播放 */
    drainEvents() {
      const out = this.events;
      this.events = [];
      return out;
    }
  }

  const api = { HoldemEngine, STREETS, STREET_NAMES };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.HoldemEngine = HoldemEngine;
    root.PokerEngine = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
