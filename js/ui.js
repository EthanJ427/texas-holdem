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

  const AI_NAMES = ['Chen', 'Marcus', 'Nadia', 'Priya', 'Tobias'];

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

  let engine = null;      // 单机模式下的本地引擎；联机时为 null
  let net = null;         // 联机客户端；单机时为 null
  let view = null;        // 渲染唯一依据。单机来自 engine.viewFor(0)，联机来自服务器
  let turnInfo = null;    // 联机时服务器给的本回合信息（含截止时刻）
  let countdownTimer = null;
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

  const isOnline = () => net !== null;

  /**
   * 把座位号换算成屏幕上的位置：自己永远在正下方。
   * 单机时 you 恒为 0，等于没变；联机时每个人看到的都是「我在下面」。
   */
  function displaySeat(seatId) {
    const me = view && typeof view.you === 'number' ? view.you : 0;
    return ((seatId - me) % 6 + 6) % 6;
  }

  /** 单机模式下把引擎状态同步成视图 —— 走的是和联机完全相同的裁剪函数 */
  function syncLocalView() {
    if (engine) view = engine.viewFor(0);
  }

  // ---------- 存档 ----------

  function save() {
    if (!engine || isOnline()) return;
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
    const players = [{ name: 'You', isHuman: true, chips: config.stack }];
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
    if (!view) return;

    $('hand-number').textContent = view.handNumber;
    $('blind-info').textContent = `Blinds ${view.smallBlind}/${view.bigBlind}`;
    $('pot-amount').textContent = view.pot;

    const streetNames = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River', showdown: 'Showdown' };
    $('street-label').textContent = streetNames[view.street] || '';

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
    view.players.forEach((p, i) => {
      seats.appendChild(seatEl(p, i));
      // 宽屏时筹码摆在座位和桌心之间；竖屏桌子太窄，摆哪儿都会压到
      // 公共牌或别人的牌，所以直接挂在座位上（见 seatEl）
      if (p.bet > 0 && !isNarrow()) seats.appendChild(betEl(p, i));
    });

    // 庄家按钮贴在庄家座位旁边
    const btnPos = seatPositions()[displaySeat(view.buttonIndex)];
    const dealer = document.createElement('div');
    dealer.className = 'dealer-button';
    dealer.textContent = 'D';
    dealer.style.left = (btnPos.left + (btnPos.left > 50 ? -14 : btnPos.left < 50 ? 14 : 16)) + '%';
    dealer.style.top = (btnPos.top + (btnPos.top > 50 ? -13 : 13)) + '%';
    seats.appendChild(dealer);
  }

  function seatEl(p, i) {
    const pos = seatPositions()[displaySeat(i)];
    const seat = document.createElement('div');
    seat.className = 'seat';
    if (i === view.you) seat.classList.add('me');
    if (p.folded && !p.busted) seat.classList.add('folded');
    if (p.busted) seat.classList.add('folded');
    if (view.actorIndex === i && !view.handOver) seat.classList.add('acting');
    if (winnerIds.has(i)) seat.classList.add('winner');
    seat.style.left = pos.left + '%';
    seat.style.top = pos.top + '%';

    // 状态标签
    let status = null;
    if (p.busted) status = { text: 'Out', cls: '' };
    else if (thinkingId === i) status = { text: 'Thinking', cls: 'thinking' };
    else if (p.folded) status = { text: 'Folded', cls: '' };
    else if (p.allIn) status = { text: 'All in', cls: 'allin' };
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
    // 视图里有牌就是明的，没有就是背面 —— 界面不再自己判断该不该露，
    // 一切以裁剪结果为准。这样联机时哪怕界面写错也泄不出去。
    if (!p.busted && p.holeCount === 2) {
      if (p.hole) {
        p.hole.forEach((c, idx) => {
          const fresh = isFresh(`hole:${i}:${idx}:${c}`);
          cards.appendChild(cardEl(c, {
            winning: highlightCards.has(c), dimmed: p.folded, animate: fresh,
          }));
        });
      } else {
        for (let idx = 0; idx < 2; idx++) {
          cards.appendChild(cardEl(null, { animate: isFresh(`hole:${i}:${idx}:back`) }));
        }
      }
    }
    seat.appendChild(cards);

    // 名牌
    const plate = document.createElement('div');
    plate.className = 'plate';
    const levelName = p.level && AI.LEVELS[p.level] ? AI.LEVELS[p.level].name : '';
    plate.innerHTML =
      `<div class="plate-name">${p.name}</div>` +
      `<div class="plate-level">${levelName}</div>` +
      `<div class="plate-chips${p.busted ? ' busted' : ''}">${p.busted ? 'Out' : p.chips}</div>`;
    seat.appendChild(plate);

    // 剩余筹码也画成实物，输光了自然就没了
    if (!p.busted && p.chips > 0) {
      const bank = chipPileEl(p.chips, {
        small: true,
        unit: (view.startingChips || 1000) / 12,
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
      bet.appendChild(chipPileEl(p.bet, { small: true, unit: view.bigBlind, maxChips: 10, perStack: 5 }));
      const label = document.createElement('span');
      label.textContent = p.bet;
      bet.appendChild(label);
      seat.appendChild(bet);
    }

    // 摊牌时显示牌型
    if (view.result && view.result.showdown) {
      const info = view.result.hands.find((h) => h.player === i);
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
    const pos = BET_OFFSETS[displaySeat(i)];
    const el = document.createElement('div');
    el.className = 'seat-bet';
    if (isFresh(`bet:${i}:${p.bet}`)) el.classList.add('changed');
    el.style.left = pos.left + '%';
    el.style.top = pos.top + '%';
    el.appendChild(chipPileEl(p.bet, { unit: view.bigBlind, maxChips: 16, perStack: 8 }));
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
    syncLocalView();
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
        Sound.deal(view ? view.players.filter((p) => !p.busted && !p.folded).length : 6);
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
    const reference = (view && view.startingChips) || 1000;
    return Math.min(1, (amount || (view && view.bigBlind) || 20) / (reference * 0.45));
  }

  /** 公共牌一张一张地翻出来，而不是整排突然出现 */
  async function syncBoard() {
    while (view && displayBoard.length < view.board.length) {
      displayBoard.push(view.board[displayBoard.length]);
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

    if (view.you === null || view.you === undefined) return;
    const me = view.players[view.you];
    const legal = view.legalActions;
    const toCall = view.toCall;

    // 提示当前牌型，方便新手判断
    let prompt = 'Your turn';
    if (view.board.length >= 3 && me.hole) {
      const score = Cards.evaluate(me.hole.concat(view.board));
      prompt = `Your turn — you have ${Cards.describe(score)}`;
    }
    if (toCall > 0) prompt += ` · ${toCall} to call`;
    $('action-prompt').textContent = prompt;

    for (const action of legal) {
      if (action.type === 'bet' || action.type === 'raise') {
        const btn = makeActBtn('raise', action.label,
          action.min >= action.max ? `All in ${action.max}` : `${action.min} min`);
        btn.onclick = () => openRaisePanel(action);
        container.appendChild(btn);
      } else if (action.type === 'call') {
        const btn = makeActBtn('call', 'Call', String(action.amount));
        btn.onclick = () => submit({ type: 'call' });
        container.appendChild(btn);
      } else if (action.type === 'check') {
        const btn = makeActBtn('call', 'Check', 'costs nothing');
        btn.onclick = () => submit({ type: 'check' });
        container.appendChild(btn);
      } else {
        const btn = makeActBtn('fold', 'Fold', me.committed > 0 ? `give up ${me.committed}` : '');
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
    slider.value = Math.min(action.max, Math.max(action.min, Math.round(view.pot * 0.6)));
    output.textContent = slider.value;
    slider.oninput = () => { output.textContent = slider.value; };

    // 常用下注尺度
    const presets = $('raise-presets');
    presets.innerHTML = '';
    const options = [
      { label: '½ pot', to: view.currentBet + view.pot * 0.5 },
      { label: '⅔ pot', to: view.currentBet + view.pot * 0.67 },
      { label: 'Pot', to: view.currentBet + view.pot },
      { label: 'All in', to: action.max },
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
    if (isOnline()) {
      // 带上手牌号和动作序号，服务器靠这两个挡住重复提交
      net.action(view.handNumber, turnInfo ? turnInfo.actionSeq : 0, move.type, move.amount);
      clearActionBar();
      return;
    }
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
      syncLocalView();
      await flush();
      return endGame();
    }
    syncLocalView();

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
        // 交给 AI 的是裁剪过的视图，它拿不到别人的底牌
        move = AI.decide(engine.viewFor(actor.id));
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
    const result = view && view.result;
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
      const names = pot.winners.map((id) => view.players[id].name).join('、');
      if (result.showdown) {
        const info = result.hands.find((h) => h.player === pot.winners[0]);
        lines.push(`${pot.label} ${pot.amount} → ${names} (${info ? info.description : ''})`);
      } else {
        lines.push(`${names} wins ${pot.amount} — everyone else folded`);
      }
    }

    const me = view.players[view.you];
    const delta = me.wonThisHand - me.committed;
    if (delta > 0) lines.push(`You won ${delta} this hand`);
    else if (delta < 0) lines.push(`You lost ${-delta} this hand`);
    else if (me.committed > 0) lines.push('You broke even this hand');

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
      $('gameover-title').textContent = 'You took it all';
      $('gameover-text').textContent =
        `You won every chip on the table — ${me.chips} across ${engine.handNumber} hands.`;
    } else {
      $('gameover-title').textContent = 'You are out';
      const best = alive.sort((a, b) => b.chips - a.chips)[0];
      $('gameover-text').textContent =
        `Out of chips after ${engine.handNumber} hands.${best ? ` ${best.name} leads with ${best.chips}.` : ''}`;
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

  // ---------- 联机 ----------

  /**
   * 联机模式没有本地循环 —— 界面完全被动：
   * 服务器推 state 就重画，推 turn 就亮出按钮，点了按钮就把动作发回去。
   * 所有判断都在服务器，客户端不推导也不预测。
   */
  function startOnline(roomCode, playerName) {
    if (Sound) Sound.unlock();
    engine = null;
    view = null;
    turnInfo = null;
    humanResolve = null;
    displayBoard = [];
    shownKeys = new Set();
    highlightCards = new Set();
    winnerIds = new Set();
    generation++;                 // 让可能还在跑的单机循环退场

    $('log-body').innerHTML = '';
    $('setup').classList.add('hidden');
    $('gameover').classList.add('hidden');
    $('game').classList.remove('hidden');
    $('result-banner').classList.add('hidden');
    $('room-info').classList.remove('hidden');
    $('room-info').textContent = `Room ${roomCode}`;
    $('conn-info').classList.remove('hidden');

    net = new window.PokerNet.NetClient({
      room: roomCode,
      name: playerName,
      on: {
        status: onNetStatus,
        welcome: (d) => {
          if (d.waiting) appendLog('Hand in progress — you are seated next hand', 'log-street');
          else appendLog(`Seated in room ${roomCode}`, 'log-hand');
        },
        state: onNetState,
        events: onNetEvents,
        turn: onNetTurn,
        serverError: onNetError,
      },
    });
    net.connect();
    startCountdown();
  }

  function onNetStatus(s) {
    const el = $('conn-info');
    const label = {
      connecting: 'Connecting…', open: 'Connected',
      reconnecting: 'Reconnecting…', error: 'Connection failed',
    }[s.state] || '';
    el.textContent = label;
    el.classList.toggle('bad', s.state === 'reconnecting' || s.state === 'error');
  }

  function onNetState(d) {
    const previous = view;
    view = d.view;
    // you 为 null = 还在等下一手入座，此时是旁观视角
    const waiting = view.you === null || view.you === undefined;
    $('action-prompt').textContent = waiting ? 'Hand in progress — you are seated next hand' : '';
    // 换手了就把动画状态清空，否则上一手的牌会被当成"已经出现过"
    if (!previous || previous.handNumber !== view.handNumber) {
      displayBoard = [];
      shownKeys = new Set();
      highlightCards = new Set();
      winnerIds = new Set();
      $('result-banner').classList.add('hidden');
    }
    if (view.handOver && view.result) showResultBanner();
    syncBoard().then(render);
    render();
    // 不该我行动了就把按钮收掉
    if (waiting || view.actorIndex !== view.you || view.handOver) clearActionBar();
    if (waiting) $('action-prompt').textContent = 'Hand in progress — you are seated next hand';
  }

  function onNetEvents(events) {
    for (const e of events) {
      logEvent(e);
      playEventSound(e);
    }
  }

  function onNetTurn(d) {
    turnInfo = d;
    if (!view || view.actorIndex !== view.you) return;
    renderActionButtons();
  }

  function onNetError(d) {
    // stale_action 多半是自己手快点了两下，不值得打扰玩家
    if (d.code === 'stale_action') return;
    appendLog(`× ${d.message || d.code}`, 'log-street');
  }

  function clearActionBar() {
    $('action-buttons').innerHTML = '';
    $('raise-panel').classList.add('hidden');
    $('action-prompt').textContent = '';
    $('countdown').classList.add('hidden');
  }

  /** 倒计时按服务器给的截止时刻走，本地时钟偏移已经在 net 里校正过 */
  function startCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      const el = $('countdown');
      if (!isOnline() || !turnInfo || !view || view.actorIndex !== view.you || view.handOver) {
        el.classList.add('hidden');
        return;
      }
      const left = Math.max(0, net.localDeadline(turnInfo.deadline) - Date.now());
      el.classList.remove('hidden');
      el.textContent = `${Math.ceil(left / 1000)}s`;
      el.classList.toggle('urgent', left < 10000);
    }, 250);
  }

  function stopOnline() {
    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    if (net) { net.disconnect(); net = null; }
    turnInfo = null;
    $('room-info').classList.add('hidden');
    $('conn-info').classList.add('hidden');
  }

  /** 联机时结算条只是展示，下一手由服务器安排 */
  function showResultBanner() {
    if (!view.result) return;
    revealAll = true;
    for (const pot of view.result.pots) {
      for (const id of pot.winners) {
        winnerIds.add(id);
        const info = view.result.hands.find((h) => h.player === id);
        if (info) for (const c of info.best) highlightCards.add(c);
      }
    }
    const lines = view.result.pots.map((pot) => {
      const names = pot.winners.map((id) => view.players[id].name).join('、');
      const info = view.result.hands.find((h) => h.player === pot.winners[0]);
      return view.result.showdown
        ? `${pot.label} ${pot.amount} → ${names} (${info ? info.description : ''})`
        : `${names} wins ${pot.amount}`;
    });
    const me = view.you === null || view.you === undefined ? null : view.players[view.you];
    if (me) {
      const delta = me.wonThisHand - me.committed;
      if (delta > 0) lines.push(`You won ${delta} this hand`);
      else if (delta < 0) lines.push(`You lost ${-delta} this hand`);
    }
    $('result-text').innerHTML = lines.join('<br>');
    $('result-banner').classList.remove('hidden');
    $('next-hand-btn').textContent = 'Next hand shortly…';
  }

  // ---------- 启动 ----------

  function startGame(g) {
    // 浏览器只允许在用户手势里启动音频，点「开打」正好是个手势
    if (Sound) Sound.unlock();
    stopOnline();
    engine = g;
    humanResolve = null;
    syncLocalView();
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
      if (isOnline()) {
        stopOnline();
        $('game').classList.add('hidden');
        $('result-banner').classList.add('hidden');
        $('setup').classList.remove('hidden');
        return;
      }
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
      soundBtn.textContent = on ? '🔊 Sound' : '🔇 Muted';
      soundBtn.title = on ? 'Mute' : 'Unmute';
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

    // 单机 / 联机切换
    const soloTab = $('mode-solo');
    const onlineTab = $('mode-online');
    const showMode = (online) => {
      soloTab.classList.toggle('active', !online);
      onlineTab.classList.toggle('active', online);
      $('solo-fields').classList.toggle('hidden', online);
      $('online-fields').classList.toggle('hidden', !online);
      const resume = $('resume-btn');
      if (resume) resume.classList.toggle('hidden', online);
    };
    soloTab.onclick = () => showMode(false);
    onlineTab.onclick = () => showMode(true);

    $('join-btn').onclick = () => {
      const code = ($('room-code').value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      const name = ($('player-name').value || '').trim().slice(0, 12);
      if (!code) { $('room-code').focus(); return; }
      startOnline(code, name || 'Player');
    };
    $('room-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') $('join-btn').click();
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
    btn.textContent = `Resume — you have ${me.chips} chips`;
    btn.onclick = () => startGame(restoreEngine(data));

    const card = document.querySelector('#setup .setup-card');
    card.insertBefore(btn, card.querySelector('.field'));
  }

  // 联机是分布式的，出问题时光看画面判断不了。留一个只读的调试出口。
  window.__holdemDebug = () => ({
    online: isOnline(),
    you: view && view.you,
    actorIndex: view && view.actorIndex,
    handNumber: view && view.handNumber,
    handOver: view && view.handOver,
    turnInfo,
    clockOffset: net ? net.clockOffset : null,
    localDeadline: net && turnInfo ? net.localDeadline(turnInfo.deadline) : null,
    now: Date.now(),
  });

  // 脚本挂在 body 末尾，DOM 已经就绪
  init();
})();
