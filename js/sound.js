/*
 * 音效
 *
 * 全部用 Web Audio 现场合成，不加载任何音频文件 —— 这样仓库里没有二进制资源，
 * 离线也照样响，也不用担心 GitHub Pages 上的加载顺序。
 *
 * 浏览器要求音频必须由用户手势触发，所以 AudioContext 是懒创建的：
 * 第一次点「坐下开打」时才 unlock()。
 */
(function (root) {
  'use strict';

  const STORAGE_KEY = 'holdem_sound_v1';

  // 总音量。牌桌音效大多是短促的瞬态，滤波之后实际峰值只有目标值的三分之一左右，
  // 所以这里要留够增益，否则听起来跟没开一样。
  const MASTER_GAIN = 0.5;

  let ctx = null;
  let master = null;
  let noise = null;
  let enabled = true;
  let offline = false;   // 测试注入的离线上下文

  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved !== null) enabled = saved === '1';
  } catch (e) { /* 读不到就用默认值 */ }

  /** 一秒钟的白噪声，发牌和筹码的「沙沙」「咔哒」都从这里取材 */
  function makeNoise(context) {
    const length = Math.floor(context.sampleRate * 1);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /**
   * 主输出链：master → 低通 → 输出。
   * 那条低通是刻意加的：不砍掉最高的那截，噪声听起来就是「呲呲」的齿音。
   * 但也不能砍太狠 —— 压到 2.4kHz 时整体又闷得像在敲门，3.4kHz 是折中。
   */
  function buildGraph(context) {
    master = context.createGain();
    master.gain.value = MASTER_GAIN;

    const tame = context.createBiquadFilter();
    tame.type = 'lowpass';
    tame.frequency.value = 3400;
    tame.Q.value = 0.5;

    master.connect(tame);
    tame.connect(context.destination);
    noise = makeNoise(context);
  }

  /**
   * 在用户手势里调用，创建（或恢复）音频上下文。
   * 传入 injected 可以换成别的上下文 —— 测试用 OfflineAudioContext 离线渲染，
   * 这样不需要用户手势就能验证「到底有没有声音出来」。
   */
  function unlock(injected) {
    if (injected) {
      ctx = injected;
      offline = true;
      buildGraph(ctx);
      return true;
    }
    if (!ctx) {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return false;          // 环境不支持就安静运行
      try {
        ctx = new AC();
        buildGraph(ctx);
      } catch (e) {
        ctx = null;
        return false;
      }
    }
    // 离线上下文由 startRendering 驱动，不能手动 resume
    if (!offline && ctx.state === 'suspended') ctx.resume();
    return true;
  }

  // 实时上下文必须已经 running：挂起时排进去的声音会在恢复那一刻一起炸出来。
  // 离线上下文在 startRendering 之前一直是 suspended，属于正常状态。
  const ready = () => enabled && ctx && (offline || ctx.state === 'running');
  const now = () => ctx.currentTime;

  /** 一段带包络的噪声，用来做摩擦、滑动这类声音 */
  function burst(at, opts) {
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.playbackRate.value = opts.rate || 1;

    const filter = ctx.createBiquadFilter();
    filter.type = opts.type || 'bandpass';
    filter.frequency.value = opts.freq;
    filter.Q.value = opts.q || 1;

    // 第二级低通。单个 biquad 只有 12dB/oct，滚降太缓，
    // 高频漏出来就是「呲呲」的齿音；级联一级变成 24dB/oct 才压得住。
    const polish = ctx.createBiquadFilter();
    polish.type = 'lowpass';
    polish.frequency.value = Math.min(opts.freq * 1.6, 3400);
    polish.Q.value = 0.5;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(opts.peak, at + (opts.attack || 0.004));
    gain.gain.exponentialRampToValueAtTime(0.0001, at + opts.decay);

    // 从噪声缓冲的随机位置起播，避免每次听起来一模一样
    const offset = Math.random() * 0.8;
    src.connect(filter);
    filter.connect(polish);
    polish.connect(gain);
    gain.connect(master);
    src.start(at, offset, opts.decay + 0.05);
    src.stop(at + opts.decay + 0.05);
  }

  /** 一个带音高的短音，用来做筹码碰撞和敲桌子 */
  function tone(at, opts) {
    const osc = ctx.createOscillator();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(opts.from, at);
    if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, at + opts.decay);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(opts.peak, at + (opts.attack || 0.003));
    gain.gain.exponentialRampToValueAtTime(0.0001, at + opts.decay);

    osc.connect(gain);
    gain.connect(master);
    osc.start(at);
    osc.stop(at + opts.decay + 0.02);
  }

  // ---------- 具体音效 ----------

  /**
   * 发一张牌：牌面擦过桌布的一声轻响。
   * 用低通而不是带通，避免在齿音区留下尖峰；但截止频率不能压太低，
   * 否则就成了闷闷的「咚」。之前还叠了一记 200Hz 的落桌声，
   * 那正是「像敲门」的元凶，已经去掉。
   */
  function card(delay) {
    if (!ready()) return;
    const at = now() + (delay || 0);
    // 擦过桌面
    burst(at, {
      type: 'lowpass', freq: 1500 + Math.random() * 350, q: 0.4,
      peak: 0.34, decay: 0.085, attack: 0.006, rate: 0.9 + Math.random() * 0.25,
    });
  }

  /** 一叠牌依次发出去，用于每手开局 */
  function deal(count) {
    if (!ready()) return;
    const n = Math.max(1, Math.min(count || 6, 12));
    for (let i = 0; i < n; i++) card(i * 0.075);
  }

  /**
   * 筹码推进底池。weight 0~1，越大扔得越多、越响。
   * 每颗筹码 = 一个短音 + 一点低通噪声，叠在一起就是「嗒嗒嗒」。
   */
  function chips(weight) {
    if (!ready()) return;
    const w = Math.max(0, Math.min(weight === undefined ? 0.35 : weight, 1));
    const count = 2 + Math.round(w * 6);
    const base = now();

    for (let i = 0; i < count; i++) {
      const at = base + i * (0.016 + Math.random() * 0.024);
      // 筹码是清脆短促的「嗒」：基频不低、衰减极快、没有余韵
      tone(at, {
        type: 'sine',
        from: 900 + Math.random() * 400,
        to: 430 + Math.random() * 120,
        peak: 0.1 + w * 0.06,
        decay: 0.03 + Math.random() * 0.015,
      });
      // 一点点低通噪声做碰撞的颗粒感，别让它变成纯音
      burst(at, {
        type: 'lowpass', freq: 1900, q: 0.4,
        peak: 0.08 + w * 0.05, decay: 0.018, attack: 0.001, rate: 1.1,
      });
    }
  }

  /** 过牌：指节敲桌面，要短要轻，不然真成砸门了 */
  function knock() {
    if (!ready()) return;
    const at = now();
    // 指节声的主体是那一下瞬态，不是低频余韵。
    // 之前正弦占了绝大部分能量，听起来就成了砸门。
    tone(at, { type: 'sine', from: 320, to: 170, peak: 0.075, decay: 0.05 });
    burst(at, { type: 'lowpass', freq: 2100, q: 0.5, peak: 0.2, decay: 0.028, rate: 1.2 });
  }

  /** 弃牌：把两张牌推出去的轻擦声，比发牌更钝更长 */
  function fold() {
    if (!ready()) return;
    const at = now();
    burst(at, {
      type: 'lowpass', freq: 1250, q: 0.4,
      peak: 0.26, decay: 0.17, attack: 0.012, rate: 0.7,
    });
    burst(at + 0.06, {
      type: 'lowpass', freq: 1050, q: 0.4,
      peak: 0.18, decay: 0.14, attack: 0.012, rate: 0.65,
    });
  }

  /** 收底池：一大把筹码被拨到面前 */
  function pot() {
    if (!ready()) return;
    const base = now();
    for (let i = 0; i < 14; i++) {
      const at = base + i * (0.024 + Math.random() * 0.032);
      tone(at, {
        type: 'sine',
        from: 820 + Math.random() * 420,
        to: 400 + Math.random() * 140,
        peak: 0.075,
        decay: 0.032 + Math.random() * 0.018,
      });
    }
    // 筹码被推过桌布的底噪
    burst(base, {
      type: 'lowpass', freq: 1400, q: 0.4,
      peak: 0.12, decay: 0.38, attack: 0.02, rate: 0.8,
    });
  }

  /** 翻开公共牌：牌拍到桌面上，比发牌更短促干脆 */
  function flip() {
    if (!ready()) return;
    const at = now();
    burst(at, {
      type: 'lowpass', freq: 1800 + Math.random() * 300, q: 0.5,
      peak: 0.36, decay: 0.055, attack: 0.002, rate: 1.15,
    });
    tone(at, { type: 'sine', from: 520, to: 260, peak: 0.09, decay: 0.035 });
  }

  // ---------- 开关 ----------

  function setEnabled(value) {
    enabled = !!value;
    try { localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0'); } catch (e) {}
    if (enabled) unlock();
  }

  const api = {
    unlock, setEnabled,
    isEnabled: () => enabled,
    card, deal, chips, knock, fold, pot, flip,
    // 给测试用：能拿到节点才能真正测出「有没有声音出来」
    _nodes: () => ({ ctx, master }),
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PokerSound = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
