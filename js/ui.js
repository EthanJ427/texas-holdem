/*
 * 界面与流程控制
 *
 * 引擎是同步的、一步一步推进的；这一层负责把它变成看得见的牌桌：
 * 按节奏播放事件、给电脑对手加上「思考」的停顿、等真人点按钮。
 */
(function () {
  'use strict';

  const Cards = window.PokerCards;
  const AI = window.PokerAI;
  const Sound = window.PokerSound;
  const { HoldemEngine } = window.PokerEngine;

  const STORAGE_KEY = 'holdem_save_v1';

  // 六个座位在桌面上的位置（left%, top%），真人固定在正下方，
  // 顺时针依次是左下、左上、正上、右上、右下
  const SEAT_POSITIONS = [
    { left: 50, top: 93 },
    { left: 12, top: 74 },
    { left: 12, top: 28 },
    { left: 50, top: 7 },
    { left: 88, top: 28 },
    { left: 88, top: 74 },
  ];

  // 竖屏时桌子变窄，两侧的座位要往里收，否则会挂到桌沿外面。
  // 上面两个座位还要再抬高一点：挂上下注额后座位会变高，
  // 不留余量的话底部会探进公共牌那一行。
  const SEAT_POSITIONS_NARROW = [
    { left: 50, top: 94 },
    { left: 22, top: 76 },
    { left: 26, top: 24 },
    { left: 50, top: 8 },
    { left: 74, top: 24 },
    { left: 78, top: 76 },
  ];

  // 下注筹码显示在座位朝向桌心的一侧。
  // 正上方那个要再抬高些，否则会压到底池的数字。
  const BET_OFFSETS = [
    { left: 50, top: 62 },
    { left: 28, top: 56 },
    { left: 28, top: 40 },
    { left: 50, top: 29 },
    { left: 72, top: 40 },
    { left: 72, top: 56 },
  ];

  const NARROW_BREAKPOINT = 780;
  const isNarrow = () => window.innerWidth <= NARROW_BREAKPOINT;
  const seatPositions = () => (isNarrow() ? SEAT_POSITIONS_NARROW : SEAT_POSITIONS);

  const AI_NAMES = ['老陈', '阿杰', '王姐', '小林', '高博'];

  const LEVEL_PRESETS = {
    mixed: ['novice', 'novice', 'intermediate', 'intermediate', 'expert'],
    novice: ['novice', 'novice', 'novice', 'novice', 'novice'],
    intermediate: ['intermediate', 'intermediate', 'intermediate', 'intermediate', 'intermediate'],
    expert: ['expert', 'expert', 'expert', 'expert', 'expert'],
  };

  const $ = (id) => document.getElementById(id);

  /**
   * 筹码颜色按金额档位走，沿用赌场的惯例配色。
   * 注意不能按面额把金额拆开来堆 —— 那样 990 会拆成十几颗，
   * 1000 反而只有一颗千元筹码，堆头大小和实际筹码量正好相反。
   */
  function chipTier(amount) {
    if (amount >= 3000) return 'c1000';
    if (amount >= 1000) return 'c500';
    if (amount >= 200) return 'c100';
    if (amount >= 50) return 'c25';
    return 'c5';
  }

  /**
   * 画一堆筹码：颗数与金额成正比，堆头大小就能一眼看出多少。
   * unit 决定「一颗代表多少」，maxChips 封顶避免全下时铺满桌子。
   */
  function chipPileEl(amount, options) {
    const opts = options || {};
    const pile = document.createElement('div');
    pile.className = 'chip-pile' + (opts.small ? ' small' : '');
    if (!(amount > 0)) return pile;

    const unit = Math.max(1, opts.unit || 1);
    const maxChips = opts.maxChips || 12;
    const perStack = opts.perStack || 6;
    const count = Math.max(1, Math.min(Math.round(amount / unit), maxChips));
    const cls = chipTier(amount);

    let left = count;
    while (left > 0) {
      const column = document.createElement('div');
      column.className = 'chip-stack';
      const n = Math.min(left, perStack);
      for (let i = 0; i < n; i++) {
        const chip = document.createElement('div');
        chip.className = 'chip ' + cls;
        // 序号交给 CSS，用来沿桌面法线把这一片往上摞
        chip.style.setProperty('--chip-i', String(i));
        column.appendChild(chip);
      }
      pile.appendChild(column);
      left -= n;
    }
    return pile;
  }

  let engine = null;
  let displayBoard = [];
  let revealAll = false;
  let highlightCards = new Set();
  let winnerIds = new Set();
  let thinkingId = -1;
  let humanResolve = null;
  // 每开一局就 +1。退出或结束时也 +1，让旧的循环自己安静退场，
  // 否则旧循环会被新牌局的「下一手」按钮唤醒，拿着上一局的引擎乱改界面。
  let generation = 0;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------- 存档 ----------

  function save() {
    if (!engine) return;
    // 中途退出时这一手作废，已经推进底池的筹码要退回来，否则存档一读就少了一截。
    // 一手打完后 committed 仍保留着本手的投入，但赢的钱已经进了 chips，这时不能再加。
    const handInProgress = !engine.handOver;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        players: engine.players.map((p) => ({
          name: p.name,
          level: p.level,
          chips: p.chips + (handInProgress ? p.committed : 0),
          isHuman: p.isHuman,
          busted: p.busted,
        })),
        smallBlind: engine.smallBlind,
        bigBlind: engine.bigBlind,
        buttonIndex: engine.buttonIndex,
        handNumber: engine.handNumber,
      }));
    } catch (e) { /* 存档失败不影响玩 */ }
  }

  function loadSave() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.players) || data.players.length !== 6) return null;
      const human = data.players.find((p) => p.isHuman);
      if (!human || human.chips <= 0) return null;
      return data;
    } catch (e) { return null; }
  }

  const clearSave = () => { try { localStorage.removeItem(STORAGE_KEY); } catch (e) {} };

  // ---------- 建桌 ----------

  function buildEngine(config) {
    const levels = LEVEL_PRESETS[config.difficulty] || LEVEL_PRESETS.mixed;
    const players = [{ name: '你', isHuman: true, chips: config.stack }];
    for (let i = 0; i < 5; i++) {
      players.push({ name: AI_NAMES[i], level: levels[i], chips: config.stack });
    }
    return new HoldemEngine({
      players,
      smallBlind: config.smallBlind,
      bigBlind: config.smallBlind * 2,
      startingChips: config.stack,
    });
  }

  function restoreEngine(data) {
    const g = new HoldemEngine({
      players: data.players.map((p) => ({
        name: p.name, level: p.level, chips: p.chips, isHuman: p.isHuman,
      })),
      smallBlind: data.smallBlind,
      bigBlind: data.bigBlind,
    });
    data.players.forEach((p, i) => { g.players[i].busted = !!p.busted; });
    g.buttonIndex = data.buttonIndex || 0;
    g.handNumber = data.handNumber || 0;
    return g;
  }

  // ---------- 渲染 ----------

  /**
   * 记录已经出现过的牌和下注额。渲染是整块重建 DOM 的，
   * 没有这层记录的话每次重建都会重播一遍入场动画，满屏乱闪。
   * 每手牌开始时清空。
   */
  let shownKeys = new Set();

  /** 这个 key 是第一次出现吗？顺手记下来。 */
  function isFresh(key) {
    if (shownKeys.has(key)) return false;
    shownKeys.add(key);
    return true;
  }

  function cardEl(cardId, options) {
    const opts = options || {};
    const el = document.createElement('div');
    if (cardId === null || cardId === undefined) {
      el.className = 'card back';
      if (opts.animate) el.classList.add('dealing');
      return el;
    }
    const suit = Cards.suitOf(cardId);
    const red = suit === 1 || suit === 2;
    el.className = 'card ' + (red ? 'red' : 'black');
    if (opts.animate) el.classList.add('dealing');
    if (opts.dimmed) el.classList.add('dimmed');
    if (opts.winning) el.classList.add('winning');
    const label = Cards.RANK_LABELS[Cards.rankOf(cardId)];
    el.innerHTML =
      `<span class="rank${label.length > 1 ? ' wide' : ''}">${label}</span>` +
      `<span class="suit">${Cards.SUIT_CHARS[suit]}</span>`;
    return el;
  }

  function render() {
    if (!engine) return;

    $('hand-number').textContent = engine.handNumber;
    $('blind-info').textContent = `盲注 ${engine.smallBlind}/${engine.bigBlind}`;
    $('pot-amount').textContent = engine.pot;

    const streetNames = { preflop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '摊牌' };
    $('street-label').textContent = streetNames[engine.street] || '';

    // 公共牌
    // 公共牌复用已有节点：翻牌是一张一张发的，中间还夹着别的重渲染，
    // 每次都重建的话动画会被掐断，牌等于没动过就出现了。
    const board = $('board');
    while (board.children.length > displayBoard.length) board.lastChild.remove();
    displayBoard.forEach((c, i) => {
      const key = `board:${i}:${c}`;
      const existing = board.children[i];
      if (existing && existing.dataset.key === key) {
        existing.classList.toggle('winning', highlightCards.has(c));
        return;
      }
      const el = cardEl(c, { winning: highlightCards.has(c), animate: isFresh(key) });
      el.dataset.key = key;
      if (existing) board.replaceChild(el, existing);
      else board.appendChild(el);
    });

    // 座位
    const seats = $('seats');
    seats.innerHTML = '';
    engine.players.forEach((p, i) => {
      seats.appendChild(seatEl(p, i));
      // 宽屏时筹码摆在座位和桌心之间；竖屏桌子太窄，摆哪儿都会压到
      // 公共牌或别人的牌，所以直接挂在座位上（见 seatEl）
      if (p.bet > 0 && !isNarrow()) seats.appendChild(betEl(p, i));
    });

    // 庄家按钮贴在庄家座位旁边
    const btnPos = seatPositions()[engine.buttonIndex];
    const dealer = document.createElement('div');
    dealer.className = 'dealer-button';
    dealer.textContent = 'D';
    dealer.style.left = (btnPos.left + (btnPos.left > 50 ? -14 : btnPos.left < 50 ? 14 : 16)) + '%';
    dealer.style.top = (btnPos.top + (btnPos.top > 50 ? -13 : 13)) + '%';
    seats.appendChild(dealer);
  }

  function seatEl(p, i) {
    const pos = seatPositions()[i];
    const seat = document.createElement('div');
    seat.className = 'seat';
    if (p.isHuman) seat.classList.add('me');
    if (p.folded && !p.busted) seat.classList.add('folded');
    if (p.busted) seat.classList.add('folded');
    if (engine.actorIndex === i && !engine.handOver) seat.classList.add('acting');
    if (winnerIds.has(i)) seat.classList.add('winner');
    seat.style.left = pos.left + '%';
    seat.style.top = pos.top + '%';

    // 状态标签
    let status = null;
    if (p.busted) status = { text: '已出局', cls: '' };
    else if (thinkingId === i) status = { text: '思考中', cls: 'thinking' };
    else if (p.folded) status = { text: '弃牌', cls: '' };
    else if (p.allIn) status = { text: '全下', cls: 'allin' };
    else if (p.lastAction) status = { text: p.lastAction, cls: '' };

    if (status) {
      const s = document.createElement('div');
      s.className = 'seat-status ' + status.cls;
      s.textContent = status.text;
      seat.appendChild(s);
    }

    // 底牌
    const cards = document.createElement('div');
    cards.className = 'seat-cards';
    if (!p.busted && p.hole.length === 2) {
      const faceUp = p.isHuman || (revealAll && !p.folded);
      p.hole.forEach((c, idx) => {
        // key 里带上正反面，摊牌翻开时 key 会变，正好让翻牌动一下
        const fresh = isFresh(`hole:${i}:${idx}:${faceUp ? c : 'back'}`);
        cards.appendChild(faceUp
          ? cardEl(c, { winning: highlightCards.has(c), dimmed: p.folded, animate: fresh })
          : cardEl(null, { animate: fresh }));
      });
    }
    seat.appendChild(cards);

    // 名牌
    const plate = document.createElement('div');
    plate.className = 'plate';
    const levelName = p.level && AI.LEVELS[p.level] ? AI.LEVELS[p.level].name : '';
    plate.innerHTML =
      `<div class="plate-name">${p.name}</div>` +
      `<div class="plate-level">${levelName}</div>` +
      `<div class="plate-chips${p.busted ? ' busted' : ''}">${p.busted ? '出局' : p.chips}</div>`;
    seat.appendChild(plate);

    // 剩余筹码也画成实物，输光了自然就没了
    if (!p.busted && p.chips > 0) {
      const bank = chipPileEl(p.chips, {
        small: true,
        unit: (engine.startingChips || 1000) / 12,
        maxChips: 24,   // 赢到起始筹码的两倍才封顶，赢钱看得出来
        perStack: 12,   // 又高又窄，才像真实牌桌上的筹码柱
      });
      bank.classList.add('bank');
      seat.appendChild(bank);
    }

    // 竖屏时下注额跟着座位走，避免和公共牌抢地方
    if (p.bet > 0 && isNarrow()) {
      const bet = document.createElement('div');
      bet.className = 'seat-bet inline';
      if (isFresh(`bet:${i}:${p.bet}`)) bet.classList.add('changed');
      bet.appendChild(chipPileEl(p.bet, { small: true, unit: engine.bigBlind, maxChips: 10, perStack: 5 }));
      const label = document.createElement('span');
      label.textContent = p.bet;
      bet.appendChild(label);
      seat.appendChild(bet);
    }

    // 摊牌时显示牌型
    if (revealAll && engine.result && engine.result.showdown) {
      const info = engine.result.hands.find((h) => h.player === i);
      if (info && !p.folded) {
        const tag = document.createElement('div');
        tag.className = 'seat-handinfo';
        tag.textContent = info.description;
        seat.appendChild(tag);
      }
    }

    return seat;
  }

  function betEl(p, i) {
    const pos = BET_OFFSETS[i];
    const el = document.createElement('div');
    el.className = 'seat-bet';
    if (isFresh(`bet:${i}:${p.bet}`)) el.classList.add('changed');
    el.style.left = pos.left + '%';
    el.style.top = pos.top + '%';
    el.appendChild(chipPileEl(p.bet, { unit: engine.bigBlind, maxChips: 16, perStack: 8 }));
    const label = document.createElement('span');
    label.textContent = p.bet;
    el.appendChild(label);
    return el;
  }

  // ---------- 记录 ----------

  function appendLog(text, cls) {
    const body = $('log-body');
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = text;
    body.appendChild(line);
    body.scrollTop = body.scrollHeight;
  }

  function logEvent(e) {
    if (!e.text) return;
    const cls =
      e.type === 'hand-start' ? 'log-hand' :
      e.type === 'street' ? 'log-street' :
      e.type === 'hand-end' ? 'log-win' : '';
    appendLog(e.text, cls);
  }

  // ---------- 事件播放 ----------

  async function flush() {
    for (const e of engine.drainEvents()) {
      logEvent(e);
      playEventSound(e);
    }
    await syncBoard();
    render();
  }

  /** 事件 → 音效。放在这里是因为盲注、行动、结算都从同一条事件流经过。 */
  function playEventSound(e) {
    if (!Sound) return;
    switch (e.type) {
      case 'deal-hole':
        Sound.deal(engine.livePlayers().length);
        break;
      case 'blind':
        Sound.chips(0.15);
        break;
      case 'action':
        if (e.action === 'fold') Sound.fold();
        else if (e.action === 'check') Sound.knock();
        else Sound.chips(betWeight(e.amount));
        break;
      case 'hand-end':
        Sound.pot();
        break;
      default:
        break;
    }
  }

  /** 下注额相对起始筹码的分量，用来决定扔多少颗筹码 */
  function betWeight(amount) {
    const reference = engine.startingChips || 1000;
    return Math.min(1, (amount || engine.bigBlind) / (reference * 0.45));
  }

  /** 公共牌一张一张地翻出来，而不是整排突然出现 */
  async function syncBoard() {
    while (displayBoard.length < engine.board.length) {
      displayBoard.push(engine.board[displayBoard.length]);
      if (Sound) Sound.flip();
      render();
      await sleep(displayBoard.length <= 3 ? 140 : 400);
    }
  }

  // ---------- 真人操作 ----------

  function renderActionButtons() {
    const container = $('action-buttons');
    container.innerHTML = '';
    $('raise-panel').classList.add('hidden');

    const me = engine.players[0];
    const legal = engine.legalActions(me);
    const toCall = engine.toCall(me);

    // 提示当前牌型，方便新手判断
    let prompt = '轮到你了';
    if (engine.board.length >= 3) {
      const score = Cards.evaluate(me.hole.concat(engine.board));
      prompt = `轮到你了 · 你现在是 ${Cards.describe(score)}`;
    }
    if (toCall > 0) prompt += ` · 需跟 ${toCall}`;
    $('action-prompt').textContent = prompt;

    for (const action of legal) {
      if (action.type === 'bet' || action.type === 'raise') {
        const btn = makeActBtn('raise', action.label,
          action.min >= action.max ? `全下 ${action.max}` : `${action.min} 起`);
        btn.onclick = () => openRaisePanel(action);
        container.appendChild(btn);
      } else if (action.type === 'call') {
        const btn = makeActBtn('call', '跟注', String(action.amount));
        btn.onclick = () => submit({ type: 'call' });
        container.appendChild(btn);
      } else if (action.type === 'check') {
        const btn = makeActBtn('call', '过牌', '不用加钱');
        btn.onclick = () => submit({ type: 'check' });
        container.appendChild(btn);
      } else {
        const btn = makeActBtn('fold', '弃牌', me.committed > 0 ? `放弃已投入的 ${me.committed}` : '');
        btn.onclick = () => submit({ type: 'fold' });
        container.appendChild(btn);
      }
    }
  }

  function makeActBtn(cls, label, sub) {
    const btn = document.createElement('button');
    btn.className = 'act-btn ' + cls;
    btn.innerHTML = `${label}${sub ? `<span class="sub">${sub}</span>` : ''}`;
    return btn;
  }

  function openRaisePanel(action) {
    const panel = $('raise-panel');
    const slider = $('raise-slider');
    const output = $('raise-amount');

    slider.min = action.min;
    slider.max = action.max;
    slider.value = Math.min(action.max, Math.max(action.min, Math.round(engine.pot * 0.6)));
    output.textContent = slider.value;
    slider.oninput = () => { output.textContent = slider.value; };

    // 常用下注尺度
    const presets = $('raise-presets');
    presets.innerHTML = '';
    const options = [
      { label: '½ 底池', to: engine.currentBet + engine.pot * 0.5 },
      { label: '⅔ 底池', to: engine.currentBet + engine.pot * 0.67 },
      { label: '1× 底池', to: engine.currentBet + engine.pot },
      { label: '全下', to: action.max },
    ];
    for (const opt of options) {
      const value = Math.round(Math.min(action.max, Math.max(action.min, opt.to)));
      const btn = document.createElement('button');
      btn.className = 'preset-btn';
      btn.innerHTML = `${opt.label}<br>${value}`;
      btn.onclick = () => { slider.value = value; output.textContent = value; };
      presets.appendChild(btn);
    }

    panel.classList.remove('hidden');
    $('raise-cancel').onclick = () => { panel.classList.add('hidden'); };
    $('raise-confirm').onclick = () => {
      panel.classList.add('hidden');
      submit({ type: action.type, amount: parseInt(slider.value, 10) });
    };
  }

  function submit(move) {
    if (!humanResolve) return;
    const resolve = humanResolve;
    humanResolve = null;
    $('action-buttons').innerHTML = '';
    $('raise-panel').classList.add('hidden');
    $('action-prompt').textContent = '';
    resolve(move);
  }

  function waitForHuman() {
    renderActionButtons();
    return new Promise((resolve) => { humanResolve = resolve; });
  }

  // ---------- 主循环 ----------

  async function playHand(gen) {
    displayBoard = [];
    shownKeys = new Set();
    revealAll = false;
    highlightCards = new Set();
    winnerIds = new Set();
    thinkingId = -1;
    $('result-banner').classList.add('hidden');

    if (!engine.startHand()) {
      await flush();
      return endGame();
    }

    await flush();
    await sleep(350);

    let guard = 0;
    while (!engine.handOver && guard++ < 500) {
      if (gen !== generation) return;
      const actor = engine.currentActor();
      if (!actor) break;

      let move;
      if (actor.isHuman) {
        move = await waitForHuman();
      } else {
        thinkingId = actor.id;
        render();
        // 决策本身很快，这里的停顿纯粹是为了让牌桌有节奏感
        await sleep(420 + Math.random() * 520);
        move = AI.decide(engine, actor);
        thinkingId = -1;
      }

      if (gen !== generation) return;
      engine.act(move.type, move.amount);
      await flush();
      await sleep(190);
    }

    if (gen !== generation) return;
    await finishHand();
  }

  async function finishHand() {
    const result = engine.result;
    if (!result) return;

    revealAll = true;

    if (result.showdown) {
      // 高亮赢家用来取胜的那五张牌
      for (const pot of result.pots) {
        for (const id of pot.winners) {
          winnerIds.add(id);
          const info = result.hands.find((h) => h.player === id);
          if (info) for (const c of info.best) highlightCards.add(c);
        }
      }
    } else {
      for (const pot of result.pots) for (const id of pot.winners) winnerIds.add(id);
    }

    render();
    await sleep(result.showdown ? 700 : 250);

    const lines = [];
    for (const pot of result.pots) {
      const names = pot.winners.map((id) => engine.players[id].name).join('、');
      if (result.showdown) {
        const info = result.hands.find((h) => h.player === pot.winners[0]);
        lines.push(`${pot.label} ${pot.amount} → ${names}（${info ? info.description : ''}）`);
      } else {
        lines.push(`${names} 赢得 ${pot.amount}，其他人都弃牌了`);
      }
    }

    const me = engine.players[0];
    const net = me.wonThisHand - me.committed;
    if (net > 0) lines.push(`你这手净赢 ${net}`);
    else if (net < 0) lines.push(`你这手净输 ${-net}`);
    else if (me.committed > 0) lines.push('你这手打平');

    $('result-text').innerHTML = lines.join('<br>');
    $('result-banner').classList.remove('hidden');
    $('action-prompt').textContent = '';
    save();
  }

  function endGame() {
    const alive = engine.players.filter((p) => !p.busted);
    const me = engine.players[0];
    $('game').classList.add('hidden');
    $('result-banner').classList.add('hidden');
    $('gameover').classList.remove('hidden');

    if (!me.busted && alive.length === 1) {
      $('gameover-title').textContent = '通吃全场';
      $('gameover-text').textContent =
        `你赢下了牌桌上全部 ${me.chips} 筹码，一共打了 ${engine.handNumber} 手。`;
    } else {
      $('gameover-title').textContent = '你出局了';
      const best = alive.sort((a, b) => b.chips - a.chips)[0];
      $('gameover-text').textContent =
        `筹码输光，打了 ${engine.handNumber} 手。${best ? `目前筹码最多的是 ${best.name}（${best.chips}）。` : ''}`;
    }
    clearSave();
    generation++;   // 让当前循环退出
  }

  async function gameLoop(gen) {
    while (gen === generation) {
      await playHand(gen);
      if (gen !== generation) return;

      // 等玩家点「下一手」
      await new Promise((resolve) => { $('next-hand-btn').onclick = resolve; });
      if (gen !== generation) return;

      if (engine.players[0].busted || engine.players[0].chips <= 0) {
        // 真人破产，直接进结算画面
        engine.players[0].busted = true;
        return endGame();
      }
    }
  }

  // ---------- 启动 ----------

  function startGame(g) {
    // 浏览器只允许在用户手势里启动音频，点「开打」正好是个手势
    if (Sound) Sound.unlock();
    engine = g;
    humanResolve = null;
    $('log-body').innerHTML = '';
    $('setup').classList.add('hidden');
    $('gameover').classList.add('hidden');
    $('game').classList.remove('hidden');
    render();
    gameLoop(++generation);
  }

  function init() {
    $('start-btn').onclick = () => {
      startGame(buildEngine({
        difficulty: $('difficulty').value,
        stack: parseInt($('stack').value, 10),
        smallBlind: parseInt($('blinds').value, 10),
      }));
    };

    $('restart-btn').onclick = () => {
      $('gameover').classList.add('hidden');
      $('setup').classList.remove('hidden');
    };

    $('quit-btn').onclick = () => {
      save();
      generation++;          // 结束当前循环
      humanResolve = null;
      $('game').classList.add('hidden');
      $('result-banner').classList.add('hidden');
      $('setup').classList.remove('hidden');
      renderResumeButton();
    };

    $('log-toggle').onclick = () => $('log-panel').classList.toggle('hidden');
    $('log-close').onclick = () => $('log-panel').classList.add('hidden');

    const soundBtn = $('sound-toggle');
    const paintSoundBtn = () => {
      const on = Sound && Sound.isEnabled();
      soundBtn.textContent = on ? '🔊 声音' : '🔇 静音';
      soundBtn.title = on ? '点击静音' : '点击开启声音';
    };
    soundBtn.onclick = () => {
      if (!Sound) return;
      Sound.setEnabled(!Sound.isEnabled());
      paintSoundBtn();
      if (Sound.isEnabled()) Sound.chips(0.3);   // 开启时给个反馈
    };
    paintSoundBtn();

    // 横竖屏切换时座位坐标要跟着换一套
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (engine) render(); }, 120);
    });

    renderResumeButton();
  }

  /** 有存档时在设置页顶部加一个「继续上次牌局」 */
  function renderResumeButton() {
    const existing = $('resume-btn');
    if (existing) existing.remove();

    const data = loadSave();
    if (!data) return;

    const btn = document.createElement('button');
    btn.id = 'resume-btn';
    btn.className = 'primary-btn';
    btn.style.marginBottom = '14px';
    btn.style.background = 'linear-gradient(180deg, #4a9d6e, #3a8259)';
    btn.style.color = '#f2ede4';
    const me = data.players.find((p) => p.isHuman);
    btn.textContent = `继续上次牌局（你还有 ${me.chips} 筹码）`;
    btn.onclick = () => startGame(restoreEngine(data));

    const card = document.querySelector('#setup .setup-card');
    card.insertBefore(btn, card.querySelector('.field'));
  }

  // 脚本挂在 body 末尾，DOM 已经就绪
  init();
})();
