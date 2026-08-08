/*
 * 电脑对手
 *
 * 两件武器：
 *   1. 翻牌前用 Chen 公式给起手牌打分（扑克圈流传多年的经典启发式）
 *   2. 翻牌后用蒙特卡洛模拟算胜率：把剩下的牌随机发完很多次，数自己赢了几次
 *
 * 重要：AI 只能看到自己的底牌和公共牌，绝不偷看别人的牌。
 * 模拟时对手的手牌是从剩余牌堆里随机抽的，和真人玩家掌握的信息完全一样。
 */
(function (root) {
  'use strict';

  const Cards = root.PokerCards || (typeof require !== 'undefined' ? require('./cards.js') : null);

  /**
   * 三个难度档位。数字越大越紧、越凶、算得越准。
   *   openThreshold  各个位置的开池门槛（Chen 分数）
   *   callRaise      面对加注时的跟注门槛
   *   threeBet       反加注门槛
   *   iterations     蒙特卡洛模拟次数，直接决定胜率估算的精度
   *   callMargin     跟注时要求胜率高出底池赔率多少（负数 = 明知不划算也爱跟）
   *   bluffRate      诈唬频率
   *   aggression     有牌时选择加注而不是跟注的倾向
   *   noise          胜率估算上叠加的随机误差，用来模拟「看走眼」
   */
  const LEVELS = {
    novice: {
      key: 'novice',
      name: '新手',
      blurb: '什么牌都想看看，很少弃牌，也很少加注',
      openThreshold: { early: 2, middle: 1, late: 0, blind: 0 },
      callRaise: 1,
      threeBet: 17,
      iterations: 80,
      callMargin: -0.18,
      bluffRate: 0.03,
      aggression: 0.15,
      noise: 0.14,
      sizing: [0.4, 0.5],
    },
    intermediate: {
      key: 'intermediate',
      name: '进阶',
      blurb: '会算底池赔率，打得中规中矩，偶尔诈唬',
      openThreshold: { early: 8, middle: 7, late: 6, blind: 6.5 },
      callRaise: 7,
      threeBet: 12,
      iterations: 250,
      callMargin: 0.02,
      bluffRate: 0.12,
      aggression: 0.45,
      noise: 0.06,
      sizing: [0.5, 0.75],
    },
    expert: {
      key: 'expert',
      name: '高手',
      blurb: '算得准、位置感强、该凶的时候很凶，诈唬也挑时机',
      openThreshold: { early: 9, middle: 7.5, late: 5.5, blind: 7 },
      callRaise: 8,
      threeBet: 11,
      iterations: 500,
      callMargin: 0.04,
      bluffRate: 0.22,
      aggression: 0.72,
      noise: 0.02,
      sizing: [0.5, 0.66, 0.75, 1.0],
    },
  };

  // ---------- 翻牌前：Chen 公式 ----------

  /** 给两张起手牌打分，AA=20，72o≈-1。 */
  function chenScore(hole) {
    const a = Cards.rankOf(hole[0]);
    const b = Cards.rankOf(hole[1]);
    const high = Math.max(a, b);
    const low = Math.min(a, b);
    const suited = Cards.suitOf(hole[0]) === Cards.suitOf(hole[1]);

    const baseOf = (idx) => {
      if (idx === 12) return 10;   // A
      if (idx === 11) return 8;    // K
      if (idx === 10) return 7;    // Q
      if (idx === 9) return 6;     // J
      return (idx + 2) / 2;
    };

    let score = baseOf(high);

    if (a === b) {
      score = Math.max(score * 2, 5);   // 对子翻倍，最低算 5 分
    } else {
      if (suited) score += 2;
      const gap = high - low - 1;
      if (gap === 1) score -= 1;
      else if (gap === 2) score -= 2;
      else if (gap === 3) score -= 4;
      else if (gap >= 4) score -= 5;
      // 小连牌有做顺的潜力，补回一点
      if (gap <= 1 && high < 10) score += 1;
    }

    return Math.ceil(score);
  }

  /**
   * 位置判断：看自己之后还有多少人要行动。人越多位置越差。
   * 关键是只数「我到按钮之间」的人——按钮永远最后说话。
   */
  function positionOf(engine, player) {
    if (engine.street === 'preflop'
        && (player.id === engine.sbIndex || player.id === engine.bbIndex)) {
      return 'blind';
    }

    const live = engine.livePlayers();
    if (live.length <= 3) return 'late';

    let after = 0;
    if (player.id !== engine.buttonIndex) {
      const n = engine.players.length;
      for (let step = 1; step < n; step++) {
        const idx = (player.id + step) % n;
        const p = engine.players[idx];
        if (!p.busted && !p.folded && !p.allIn) after++;
        if (idx === engine.buttonIndex) break;   // 按钮之后就轮不到别人了
      }
    }

    const ratio = after / Math.max(1, live.length - 1);
    if (ratio > 0.6) return 'early';
    if (ratio > 0.3) return 'middle';
    return 'late';
  }

  // ---------- 翻牌后：蒙特卡洛胜率 ----------

  /**
   * 估算自己这手牌打到底的胜率（平局按半个胜利算）。
   * 对手手牌从剩余牌堆随机抽取——AI 拿不到任何它不该知道的信息。
   */
  function estimateEquity(hole, board, opponents, iterations) {
    if (opponents <= 0) return 1;

    const known = new Uint8Array(52);
    for (const c of hole) known[c] = 1;
    for (const c of board) known[c] = 1;

    const remaining = [];
    for (let c = 0; c < 52; c++) if (!known[c]) remaining.push(c);

    const boardNeeded = 5 - board.length;
    const drawCount = opponents * 2 + boardNeeded;
    if (drawCount > remaining.length) return 0.5;

    const myCards = new Array(7);
    const oppCards = new Array(7);
    let score = 0;

    for (let iter = 0; iter < iterations; iter++) {
      // 只对需要的前 drawCount 张做局部洗牌，比整副洗快得多
      for (let i = 0; i < drawCount; i++) {
        const j = i + ((Math.random() * (remaining.length - i)) | 0);
        const tmp = remaining[i];
        remaining[i] = remaining[j];
        remaining[j] = tmp;
      }

      const fullBoard = board.concat(remaining.slice(opponents * 2, opponents * 2 + boardNeeded));

      myCards[0] = hole[0];
      myCards[1] = hole[1];
      for (let i = 0; i < 5; i++) myCards[2 + i] = fullBoard[i];
      const mine = Cards.evaluate(myCards);

      let bestOpponent = -1;
      for (let o = 0; o < opponents; o++) {
        oppCards[0] = remaining[o * 2];
        oppCards[1] = remaining[o * 2 + 1];
        for (let i = 0; i < 5; i++) oppCards[2 + i] = fullBoard[i];
        const s = Cards.evaluate(oppCards);
        if (s > bestOpponent) bestOpponent = s;
      }

      if (mine > bestOpponent) score += 1;
      else if (mine === bestOpponent) score += 0.5;
    }

    return score / iterations;
  }

  /**
   * 人越少，起手牌范围就该越宽：六人桌等得起好牌，单挑还挑三拣四就会被盲注磨死。
   * 返回值直接从各种门槛上减掉。
   */
  function loosenBy(engine) {
    const n = engine.livePlayers().length;
    if (n <= 2) return 4;
    if (n === 3) return 2.5;
    if (n <= 5) return 1;
    return 0;
  }

  // ---------- 决策 ----------

  function decide(engine, player) {
    const level = LEVELS[player.level] || LEVELS.intermediate;
    const legal = engine.legalActions(player);
    const toCall = engine.toCall(player);
    const pot = engine.pot;

    const has = (type) => legal.find((a) => a.type === type);
    const raiseOption = has('raise') || has('bet');

    const decision = engine.street === 'preflop'
      ? preflop(engine, player, level, { legal, toCall, pot, raiseOption })
      : postflop(engine, player, level, { legal, toCall, pot, raiseOption });

    return sanitize(decision, legal);
  }

  function preflop(engine, player, level, ctx) {
    const { toCall, pot, raiseOption } = ctx;
    const score = chenScore(player.hole);
    const position = positionOf(engine, player);
    const facingRaise = engine.currentBet > engine.bigBlind;
    const jitter = (Math.random() - 0.5) * 2 * level.noise * 10;
    const effective = score + jitter;
    const loosen = loosenBy(engine);

    // 没人加注：够门槛就开池，否则能过牌就过牌
    if (!facingRaise) {
      const threshold = level.openThreshold[position] - loosen;
      if (effective >= threshold && raiseOption && Math.random() < 0.55 + level.aggression * 0.4) {
        const open = engine.bigBlind * (position === 'late' ? 2.5 : 3);
        return { type: raiseOption.type, amount: open + pot * 0.1 };
      }
      if (toCall === 0) return { type: 'check' };
      // 小盲位只要补半个盲注就能看翻牌，门槛可以放宽
      if (position === 'blind' && effective >= threshold - 3) return { type: 'call' };
      // 其余位置得牌够格才值得跟进
      if (effective >= threshold - 1) return { type: 'call' };
      return { type: 'fold' };
    }

    // 面对加注
    if (effective >= level.threeBet - loosen && raiseOption && Math.random() < level.aggression) {
      return { type: raiseOption.type, amount: engine.currentBet * 3 };
    }
    if (effective >= level.callRaise - loosen) return { type: 'call' };

    // 便宜的投机牌可以跟一手
    const priceRatio = toCall / Math.max(1, player.chips);
    if (priceRatio < 0.04 && effective >= level.callRaise - loosen - 3) return { type: 'call' };

    // 新手就是爱跟
    if (level.key === 'novice' && Math.random() < 0.45 && priceRatio < 0.25) {
      return { type: 'call' };
    }

    return { type: 'fold' };
  }

  function postflop(engine, player, level, ctx) {
    const { toCall, pot, raiseOption } = ctx;
    const opponents = engine.livePlayers().length - 1;

    let equity = estimateEquity(player.hole, engine.board, opponents, level.iterations);
    equity += (Math.random() - 0.5) * 2 * level.noise;
    equity = Math.max(0, Math.min(1, equity));

    const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
    const sizing = level.sizing[(Math.random() * level.sizing.length) | 0];

    // 没人下注：考虑价值下注或诈唬
    if (toCall === 0) {
      const valueBet = equity > 0.62 && Math.random() < 0.35 + level.aggression * 0.6;
      const bluff = equity < 0.32 && Math.random() < level.bluffRate;
      if ((valueBet || bluff) && raiseOption) {
        return { type: raiseOption.type, amount: engine.currentBet + Math.max(engine.bigBlind, pot * sizing) };
      }
      return { type: 'check' };
    }

    // 面对下注：拿胜率和底池赔率比
    const edge = equity - potOdds;

    if (edge > 0.22 && raiseOption && Math.random() < level.aggression) {
      return { type: raiseOption.type, amount: engine.currentBet + Math.max(engine.bigBlind, pot * sizing) };
    }
    if (edge > level.callMargin) return { type: 'call' };

    // 偶尔把差牌打成诈唬加注
    if (raiseOption && equity < 0.3 && Math.random() < level.bluffRate * 0.4) {
      return { type: raiseOption.type, amount: engine.currentBet + Math.max(engine.bigBlind, pot * sizing) };
    }

    return { type: 'fold' };
  }

  /** 把决策修正成引擎一定接受的形式：动作合法、金额在区间内。 */
  function sanitize(decision, legal) {
    const entry = legal.find((a) => a.type === decision.type);
    if (!entry) {
      // 想做的事不合法时，优先过牌，其次弃牌
      const check = legal.find((a) => a.type === 'check');
      return check ? { type: 'check' } : { type: 'fold' };
    }
    if (entry.type === 'bet' || entry.type === 'raise') {
      let amount = Math.round(decision.amount);
      if (!Number.isFinite(amount)) amount = entry.min;
      amount = Math.max(entry.min, Math.min(entry.max, amount));
      return { type: entry.type, amount };
    }
    return { type: entry.type };
  }

  const api = { LEVELS, decide, chenScore, estimateEquity, positionOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PokerAI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
