// Stoch RSI Signals (1m) — Lógica completa
(function () {
  'use strict';

  // ===== Constantes e Estado =====
  const SYMBOLS = ["ADAUSDT", "XRPUSDT", "ETHUSDT", "BTCUSDT"];

  const RSI_PERIOD = 14;
  const STOCH_PERIOD = 14;
  const ATR_PERIOD = 14;
  const K_SMOOTH = 3;
  const D_SMOOTH = 3;
  const ANNOUNCE_MIN = 1;
  const ANNOUNCE_MAX = 25;
  const EXIT_SECOND = 0;

  const MAX_CLOSES = 500;
  const FEED_MAX_ITEMS = 100;
  const STORAGE_KEY = 'stoch_rsi_signals_web';

  const state = {
    closes: Object.fromEntries(SYMBOLS.map(s => [s, []])),
    lastPrice: Object.fromEntries(SYMBOLS.map(s => [s, null])),
    prevPrice: Object.fromEntries(SYMBOLS.map(s => [s, null])),
    pending: Object.fromEntries(SYMBOLS.map(s => [s, null])),
    entry: Object.fromEntries(SYMBOLS.map(s => [s, null])),
    stats: Object.fromEntries(SYMBOLS.map(s => [s, { total: 0, wins: 0 }])),
    ws: null,
    reconnectAttempts: 0,
    minuteStampAnnounced: null,
    minuteStampExited: null,
    dayKey: null,
    store: {},
  };

  // ===== Seletores =====
  const $ = sel => document.querySelector(sel);
  const connStatusEl = $('#connStatus');
  const signalsFeedEl = $('#signalsFeed');
  const resultsFeedEl = $('#resultsFeed');
  const clockEl = $('#clock');
  const sumTotalEl = $('#sum-total');
  const sumWinsEl = $('#sum-wins');
  const sumLossesEl = $('#sum-losses');
  const sumWinrateEl = $('#sum-winrate');
  const btnReconnect = $('#btnReconnect');
  const btnReset = $('#btnReset');

  // ===== Utils =====
  function nowHMS() {
    const d = new Date();
    const hh = d.getHours().toString().padStart(2, '0');
    const mm = d.getMinutes().toString().padStart(2, '0');
    const ss = d.getSeconds().toString().padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function trimFeed(ul, max = FEED_MAX_ITEMS) {
    if (!ul) return;
    while (ul.children.length > max) {
      ul.removeChild(ul.lastElementChild);
    }
  }

  function setStatus(text, cls) {
    if (!connStatusEl) return;
    connStatusEl.textContent = text;
    connStatusEl.classList.remove('ok', 'warn', 'err');
    if (cls) connStatusEl.classList.add(cls);
  }

  function updateTicker(symbol) {
    const price = state.lastPrice[symbol];
    if (price == null) return;
    const priceEl = document.getElementById(`price-${symbol}`);
    const arrowEl = document.getElementById(`arrow-${symbol}`);
    if (!priceEl || !arrowEl) return;

    const prev = state.prevPrice[symbol];
    let dir = 'flat';
    let arrow = '→';
    if (prev != null) {
      if (price > prev) { dir = 'up'; arrow = '↑'; }
      else if (price < prev) { dir = 'down'; arrow = '↓'; }
    }
    priceEl.textContent = Number(price).toFixed(6).replace(/\.?(0+)$/, '');
    priceEl.classList.remove('up', 'down', 'flat');
    priceEl.classList.add(dir);

    arrowEl.textContent = arrow;
    arrowEl.classList.remove('up', 'down', 'flat');
    arrowEl.classList.add(dir);
  }

  function prependSignalItem(symbol, side, price) {
    if (!signalsFeedEl) return;
    const li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = `
      <span class="time-badge">${nowHMS()}</span>
      <span class="text">🔔 <strong class="symbol">${symbol}</strong> <span class="${side === 'CALL' ? 'side-call' : 'side-put'}">${side}</span></span>
      <span class="price ${side === 'CALL' ? 'up' : 'down'}">${Number(price).toFixed(6).replace(/\.?(0+)$/, '')}</span>
    `;
    signalsFeedEl.insertBefore(li, signalsFeedEl.firstChild);
    trimFeed(signalsFeedEl);
  }

  function prependResultItem(symbol, result, entryPrice, exitPrice) {
    if (!resultsFeedEl) return;
    const li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = `
      <span class="time-badge">${nowHMS()}</span>
      <span class="text"><strong class="symbol">${symbol}</strong> <span class="result ${result === 'WIN' ? 'win' : 'loss'}">${result}</span></span>
      <span class="price">${Number(exitPrice).toFixed(6).replace(/\.?(0+)$/, '')}</span>
    `;
    resultsFeedEl.insertBefore(li, resultsFeedEl.firstChild);
    trimFeed(resultsFeedEl);
  }

  function updateStats(symbol) {
    const { total, wins } = state.stats[symbol];
    const winrate = total > 0 ? Math.round((wins / total) * 100) : 0;
    const totalEl = document.getElementById(`stat-total-${symbol}`);
    const winsEl = document.getElementById(`stat-wins-${symbol}`);
    const wrEl = document.getElementById(`stat-winrate-${symbol}`);
    if (totalEl) totalEl.textContent = String(total);
    if (winsEl) winsEl.textContent = String(wins);
    if (wrEl) wrEl.textContent = `${winrate}%`;
  }

  // ===== Clock & Summary =====
  function updateClock() {
    if (!clockEl) return;
    clockEl.textContent = nowHMS();
  }

  function ensureDay(store, key) {
    if (!store[key]) {
      store[key] = { signals: [], results: [], stats: { total: 0, wins: 0, losses: 0, winrate: 0 } };
    }
  }

  function getDayKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj : {};
    } catch (_) { return {}; }
  }

  function saveStore() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.store));
    } catch (_) { /* ignore */ }
  }

  function updateDailySummaryUI() {
    const stats = state.store[state.dayKey]?.stats;
    if (!stats) return;
    if (sumTotalEl) sumTotalEl.textContent = String(stats.total || 0);
    if (sumWinsEl) sumWinsEl.textContent = String(stats.wins || 0);
    if (sumLossesEl) sumLossesEl.textContent = String(stats.losses || 0);
    if (sumWinrateEl) sumWinrateEl.textContent = `${Number(stats.winrate || 0).toFixed(1)}%`;
  }

  function addSignalToStore(symbol, side, price) {
    ensureDay(state.store, state.dayKey);
    const rec = { time: nowHMS(), symbol, side, price };
    state.store[state.dayKey].signals.unshift(rec);
    // manter tamanho razoável
    if (state.store[state.dayKey].signals.length > 1000) state.store[state.dayKey].signals.length = 1000;
    saveStore();
  }

  function addResultToStore(symbol, result) {
    ensureDay(state.store, state.dayKey);
    const rec = { time: nowHMS(), symbol, result };
    state.store[state.dayKey].results.unshift(rec);
    const stats = state.store[state.dayKey].stats;
    stats.total = (stats.total || 0) + 1;
    if (result === 'WIN') stats.wins = (stats.wins || 0) + 1;
    stats.losses = Math.max(0, stats.total - stats.wins);
    stats.winrate = stats.total > 0 ? (stats.wins / stats.total) * 100 : 0;
    saveStore();
    updateDailySummaryUI();
  }

  function loadDayToUI() {
    const day = state.store[state.dayKey];
    if (!day) return;
    // Limpar feeds visuais e repopular com o dia atual
    if (signalsFeedEl) signalsFeedEl.innerHTML = '';
    if (resultsFeedEl) resultsFeedEl.innerHTML = '';
    // Popular sinais (mais antigos no fim, mostramos do mais recente para cima)
    for (const s of day.signals.slice().reverse()) {
      const li = document.createElement('li');
      li.className = 'item';
      const sideClass = s.side === 'CALL' ? 'side-call' : 'side-put';
      const priceDir = s.side === 'CALL' ? 'up' : 'down';
      li.innerHTML = `
        <span class="time-badge">${s.time}</span>
        <span class="text">🔔 <strong class="symbol">${s.symbol}</strong> <span class="${sideClass}">${s.side}</span></span>
        <span class="price ${priceDir}">${Number(s.price).toFixed(6).replace(/\.?(0+)$/, '')}</span>
      `;
      signalsFeedEl && signalsFeedEl.appendChild(li);
    }
    // Popular resultados
    for (const r of day.results.slice().reverse()) {
      const li = document.createElement('li');
      li.className = 'item';
      li.innerHTML = `
        <span class="time-badge">${r.time}</span>
        <span class="text"><strong class="symbol">${r.symbol}</strong> <span class="result ${r.result === 'WIN' ? 'win' : 'loss'}">${r.result}</span></span>
        <span class="price">—</span>
      `;
      resultsFeedEl && resultsFeedEl.appendChild(li);
    }
    updateDailySummaryUI();
  }

  function newDaySession() {
    state.dayKey = getDayKey();
    ensureDay(state.store, state.dayKey);
    loadDayToUI();
  }

  // ===== Beeps =====
  function beep(freq = 800, ms = 200) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.value = 0.05;
      o.start();
      setTimeout(() => { o.stop(); ctx.close(); }, ms);
    } catch (_) {
      // silencioso
    }
  }

  // ===== Indicadores =====
  function rsi(series, length = RSI_PERIOD) {
    if (!series || series.length < length + 1) return null;
    const diffs = [];
    for (let i = 1; i < series.length; i++) {
      diffs.push(series[i] - series[i - 1]);
    }
    const rsiSeries = [];
    for (let i = length - 1; i < diffs.length; i++) {
      let gains = 0, losses = 0;
      for (let j = i - (length - 1); j <= i; j++) {
        const d = diffs[j];
        if (d > 0) gains += d; else losses += (-d);
      }
      const avgGain = gains / length;
      const avgLoss = losses / length;
      const rs = avgLoss === 0 ? 0 : (avgGain / avgLoss);
      const val = avgLoss === 0 ? 100 : (100 - 100 / (1 + rs));
      rsiSeries.push(val);
    }
    return rsiSeries; // última é o RSI atual
  }

  function simpleSMA(arr, len) {
    if (!arr || arr.length < len) return null;
    let sum = 0;
    for (let i = arr.length - len; i < arr.length; i++) sum += arr[i];
    return sum / len;
  }

  function stochRsi(series, rsiLen = RSI_PERIOD, stochLen = STOCH_PERIOD, k = K_SMOOTH, d = D_SMOOTH) {
    const rsiSeries = rsi(series, rsiLen);
    if (!rsiSeries || rsiSeries.length < stochLen) return null;
    // janela dos últimos stochLen valores de RSI
    const recent = rsiSeries.slice(-stochLen);
    const minRSI = Math.min(...recent);
    const maxRSI = Math.max(...recent);
    if (maxRSI === minRSI) return { stoch: 0, K: 0, D: 0 };
    const stoch = 100 * ((rsiSeries[rsiSeries.length - 1] - minRSI) / (maxRSI - minRSI));

    // K e D como SMAs
    // Para K, precisamos de stochLen valores; aqui usamos uma série fake de stoch rolando
    const stochSeries = [];
    for (let i = stochLen; i <= rsiSeries.length; i++) {
      const win = rsiSeries.slice(i - stochLen, i);
      const mn = Math.min(...win), mx = Math.max(...win);
      const s = mx === mn ? 0 : 100 * ((win[win.length - 1] - mn) / (mx - mn));
      stochSeries.push(s);
    }
    const K = simpleSMA(stochSeries, Math.min(k, stochSeries.length)) ?? stoch;
    const kSeriesForD = stochSeries.slice(-Math.max(d, 1));
    const D = simpleSMA(kSeriesForD, Math.min(d, kSeriesForD.length)) ?? K;
    return { stoch, K, D };
  }

  function atr(series, period = ATR_PERIOD) {
    if (!series || series.length < period + 1) return null;
    const diffs = [];
    for (let i = 1; i < series.length; i++) diffs.push(Math.abs(series[i] - series[i - 1]));
    const recent = diffs.slice(-period);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    return avg;
  }

  // ===== Dados: Preload =====
  async function preloadAll() {
    const base = 'https://api.binance.com/api/v3/klines';
    // Observação: remover o ponto ao final de limit=100 (Binance rejeita ponto)
    // ex.: ...limit=100
    const tasks = SYMBOLS.map(async (sym) => {
      const url = `${base}?symbol=${sym}&interval=1m&limit=100`;
      try {
        const res = await fetch(url);
        const data = await res.json();
        if (!Array.isArray(data)) return;
        const closes = data.map(k => Number(k[4])).filter(n => Number.isFinite(n));
        state.closes[sym] = closes.slice(-MAX_CLOSES);
        const last = closes[closes.length - 1];
        state.lastPrice[sym] = last;
        state.prevPrice[sym] = last;
      } catch (_) {
        // falha silenciosa
      }
    });
    await Promise.all(tasks);
  }

  // ===== WebSocket =====
  function wsUrl() {
    return 'wss://stream.binance.com:9443/stream?streams=' +
      'adausdt@kline_1m/xrpusdt@kline_1m/ethusdt@kline_1m/btcusdt@kline_1m';
  }

  function openWS() {
    try {
      if (state.ws) {
        try { state.ws.close(); } catch (_) {}
        state.ws = null;
      }
      const ws = new WebSocket(wsUrl());
      state.ws = ws;
      ws.onopen = () => {
        state.reconnectAttempts = 0;
        setStatus('Conectado', 'ok');
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          const k = msg?.data?.k;
          if (!k) return;
          const symbol = (k.s || '').toUpperCase();
          if (!SYMBOLS.includes(symbol)) return;
          const closePrice = Number(k.c);
          if (Number.isFinite(closePrice)) {
            state.prevPrice[symbol] = state.lastPrice[symbol] ?? closePrice;
            state.lastPrice[symbol] = closePrice;
            updateTicker(symbol);
          }
          if (k.x === true) {
            // candle fechado: empurrar close
            const arr = state.closes[symbol];
            arr.push(closePrice);
            if (arr.length > MAX_CLOSES) arr.splice(0, arr.length - MAX_CLOSES);
          }
        } catch (_) { /* silencioso */ }
      };
      ws.onclose = () => {
        setStatus('Reconectando...', 'warn');
        scheduleReconnect();
      };
      ws.onerror = () => {
        setStatus('Reconectando...', 'warn');
        try { ws.close(); } catch (_) {}
      };
    } catch (_) {
      setStatus('Erro de conexão', 'err');
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    state.reconnectAttempts = Math.min(state.reconnectAttempts + 1, 5);
    const backoff = [1000, 2000, 5000, 8000, 12000][state.reconnectAttempts - 1] || 15000;
    setTimeout(openWS, backoff);
  }

  // ===== Lógica de Sinais =====
  function announceSignals() {
    const workingTime = Date.now();
    for (const symbol of SYMBOLS) {
      if (state.entry[symbol]) continue; // já há trade aberto
      if (state.pending[symbol]) continue; // já há sinal pendente
      const closes = state.closes[symbol];
      if (!closes || closes.length < (RSI_PERIOD + STOCH_PERIOD)) continue;
      const working = closes.slice();
      const lp = state.lastPrice[symbol];
      if (!Number.isFinite(lp)) continue;
      working.push(lp);

      // Filtro ATR
      const atrVal = atr(working, ATR_PERIOD);
      const diffs = [];
      for (let i = Math.max(1, working.length - Math.max(ATR_PERIOD, 20)); i < working.length; i++) {
        diffs.push(Math.abs(working[i] - working[i - 1]));
      }
      const baseline = diffs.length ? (diffs.reduce((a, b) => a + b, 0) / diffs.length) : null;
      if (atrVal == null || baseline == null || atrVal < 0.20 * baseline) continue;

      const sd = stochRsi(working, RSI_PERIOD, STOCH_PERIOD, K_SMOOTH, D_SMOOTH);
      if (!sd) continue;
      let side = null;
      if (sd.K >= 98 && sd.D >= 98) side = 'PUT';
      else if (sd.K <= 2 && sd.D <= 2) side = 'CALL';
      if (!side) continue;

      state.pending[symbol] = { side, price: lp, ts: workingTime };
      beep(1000, 200);
      prependSignalItem(symbol, side, lp);
      addSignalToStore(symbol, side, lp);
    }
  }

  function enterTrades() {
    for (const symbol of SYMBOLS) {
      const pend = state.pending[symbol];
      if (!pend) continue;
      const lp = state.lastPrice[symbol];
      state.entry[symbol] = { side: pend.side, entryPrice: lp, ts: Date.now() };
      state.pending[symbol] = null;
      // opcional: refletir entrada no feed de sinais já criada
    }
  }

  function exitAndScore() {
    for (const symbol of SYMBOLS) {
      const ent = state.entry[symbol];
      if (!ent) continue;
      const exit = state.lastPrice[symbol];
      const side = ent.side;
      let result = 'LOSS';
      if (side === 'CALL' && exit > ent.entryPrice) result = 'WIN';
      else if (side === 'PUT' && exit < ent.entryPrice) result = 'WIN';

      state.stats[symbol].total += 1;
      if (result === 'WIN') state.stats[symbol].wins += 1;
      updateStats(symbol);

      beep(result === 'WIN' ? 800 : 400, 400);
      prependResultItem(symbol, result, ent.entryPrice, exit);
      addResultToStore(symbol, result);

      state.entry[symbol] = null;
    }
  }

  // ===== Temporização =====
  function startScheduler() {
    setInterval(() => {
      const d = new Date();
      const seconds = d.getSeconds();
      const minuteStamp = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;

      // Atualiza relógio a cada tick do scheduler
      updateClock();

      // Verifica virada de dia
      const keyNow = getDayKey(d);
      if (state.dayKey !== keyNow) {
        newDaySession();
      }

      if (seconds >= ANNOUNCE_MIN && seconds <= ANNOUNCE_MAX) {
        // Para evitar múltiplas execuções redundantes, não bloqueamos aqui
        announceSignals();
        enterTrades();
      }

      if (seconds === EXIT_SECOND) {
        if (state.minuteStampExited !== minuteStamp) {
          state.minuteStampExited = minuteStamp;
          exitAndScore();
        }
      }
    }, 100);

    // Atualização do ticker a cada 1s
    setInterval(() => {
      for (const s of SYMBOLS) updateTicker(s);
    }, 1000);
  }

  // ===== Inicialização =====
  async function init() {
    setStatus('Carregando...', 'warn');
    state.store = loadStore();
    newDaySession();
    await preloadAll();
    for (const s of SYMBOLS) updateTicker(s);
    openWS();
    startScheduler();

    // Botões topo
    if (btnReconnect) {
      btnReconnect.addEventListener('click', () => {
        setStatus('Reconectando...', 'warn');
        openWS();
        // mostrar mensagem rápida
        setStatus('Reconectado com sucesso', 'ok');
        setTimeout(() => setStatus('Conectado', 'ok'), 2000);
      });
    }
    if (btnReset) {
      btnReset.addEventListener('click', () => {
        ensureDay(state.store, state.dayKey);
        state.store[state.dayKey] = { signals: [], results: [], stats: { total: 0, wins: 0, losses: 0, winrate: 0 } };
        saveStore();
        loadDayToUI();
      });
    }
  }

  // Boot
  init();
})();