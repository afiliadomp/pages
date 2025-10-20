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

  // ===== Banca e Payout =====
  let SALDO_INICIAL = 0.00;    // começa o dia sempre com 0 USDT
  let VALOR_ENTRADA = 1.00;    // valor por operação
  let PAYOUT = 0.89;           // payout padrão (ex: 0.89 = 89%)
  let saldoAtual = SALDO_INICIAL;

  // ===== Lookback e temporização =====
  const SR_LOOKBACK = 300; // usado para preload de candles (compatibilidade)
  const COOLDOWN_BARS = 1;

  // ===== Modo de Operação (compatibilidade) =====
  const MODE = 'AUTO';

  const state = {
    closes: Object.fromEntries(SYMBOLS.map(s => [s, []])),
    highs: Object.fromEntries(SYMBOLS.map(s => [s, []])),
    lows:  Object.fromEntries(SYMBOLS.map(s => [s, []])),
    trends: Object.fromEntries(SYMBOLS.map(s => [s, { ltb: null, lta: null }])),
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
    updateBreakHighlight(symbol);
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
      const color = lastRsiNum >= 70 || kNum >= 90 ? '#ff4d4d'
              : lastRsiNum <= 30 || kNum <= 10 ? '#3aff7a'
              : '#cccccc';
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
      if (obj._saldoAtual !== undefined) saldoAtual = obj._saldoAtual;
      if (obj._saldoInicial !== undefined) SALDO_INICIAL = obj._saldoInicial;
      return obj && typeof obj === 'object' ? obj : {};
    } catch (_) { return {}; }
  }

  function saveStore() {
    try {
      state.store._saldoAtual = saldoAtual;
      state.store._saldoInicial = SALDO_INICIAL;
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

  // ===== Atualização de saldo na UI =====
  function updateSaldoUI() {
    const el = document.getElementById('saldoValor');
    if (!el) return;
    const lucro = saldoAtual - SALDO_INICIAL;
    const cor = lucro >= 0 ? '#3aff7a' : '#ff4d4d';
    el.innerHTML = `Saldo: <span style="color:${cor}">${saldoAtual.toFixed(2)}</span> (${lucro >= 0 ? '+' : ''}${lucro.toFixed(2)})`;
  }

  // ===== Inicialização do painel de configuração =====
  function initConfigBox() {
    const valInput = document.getElementById('valorEntradaInput');
    const payInput = document.getElementById('payoutInput');
    const btn = document.getElementById('btnSalvarConfig');
    if (!valInput || !payInput || !btn) return;

    btn.addEventListener('click', () => {
      VALOR_ENTRADA = parseFloat(valInput.value) || VALOR_ENTRADA;
      PAYOUT = parseFloat(payInput.value) || PAYOUT;
      updateSaldoUI();
      alert(`Configurações atualizadas!\nEntrada: ${VALOR_ENTRADA.toFixed(2)} USDT\nPayout: ${(PAYOUT * 100).toFixed(1)}%`);
    });
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

    // Reset banca para novo dia
    SALDO_INICIAL = 0.00;
    saldoAtual = 0.00;
    updateSaldoUI();

    saveStore();
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
      const val = avgLoss === 0 ? 100 : Math.min(100, Math.max(0, 100 - 100 / (1 + rs)));
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
    return { stoch: Number(stoch.toFixed(2)), K: Number(K.toFixed(2)), D: Number(D.toFixed(2)) };
  }

  function atr(series, period = ATR_PERIOD) {
    if (!series || series.length < period + 1) return null;
    const diffs = [];
    for (let i = 1; i < series.length; i++) diffs.push(Math.abs(series[i] - series[i - 1]));
    const recent = diffs.slice(-period);
    const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
    return avg;
  }

  function ema(series, length) {
    if (!series || series.length < length) return null;
    const k = 2 / (length + 1);
    let emaVal = series[0];
    for (let i = 1; i < series.length; i++) {
      emaVal = series[i] * k + emaVal * (1 - k);
    }
    return emaVal;
  }

  // ===== Tendências (LTB/LTA) =====
  function computeTrendLines(symbol) {
    const highs = state.highs[symbol];
    const lows  = state.lows[symbol];
    if (!highs || !lows || highs.length < 20 || lows.length < 20) return null;

    const lastHighs = [];
    const lastLows = [];
    for (let i = highs.length - 2; i > 1; i--) {
      const hPrev = highs[i - 1], hNext = highs[i + 1], hCur = highs[i];
      const lPrev = lows[i - 1], lNext = lows[i + 1], lCur = lows[i];
      if (Number.isFinite(hCur) && Number.isFinite(hPrev) && Number.isFinite(hNext) && hCur > hPrev && hCur > hNext) lastHighs.push({ idx: i, val: hCur });
      if (Number.isFinite(lCur) && Number.isFinite(lPrev) && Number.isFinite(lNext) && lCur < lPrev && lCur < lNext) lastLows.push({ idx: i, val: lCur });
      if (lastHighs.length >= 3 && lastLows.length >= 3) break;
    }

    if (lastHighs.length < 2 || lastLows.length < 2) return null;

    const [h1, h2] = lastHighs.slice(0, 2);
    const [l1, l2] = lastLows.slice(0, 2);
    const slopeHigh = (h2.val - h1.val) / (h2.idx - h1.idx);
    const slopeLow  = (l2.val - l1.val) / (l2.idx - l1.idx);

    const lastIdx = highs.length - 1;
    const ltb = h2.val + slopeHigh * (lastIdx - h2.idx);
    const lta = l2.val + slopeLow  * (lastIdx - l2.idx);

    if (!Number.isFinite(ltb) || !Number.isFinite(lta)) return null;
    return { ltb, lta };
  }

  function updateBreakHighlight(symbol) {
    const card = document.querySelector(`.ticker-card[data-symbol="${symbol}"]`);
    if (!card) return;
    const tr = state.trends?.[symbol];
    const lp = state.lastPrice[symbol];
    if (!tr || !Number.isFinite(lp) || !Number.isFinite(tr.ltb) || !Number.isFinite(tr.lta)) {
      card.removeAttribute('data-break');
      return;
    }
    if (lp > tr.ltb) card.setAttribute('data-break', 'CALL');
    else if (lp < tr.lta) card.setAttribute('data-break', 'PUT');
    else card.setAttribute('data-break', 'NONE');
  }

  // Atualiza UI com LTB/LTA por símbolo
  function updateTrendUI(symbol) {
    const ltbEl = document.getElementById(`ltb-${symbol}`);
    const ltaEl = document.getElementById(`lta-${symbol}`);

    const highs = state.highs[symbol];
    const lows  = state.lows[symbol];
    if (!highs || !highs.length || !lows || !lows.length) {
      if (ltbEl) ltbEl.textContent = '—';
      if (ltaEl) ltaEl.textContent = '—';
      return;
    }

    const tr = computeTrendLines(symbol);
    if (state.trends && state.trends[symbol]) {
      state.trends[symbol].ltb = tr ? tr.ltb : null;
      state.trends[symbol].lta = tr ? tr.lta : null;
    }

    const ltbFmt = tr && tr.ltb != null ? Number(tr.ltb).toFixed(4) : '—';
    const ltaFmt = tr && tr.lta != null ? Number(tr.lta).toFixed(4) : '—';
    if (ltbEl) ltbEl.textContent = ltbFmt;
    if (ltaEl) ltaEl.textContent = ltaFmt;
    updateBreakHighlight(symbol);
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
        const tr = computeTrendLines(sym);
        if (tr) { state.trends[sym] = { ltb: tr.ltb, lta: tr.lta }; }
        updateTrendUI(sym);
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
            // candle fechado: empurrar H/L/C e recalcular tendências
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
            const tr = computeTrendLines(symbol);
            if (tr) { state.trends[symbol] = { ltb: tr.ltb, lta: tr.lta }; }
            updateTrendUI(symbol);
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
      const ema50 = ema(working, 50);
      const ema200 = ema(working, 200);
      const trendUp = ema50 && ema200 && ema50 > ema200;
      const trendDown = ema50 && ema200 && ema50 < ema200;
      const tr = state.trends[symbol] || {};
      if (!Number.isFinite(tr.ltb) && !Number.isFinite(tr.lta)) continue;
      let side = null;
      const mode = state.modes?.[symbol] || MODE;
      if (mode === 'ROMPIMENTO') {
        const lastClose = closes.at(-1);
        if (Number.isFinite(tr.ltb) && lp > tr.ltb && lastClose > tr.ltb) side = 'CALL';
        else if (Number.isFinite(tr.lta) && lp < tr.lta && lastClose < tr.lta) side = 'PUT';
        else continue;
      } else {
        if (Number.isFinite(tr.ltb) && Number.isFinite(tr.lta)) {
          const nearLTB = Math.abs(lp - tr.ltb) / tr.ltb < 0.0005;
          const nearLTA = Math.abs(lp - tr.lta) / tr.lta < 0.0005;

          if (nearLTB && sd.K >= 95 && sd.D >= 95 && rsiNow >= 70) side = 'PUT';
          else if (nearLTA && sd.K <= 5 && sd.D <= 5 && rsiNow <= 30) side = 'CALL';
          else continue;
        } else {
          continue;
        }
      }
      const lastClose = closes.at(-1);
      const prevClose = closes.at(-2) ?? lastClose;
      updateBreakHighlight(symbol);

      // Filtro macro: operar apenas a favor da tendência EMA50/EMA200
      if (side === 'CALL' && trendDown) continue;
      if (side === 'PUT' && trendUp) continue;

      // Resumo visual de tendência
      const trendEl = document.getElementById(`trend-${symbol}`);
      if (trendEl) {
        trendEl.textContent = trendUp ? "📈 Tendência de Alta" : trendDown ? "📉 Tendência de Baixa" : "—";
        trendEl.classList.remove('up','down','neutral');
        trendEl.classList.add(trendUp ? 'up' : trendDown ? 'down' : 'neutral');
      }

      state.pending[symbol] = { side, price: lp, ts: workingTime };
      beep(1000, 220);
      prependSignalItem(symbol, side, lp);
      addSignalToStore(symbol, side, lp);
      console.log(`[SIGNAL] ${symbol} ${side} @ ${lp} (${mode}) RSI:${rsiNow.toFixed(1)} K:${sd.K.toFixed(1)} D:${sd.D.toFixed(1)} | EMA50:${ema50?.toFixed(4)} EMA200:${ema200?.toFixed(4)}`);
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

    const tr = state.trends[symbol];
    const price = state.lastPrice[symbol];

    let newMode = state.modes[symbol];

    // === Detecta rompimentos confirmados por dois fechamentos ===
    const lastTwoAbove = tr?.ltb != null ? closes.slice(-2).every(c => c > tr.ltb) : false;
    const lastTwoBelow = tr?.lta != null ? closes.slice(-2).every(c => c < tr.lta) : false;

    if (tr?.ltb != null && lastTwoAbove) newMode = 'ROMPIMENTO';
    else if (tr?.lta != null && lastTwoBelow) newMode = 'ROMPIMENTO';
    else if (tr?.ltb != null && tr?.lta != null && price < tr.ltb && price > tr.lta && avgRSI < 65 && avgRSI > 35)
      newMode = 'REVERSAO';

    if (newMode !== state.modes[symbol]) {
      state.modes[symbol] = newMode;
      console.log(`[AUTO-MODE] ${symbol} mudou para ${newMode}`);
      updateSymbolModeUI(symbol, newMode);
      updateBreakHighlight(symbol);
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
      const atrVal = atr(state.closes[symbol], ATR_PERIOD) || 0;
      const minMove = atrVal * 0.2; // exige movimento real de 20% do ATR
      const diff = exitPrice - entryPrice;

      if (side === 'CALL' && diff > minMove) result = 'WIN';
      else if (side === 'PUT' && -diff > minMove) result = 'WIN';
      else result = 'LOSS';

      // ===== Atualiza Saldo =====
      if (result === 'WIN') {
        const ganho = VALOR_ENTRADA * PAYOUT;
        saldoAtual += ganho;
      } else {
        saldoAtual -= VALOR_ENTRADA;
      }
      updateSaldoUI();

      // Estatísticas por símbolo
      state.stats[symbol].total += 1;
      if (result === 'WIN') state.stats[symbol].wins += 1;
      updateStats(symbol);

      // UI e persistência
      beep(result === 'WIN' ? 800 : 400, 400);
      prependResultItem(symbol, result, side, entryPrice, exitPrice);
      addResultToStore(symbol, result, side, entryPrice, exitPrice);
      console.log(`[RESULT] ${symbol} ${result} (${side}) ${entryPrice} → ${exitPrice}`);
      // cooldown por barras após finalizar
      const idx = state.closes[symbol]?.length || 0;
      state.cooldownUntil[symbol] = idx + COOLDOWN_BARS;
      state.pending[symbol] = null;
      if (result === 'LOSS') state.modes[symbol] = 'REVERSAO';
      
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
        updateTrendUI(s);
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
    for (const s of SYMBOLS) { updateTicker(s); updateMetrics(s); updateTrendUI(s); }
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
        
        // ===== Resetar Banca =====
        saldoAtual = 0.00;
        SALDO_INICIAL = 0.00;
        updateSaldoUI();
        
        saveStore();
        loadDayToUI();
        alert('✅ Dados e banca resetados para o novo dia!');
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

    // Inicialização do painel de configuração e saldo
    initConfigBox();
    updateSaldoUI();
  }

  // Boot
  init();
})();