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

  // ===== Suporte/Resistência (SR) =====
  const SR_LOOKBACK = 300;
  const SR_MIN_TOUCHES = 4;
  const SR_BIN_SIZE_ATR = 0.35;
  const SR_PROX_ATR = 0.18;
  const COOLDOWN_BARS = 1;

  // ===== Modo de Operação (compatibilidade) =====
  const MODE = 'AUTO';

  const state = {
    closes: Object.fromEntries(SYMBOLS.map(s => [s, []])),
    highs: Object.fromEntries(SYMBOLS.map(s => [s, []])),
    lows:  Object.fromEntries(SYMBOLS.map(s => [s, []])),
    sr:    Object.fromEntries(SYMBOLS.map(s => [s, { top: null, bottom: null, atr: null, updated: 0 }])),
    modes: Object.fromEntries(SYMBOLS.map(s => [s, 'REVERSAO'])),
    cooldownUntil: Object.fromEntries(SYMBOLS.map(s => [s, 0])),
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
  // const btnModeEl = $('#btnMode'); // removido: painel 100% automático

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

  // Removido toggleMode: operação 100% automática por símbolo

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
  // Exibir métricas em tempo real nos cards do ticker
  function formatMetrics(symbol) {
    const closes = state.closes[symbol];
    if (!closes || closes.length < (RSI_PERIOD + STOCH_PERIOD)) return null;
    const working = closes.slice();
    const lp = state.lastPrice[symbol];
    if (Number.isFinite(lp)) working.push(lp);

    const rsiVal = rsi(working, RSI_PERIOD);
    const sd = stochRsi(working, RSI_PERIOD, STOCH_PERIOD, K_SMOOTH, D_SMOOTH);
    const atrVal = atr(working, ATR_PERIOD);

    const lastRsi = rsiVal ? Number(rsiVal[rsiVal.length - 1]).toFixed(1) : '—';
    const kVal = sd ? Number(sd.K).toFixed(1) : '—';
    const dVal = sd ? Number(sd.D).toFixed(1) : '—';
    const atrFmt = atrVal ? atrVal.toFixed(5) : '—';

    return `RSI:${lastRsi} | K:${kVal} | D:${dVal} | ATR:${atrFmt}`;
  }

  function updateMetrics(symbol) {
    const closes = state.closes[symbol];
    if (!closes || closes.length < (RSI_PERIOD + STOCH_PERIOD)) return;
    const working = closes.slice();
    const lp = state.lastPrice[symbol];
    if (Number.isFinite(lp)) working.push(lp);

    const rsiVal = rsi(working, RSI_PERIOD);
    const sd = stochRsi(working, RSI_PERIOD, STOCH_PERIOD, K_SMOOTH, D_SMOOTH);
    const atrVal = atr(working, ATR_PERIOD);

    const lastRsiNum = rsiVal ? Number(rsiVal[rsiVal.length - 1]) : null;
    const kNum = sd ? Number(sd.K) : null;
    const dVal = sd ? Number(sd.D).toFixed(1) : '—';
    const lastRsi = lastRsiNum != null ? lastRsiNum.toFixed(1) : '—';
    const kVal = kNum != null ? kNum.toFixed(1) : '—';
    const atrFmt = atrVal ? atrVal.toFixed(5) : '—';

    const el = document.getElementById(`metrics-${symbol}`);
    if (el) {
      const color = (lastRsiNum != null && lastRsiNum >= 70) || (kNum != null && kNum >= 90)
        ? '#f66'
        : (lastRsiNum != null && lastRsiNum <= 30) || (kNum != null && kNum <= 10)
        ? '#4f8'
        : '#bbb';
      el.innerHTML = `<span style="color:${color}">RSI:${lastRsi}</span> | K:${kVal} | D:${dVal} | ATR:${atrFmt}`;
    }
  }

  function prependSignalItem(symbol, side, price) {
    if (!signalsFeedEl) return;
    const metrics = formatMetrics(symbol);
    const li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = `
      <span class="time-badge">${nowHMS()}</span>
      <span class="text">🔔 <strong class="symbol">${symbol}</strong> 
        <span class="${side === 'CALL' ? 'side-call' : 'side-put'}">${side}</span>
      </span>
      <span class="price ${side === 'CALL' ? 'up' : 'down'}">${Number(price).toFixed(6)}</span>
      <div class="metrics-inline">${metrics ?? ''}</div>
    `;
    signalsFeedEl.insertBefore(li, signalsFeedEl.firstChild);
    trimFeed(signalsFeedEl);
  }

  function prependResultItem(symbol, result, side, entryPrice, exitPrice) {
    if (!resultsFeedEl) return;
    const metrics = formatMetrics(symbol);
    const li = document.createElement('li');
    li.className = 'item';
    const priceClass = result === 'WIN' ? 'win' : 'loss';
    const entryFmt = Number(entryPrice).toFixed(4);
    const exitFmt = Number(exitPrice).toFixed(4);
    li.innerHTML = `
      <span class="time-badge">${nowHMS()}</span>
      <span class="text">
        <strong class="symbol">${symbol}</strong>
        <span class="side-badge ${side === 'CALL' ? 'side-call' : 'side-put'}">${side}</span>
        <span class="result ${result === 'WIN' ? 'win' : 'loss'}">${result}</span>
      </span>
      <span class="price ${priceClass}">${entryFmt} → ${exitFmt}</span>
      <div class="metrics-inline">${metrics ?? ''}</div>
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
    const total = Number(stats.total || 0);
    const wins = Number(stats.wins || 0);
    const losses = Number(stats.losses || 0);
    const winrate = Number(stats.winrate || 0);
    if (sumTotalEl) sumTotalEl.textContent = String(total);
    if (sumWinsEl) sumWinsEl.textContent = String(wins);
    if (sumLossesEl) sumLossesEl.textContent = String(losses);
    if (sumWinrateEl) sumWinrateEl.textContent = `${winrate.toFixed(1)}%`;
  }

  function addSignalToStore(symbol, side, price) {
    ensureDay(state.store, state.dayKey);
    const rec = { time: nowHMS(), symbol, side, price, metrics: formatMetrics(symbol) };
    state.store[state.dayKey].signals.unshift(rec);
    // manter tamanho razoável
    if (state.store[state.dayKey].signals.length > 1000) state.store[state.dayKey].signals.length = 1000;
    saveStore();
  }

  function addResultToStore(symbol, result, side, entryPrice, exitPrice) {
    ensureDay(state.store, state.dayKey);
    const day = state.store[state.dayKey];
    const rec = { time: nowHMS(), symbol, side, result, entryPrice, exitPrice, metrics: formatMetrics(symbol) };
    day.results.unshift(rec);
    // Estatísticas diárias (incremental)
    day.stats.total = (day.stats.total || 0) + 1;
    day.stats.wins = (day.stats.wins || 0) + (result === 'WIN' ? 1 : 0);
    day.stats.losses = Math.max(0, day.stats.total - day.stats.wins);
    day.stats.winrate = day.stats.total > 0 ? parseFloat(((day.stats.wins / day.stats.total) * 100).toFixed(1)) : 0;
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
      const metricsInline = s.metrics ?? formatMetrics(s.symbol) ?? '';
      li.innerHTML = `
        <span class="time-badge">${s.time}</span>
        <span class="text">🔔 <strong class="symbol">${s.symbol}</strong> <span class="${sideClass}">${s.side}</span></span>
        <span class="price ${priceDir}">${Number(s.price).toFixed(6)}</span>
        <div class="metrics-inline">${metricsInline}</div>
      `;
      signalsFeedEl && signalsFeedEl.appendChild(li);
    }
    // Popular resultados
    for (const r of day.results.slice().reverse()) {
      const li = document.createElement('li');
      li.className = 'item';
      const entryFmt = Number(r.entryPrice).toFixed(4);
      const exitFmt = Number(r.exitPrice).toFixed(4);
      const priceClass = r.result === 'WIN' ? 'win' : 'loss';
      const metricsInline = r.metrics ?? formatMetrics(r.symbol) ?? '';
      li.innerHTML = `
        <span class="time-badge">${r.time}</span>
        <span class="text">
          <strong class="symbol">${r.symbol}</strong>
          <span class="side-badge ${r.side === 'CALL' ? 'side-call' : 'side-put'}">${r.side}</span>
          <span class="result ${r.result === 'WIN' ? 'win' : 'loss'}">${r.result}</span>
        </span>
        <span class="price ${priceClass}">${entryFmt} → ${exitFmt}</span>
        <div class="metrics-inline">${metricsInline}</div>
      `;
      resultsFeedEl && resultsFeedEl.appendChild(li);
    }
    // --- Recalcular estatísticas por símbolo a partir do histórico do dia ---
    // zera estatísticas em memória
    for (const s of SYMBOLS) state.stats[s] = { total: 0, wins: 0 };

    // varre os resultados salvos e acumula por símbolo
    for (const r of day.results) {
      if (!SYMBOLS.includes(r.symbol)) continue;
      state.stats[r.symbol].total += 1;
      if (r.result === 'WIN') state.stats[r.symbol].wins += 1;
    }

    // atualiza os cards de stats na UI
    for (const s of SYMBOLS) updateStats(s);
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

  // ===== Suporte/Resistência: Helpers =====
  function buildBins(minP, maxP, step) {
    const bins = [];
    for (let p = minP; p <= maxP + step * 0.5; p += step) bins.push({ c: 0, p });
    return bins;
  }
  function bumpClosestBin(bins, price, step) {
    if (!Number.isFinite(price)) return;
    let best = 0, bi = 0;
    for (let i = 0; i < bins.length; i++) {
      const d = Math.abs(bins[i].p - price);
      if (i === 0 || d < best) { best = d; bi = i; }
    }
    const weight = Math.max(0.2, 1 - (best / step));
    bins[bi].c += weight;
  }
  function computeSRLevels(symbol) {
    const closes = state.closes[symbol];
    const highs  = state.highs[symbol];
    const lows   = state.lows[symbol];
    if (!closes || closes.length < Math.min(SR_LOOKBACK, 50)) return null;
    // Proteção: requer highs e lows disponíveis
    if (!highs || !highs.length || !lows || !lows.length) return null;
    const n = Math.min(SR_LOOKBACK, closes.length);
    const c = closes.slice(-n), h = highs.slice(-n), l = lows.slice(-n);
    const atrVal = atr(c, Math.min(ATR_PERIOD, Math.floor(n * 0.4))) ?? 0;
    if (!Number.isFinite(atrVal) || atrVal <= 0) return null;
    const minP = Math.min(...l), maxP = Math.max(...h);
    const step = Math.max(atrVal * SR_BIN_SIZE_ATR, (maxP - minP) / 200);
    const topBins = buildBins(minP, maxP, step);
    const botBins = buildBins(minP, maxP, step);
    for (let i = 0; i < h.length; i++) bumpClosestBin(topBins, h[i], step);
    for (let i = 0; i < l.length; i++) bumpClosestBin(botBins, l[i], step);
    if (!topBins.length || !botBins.length) return { top: null, bottom: null, atr: atrVal };
    const topBest = topBins.reduce((a, b) => (b.c > a.c ? b : a), topBins[0]);
    const botBest = botBins.reduce((a, b) => (b.c > a.c ? b : a), botBins[0]);
    if (topBest.c < SR_MIN_TOUCHES || botBest.c < SR_MIN_TOUCHES) return { top: null, bottom: null, atr: atrVal };
    return { top: topBest.p, bottom: botBest.p, atr: atrVal };
  }

  // Atualiza UI com níveis SR por símbolo
  function updateSRUI(symbol) {
    const topEl = document.getElementById(`sr-top-${symbol}`);
    const botEl = document.getElementById(`sr-bot-${symbol}`);

    const highs = state.highs[symbol];
    const lows = state.lows[symbol];
    if (!highs || !highs.length || !lows || !lows.length) {
      if (topEl) topEl.textContent = '—';
      if (botEl) botEl.textContent = '—';
      return;
    }

    const levels = computeSRLevels(symbol);
    const topFmt = levels && levels.top != null ? Number(levels.top).toFixed(6).replace(/\.?(0+)$/, '') : '—';
    const botFmt = levels && levels.bottom != null ? Number(levels.bottom).toFixed(6).replace(/\.?(0+)$/, '') : '—';

    if (state.sr && state.sr[symbol]) {
      state.sr[symbol].top = levels ? levels.top : null;
      state.sr[symbol].bottom = levels ? levels.bottom : null;
      state.sr[symbol].atr = levels ? levels.atr : null;
      state.sr[symbol].updated = (state.sr[symbol].updated || 0) + 1;
    }

    if (topEl) topEl.textContent = topFmt;
    if (botEl) botEl.textContent = botFmt;
  }

  // ===== Dados: Preload =====
  async function preloadAll() {
    const base = 'https://api.binance.com/api/v3/klines';
    const tasks = SYMBOLS.map(async (sym) => {
      const url = `${base}?symbol=${sym}&interval=1m&limit=${SR_LOOKBACK}`;
      try {
        const res = await fetch(url);
        const data = await res.json();
        if (!Array.isArray(data)) return;
        const closes = [], highs = [], lows = [];
        for (const k of data) {
          closes.push(Number(k[4]));
          highs.push(Number(k[2]));
          lows.push(Number(k[3]));
        }
        state.closes[sym] = closes.slice(-MAX_CLOSES);
        state.highs[sym]  = highs.slice(-MAX_CLOSES);
        state.lows[sym]   = lows.slice(-MAX_CLOSES);
        const last = closes.at(-1);
        state.prevPrice[sym] = last;
        state.lastPrice[sym] = last;
        const sr = computeSRLevels(sym);
        if (sr) { state.sr[sym] = { ...sr, updated: Date.now() }; updateSRUI(sym); }
      } catch (_) {}
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
            // candle fechado: empurrar H/L/C e recalcular SR
            const highPrice  = Number(k.h);
            const lowPrice   = Number(k.l);
            const cArr = state.closes[symbol];
            const hArr = state.highs[symbol];
            const lArr = state.lows[symbol];
            cArr.push(closePrice);
            hArr.push(highPrice);
            lArr.push(lowPrice);
            if (cArr.length > MAX_CLOSES) cArr.splice(0, cArr.length - MAX_CLOSES);
            if (hArr.length > MAX_CLOSES) hArr.splice(0, hArr.length - MAX_CLOSES);
            if (lArr.length > MAX_CLOSES) lArr.splice(0, lArr.length - MAX_CLOSES);
            const sr = computeSRLevels(symbol);
            if (sr) { state.sr[symbol] = { ...sr, updated: Date.now() }; updateSRUI(symbol); }
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
      if (state.entry[symbol] || state.pending[symbol]) continue;
      const lastIdx = state.closes[symbol]?.length || 0;
      if (state.cooldownUntil[symbol] > lastIdx) continue;
      const closes = state.closes[symbol];
      if (!closes || closes.length < (RSI_PERIOD + STOCH_PERIOD)) continue;
      const working = closes.slice();
      const lp = state.lastPrice[symbol];
      if (!Number.isFinite(lp)) continue;
      working.push(lp);
      const sd  = stochRsi(working, RSI_PERIOD, STOCH_PERIOD, K_SMOOTH, D_SMOOTH);
      const rsiS = rsi(working, RSI_PERIOD);
      if (!sd || !rsiS) continue;
      const rsiNow = rsiS.at(-1);
      const { top, bottom, atr } = state.sr[symbol] || {};
      if (!Number.isFinite(atr) || (!Number.isFinite(top) && !Number.isFinite(bottom))) continue;
      const prox = Math.max(atr * SR_PROX_ATR, 0);
      let side = null;
      if (Number.isFinite(top) && Math.abs(lp - top) <= prox && sd.K >= 98 && sd.D >= 98 && rsiNow >= 70)
        side = 'PUT';
      else if (Number.isFinite(bottom) && Math.abs(lp - bottom) <= prox && sd.K <= 2 && sd.D <= 2 && rsiNow <= 30)
        side = 'CALL';
      if (!side) continue;
      const lastClose = closes.at(-1);
      const prevClose = closes.at(-2) ?? lastClose;
      const highPrice = Math.max(...state.highs[symbol].slice(-1));
      const lowPrice  = Math.min(...state.lows[symbol].slice(-1));
      const mode = state.modes?.[symbol] || MODE;

      if (mode === 'REVERSAO') {
        // ===== Filtro de rejeição confirmada =====
        // 1️⃣ Ignora se candle atual OU anterior fechou além do nível
        if (side === 'PUT' && (lastClose > top || prevClose > top)) {
          console.log(`[${symbol}] Rompeu resistência (${lastClose.toFixed(4)} > ${top.toFixed(4)}) — ignorando reversão.`);
          continue;
        }
        if (side === 'CALL' && (lastClose < bottom || prevClose < bottom)) {
          console.log(`[${symbol}] Rompeu suporte (${lastClose.toFixed(4)} < ${bottom.toFixed(4)}) — ignorando reversão.`);
          continue;
        }

        // 2️⃣ Ignora se candle teve corpo completo fora da zona SR (wick de rompimento sem volta)
        if (side === 'PUT' && highPrice > top && lastClose > top) {
          console.log(`[${symbol}] Candle fechou fora da resistência — rompimento confirmado, ignorando.`);
          continue;
        }
        if (side === 'CALL' && lowPrice < bottom && lastClose < bottom) {
          console.log(`[${symbol}] Candle fechou fora do suporte — rompimento confirmado, ignorando.`);
          continue;
        }
      } else if (mode === 'ROMPIMENTO') {
        // ===== Lógica de rompimento confirmada =====
        if (side === 'PUT' && lastClose > top) {
          console.log(`[${symbol}] Rompeu resistência — invertendo para CALL (rompimento confirmado).`);
          side = 'CALL';
        } else if (side === 'CALL' && lastClose < bottom) {
          console.log(`[${symbol}] Rompeu suporte — invertendo para PUT (rompimento confirmado).`);
          side = 'PUT';
        }
      }
      state.pending[symbol] = { side, price: lp, ts: workingTime };
      beep(1000, 220);
      prependSignalItem(symbol, side, lp);
      addSignalToStore(symbol, side, lp);
    }
  }

  // ===== Automação de modo por símbolo =====
  function autoAdjustModePerSymbol(symbol) {
    const closes = state.closes[symbol];
    if (!closes || closes.length < RSI_PERIOD + 10) return;

    const highs = state.highs[symbol];
    const lows = state.lows[symbol];
    if (!highs || !lows) return;

    const recentRSI = rsi(closes.slice(-30), RSI_PERIOD);
    if (!recentRSI || recentRSI.length < 10) return;
    const avgRSI = recentRSI.slice(-10).reduce((a,b)=>a+b,0)/10;

    const atrVal = atr(closes, ATR_PERIOD); // disponível se precisar
    const sr = state.sr[symbol];
    const price = state.lastPrice[symbol];
    const prev = closes.at(-2);

    let newMode = state.modes[symbol];

    // === Detecta rompimentos ===
    if (sr?.top && price > sr.top && prev <= sr.top) newMode = 'ROMPIMENTO';
    else if (sr?.bottom && price < sr.bottom && prev >= sr.bottom) newMode = 'ROMPIMENTO';
    // === Volta pro modo reversão se voltar pro canal ===
    else if (sr?.top && sr?.bottom && price < sr.top && price > sr.bottom && avgRSI < 65 && avgRSI > 35)
      newMode = 'REVERSAO';

    if (newMode !== state.modes[symbol]) {
      state.modes[symbol] = newMode;
      console.log(`[AUTO-MODE] ${symbol} mudou para ${newMode}`);
      updateSymbolModeUI(symbol, newMode);
    }
  }

  function updateSymbolModeUI(symbol, mode) {
    const card = document.querySelector(`.ticker-card[data-symbol="${symbol}"]`);
    if (!card) return;
    card.setAttribute('data-mode', mode);
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
      const side = ent.side;
      const entryPrice = Number(ent.entryPrice);
      const exitPrice = Number(state.lastPrice[symbol]);

      if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice)) {
        // Evita NaN: não registra resultado se valores inválidos
        state.entry[symbol] = null;
        continue;
      }

      let result = 'LOSS';
      if (side === 'CALL' && exitPrice > entryPrice) result = 'WIN';
      else if (side === 'PUT' && exitPrice < entryPrice) result = 'WIN';

      // Estatísticas por símbolo
      state.stats[symbol].total += 1;
      if (result === 'WIN') state.stats[symbol].wins += 1;
      updateStats(symbol);

      // UI e persistência
      beep(result === 'WIN' ? 800 : 400, 400);
      prependResultItem(symbol, result, side, entryPrice, exitPrice);
      addResultToStore(symbol, result, side, entryPrice, exitPrice);
      // cooldown por barras após finalizar
      const idx = state.closes[symbol]?.length || 0;
      state.cooldownUntil[symbol] = idx + COOLDOWN_BARS;
      
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
      for (const s of SYMBOLS) { 
        updateTicker(s);
        updateMetrics(s);
        updateSRUI(s);
        autoAdjustModePerSymbol(s);
      }
    }, 1000);
  }

  // ===== Inicialização =====
  async function init() {
    setStatus('Carregando...', 'warn');
    state.store = loadStore();
    newDaySession();
    await preloadAll();
    for (const s of SYMBOLS) { updateTicker(s); updateMetrics(s); updateSRUI(s); }
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

    // Inicializar faixa de modo automático
    const bar = document.getElementById('modeStatusBar');
    if (bar) {
      bar.className = 'mode-bar mode-auto';
      bar.innerHTML = '⚙️ <strong>Modo Automático</strong> — cada ativo alterna entre reversão e rompimento dinamicamente.';
      document.body.style.background = '#0c0f14';
    }
    // Inicializar destaque dos cards por símbolo
    for (const s of SYMBOLS) {
      updateSymbolModeUI(s, state.modes[s]);
    }
  }

  // Boot
  init();
})();