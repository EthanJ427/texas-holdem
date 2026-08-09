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
  const MASTER_GAIN = 0.7;

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
   * 在用户手势里调用，创建（或恢复）音频上下文。
   * 传入 injected 可以换成别的上下文 —— 测试用 OfflineAudioContext 离线渲染，
   * 这样不需要用户手势就能验证「到底有没有声音出来」。
   */
  function unlock(injected) {
    if (injected) {
      ctx = injected;
      offline = true;
      master = ctx.createGain();
      master.gain.value = MASTER_GAIN;
      master.connect(ctx.destination);
      noise = makeNoise(ctx);
      return true;
    }
    if (!ctx) {
      const AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return false;          // 环境不支持就安静运行
      try {
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = MASTER_GAIN;
        master.connect(ctx.destination);
        noise = makeNoise(ctx);
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

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(opts.peak, at + (opts.attack || 0.004));
    gain.gain.exponentialRampToValueAtTime(0.0001, at + opts.decay);

    // 从噪声缓冲的随机位置起播，避免每次听起来一模一样
    const offset = Math.random() * 0.8;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    src.start(at, offset, opts.decay + 0.05);
    src.stop(at + opts.decay + 0.05);
  }

  /** 一个带音高的短音，用来做筹码的金属感和敲桌子的闷响 */
  function tone(at, opts) {
    const osc = ctx.createOscillator();
    osc.type = opts.type || 'triangle';
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

  /** 发一张牌：牌面擦过桌布的短促「唰」 */
  function card(delay) {
    if (!ready()) return;
    const at = now() + (delay || 0);
    burst(at, {
      freq: 1800 + Math.random() * 900,
      q: 0.9, peak: 0.34, decay: 0.11, rate: 1.3 + Math.random() * 0.3,
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
   * 每颗筹码 = 一个高频短音 + 一点噪声，叠在一起就是「哗啦」。
   */
  function chips(weight) {
    if (!ready()) return;
    const w = Math.max(0, Math.min(weight === undefined ? 0.35 : weight, 1));
    const count = 2 + Math.round(w * 6);
    const base = now();

    for (let i = 0; i < count; i++) {
      const at = base + i * (0.014 + Math.random() * 0.022);
      tone(at, {
        type: 'triangle',
        from: 1700 + Math.random() * 1500,
        to: 700 + Math.random() * 300,
        peak: 0.07 + w * 0.06,
        decay: 0.07 + Math.random() * 0.04,
      });
      burst(at, {
        type: 'highpass', freq: 3200, q: 0.7,
        peak: 0.07 + w * 0.05, decay: 0.035, rate: 1.6,
      });
    }
  }

  /** 过牌：指节敲桌面的闷响 */
  function knock() {
    if (!ready()) return;
    const at = now();
    tone(at, { type: 'sine', from: 180, to: 70, peak: 0.3, decay: 0.13 });
    burst(at, { type: 'lowpass', freq: 700, q: 0.6, peak: 0.13, decay: 0.06, rate: 0.7 });
  }

  /** 弃牌：把两张牌推出去的轻擦声，比发牌更钝更长 */
  function fold() {
    if (!ready()) return;
    const at = now();
    burst(at, { freq: 1100, q: 0.7, peak: 0.16, decay: 0.2, rate: 0.75 });
    burst(at + 0.05, { freq: 900, q: 0.7, peak: 0.11, decay: 0.16, rate: 0.7 });
  }

  /** 收底池：一大把筹码被拨到面前 */
  function pot() {
    if (!ready()) return;
    const base = now();
    for (let i = 0; i < 14; i++) {
      const at = base + i * (0.022 + Math.random() * 0.03);
      tone(at, {
        type: 'triangle',
        from: 1500 + Math.random() * 1600,
        to: 600 + Math.random() * 400,
        peak: 0.045,
        decay: 0.08 + Math.random() * 0.05,
      });
    }
    burst(base, { type: 'bandpass', freq: 2600, q: 0.5, peak: 0.1, decay: 0.42, rate: 0.9 });
  }

  /** 翻开公共牌：比发牌更清脆一点 */
  function flip() {
    if (!ready()) return;
    burst(now(), { freq: 2600 + Math.random() * 800, q: 1.1, peak: 0.32, decay: 0.09, rate: 1.5 });
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
