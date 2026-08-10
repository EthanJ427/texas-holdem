/*
 * 音效测试
 *
 * 用 OfflineAudioContext 把声音真正渲染成波形再测量 —— 光验证「函数被调用了」
 * 说明不了问题，一个接错线的节点照样一声不响。
 *
 * 这些用例是异步的：harness 跑完同步部分后由 runAsync() 补跑。
 */
(function () {
  'use strict';

  const S = window.PokerSound;
  const { suite, ok, eq } = window.T;

  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;

  /** 渲染一段音效，返回峰值和有效样本占比 */
  async function render(trigger, seconds) {
    const duration = seconds || 1.2;
    const ctx = new OAC(1, Math.ceil(44100 * duration), 44100);
    S.unlock(ctx);
    trigger();
    const buffer = await ctx.startRendering();
    const data = buffer.getChannelData(0);

    let peak = 0;
    let energy = 0;
    let diffEnergy = 0;
    let loud = 0;
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
      energy += data[i] * data[i];
      if (i > 0) {
        const d = data[i] - data[i - 1];
        diffEnergy += d * d;
      }
      if (v > 0.005) loud++;
    }
    return {
      peak,
      rms: Math.sqrt(energy / data.length),
      loudRatio: loud / data.length,
      samples: data.length,
      // 一阶差分能量占比 —— 廉价的「亮度」代理。
      // 低频为主的声音这个值很小；嘶嘶的高频噪声会明显偏大。
      brightness: energy > 0 ? diffEnergy / energy : 0,
    };
  }

  window.__soundTests = async function () {
    if (!OAC) {
      suite('音效', () => ok(false, '此浏览器不支持 OfflineAudioContext，无法测试'));
      return;
    }

    // 静音开关是存在 localStorage 里的用户偏好。不强制打开的话，
    // 只要在游戏里点过一次静音，这里所有音效都会渲染成全零波形，
    // 测试结果就变成「取决于你上次玩的时候有没有静音」。
    const userPreference = S.isEnabled();
    S.setEnabled(true);

    const card = await render(() => S.card());
    const chips = await render(() => S.chips(0.8));
    const knock = await render(() => S.knock());
    const fold = await render(() => S.fold());
    const flip = await render(() => S.flip());
    const pot = await render(() => S.pot(), 1.6);
    const deal = await render(() => S.deal(6), 1.6);

    suite('每个音效都真的产生了波形', () => {
      const cases = [
        ['发牌', card], ['筹码', chips], ['敲桌（过牌）', knock],
        ['弃牌', fold], ['翻公共牌', flip], ['收底池', pot], ['开局发牌', deal],
      ];
      for (const [name, r] of cases) {
        ok(r.peak > 0.01, `${name}：峰值 ${r.peak.toFixed(4)}（不是静音）`);
        ok(r.peak <= 1.0, `${name}：峰值未削顶（${r.peak.toFixed(4)} ≤ 1.0）`);
      }
    });

    suite('声音不刺耳（高频能量受控）', () => {
      // 「呲呲」的齿音来自高频噪声。用一阶差分能量占比当亮度代理：
      // 0.02 附近是低频闷响，0.3 以上就是明显的嘶声了。
      const cases = [
        ['发牌', card], ['筹码', chips], ['敲桌', knock],
        ['弃牌', fold], ['翻公共牌', flip], ['收底池', pot],
      ];
      for (const [name, r] of cases) {
        ok(r.brightness < 0.25, `${name}：亮度 ${r.brightness.toFixed(4)}（低于刺耳阈值 0.25）`);
      }
    });

    suite('音效之间有区分度', () => {
      ok(pot.loudRatio > card.loudRatio,
        `收底池比发单张牌持续更久（${(pot.loudRatio * 100).toFixed(1)}% vs ${(card.loudRatio * 100).toFixed(1)}%）`);
      ok(deal.loudRatio > card.loudRatio,
        `连发六张比单张持续更久（${(deal.loudRatio * 100).toFixed(1)}% vs ${(card.loudRatio * 100).toFixed(1)}%）`);
      ok(fold.loudRatio > flip.loudRatio,
        `弃牌的擦牌声比翻牌更长（${(fold.loudRatio * 100).toFixed(1)}% vs ${(flip.loudRatio * 100).toFixed(1)}%）`);
    });

    // 下面两组要先把异步渲染做完，suite 的回调是同步的，里面不能 await
    let smallSum = 0;
    let bigSum = 0;
    const rounds = 5;
    for (let i = 0; i < rounds; i++) {
      smallSum += (await render(() => S.chips(0.05))).loudRatio;
      bigSum += (await render(() => S.chips(1))).loudRatio;
    }

    suite('下注越大筹码声越足', () => {
      // 有随机成分，多跑几次取总量比较
      ok(bigSum > smallSum,
        `全下的筹码声明显多于小注（${(bigSum / rounds * 100).toFixed(1)}% vs ${(smallSum / rounds * 100).toFixed(1)}%）`);
    });

    S.setEnabled(false);
    const muted = await render(() => { S.card(); S.chips(1); S.pot(); }, 1.6);
    S.setEnabled(true);
    const unmuted = await render(() => S.chips(0.8));

    suite('静音开关真的能切断声音', () => {
      eq(muted.peak, 0, '静音后渲染出来的是全零波形');
      ok(unmuted.peak > 0.01, '重新开启后又有声音了');
    });

    suite('环境不支持音频时不会崩', () => {
      // 引擎和界面都不该依赖音效可用
      let threw = null;
      try {
        S.setEnabled(false);
        S.card(); S.chips(0.5); S.knock(); S.fold(); S.pot(); S.flip(); S.deal(6);
        S.setEnabled(true);
      } catch (e) { threw = e.message; }
      eq(threw, null, '静音状态下调用任何音效都不会抛异常');
    });

    // 还原玩家自己的静音选择，测试不该改掉用户偏好
    S.setEnabled(userPreference);
  };
})();
