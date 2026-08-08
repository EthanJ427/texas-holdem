/*
 * 牌与牌型评估
 *
 * 一张牌用 0..51 的整数表示：id = rank * 4 + suit
 *   rank: 0='2' … 12='A'
 *   suit: 0=♠ 1=♥ 2=♦ 3=♣
 *
 * 牌力用一个整数表示，直接比大小即可：
 *   score = 类别 << 20 | k1 << 16 | k2 << 12 | k3 << 8 | k4 << 4 | k5
 */
(function (root) {
  'use strict';

  const RANK_CHARS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  const SUIT_CHARS = ['♠', '♥', '♦', '♣'];

  const CATEGORY = {
    HIGH_CARD: 0,
    PAIR: 1,
    TWO_PAIR: 2,
    TRIPS: 3,
    STRAIGHT: 4,
    FLUSH: 5,
    FULL_HOUSE: 6,
    QUADS: 7,
    STRAIGHT_FLUSH: 8,
  };

  const CATEGORY_NAMES = [
    '高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺',
  ];

  const rankOf = (card) => card >> 2;
  const suitOf = (card) => card & 3;
  const cardName = (card) => RANK_CHARS[rankOf(card)] + SUIT_CHARS[suitOf(card)];

  function makeDeck() {
    const deck = new Array(52);
    for (let i = 0; i < 52; i++) deck[i] = i;
    return deck;
  }

  /** Fisher-Yates 洗牌，原地打乱。 */
  function shuffle(deck, rng) {
    const random = rng || Math.random;
    for (let i = deck.length - 1; i > 0; i--) {
      const j = (random() * (i + 1)) | 0;
      const tmp = deck[i];
      deck[i] = deck[j];
      deck[j] = tmp;
    }
    return deck;
  }

  /** 五张牌的牌力评分。 */
  function evaluate5(a, b, c, d, e) {
    const cards = [a, b, c, d, e];

    const rankCount = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const suitCount = [0, 0, 0, 0];
    let rankMask = 0;
    for (let i = 0; i < 5; i++) {
      const r = cards[i] >> 2;
      rankCount[r]++;
      suitCount[cards[i] & 3]++;
      rankMask |= 1 << r;
    }

    const isFlush = suitCount[0] === 5 || suitCount[1] === 5 || suitCount[2] === 5 || suitCount[3] === 5;

    // 顺子：找最高的五连。A2345 单独处理（A 当 1 用，顺子最大牌是 5）
    let straightHigh = -1;
    for (let hi = 12; hi >= 4; hi--) {
      if (((rankMask >> (hi - 4)) & 0b11111) === 0b11111) {
        straightHigh = hi;
        break;
      }
    }
    if (straightHigh < 0 && (rankMask & (1 << 12)) !== 0 && (rankMask & 0b1111) === 0b1111) {
      straightHigh = 3; // 5 高顺子（轮子）
    }

    if (straightHigh >= 0 && isFlush) return score(CATEGORY.STRAIGHT_FLUSH, [straightHigh]);

    // 按「出现次数降序、点数降序」排列，得到天然的比牌顺序
    const groups = [];
    for (let r = 12; r >= 0; r--) {
      if (rankCount[r] > 0) groups.push([rankCount[r], r]);
    }
    groups.sort((x, y) => (y[0] - x[0]) || (y[1] - x[1]));
    const kickers = [];
    for (const [count, rank] of groups) {
      for (let i = 0; i < count; i++) kickers.push(rank);
    }

    const shape = groups[0][0] * 10 + (groups.length > 1 ? groups[1][0] : 0);

    if (shape === 41) return score(CATEGORY.QUADS, kickers);
    if (shape === 32) return score(CATEGORY.FULL_HOUSE, kickers);
    if (isFlush) return score(CATEGORY.FLUSH, kickers);
    if (straightHigh >= 0) return score(CATEGORY.STRAIGHT, [straightHigh]);
    if (shape === 31) return score(CATEGORY.TRIPS, kickers);
    if (shape === 22) return score(CATEGORY.TWO_PAIR, kickers);
    if (shape === 21) return score(CATEGORY.PAIR, kickers);
    return score(CATEGORY.HIGH_CARD, kickers);
  }

  function score(category, kickers) {
    let value = category << 20;
    for (let i = 0; i < 5; i++) {
      value |= (kickers[i] !== undefined ? kickers[i] : 0) << (16 - i * 4);
    }
    return value;
  }

  // C(7,5) = 21 种五张组合
  const COMBOS_7 = (() => {
    const out = [];
    for (let a = 0; a < 3; a++) {
      for (let b = a + 1; b < 4; b++) {
        for (let c = b + 1; c < 5; c++) {
          for (let d = c + 1; d < 6; d++) {
            for (let e = d + 1; e < 7; e++) out.push([a, b, c, d, e]);
          }
        }
      }
    }
    return out;
  })();

  /** 从 5~7 张牌里取最好的五张，返回牌力评分。 */
  function evaluate(cards) {
    if (cards.length === 5) {
      return evaluate5(cards[0], cards[1], cards[2], cards[3], cards[4]);
    }
    if (cards.length === 6) {
      let best = -1;
      for (let skip = 0; skip < 6; skip++) {
        const five = [];
        for (let i = 0; i < 6; i++) if (i !== skip) five.push(cards[i]);
        const s = evaluate5(five[0], five[1], five[2], five[3], five[4]);
        if (s > best) best = s;
      }
      return best;
    }
    let best = -1;
    for (let i = 0; i < COMBOS_7.length; i++) {
      const c = COMBOS_7[i];
      const s = evaluate5(cards[c[0]], cards[c[1]], cards[c[2]], cards[c[3]], cards[c[4]]);
      if (s > best) best = s;
    }
    return best;
  }

  const categoryOf = (scoreValue) => scoreValue >> 20;

  /** 把评分翻译成「两对 A/K」这样的中文描述。 */
  function describe(scoreValue) {
    const cat = categoryOf(scoreValue);
    const k = [];
    for (let i = 0; i < 5; i++) k.push((scoreValue >> (16 - i * 4)) & 0xf);
    const R = (idx) => RANK_CHARS[idx];

    switch (cat) {
      case CATEGORY.STRAIGHT_FLUSH:
        return k[0] === 12 ? '皇家同花顺' : `${R(k[0])} 高同花顺`;
      case CATEGORY.QUADS: return `四条 ${R(k[0])}`;
      case CATEGORY.FULL_HOUSE: return `葫芦 ${R(k[0])} 带 ${R(k[3])}`;
      case CATEGORY.FLUSH: return `${R(k[0])} 高同花`;
      case CATEGORY.STRAIGHT: return `${R(k[0])} 高顺子`;
      case CATEGORY.TRIPS: return `三条 ${R(k[0])}`;
      case CATEGORY.TWO_PAIR: return `两对 ${R(k[0])}/${R(k[2])}`;
      case CATEGORY.PAIR: return `一对 ${R(k[0])}`;
      default: return `高牌 ${R(k[0])}`;
    }
  }

  /** 找出最好的五张牌本身，用于摊牌时高亮。 */
  function bestFive(cards) {
    if (cards.length <= 5) return cards.slice();
    let best = -1;
    let bestCards = null;
    const n = cards.length;
    for (let a = 0; a < n - 4; a++) {
      for (let b = a + 1; b < n - 3; b++) {
        for (let c = b + 1; c < n - 2; c++) {
          for (let d = c + 1; d < n - 1; d++) {
            for (let e = d + 1; e < n; e++) {
              const s = evaluate5(cards[a], cards[b], cards[c], cards[d], cards[e]);
              if (s > best) {
                best = s;
                bestCards = [cards[a], cards[b], cards[c], cards[d], cards[e]];
              }
            }
          }
        }
      }
    }
    return bestCards;
  }

  const api = {
    RANK_CHARS, SUIT_CHARS, CATEGORY, CATEGORY_NAMES,
    rankOf, suitOf, cardName,
    makeDeck, shuffle,
    evaluate, evaluate5, categoryOf, describe, bestFive,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PokerCards = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
