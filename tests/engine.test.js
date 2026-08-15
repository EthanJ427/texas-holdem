/* 规则引擎测试 */
(function () {
  'use strict';

  const { HoldemEngine } = window.PokerEngine;
  const C = window.PokerCards;
  const { suite, ok, eq } = window.T;

  const RANKS = '23456789TJQKA';
  const SUITS = { s: 0, h: 1, d: 2, c: 3 };
  const card = (str) => RANKS.indexOf(str[0]) * 4 + SUITS[str[1]];
  const hand = (str) => str.split(' ').map(card);

  const makeEngine = (count, chips) => new HoldemEngine({
    players: Array.from({ length: count }, (_, i) => ({
      name: `P${i}`,
      isHuman: false,
      chips: Array.isArray(chips) ? chips[i] : (chips || 1000),
    })),
    smallBlind: 10,
    bigBlind: 20,
  });

  const totalChips = (g) => g.players.reduce((s, p) => s + p.chips, 0);

  suite('盲注与座位', () => {
    const g = makeEngine(6);
    g.startHand();
    const sb = g.players[g.sbIndex];
    const bb = g.players[g.bbIndex];
    eq(sb.committed, 10, '小盲投入 10');
    eq(bb.committed, 20, '大盲投入 20');
    eq(g.currentBet, 20, '翻牌前当前注额是大盲');
    eq(g.pot, 30, '底池等于两个盲注之和');
    eq(g.sbIndex, (g.buttonIndex + 1) % 6, '六人桌小盲在按钮左手边');
    eq(g.actorIndex, (g.bbIndex + 1) % 6, '翻牌前由大盲左手边的枪口位先行动');
    ok(g.players.every((p) => p.hole.length === 2), '每人两张底牌');

    const dealt = g.players.flatMap((p) => p.hole);
    eq(new Set(dealt).size, dealt.length, '发出的底牌没有重复');
  });

  suite('单挑时的按钮规则', () => {
    const g = makeEngine(2);
    g.startHand();
    eq(g.sbIndex, g.buttonIndex, '单挑时庄家下小盲');
    eq(g.actorIndex, g.buttonIndex, '单挑翻牌前由庄家（小盲）先行动');
    // 走到翻牌看后手位置
    g.act('call');
    g.act('check');
    eq(g.street, 'flop', '双方看牌后进入翻牌');
    eq(g.actorIndex, g.bbIndex, '单挑翻牌后由大盲先行动');
  });

  suite('基本动作', () => {
    const g = makeEngine(3);
    const bankroll = 3000;
    g.startHand();
    const actor = g.currentActor();
    const chipsBefore = actor.chips;

    g.act('call');
    eq(actor.chips, chipsBefore - 20, '跟注扣掉正确的筹码');
    eq(totalChips(g) + g.pot, bankroll, '手上筹码 + 底池 = 起始总量');

    const raiser = g.currentActor();
    g.act('raise', 60);
    eq(g.currentBet, 60, '加注后当前注额更新');
    eq(g.minRaise, 40, '最小加注额等于本次加注的增量');
    eq(raiser.bet, 60, '加注者的本轮投入等于加注到的总额');
  });

  suite('加注下限与上限', () => {
    const g = makeEngine(3);
    g.startHand();
    const p = g.currentActor();
    const raise = g.legalActions().find((a) => a.type === 'raise');
    eq(raise.min, 40, '翻牌前最小加注到 2 倍大盲');
    eq(raise.max, p.bet + p.chips, '最大加注到等于自己的全部筹码');

    // 超出范围的加注会被夹到合法区间，而不是产生非法状态
    g.act('raise', 999999);
    ok(p.allIn, '加注超过筹码量时变成全下');
    eq(p.chips, 0, '全下后筹码归零');
  });

  suite('弃牌到只剩一人', () => {
    const g = makeEngine(4);
    const before = totalChips(g);
    g.startHand();
    let guard = 0;
    while (!g.handOver && guard++ < 50) g.act('fold');
    ok(g.handOver, '其余人全部弃牌后本手结束');
    eq(totalChips(g), before, '筹码总量不变');
    eq(g.result.showdown, false, '无人跟注时不摊牌');
    const winner = g.players[g.result.pots[0].winners[0]];
    ok(winner.wonThisHand > 0, '赢家拿到了底池');
  });

  suite('边池分层', () => {
    // 三家全下不同金额：100 / 200 / 300
    const g = makeEngine(3, [100, 200, 300]);
    g.players[0].committed = 100;
    g.players[1].committed = 200;
    g.players[2].committed = 300;
    const pots = g.buildPots();

    eq(pots.length, 3, '分出主池 + 两个边池');
    eq(pots[0].amount, 300, '主池 = 100 × 3');
    eq(pots[0].eligible.length, 3, '主池三家都有资格');
    eq(pots[1].amount, 200, '第一个边池 = 100 × 2');
    eq(pots[1].eligible.join(','), '1,2', '第一个边池只有投入更多的两家有资格');
    eq(pots[2].amount, 100, '第二个边池 = 投入最多者多出的部分');
    eq(pots[2].eligible.join(','), '2', '第二个边池只有一家有资格');
    eq(pots.reduce((s, p) => s + p.amount, 0), 600, '所有池加起来等于总投入');
  });

  suite('弃牌者的筹码留在池里但没有分配资格', () => {
    const g = makeEngine(3, [100, 200, 300]);
    g.players[0].committed = 100;
    g.players[0].folded = true;
    g.players[1].committed = 200;
    g.players[2].committed = 300;
    const pots = g.buildPots();

    eq(pots.reduce((s, p) => s + p.amount, 0), 600, '弃牌者的 100 仍然在池中');
    ok(!pots.some((p) => p.eligible.includes(0)), '弃牌者不出现在任何一个池的分配名单里');
    eq(pots[0].amount, 500, '资格相同的相邻层已合并为一个池');
  });

  suite('弃牌者投得比所有在牌玩家都多时，死钱不能蒸发', () => {
    // 取自压力测试真实抓到的一手：P1、P4 各投 844 后弃牌，
    // 还在牌里的两人最多只投到 720，顶上 248 筹码一度无人认领。
    const g = makeEngine(6, 0);
    const committed = [85, 844, 0, 19, 844, 720];
    const folded = [true, true, true, false, true, false];
    g.players.forEach((p, i) => { p.committed = committed[i]; p.folded = folded[i]; });

    const pots = g.buildPots();
    const total = pots.reduce((s, p) => s + p.amount, 0);

    eq(total, 2512, '所有池加起来等于全部投入，248 筹码没有丢');
    eq(pots[0].amount, 95, '主池 = 最小全下额 19 × 5 家有效投入');
    eq(pots[0].eligible.join(','), '3,5', '主池由两个还在牌里的人争');
    ok(pots.every((p) => p.eligible.length > 0), '每个池都有人有资格分');
    eq(pots[pots.length - 1].eligible.join(','), '5', '死钱并入了最高的那个有人争的池');
  });

  suite('摊牌分配（含平分与零头）', () => {
    // 两家同花色不同但牌型完全相同 → 平分底池
    const g = makeEngine(2, [0, 0]);
    g.board = hand('2h 7d 9s Jc 4c');
    g.players[0].hole = hand('Ah Kd');
    g.players[1].hole = hand('As Kc');
    g.players[0].committed = 50;
    g.players[1].committed = 51;   // 制造 101 的奇数底池
    g.buttonIndex = 0;
    g.showdown();

    eq(g.players[0].chips + g.players[1].chips, 101, '底池全额发出，没有丢筹码');
    eq(g.result.pots.length, 2, '投入不等时会分出一个边池');
    ok(Math.abs(g.players[0].chips - g.players[1].chips) <= 2, '牌力相同的两家基本平分');
  });

  suite('摊牌时牌力更强的一方通吃', () => {
    const g = makeEngine(2, [0, 0]);
    g.board = hand('2h 7d 9s Jc 4c');
    g.players[0].hole = hand('Ah Ad');   // 一对 A
    g.players[1].hole = hand('Ks Qc');   // 高牌
    g.players[0].committed = 100;
    g.players[1].committed = 100;
    g.showdown();

    eq(g.players[0].chips, 200, '一对 A 赢下全部 200');
    eq(g.players[1].chips, 0, '输家一无所获');
    eq(g.result.hands.find((h) => h.player === 0).description, 'Pair of As', '摊牌描述正确');
  });

  suite('随机对局压力测试（2000 手，六人桌）', () => {
    let handsPlayed = 0;
    let showdowns = 0;
    let sidePots = 0;
    let error = null;
    let chipLeak = null;
    let badActor = null;
    let stuck = null;
    let maxActions = 0;

    try {
      let g = makeEngine(6, 1000);
      let bankroll = totalChips(g);

      for (let h = 0; h < 2000; h++) {
        // 有人通吃就重开一桌，保证累计到足够多的手数
        if (!g.startHand()) {
          g = makeEngine(6, 1000);
          bankroll = totalChips(g);
          g.startHand();
        }
        handsPlayed++;

        // 随机策略会反复最小加注，一手牌的行动次数可以很多；
        // 上限设得宽一点，专门用来区分「打得久」和「卡死」。
        let guard = 0;
        while (!g.handOver && guard++ < 5000) {
          const actor = g.currentActor();
          if (!actor) {
            badActor = badActor || `第 ${h} 手：牌局未结束却没有人可以行动`;
            break;
          }
          if (actor.folded || actor.allIn || actor.busted) {
            badActor = badActor || `第 ${h} 手：轮到了不该行动的 ${actor.name}`;
            break;
          }

          // 行动中随时校验：手上的筹码 + 已投入的 = 总量
          if (totalChips(g) + g.pot !== bankroll) {
            chipLeak = chipLeak || `第 ${h} 手行动中筹码不守恒：${totalChips(g)} + ${g.pot} ≠ ${bankroll}`;
            break;
          }
          if (g.players.some((p) => p.chips < 0)) {
            chipLeak = chipLeak || `第 ${h} 手出现负数筹码`;
            break;
          }

          const legal = g.legalActions();
          const pick = legal[(Math.random() * legal.length) | 0];
          if (pick.type === 'bet' || pick.type === 'raise') {
            // 偏向小额加注，否则随机策略几乎每手都全下，走不到后面几条街
            const skew = Math.random() ** 3;
            const amount = pick.min + Math.floor(skew * (pick.max - pick.min + 1));
            g.act(pick.type, amount);
          } else {
            g.act(pick.type);
          }
        }

        if (guard > maxActions) maxActions = guard;
        if (!g.handOver && !chipLeak && !badActor) {
          stuck = stuck || `第 ${h} 手打了 5000 次行动仍未结束，疑似死循环`;
          break;
        }

        if (g.result && g.result.showdown) showdowns++;
        if (g.result && g.result.pots.length > 1) sidePots++;

        if (totalChips(g) !== bankroll) {
          chipLeak = chipLeak || `第 ${h} 手结算后筹码不守恒：${totalChips(g)} ≠ ${bankroll}`;
          break;
        }
        if (chipLeak || badActor) break;
      }
    } catch (e) {
      error = e.message + '\n' + (e.stack || '').split('\n').slice(0, 3).join(' | ');
    }

    eq(error, null, '两千手随机对局没有抛异常');
    eq(chipLeak, null, '筹码在任何时刻都守恒');
    eq(badActor, null, '永远不会轮到已弃牌或已全下的人行动');
    eq(stuck, null, `每一手都能正常结束（最长的一手用了 ${maxActions} 次行动）`);
    ok(handsPlayed >= 2000, `实际打完了 ${handsPlayed} 手`);
    ok(showdowns > 0, `其中 ${showdowns} 手进入摊牌`);
    ok(sidePots > 0, `其中 ${sidePots} 手产生了边池，说明全下路径被覆盖到`);
  });

  suite('全下后自动发完公共牌', () => {
    let reached = 0;
    let boardWrong = null;
    for (let i = 0; i < 300; i++) {
      const g = makeEngine(3, 1000);
      g.startHand();
      let guard = 0;
      // 所有人一路全下/跟注，必然导致提前全下摊牌
      while (!g.handOver && guard++ < 40) {
        const legal = g.legalActions();
        const raise = legal.find((a) => a.type === 'raise' || a.type === 'bet');
        if (raise) g.act(raise.type, raise.max);
        else g.act(legal.find((a) => a.type === 'call') ? 'call' : 'check');
      }
      if (g.result && g.result.showdown) {
        reached++;
        if (g.board.length !== 5) {
          boardWrong = boardWrong || `摊牌时公共牌只有 ${g.board.length} 张`;
        }
      }
    }
    ok(reached > 250, `${reached}/300 手走到了摊牌`);
    eq(boardWrong, null, '提前全下时公共牌一定发满五张再摊牌');
  });
})();
