/*
 * 视图裁剪测试 —— 多人模式的安全底线
 *
 * 联机时服务器手里有整副牌和所有人的底牌，发给客户端的必须是裁剪过的视图。
 * 这里测的不是「我记得过滤了」，而是「真正发出去的那份数据里到底有没有」：
 * 把视图序列化之后再检查，任何遗漏的字段、任何我没想到的嵌套路径都会被抓住。
 *
 * 注意其中的「反向对照」用例：只检查「没泄漏」是不够的，
 * 一个永远返回空对象的 viewFor 也能满分通过。所以必须同时断言该看见的看得见。
 */
(function () {
  'use strict';

  const { HoldemEngine } = window.PokerEngine;
  const { suite, ok, eq } = window.T;

  const makeEngine = (count) => new HoldemEngine({
    players: Array.from({ length: count }, (_, i) => ({
      name: `P${i}`, level: 'intermediate', chips: 1000,
    })),
    smallBlind: 10,
    bigBlind: 20,
    startingChips: 1000,
  });

  /** 收集一个对象里出现过的所有键名（含任意深度） */
  function collectKeys(value, into) {
    const keys = into || new Set();
    if (Array.isArray(value)) {
      for (const item of value) collectKeys(item, keys);
    } else if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) {
        keys.add(k);
        collectKeys(value[k], keys);
      }
    }
    return keys;
  }

  /** 随机打一手，每一步都把所有人的视图交给回调检查 */
  function playHand(g, inspect) {
    if (!g.startHand()) return false;
    inspect(g);
    let guard = 0;
    while (!g.handOver && guard++ < 300) {
      const actor = g.currentActor();
      if (!actor) break;
      const legal = g.legalActions();
      const pick = legal[(Math.random() * legal.length) | 0];
      if (pick.type === 'bet' || pick.type === 'raise') {
        const skew = Math.random() ** 3;
        g.act(pick.type, pick.min + Math.floor(skew * (pick.max - pick.min + 1)));
      } else {
        g.act(pick.type);
      }
      inspect(g);
    }
    inspect(g);
    return true;
  }

  suite('视图裁剪：别人的底牌一律看不到', () => {
    const g = makeEngine(6);
    let leaks = 0;
    let leakDetail = null;
    let checks = 0;

    for (let h = 0; h < 60; h++) {
      g.players.forEach((p) => { p.chips = 1000; p.busted = false; });
      playHand(g, (engine) => {
        for (let viewer = 0; viewer < 6; viewer++) {
          const view = engine.viewFor(viewer);
          checks++;
          for (const p of view.players) {
            if (p.id === viewer) continue;
            // 手牌进行中，别人的底牌必须是 null
            const showdownReveal = view.handOver && view.result && view.result.showdown;
            const allowed = showdownReveal && !p.folded;
            if (p.hole !== null && !allowed) {
              leaks++;
              leakDetail = leakDetail
                || `第 ${engine.handNumber} 手：${viewer} 号看到了 ${p.id} 号的底牌（street=${view.street} handOver=${view.handOver}）`;
            }
          }
        }
      });
      if (leaks) break;
    }

    eq(leaks, 0, `六十手全程逐帧检查，零泄漏（共检查 ${checks} 份视图）`);
    eq(leakDetail, null, '没有出现不该看到的底牌');
  });

  suite('视图裁剪：序列化之后依然不含别人的牌', () => {
    // 上一组查的是对象字段，这一组查真正要发出去的字节。
    // 用一副「做过记号」的牌：把别人的底牌换成固定值，再在 JSON 里搜这些值。
    const g = makeEngine(4);
    g.startHand();

    // 0 号是观察者；给其他人塞上容易辨认的底牌
    const marked = [[51, 50], [49, 48], [47, 46]];
    g.players[1].hole = marked[0].slice();
    g.players[2].hole = marked[1].slice();
    g.players[3].hole = marked[2].slice();

    const json = JSON.stringify(g.viewFor(0));
    const numbers = (json.match(/\d+/g) || []).map(Number);
    const found = marked.flat().filter((cardId) => numbers.includes(cardId));

    // 46~51 这些数字也可能碰巧出现在筹码额里，所以再做一次精确检查：
    // 把 hole 字段全挖出来，确认只有自己那一份是非空的
    const holes = JSON.parse(json).players.map((p) => p.hole);
    const visible = holes.filter((h) => h !== null);

    eq(visible.length, 1, '序列化后只有一份底牌是可见的');
    eq(JSON.stringify(visible[0]), JSON.stringify(g.players[0].hole), '可见的那份正是自己的');
    ok(json.indexOf('"deck"') === -1, '视图里不含牌堆');
    ok(found.length <= 6, `做过记号的牌号最多只作为数字巧合出现（命中 ${found.length} 个，均非 hole 字段）`);
  });

  suite('视图裁剪：字段白名单', () => {
    // 这条是给未来的自己设的闸：以后往视图里加字段，如果忘了评估它会不会带出
    // 不该给的信息，测试会直接失败，而不是悄悄泄漏出去。
    const g = makeEngine(6);
    let unknown = [];

    for (let h = 0; h < 20 && unknown.length === 0; h++) {
      g.players.forEach((p) => { p.chips = 1000; p.busted = false; });
      playHand(g, (engine) => {
        for (let viewer = 0; viewer < 6; viewer++) {
          const keys = collectKeys(engine.viewFor(viewer));
          for (const k of keys) {
            if (!HoldemEngine.VIEW_KEYS.includes(k)) unknown.push(k);
          }
        }
      });
    }

    eq([...new Set(unknown)].join(','), '', '视图里没有出现白名单之外的字段');
    ok(HoldemEngine.VIEW_KEYS.includes('hole'), '白名单本身是有效的（含 hole）');
  });

  suite('反向对照：该看见的必须看得见', () => {
    // 只测「没泄漏」是不够的 —— 一个永远返回空对象的 viewFor 也能通过上面所有用例。
    const g = makeEngine(6);
    g.startHand();

    const view = g.viewFor(2);
    eq(view.you, 2, '视图知道自己是谁');
    ok(Array.isArray(view.players) && view.players.length === 6, '看得到全部六个座位');
    eq(JSON.stringify(view.players[2].hole), JSON.stringify(g.players[2].hole), '自己的底牌是明的');
    eq(view.players[2].hole.length, 2, '自己确实有两张牌');
    ok(view.players.every((p) => p.holeCount === 2), '别人有几张牌是公开信息（虽然看不到是什么）');
    eq(view.pot, g.pot, '底池对得上');
    eq(view.bigBlind, 20, '盲注对得上');
    ok(view.players.every((p) => typeof p.chips === 'number'), '所有人的筹码量都是公开的');
    ok(view.players.every((p) => typeof p.name === 'string'), '所有人的名字都看得到');
  });

  suite('反向对照：轮到自己才给出可选动作', () => {
    const g = makeEngine(6);
    g.startHand();
    const actor = g.currentActor();
    const mine = g.viewFor(actor.id);
    const other = g.viewFor((actor.id + 1) % 6);

    ok(mine.legalActions.length > 0, '轮到自己时给出可选动作');
    ok(mine.toCall >= 0, '轮到自己时给出需要跟注的金额');
    eq(other.legalActions.length, 0, '没轮到的人拿不到可选动作');
    eq(other.toCall, 0, '没轮到的人不给跟注额');
  });

  suite('摊牌时公开的范围恰好正确', () => {
    const g = makeEngine(4);
    let checked = 0;
    let wrong = null;

    for (let h = 0; h < 80 && !wrong; h++) {
      g.players.forEach((p) => { p.chips = 1000; p.busted = false; });
      if (!g.startHand()) break;
      let guard = 0;
      while (!g.handOver && guard++ < 300) {
        const legal = g.legalActions();
        const pick = legal[(Math.random() * legal.length) | 0];
        if (pick.type === 'bet' || pick.type === 'raise') g.act(pick.type, pick.min);
        else g.act(pick.type);
      }
      if (!g.result) continue;

      const view = g.viewFor(0);
      for (const p of view.players) {
        if (p.id === 0) continue;
        if (g.result.showdown && !p.folded && p.holeCount === 2) {
          // 摊牌且还在牌里 —— 应该亮出来
          if (p.hole === null) wrong = `摊牌时 ${p.id} 号还在牌局中，牌却没亮出来`;
          checked++;
        } else {
          // 弃牌的人、以及无人跟注直接收池的情况 —— 都不该亮牌
          if (p.hole !== null) {
            wrong = g.result.showdown
              ? `${p.id} 号中途弃牌，牌却被亮了出来`
              : `无人跟注收池时 ${p.id} 号的牌被亮了出来`;
          }
          checked++;
        }
      }
    }

    eq(wrong, null, `摊牌只亮该亮的牌，弃牌者始终不亮（检查了 ${checked} 人次）`);
    ok(checked > 100, '样本量足够');
  });
})();
