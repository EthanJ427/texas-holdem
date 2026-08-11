/*
 * 房间控制器测试
 *
 * 时间是注入的，所以超时、机器人思考、开新一手这些都能直接快进，
 * 不用真等六十秒。整套测试跑完不到一秒。
 */
(function () {
  'use strict';

  const { Room } = window.PokerRoom;
  const { suite, ok, eq } = window.T;

  /** 建一个房间，机器人思考时间归零，方便一步步推 */
  function makeRoom(overrides) {
    return new Room(Object.assign({
      turnSeconds: 60,
      graceMs: 1500,
      handGapMs: 3000,
      botThinkMs: [0, 1],
      fillWithBots: true,
    }, overrides));
  }

  /** 把某类消息从 outbox 里挑出来 */
  const pick = (out, type) => out.filter((o) => o.msg.t === type).map((o) => o.msg);
  const firstOf = (out, type) => pick(out, type)[0] || null;

  /** 让房间一直 tick 到某个条件成立（或超过上限） */
  function runUntil(room, startNow, cond, stepMs, maxSteps) {
    let now = startNow;
    for (let i = 0; i < (maxSteps || 4000); i++) {
      room.tick(now);
      if (cond(room, now)) return now;
      now += stepMs || 50;
    }
    return now;
  }

  suite('进房与握手', () => {
    const room = makeRoom();
    const out = room.handle('c1', { t: 'join', id: 1, d: { name: '老王' } }, 1000);
    const welcome = firstOf(out, 'welcome');

    ok(welcome !== null, '收到 welcome');
    eq(welcome.re, 1, 'welcome 回应的是那条 join');
    ok(typeof welcome.d.token === 'string' && welcome.d.token.length > 0, '发了重连凭据');
    eq(welcome.d.serverTime, 1000, '带上服务器时间用于对时');
    eq(welcome.d.config.turnSeconds, 60, '配置里有超时秒数');
    ok(typeof welcome.d.you === 'number', '告诉他坐在几号位');
    eq(room.humanSeats().length, 1, '房间里有一个真人');
    eq(room.seats.filter((s) => s && s.isBot).length, 5, '其余五个位置由机器人补齐');
  });

  suite('机器人名字不会重复', () => {
    // 真人顶掉中间某个机器人后，如果按「现有机器人数量」取名字，
    // 会和还留在桌上的名字撞上 —— 实际打的时候桌上出现了两个「高博」。
    const room = makeRoom();
    const names = () => room.seats.filter(Boolean).map((s) => s.name);

    eq(new Set(names()).size, names().length, '开局六个名字互不相同');

    // 三个真人陆续进来，每次都会顶掉一个机器人并重新补位
    room.handle('c1', { t: 'join', id: 1, d: { name: 'A' } }, 0);
    room.handle('c2', { t: 'join', id: 2, d: { name: 'B' } }, 0);
    room.handle('c3', { t: 'join', id: 3, d: { name: 'C' } }, 0);
    room.startHand(0);

    const after = names();
    eq(new Set(after).size, after.length, `进人补位后仍然互不相同：${after.join('、')}`);
    eq(after.length, 6, '六个座位都有人');
  });

  suite('牌局进行中加入的人要等下一手', () => {
    // 之前是一进来就顶掉某个机器人，于是这个人当场接手了别人这一手的底牌，
    // 既能看见也能行动，筹码记账也会错乱。协议里写的是"绝不在牌局中途动座位"。
    const room = makeRoom();
    room.handle('c1', { t: 'join', id: 1, d: { name: '先到的' } }, 0);
    const now = runUntil(room, 0, (r) => r.engine && !r.engine.handOver, 50);
    ok(room.engine && !room.engine.handOver, '牌局正在进行中');
    const handNow = room.engine.handNumber;

    const out = room.handle('c2', { t: 'join', id: 2, d: { name: '后到的' } }, now);
    const w = firstOf(out, 'welcome');
    ok(w !== null, '中途进来的人也能连上');
    eq(w.d.you, null, '但还没有座位号，得等下一手');

    const st = firstOf(out, 'state');
    ok(st !== null, '给了他一份旁观视角的状态');
    const seen = st.d.view.players.filter((p) => p.hole !== null).length;
    eq(seen, 0, '旁观视角看不到任何人的底牌');

    // 打到下一手开始
    let t = now;
    for (let i = 0; i < 4000; i++) {
      room.tick(t);
      const a = room.engine && !room.engine.handOver && room.engine.currentActor();
      if (a && !room.seats[a.id].isBot && room.seats[a.id].connId) {
        room.handle(room.seats[a.id].connId, {
          t: 'action', id: 500 + i,
          d: { handNumber: room.engine.handNumber, actionSeq: room.actionSeq, type: 'fold' },
        }, t);
      }
      if (room.engine && room.engine.handNumber > handNow) break;
      t += 50;
    }

    const latecomer = room.seats.find((s) => s && s.name === '后到的');
    ok(latecomer, '下一手开始时他入座了');
    eq(latecomer.isBot, false, '入座的是真人不是机器人');
    eq(room.humanSeats().length, 2, '桌上现在有两个真人');
  });

  suite('凭据重连：拿回原座位和筹码', () => {
    const room = makeRoom();
    const w = firstOf(room.handle('c1', { t: 'join', id: 1, d: { name: '老王' } }, 1000), 'welcome');
    const seatIndex = w.d.you;
    const token = w.d.token;

    room.seats[seatIndex].chips = 777;          // 假装赢了一些
    room.disconnect('c1');
    eq(room.seats[seatIndex].connId, null, '断线后连接被清掉');
    ok(room.seats[seatIndex] !== null, '座位仍然保留着');

    const out2 = room.handle('c9', { t: 'join', id: 5, d: { name: '老王', token } }, 2000);
    const w2 = firstOf(out2, 'welcome');
    eq(w2.d.you, seatIndex, '重连回到原来的座位');
    eq(room.seats[seatIndex].chips, 777, '筹码没丢');
    eq(room.seats[seatIndex].connId, 'c9', '换成了新的连接');
    eq(room.humanSeats().length, 1, '没有多出一个新玩家');
  });

  suite('动作校验：手牌号与序号', () => {
    const room = makeRoom({ botThinkMs: [0, 1] });
    const w = firstOf(room.handle('c1', { t: 'join', id: 1, d: { name: '老王' } }, 0), 'welcome');
    const me = w.d.you;

    // 推到轮我行动
    const now = runUntil(room, 0, (r) => {
      const a = r.engine && !r.engine.handOver && r.engine.currentActor();
      return a && a.id === me;
    }, 50);

    ok(room.engine && room.engine.currentActor().id === me, '轮到我了');
    const seq = room.actionSeq;
    const handNo = room.engine.handNumber;

    // 序号不对
    const bad = room.handle('c1', {
      t: 'action', id: 10,
      d: { handNumber: handNo, actionSeq: seq - 1, type: 'fold' },
    }, now);
    const err = firstOf(bad, 'error');
    eq(err && err.d.code, 'stale_action', '序号过期被拒');
    eq(room.actionSeq, seq, '被拒的动作没有推进序号');
    eq(room.engine.currentActor().id, me, '仍然轮到我，状态没被改动');

    // 手牌号不对
    const bad2 = room.handle('c1', {
      t: 'action', id: 11,
      d: { handNumber: handNo + 5, actionSeq: seq, type: 'fold' },
    }, now);
    eq(firstOf(bad2, 'error').d.code, 'stale_action', '手牌号对不上也被拒');

    // 正确的动作
    const good = room.handle('c1', {
      t: 'action', id: 12,
      d: { handNumber: handNo, actionSeq: seq, type: 'fold' },
    }, now);
    eq(firstOf(good, 'error'), null, '合法动作没有报错');
    eq(room.actionSeq, seq + 1, '序号推进了一格');
  });

  suite('重复提交（双击）被挡住', () => {
    const room = makeRoom();
    const w = firstOf(room.handle('c1', { t: 'join', id: 1, d: { name: '老王' } }, 0), 'welcome');
    const me = w.d.you;
    const now = runUntil(room, 0, (r) => {
      const a = r.engine && !r.engine.handOver && r.engine.currentActor();
      return a && a.id === me;
    }, 50);

    const seq = room.actionSeq;
    const handNo = room.engine.handNumber;
    const chipsBefore = room.engine.players[me].chips;
    const action = { t: 'action', id: 20, d: { handNumber: handNo, actionSeq: seq, type: 'call' } };

    room.handle('c1', action, now);
    const chipsAfterFirst = room.engine.players[me].chips;

    // 一模一样的第二条（网络重发 / 手抖双击）
    const second = room.handle('c1', action, now);
    eq(firstOf(second, 'error').d.code, 'stale_action', '第二条被识别为过期');
    eq(room.engine.players[me].chips, chipsAfterFirst, '筹码没有被扣第二次');
    ok(chipsAfterFirst < chipsBefore, '第一条确实生效了（反向对照）');
  });

  suite('没轮到就行动会被拒', () => {
    const room = makeRoom();
    room.handle('c1', { t: 'join', id: 1, d: { name: 'A' } }, 0);
    room.handle('c2', { t: 'join', id: 2, d: { name: 'B' } }, 0);
    const now = runUntil(room, 0, (r) => r.engine && !r.engine.handOver, 50);

    const actorId = room.engine.currentActor().id;
    const otherHuman = room.humanSeats().find((s) => s.seat !== actorId);
    if (otherHuman) {
      const out = room.handle(otherHuman.connId, {
        t: 'action', id: 30,
        d: { handNumber: room.engine.handNumber, actionSeq: room.actionSeq, type: 'fold' },
      }, now);
      eq(firstOf(out, 'error').d.code, 'not_your_turn', '不是当前行动人，被拒');
    } else {
      ok(true, '这一手正好轮到唯一的真人，跳过');
    }
  });

  suite('超时自动行动（时钟快进）', () => {
    const room = makeRoom({ turnSeconds: 60 });
    const w = firstOf(room.handle('c1', { t: 'join', id: 1, d: { name: '老王' } }, 0), 'welcome');
    const me = w.d.you;
    const now = runUntil(room, 0, (r) => {
      const a = r.engine && !r.engine.handOver && r.engine.currentActor();
      return a && a.id === me;
    }, 50);

    const deadline = room.deadline;
    ok(deadline !== null, '轮到真人时设置了截止时刻');
    ok(deadline >= now + 59000, '截止时刻约为六十秒后');

    // 还没到点：不该替他行动
    room.tick(deadline - 1000);
    eq(room.engine.currentActor().id, me, '没到点时仍在等他');

    // 过了点 + 宽限：服务器替他行动
    room.tick(deadline + 1600);
    const stillMe = room.engine && !room.engine.handOver && room.engine.currentActor()
      && room.engine.currentActor().id === me;
    ok(!stillMe, '超时后服务器替他做了决定，轮到别人了');
  });

  suite('断线不弃牌，但计时照走', () => {
    const room = makeRoom({ turnSeconds: 60 });
    const w = firstOf(room.handle('c1', { t: 'join', id: 1, d: { name: '老王' } }, 0), 'welcome');
    const me = w.d.you;
    const now = runUntil(room, 0, (r) => {
      const a = r.engine && !r.engine.handOver && r.engine.currentActor();
      return a && a.id === me;
    }, 50);

    room.disconnect('c1');
    eq(room.engine.currentActor().id, me, '断线的瞬间没有立刻弃牌');
    ok(room.engine.players[me].folded === false, '牌还在手上');

    // 计时照走 —— 否则拔网线就等于无限思考时间
    room.tick(room.deadline + 1600);
    const stillMe = room.engine && !room.engine.handOver && room.engine.currentActor()
      && room.engine.currentActor().id === me;
    ok(!stillMe, '断线的人照样会超时，牌局不会卡住');
  });

  suite('机器人补位并自己行动', () => {
    const room = makeRoom();
    room.handle('c1', { t: 'join', id: 1, d: { name: '老王' } }, 0);

    let botActions = 0;
    let now = 0;
    for (let i = 0; i < 3000 && botActions < 5; i++) {
      const out = room.tick(now);
      for (const m of pick(out, 'events')) {
        botActions += m.d.events.filter((e) => e.type === 'action').length;
      }
      // 轮到真人就随便打一下，别把牌局卡死
      const a = room.engine && !room.engine.handOver && room.engine.currentActor();
      if (a && !room.seats[a.id].isBot) {
        room.handle('c1', {
          t: 'action', id: 100 + i,
          d: { handNumber: room.engine.handNumber, actionSeq: room.actionSeq, type: 'fold' },
        }, now);
      }
      now += 50;
    }
    ok(botActions >= 5, `机器人自己打了至少 5 个动作（实际 ${botActions}）`);
  });

  suite('发出去的状态是一人一份、各自裁剪的', () => {
    // 这是最关键的一条：不测引擎内部，直接检查 outbox 里真正要发出去的消息
    const room = makeRoom();
    const w1 = firstOf(room.handle('c1', { t: 'join', id: 1, d: { name: 'A' } }, 0), 'welcome');
    const w2 = firstOf(room.handle('c2', { t: 'join', id: 2, d: { name: 'B' } }, 0), 'welcome');
    const seatA = w1.d.you;
    const seatB = w2.d.you;

    let leaks = 0;
    let stateMsgs = 0;
    let eventMsgs = 0;
    let cardInEvent = 0;
    let now = 0;

    for (let i = 0; i < 2000 && stateMsgs < 60; i++) {
      const outs = [];
      outs.push(room.tick(now));
      const a = room.engine && !room.engine.handOver && room.engine.currentActor();
      if (a && !room.seats[a.id].isBot) {
        const connId = room.seats[a.id].connId;
        // 必须从合法动作里挑 —— 无需跟注时 call 是非法的，
        // 硬发会让引擎抛错、动作不生效，牌局就在这里空转了
        const legal = room.engine.legalActions(a);
        const type = legal.some((x) => x.type === 'call') ? 'call' : 'check';
        outs.push(room.handle(connId, {
          t: 'action', id: 200 + i,
          d: { handNumber: room.engine.handNumber, actionSeq: room.actionSeq, type },
        }, now));
      }

      for (const out of outs) {
        for (const entry of out) {
          if (entry.msg.t === 'state') {
            stateMsgs++;
            const seatOfConn = entry.to === 'c1' ? seatA : seatB;
            const view = entry.msg.d.view;
            for (const p of view.players) {
              if (p.id === seatOfConn) continue;
              const revealed = view.handOver && view.result && view.result.showdown && !p.folded;
              if (p.hole !== null && !revealed) leaks++;
            }
          }
          if (entry.msg.t === 'events') {
            eventMsgs++;
            const json = JSON.stringify(entry.msg.d.events);
            if (json.indexOf('"hole"') >= 0 || json.indexOf('"hands"') >= 0
                || json.indexOf('"result"') >= 0) cardInEvent++;
          }
        }
      }
      now += 50;
    }

    eq(leaks, 0, `发给两个人的每一份状态都只含自己的底牌（检查了 ${stateMsgs} 份）`);
    eq(cardInEvent, 0, `事件消息里不含 hole / hands / result（检查了 ${eventMsgs} 条）`);
    ok(stateMsgs > 20, '样本量足够');
  });

  suite('筹码在手与手之间正确结转', () => {
    const room = makeRoom({ handGapMs: 0 });
    room.handle('c1', { t: 'join', id: 1, d: { name: '老王' } }, 0);

    let now = 0;
    let handsSeen = 0;
    let chipErr = null;
    let lastHand = 0;

    for (let i = 0; i < 6000 && handsSeen < 3; i++) {
      room.tick(now);
      if (room.engine && room.engine.handNumber !== lastHand) {
        lastHand = room.engine.handNumber;
        handsSeen++;
        const total = room.seats.reduce((s, x) => s + (x ? x.chips : 0), 0);
        // 一手开始时座位上的筹码总量应该守恒
        if (Math.abs(total - 6000) > 0.001 && handsSeen > 1) {
          chipErr = chipErr || `第 ${handsSeen} 手开始时座位筹码合计 ${total}`;
        }
      }
      const a = room.engine && !room.engine.handOver && room.engine.currentActor();
      if (a && !room.seats[a.id].isBot) {
        room.handle('c1', {
          t: 'action', id: 300 + i,
          d: { handNumber: room.engine.handNumber, actionSeq: room.actionSeq, type: 'fold' },
        }, now);
      }
      now += 50;
    }

    ok(handsSeen >= 3, `连打了 ${handsSeen} 手`);
    eq(chipErr, null, '每手开始时座位上的筹码总量都守恒');
  });
})();
