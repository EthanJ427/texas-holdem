/*
 * 联机客户端
 *
 * 只管连线、收发消息、断线重连。不碰界面，也不做任何游戏判断 ——
 * 状态一律以服务器发来的为准，客户端不推导、不预测。
 *
 * 重连凭据存在 localStorage 里，刷新页面能拿回原座位和筹码。
 */
(function (root) {
  'use strict';

  const DEFAULT_URL = 'wss://holdem.ethan-poker.workers.dev/ws';
  const TOKEN_KEY = 'holdem_net_token_v1';

  class NetClient {
    constructor(options) {
      const opts = options || {};
      this.url = opts.url || DEFAULT_URL;
      this.room = (opts.room || 'DEFAULT').toUpperCase().replace(/[^A-Z0-9]/g, '') || 'DEFAULT';
      this.name = opts.name || '玩家';
      this.on = opts.on || {};

      this.ws = null;
      this.msgId = 1;
      this.you = null;
      this.config = null;
      this.clockOffset = 0;    // 服务器时间 - 本地时间
      this.closed = false;
      this.retryAt = 0;
      this.retryDelay = 800;
    }

    tokenKey() {
      return `${TOKEN_KEY}:${this.room}`;
    }

    loadToken() {
      try { return localStorage.getItem(this.tokenKey()) || null; } catch (e) { return null; }
    }

    saveToken(token) {
      try { localStorage.setItem(this.tokenKey(), token); } catch (e) {}
    }

    connect() {
      this.closed = false;
      const url = `${this.url}?room=${encodeURIComponent(this.room)}`;
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        this.emit('status', { state: 'error', message: '无法建立连接' });
        return;
      }
      this.ws = ws;
      this.emit('status', { state: 'connecting' });

      ws.onopen = () => {
        this.retryDelay = 800;
        this.emit('status', { state: 'open' });
        this.send('join', { room: this.room, name: this.name, token: this.loadToken() });
      };

      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) { return; }
        this.receive(msg);
      };

      ws.onclose = () => {
        this.ws = null;
        if (this.closed) return;
        this.emit('status', { state: 'reconnecting' });
        // 退避重连，最多等 8 秒一次
        setTimeout(() => this.connect(), this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 1.7, 8000);
      };

      ws.onerror = () => { /* onclose 会跟着触发，统一在那里处理 */ };
    }

    receive(msg) {
      switch (msg.t) {
        case 'welcome':
          this.you = msg.d.you;
          this.config = msg.d.config;
          this.clockOffset = msg.d.serverTime - Date.now();
          this.saveToken(msg.d.token);
          this.emit('welcome', msg.d);
          break;
        case 'state':
          this.emit('state', msg.d);
          break;
        case 'events':
          this.emit('events', msg.d.events || []);
          break;
        case 'turn':
          this.emit('turn', msg.d);
          break;
        case 'error':
          this.emit('serverError', msg.d);
          break;
        default:
          break;
      }
    }

    send(type, data) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
      this.ws.send(JSON.stringify({ t: type, id: this.msgId++, d: data || {} }));
      return true;
    }

    /** 行动必须带上手牌号和动作序号，服务器靠这两个挡住重复提交 */
    action(handNumber, actionSeq, type, amount) {
      return this.send('action', { handNumber, actionSeq, type, amount });
    }

    /** 把服务器给的截止时刻换算成本地时钟 */
    localDeadline(serverDeadline) {
      return serverDeadline - this.clockOffset;
    }

    disconnect() {
      this.closed = true;
      if (this.ws) {
        try { this.ws.close(); } catch (e) {}
        this.ws = null;
      }
    }

    emit(name, payload) {
      const fn = this.on[name];
      if (typeof fn === 'function') fn(payload);
    }
  }

  const api = { NetClient, DEFAULT_URL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PokerNet = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
