/* 电脑对手测试 */
(function () {
  'use strict';

  const AI = window.PokerAI;
  const C = window.PokerCards;
  const { HoldemEngine } = window.PokerEngine;
  const { suite, ok, eq, approx } = window.T;

  const RANKS = '23456789TJQKA';
  const SUITS = { s: 0, h: 1, d: 2, c: 3 };
  const card = (str) => RANKS.indexOf(str[0]) * 4 + SUITS[str[1]];
  const hand = (str) => str.split(' ').map(card);

  suite('Chen 公式起手牌打分', () => {
    eq(AI.chenScore(hand('As Ah')), 20, 'AA = 20（最高分）');
    eq(AI.chenScore(hand('Ks Kh')), 16, 'KK = 16');
    eq(AI.chenScore(hand('As Ks')), 12, 'AKs = 12');
    eq(AI.chenScore(hand('As Kh')), 10, 'AKo = 10（比同花少 2 分）');
    eq(AI.chenScore(hand('2s 2h')), 5, '22 = 5（小对子保底 5 分）');
    ok(AI.chenScore(hand('7s 2h')) <= 0, '72o 是垃圾牌，分数不高于 0');
    ok(AI.chenScore(hand('Js Ts')) > AI.chenScore(hand('Jh Td')), '同花连牌优于杂色');
    ok(AI.chenScore(hand('9s 8s')) > AI.chenScore(hand('9s 4s')), '连牌优于带大缺口的牌');
  });

  suite('蒙特卡洛胜率估算', () => {
    // 和公认的翻牌前对抗胜率比对（平局算半个胜利）
    approx(AI.estimateEquity(hand('As Ah'), [], 1, 8000), 0.852, 0.03, 'AA 对单个随机对手约 85%');
    approx(AI.estimateEquity(hand('7s 2h'), [], 1, 8000), 0.354, 0.03, '72o 对单个随机对手约 35%');
    approx(AI.estimateEquity(hand('As Ah'), [], 5, 4000), 0.493, 0.04, 'AA 对五个对手降到约 49%');
    ok(
      AI.estimateEquity(hand('As Ah'), [], 1, 3000) > AI.estimateEquity(hand('As Ah'), [], 4, 3000),
      '对手越多，同一手牌的胜率越低'
    );
  });

  suite('极端牌面下的胜率', () => {
    // 我拿到皇家同花顺，不可能输也不可能平
    eq(AI.estimateEquity(hand('As Ks'), hand('Qs Js Ts 2h 3d'), 3, 400), 1,
      '河牌拿到皇家同花顺时胜率为 100%');
    // 公共牌本身就是皇家同花顺，所有人平分
    eq(AI.estimateEquity(hand('2h 3d'), hand('As Ks Qs Js Ts'), 3, 400), 0.5,
      '公共牌打成皇家同花顺时全场平局，胜率记为 50%');
  });

  suite('AI 不会偷看对手底牌', () => {
    // 同样的自己底牌 + 公共牌，对手手里换成完全不同的牌，估值必须一致
    const g = new HoldemEngine({
      players: [{ name: 'A', chips: 1000 }, { name: 'B', chips: 1000 }],
      smallBlind: 10, bigBlind: 20,
    });
    g.startHand();
    g.players[0].hole = hand('As Ah');
    g.board = hand('2h 7d 9s');

    const e1 = AI.estimateEquity(g.players[0].hole, g.board, 1, 6000);
    g.players[1].hole = hand('Ks Kh');   // 换成一手强牌
    const e2 = AI.estimateEquity(g.players[0].hole, g.board, 1, 6000);
    g.players[1].hole = hand('3c 8d');   // 再换成垃圾牌
    const e3 = AI.estimateEquity(g.players[0].hole, g.board, 1, 6000);

    approx(e2, e1, 0.04, '对手换成 KK 后估值不变（说明没偷看）');
    approx(e3, e1, 0.04, '对手换成垃圾牌后估值同样不变');
  });

  suite('AI 决策永远合法', () => {
    let illegal = null;
    let error = null;
    let decisions = 0;
    const levels = ['novice', 'intermediate', 'expert'];

    try {
      const g = new HoldemEngine({
        players: levels.concat(levels).map((lv, i) => ({ name: `${lv}${i}`, level: lv, chips: 1000 })),
        smallBlind: 10, bigBlind: 20,
      });

      for (let h = 0; h < 60; h++) {
        if (!g.startHand()) break;
        let guard = 0;
        while (!g.handOver && guard++ < 200) {
          const actor = g.currentActor();
          if (!actor) break;
          const legal = g.legalActions();
          const move = AI.decide(g, actor);
          decisions++;

          const entry = legal.find((a) => a.type === move.type);
          if (!entry) {
            illegal = illegal || `${actor.name} 给出了非法动作 ${move.type}`;
            break;
          }
          if (entry.type === 'bet' || entry.type === 'raise') {
            if (move.amount < entry.min || move.amount > entry.max) {
              illegal = illegal || `${actor.name} 的加注额 ${move.amount} 超出 [${entry.min}, ${entry.max}]`;
              break;
            }
          }
          g.act(move.type, move.amount);
        }
        if (illegal) break;
      }
    } catch (e) {
      error = e.message;
    }

    eq(error, null, 'AI 驱动的对局没有抛异常');
    eq(illegal, null, '所有决策都在引擎允许的范围内');
    ok(decisions > 300, `共做出 ${decisions} 次决策`);
  });

  suite('等级确实有强弱之分（高手 vs 新手，单挑 400 手）', () => {
    // 每手都把双方筹码重置为 1000，只统计每手的净输赢，
    // 这样衡量的是决策质量，不会被「谁先破产」的运气放大。
    const HANDS = 400;
    const STACK = 1000;
    const g = new HoldemEngine({
      players: [
        { name: '高手', level: 'expert', chips: STACK },
        { name: '新手', level: 'novice', chips: STACK },
      ],
      smallBlind: 10, bigBlind: 20,
    });

    let expertNet = 0;
    let played = 0;
    const started = performance.now();

    for (let h = 0; h < HANDS; h++) {
      g.players[0].chips = STACK;
      g.players[1].chips = STACK;
      g.players[0].busted = false;
      g.players[1].busted = false;
      if (!g.startHand()) break;
      played++;

      let guard = 0;
      while (!g.handOver && guard++ < 200) {
        const actor = g.currentActor();
        if (!actor) break;
        const move = AI.decide(g, actor);
        g.act(move.type, move.amount);
      }
      expertNet += g.players[0].chips - STACK;
    }

    const elapsed = ((performance.now() - started) / 1000).toFixed(1);
    const perHand = expertNet / played;
    const bbPer100 = (perHand / 20) * 100;

    eq(played, HANDS, `完整打完 ${HANDS} 手（耗时 ${elapsed} 秒）`);
    ok(expertNet > 0, `高手净赢 ${expertNet} 筹码，约 ${bbPer100.toFixed(0)} BB/100 手`);
    ok(bbPer100 > 20, `优势足够明显（${bbPer100.toFixed(0)} BB/100，远超正常牌手之间的差距）`);
  });

  suite('三档 AI 的松紧程度递进', () => {
    // 给同一手边缘牌，统计各档位在翻牌前选择入池的比例
    const marginal = hand('Jh 8d');   // 不上不下的杂色牌
    const counts = {};

    for (const level of ['novice', 'intermediate', 'expert']) {
      let entered = 0;
      const trials = 300;
      for (let i = 0; i < trials; i++) {
        const g = new HoldemEngine({
          players: Array.from({ length: 6 }, (_, k) => ({ name: `P${k}`, level, chips: 1000 })),
          smallBlind: 10, bigBlind: 20,
        });
        g.startHand();
        const actor = g.currentActor();
        actor.hole = marginal.slice();
        const move = AI.decide(g, actor);
        if (move.type !== 'fold') entered++;
      }
      counts[level] = entered / trials;
    }

    ok(counts.novice > counts.intermediate,
      `新手入池率 ${(counts.novice * 100).toFixed(0)}% > 进阶 ${(counts.intermediate * 100).toFixed(0)}%`);
    ok(counts.novice > 0.7, `新手几乎什么牌都玩（${(counts.novice * 100).toFixed(0)}%）`);
    ok(counts.expert < 0.6, `高手对边缘牌明显更克制（${(counts.expert * 100).toFixed(0)}%）`);
  });
})();
