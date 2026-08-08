/* 牌型评估器测试 */
(function () {
  'use strict';

  const C = window.PokerCards;
  const { suite, ok, eq, approx } = window.T;

  // 用 "As" "Td" 这种写法造牌，方便写用例
  const RANKS = '23456789TJQKA';
  const SUITS = { s: 0, h: 1, d: 2, c: 3 };
  const card = (str) => RANKS.indexOf(str[0]) * 4 + SUITS[str[1]];
  const hand = (str) => str.split(' ').map(card);
  const ev = (str) => C.evaluate(hand(str));
  const name = (str) => C.CATEGORY_NAMES[C.categoryOf(ev(str))];
  const desc = (str) => C.describe(ev(str));

  suite('牌型识别', () => {
    const cases = [
      ['As Ks Qs Js Ts', '同花顺', '皇家同花顺'],
      ['5s 4s 3s 2s As', '同花顺', '5 高同花顺'],   // 钢轮
      ['9h 9d 9s 9c 2h', '四条', '四条 9'],
      ['8h 8d 8s 3c 3h', '葫芦', '葫芦 8 带 3'],
      ['Ah Jh 9h 5h 2h', '同花', 'A 高同花'],
      ['9h 8d 7s 6c 5h', '顺子', '9 高顺子'],
      ['5h 4d 3s 2c Ah', '顺子', '5 高顺子'],       // 轮子：A 当 1 用
      ['Qh Qd Qs 7c 2h', '三条', '三条 Q'],
      ['Kh Kd 4s 4c 9h', '两对', '两对 K/4'],
      ['Th Td 8s 5c 2h', '一对', '一对 10'],
      ['Ah Qd 9s 5c 2h', '高牌', '高牌 A'],
    ];
    for (const [h, cat, d] of cases) {
      eq(name(h), cat, `${h} → ${cat}`);
      eq(desc(h), d, `${h} 描述为「${d}」`);
    }
  });

  suite('给人看的牌面写法', () => {
    // T 是扑克圈的单字符记号，但真实扑克牌上印的是 10。
    // 凡是会出现在屏幕上的地方都必须显示 10。
    eq(C.cardName(card('Td')), '10♦', '牌面显示 10 而不是 T');
    eq(desc('Th Td 8s 5c 2h'), '一对 10', '牌型描述里也是 10');
    eq(desc('Th Td Ts 5c 2h'), '三条 10', '三条同理');
    eq(desc('Ah Kh Qh Jh Th'), '皇家同花顺', '皇家同花顺不受影响');
    eq(C.RANK_LABELS[8], '10', 'RANK_LABELS 第 9 项是 10');
    eq(C.RANK_CHARS[8], 'T', '内部记号仍然是单字符 T');
    eq(C.RANK_LABELS.length, 13, '标签表长度正确');
    ok(C.RANK_LABELS.every((l, i) => i === 8 || l === C.RANK_CHARS[i]),
      '除了 10，其余点数的两种写法一致');
  });

  suite('牌型大小排序', () => {
    const ordered = [
      'As Ks Qs Js Ts', '9h 9d 9s 9c 2h', '8h 8d 8s 3c 3h', 'Ah Jh 9h 5h 2h',
      '9h 8d 7s 6c 5h', 'Qh Qd Qs 7c 2h', 'Kh Kd 4s 4c 9h', 'Th Td 8s 5c 2h',
      'Ah Qd 9s 5c 2h',
    ];
    for (let i = 0; i < ordered.length - 1; i++) {
      ok(ev(ordered[i]) > ev(ordered[i + 1]), `${ordered[i]} > ${ordered[i + 1]}`);
    }
  });

  suite('踢脚牌与平局', () => {
    ok(ev('Ah Ad Kh Qc 9s') > ev('Ah Ad Kh Qc 8s'), '一对 A：K Q 9 胜 K Q 8');
    ok(ev('Ah Ad Kh Qc 9s') === ev('As Ac Kd Qh 9c'), '花色不影响牌力，两手完全相等');
    ok(ev('Kh Kd 4s 4c 9h') > ev('Kh Kd 4s 4c 8h'), '两对相同时比踢脚');
    ok(ev('Ah Kh Qh Jh 9h') > ev('Ah Kh Qh Th 9h'), '同花逐张比大小');
    ok(ev('5h 4d 3s 2c Ah') < ev('6h 5d 4s 3c 2h'), '轮子是最小的顺子');
    ok(ev('2h 2d 2s 2c 3h') > ev('Ah Ad Ks Kc Qh'), '最小的四条 > 最大的两对');
    ok(ev('Ah Ad Ks Kc Qh') > ev('Ah Ad Ks Kc Jh'), '两对相同时第五张定胜负');
  });

  suite('七张取最优五张', () => {
    eq(desc('As Ah Ad Kc Kh 7s 2d'), '葫芦 A 带 K', '七张中取出葫芦而非三条');
    eq(desc('2h 3d 9h 8d 7s 6c 5h'), '9 高顺子', '公共牌成顺，取出顺子');
    eq(desc('As Ks Qs Js Ts 2h 3d'), '皇家同花顺', '七张中取出皇家同花顺');
    eq(C.describe(C.evaluate(hand('As Ah Ad Kc Kh 7s'))), '葫芦 A 带 K', '六张分支同样正确');
    // 四张同花 + 第五张不同花，不能误判成同花
    eq(name('Ah Kh Qh Jh 9s 3d 2c'), '高牌', '只有四张同花不算同花');
    // 只有四连，不能误判成顺子
    eq(name('9h 8d 7s 6c 2h 3d Kc'), '高牌', '只有四连不算顺子');
  });

  suite('最优五张牌的取出', () => {
    const seven = hand('As Ah Ad Kc Kh 7s 2d');
    const five = C.bestFive(seven);
    eq(five.length, 5, 'bestFive 返回五张牌');
    eq(C.evaluate(five), C.evaluate(seven), 'bestFive 的牌力与七张评估结果一致');
    ok(five.every((c) => seven.includes(c)), 'bestFive 的牌都来自原始七张');
  });

  suite('50 万次随机发牌 vs 已知七张牌型概率', () => {
    const expected = {
      '高牌': 17.412, '一对': 43.822, '两对': 23.496, '三条': 4.829,
      '顺子': 4.619, '同花': 3.025, '葫芦': 2.596, '四条': 0.168, '同花顺': 0.0311,
    };
    const N = 500000;
    const counts = {};
    const deck = C.makeDeck();
    for (let i = 0; i < N; i++) {
      C.shuffle(deck);
      const n = C.CATEGORY_NAMES[C.categoryOf(C.evaluate(deck.slice(0, 7)))];
      counts[n] = (counts[n] || 0) + 1;
    }
    for (const [n, exp] of Object.entries(expected)) {
      const got = ((counts[n] || 0) / N) * 100;
      // 容差取「相对 8%」与「绝对 0.02 个百分点」的较大者，照顾同花顺这类极稀有牌型
      approx(got, exp, Math.max(exp * 0.08, 0.02), `${n} 占比`);
    }
  });
})();
