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
  const WORK_WINDOW = 250;

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
    // 🔧 removido cooldownUntil: sem pausa por barras
    lastPrice: Object.fromEntries(SYMBOLS.map(s => [s, null])),
    prevPrice: Object.fromEntries(SYMBOLS.map(s => [s, null])),
    pending: Object.fromEntries(SYMBOLS.map(s => [s, null])),
    entry: Object.fromEntries(SYMBOLS.map(s => [s, null])),
    stats: Object.fromEntries(SYMBOLS.map(s => [s, { total: 0, wins: 0 }])),

    // Modelo adaptativo e métricas recentes por símbolo
    model: Object.fromEntries(SYMBOLS.map(s => [s, {
      regime: 'SIDE',
      lastRegime: null,
      kOver: 95,
      kUnder: 5,
      rsiOver: 70,
      rsiUnder: 30,
      nearBreak: 0.0005,
      minAtrMult: 0.20,
      // 🔧 removido abstainUntil: sem abstenção de sinal
    }])),
    trailing: Object.fromEntries(SYMBOLS.map(s => [s, {
      winLoss: [], // 'WIN'|'LOSS'
      recentAtr: [],
      recentRsiRange: [],
    }])),
    // 🔧 removido nextSignalAt: sem rate-limit de sinal
    // 🔧 removido lossesStreak: sem streak de perdas

    ws: null,
    reconnectAttempts: 0,
    minuteStampAnnounced: null,
    minuteStampExited: null,
    dayKey: null,
    store: {},
     settings: { voice: true, sounds: true },
   };

  // Preferência de voz (TTS)
  let voiceEnabled = false;
  let lastSpeakTime = 0;

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
    const hms = nowHMS();
    if (clockEl) clockEl.textContent = hms;
    const timeBarText = document.getElementById('timeBarText');
    if (timeBarText) timeBarText.textContent = `🕒 ${hms}`;
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
      if (obj._voiceEnabled !== undefined) voiceEnabled = !!obj._voiceEnabled;
      if (obj._settings && typeof obj._settings === 'object') {
        state.settings = { ...state.settings, ...obj._settings };
        voiceEnabled = !!state.settings.voice;
      }
      if (obj._model && typeof obj._model === 'object') {
        // merge superficial por símbolo
        for (const s of SYMBOLS) {
          if (obj._model[s]) {
            state.model[s] = { ...state.model[s], ...obj._model[s] };
          }
        }
      }
      // parâmetros persistidos (globais) — usados apenas para operações futuras
      if (typeof obj._valorEntrada === 'number') {
        VALOR_ENTRADA = obj._valorEntrada;
      }
      if (typeof obj._payout === 'number') {
        PAYOUT = obj._payout;
      }
      // tenta recuperar saldo do dia atual (se existir)
      const todayKey = getDayKey();
      if (obj && obj[todayKey] && obj[todayKey].saldoAtual != null) {
        saldoAtual = obj[todayKey].saldoAtual;
        updateSaldoUI();
      }
      return obj && typeof obj === 'object' ? obj : {};
    } catch (_) { return {}; }
  }

  function saveStore() {
    try {
      ensureDay(state.store, state.dayKey);
      if (state.store[state.dayKey]) state.store[state.dayKey].saldoAtual = saldoAtual;
      state.store._saldoAtual = saldoAtual;
      state.store._saldoInicial = SALDO_INICIAL;
      state.store._voiceEnabled = !!voiceEnabled;
      state.store._settings = state.settings;
      state.store._model = state.model;
      // persistência dos parâmetros globais
      state.store._valorEntrada = VALOR_ENTRADA;
      state.store._payout = PAYOUT;
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
    const lucro = saldoAtual; // SALDO_INICIAL já é sempre 0 no início do dia
    const cor = lucro >= 0 ? '#3aff7a' : '#ff4d4d';
    el.innerHTML = `Saldo: <span style="color:${cor}">${saldoAtual.toFixed(2)}</span> (${lucro >= 0 ? '+' : ''}${lucro.toFixed(2)})`;
  }

  // ===== Inicialização do painel de configuração =====
  function initConfigBox() {
    const valInput = document.getElementById('valorEntradaInput');
    const payInput = document.getElementById('payoutInput');
    const btn = document.getElementById('btnSalvarConfig');
    const voiceTgl = document.getElementById('voiceToggle');
    if (!valInput || !payInput || !btn) return;

    // Preencher inputs com valores persistidos
    try {
      valInput.value = Number(VALOR_ENTRADA).toFixed(2);
      payInput.value = Number(PAYOUT).toFixed(2);
    } catch (_) {}

    if (voiceTgl) {
      const v = (state?.settings?.voice ?? voiceEnabled);
      voiceTgl.checked = !!v;
      voiceEnabled = !!v;
      voiceTgl.addEventListener('change', () => {
        const on = !!voiceTgl.checked;
        state.settings.voice = on;
        voiceEnabled = on;
        saveStore();
        if (on) speak('Voz ativada');
      });
    }

    btn.addEventListener('click', () => {
      const val = parseFloat(valInput.value);
      if (!Number.isNaN(val)) {
        VALOR_ENTRADA = val;
      }

      let payoutVal = (payInput.value || '').toString().replace(',', '.');
      let parsed = parseFloat(payoutVal);
      if (!Number.isNaN(parsed)) {
        if (parsed > 1) parsed = parsed / 100; // permite 89 -> 0.89
        PAYOUT = parsed;
      }

      // Persistir apenas parâmetros para operações futuras
      saveStore();
      alert(`Configurações atualizadas!\nEntrada: ${VALOR_ENTRADA.toFixed(2)} USDT\nPayout: ${(PAYOUT * 100).toFixed(1)}%${voiceTgl ? `\nVoz: ${voiceTgl.checked ? 'ON' : 'OFF'}` : ''}`);
    });
  }

  function addSignalToStore(symbol, side, price) {
    ensureDay(state.store, state.dayKey);
    const rec = { time: nowHMS(), symbol, side, price, metrics: formatMetrics(symbol) };
    state.store[state.dayKey].signals.unshift(rec);
    // manter tamanho razoável
    if (state.store[state.dayKey].signals.length > 500) state.store[state.dayKey].signals.length = 500;
    saveStore();
  }

  function addResultToStore(symbol, result, side, entryPrice, exitPrice) {
    ensureDay(state.store, state.dayKey);
    const day = state.store[state.dayKey];
    const rec = { time: nowHMS(), symbol, side, result, entryPrice, exitPrice, metrics: formatMetrics(symbol) };
    day.results.unshift(rec);
    // Cap no histórico de resultados persistido
    if (day.results.length > 500) day.results.length = 500;
    // Estatísticas diárias (incremental)
    day.stats.total = (day.stats.total || 0) + 1;
    day.stats.wins = (day.stats.wins || 0) + (result === 'WIN' ? 1 : 0);
    day.stats.losses = Math.max(0, day.stats.total - day.stats.wins);
    day.stats.winrate = day.stats.total > 0 ? parseFloat(((day.stats.wins / day.stats.total) * 100).toFixed(1)) : 0;
    saveStore();
    updateDailySummaryUI();
  }

  function recalcSaldoFromResults() {
    try {
      ensureDay(state.store, state.dayKey);
      const day = state.store[state.dayKey];
      if (!day || !Array.isArray(day.results)) return;
      let saldo = 0;
      for (const r of day.results) {
        if (r.result === 'WIN') saldo += VALOR_ENTRADA * PAYOUT;
        else if (r.result === 'LOSS') saldo -= VALOR_ENTRADA;
      }
      saldoAtual = saldo;
      try { day.saldoAtual = saldoAtual; } catch (_) {}
      updateSaldoUI();
      try { saveStore(); } catch (_) {}
      console.log('[RECALC] Saldo restaurado:', saldoAtual.toFixed(2), 'USDT');
    } catch (_) { /* silencioso */ }
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
    const dayAfter = state.store[state.dayKey];
    if (dayAfter && typeof dayAfter.saldoAtual === 'number') {
      saldoAtual = dayAfter.saldoAtual;
      updateSaldoUI();
    } else {
      recalcSaldoFromResults();
    }
  }

  function newDaySession() {
    state.dayKey = getDayKey();
    ensureDay(state.store, state.dayKey);

    const day = state.store[state.dayKey];
    if (day && typeof day.saldoAtual === 'number') {
      saldoAtual = day.saldoAtual;
    } else {
      recalcSaldoFromResults();
    }
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

  // ===== Voz (TTS) e Sons =====
  function speak(text, optsOrPitch, rateArg, langArg) {
    const voiceOn = (state?.settings?.voice ?? voiceEnabled);
    if (!voiceOn) return;
    try {
      const ss = window.speechSynthesis;
      if (!ss || typeof SpeechSynthesisUtterance === 'undefined') return;

      const now = Date.now();
      if (now - lastSpeakTime < 2000) return; // evita sobreposição (2s)
      lastSpeakTime = now;

      // Cancela falas anteriores para evitar sobreposição
      try { ss.cancel(); } catch (_) {}

      // Carrega defaults persistidos (com fallbacks)
      const savedRate = Number.parseFloat(localStorage.getItem('ttsRate') ?? '1.0');
      const savedPitch = Number.parseFloat(localStorage.getItem('ttsPitch') ?? '1.0');
      const savedVol = Number.parseFloat(localStorage.getItem('ttsVol') ?? '1.0');

      let rate = Number.isFinite(savedRate) ? savedRate : 1.0;
      let pitch = Number.isFinite(savedPitch) ? savedPitch : 1.0;
      let volume = Number.isFinite(savedVol) ? savedVol : 1.0;
      let lang = 'pt-BR';

      if (optsOrPitch && typeof optsOrPitch === 'object') {
        if (Number.isFinite(optsOrPitch.pitch)) pitch = optsOrPitch.pitch;
        if (Number.isFinite(optsOrPitch.rate)) rate = optsOrPitch.rate;
        if (Number.isFinite(optsOrPitch.volume)) volume = optsOrPitch.volume;
        if (optsOrPitch.lang) lang = optsOrPitch.lang;
      } else {
        if (Number.isFinite(optsOrPitch)) pitch = optsOrPitch;
        if (Number.isFinite(rateArg)) rate = rateArg;
        if (typeof langArg === 'string' && langArg) lang = langArg;
      }

      const utter = new SpeechSynthesisUtterance(String(text));
      utter.lang = lang;
      utter.pitch = pitch;
      utter.rate = rate;
      utter.volume = volume;

      // Seleciona voz feminina brasileira, se disponível
      const voices = ss.getVoices?.() || [];
      const preferredName = localStorage.getItem('ttsVoice');
      let selected = null;
      if (preferredName) {
        selected = voices.find(v => v.name === preferredName) || null;
      }
      if (!selected && voices.length) {
        selected =
          voices.find(v => /^pt/i.test(v.lang) && /(female|mulher|feminina|woman|luciana|let[ií]cia|maria|camila|helo[ií]sa|fernanda|isabel?a|v[íi]t[oó]ria|bia|gabriela|carla|paula|google|brasil|brazil)/i.test(v.name)) ||
          voices.find(v => v.lang === 'pt-BR' && /(luciana|let[ií]cia|maria|camila|helo[ií]sa|fernanda|isabel?a|v[íi]t[oó]ria|bia|gabriela|carla|paula|google|brasil|brazil)/i.test(v.name)) ||
          voices.find(v => v.lang === 'pt-BR') ||
          voices[0];
      }
      if (selected) utter.voice = selected;

      ss.speak(utter);
      console.log(`[TTS] Falando: "${text}" voz=${utter.voice?.name || 'padrão'} rate=${utter.rate} pitch=${utter.pitch} vol=${utter.volume}`);
    } catch (err) {
      console.warn('Erro no TTS:', err);
    }
  }

  // Pronúncia e mensagens TTS para símbolos (pt-BR)
  function baseSymbol(sym) {
    const s = String(sym || '').toUpperCase();
    if (s.includes('BTC')) return 'BTC';
    if (s.includes('ETH')) return 'ETH';
    if (s.includes('XRP')) return 'XRP';
    if (s.includes('ADA')) return 'ADA';
    return s;
  }
  function readableAcronymPT(base) {
    switch (base) {
      case 'BTC': return 'Bê Tê Cê';
      case 'ETH': return 'Ê Tê H';
      case 'XRP': return 'X R Pê';
      case 'ADA': return 'Á DÁ';
      default: return base;
    }
  }
  function readableNamePT(base) {
    switch (base) {
      case 'BTC': return 'Bitcoin';
      case 'ETH': return 'Étirium';
      case 'XRP': return 'X R Pê';
      case 'ADA': return 'Áda';
      default: return base;
    }
  }
  function resolveSymbolSpeech(symbol, mode) {
    const base = baseSymbol(symbol);
    const m = mode || (localStorage.getItem('ttsSymbolMode') || 'acronym');
    return m === 'full' ? readableNamePT(base) : readableAcronymPT(base);
  }
  function speakSymbol(symbol, action, opts) {
    const readable = resolveSymbolSpeech(symbol, opts?.mode);
    const text = `Operação ${action}, ${readable}`;
    speak(text, opts);
  }
  function buildSignalSpeech(symbol, side, score, mode) {
    const action = side === 'CALL' ? 'de compra' : 'de venda';
    const readable = resolveSymbolSpeech(symbol, mode);
    const pct = Math.round((Number(score) || 0) * 100);
    return `Operação ${action}, ${readable}, score ${pct} por cento.`;
  }
  function buildResultSpeech(symbol, result, mode) {
    const readable = resolveSymbolSpeech(symbol, mode);
    return String(result).toUpperCase() === 'WIN' ? `Vitória, em ${readable}.` : `Derrota, em ${readable}.`;
  }

  // Memoriza voz preferida e repovoa seletor quando vozes carregarem
  try {
    const ss = window.speechSynthesis;
    if (ss) {
      const prev = ss.onvoiceschanged;
      ss.onvoiceschanged = () => {
        try {
          const voices = ss.getVoices();
          if (!localStorage.getItem('ttsVoice')) {
            const female = voices.filter(v => /^pt/i.test(v.lang) && /(maria|let[ií]cia|luciana|feminina|google|brasil|brazil|camila|helo[ií]sa|fernanda|isabel?a|v[íi]t[oó]ria|bia|gabriela|carla|paula)/i.test(v.name));
            const pt = voices.filter(v => /^pt/i.test(v.lang));
            const chosen = female[0] || pt.find(v => v.lang === 'pt-BR') || pt[0];
            if (chosen) localStorage.setItem('ttsVoice', chosen.name);
          }
        } catch (_) { /* silencioso */ }
        try { if (typeof prev === 'function') prev(); } catch (_) { /* silencioso */ }
        try { if (typeof populateVoices === 'function') populateVoices(); } catch (_) { /* silencioso */ }
      };
    }
  } catch (_) { /* silencioso */ }

  function soundSignal(side) {
    if (state?.settings && state.settings.sounds === false) return;
    if (side === 'CALL') beep(900, 160); else beep(600, 160);
  }
  function soundWin() {
    if (state?.settings && state.settings.sounds === false) return;
    beep(900, 110); setTimeout(() => beep(1100, 110), 130);
  }
  function soundLoss() {
    if (state?.settings && state.settings.sounds === false) return;
    beep(600, 110); setTimeout(() => beep(450, 110), 130);
  }
  function soundReconnect() {
    if (state?.settings && state.settings.sounds === false) return;
    beep(850, 100);
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
        try { soundReconnect(); } catch (_) {}
        try { logLearn('ALL', 'WebSocket conectado'); } catch (_) {}
        try { speak('Conectado'); } catch (_) {}
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
  function detectMarketRegime(symbol) { 
    const closes = state.closes[symbol]; 
    if (!closes || closes.length < 100) return "UNKNOWN"; 

    const ema50 = ema(closes, 50); 
    const ema200 = ema(closes, 200); 
    const atrVal = atr(closes, ATR_PERIOD); 
    const rsiVals = rsi(closes, RSI_PERIOD); 
    const lastRSI = rsiVals.at(-1); 
    const recentRSI = rsiVals.slice(-10); 

    const emaDiff = Math.abs(ema50 - ema200) / ema200; 
    const rsiRange = Math.max(...recentRSI) - Math.min(...recentRSI); 

    if (atrVal < 0.0002) return "FLAT"; // mercado travado 
    if (emaDiff > 0.001 && rsiRange > 25) return "TREND"; // tendência forte 
    if (emaDiff < 0.0005 && rsiRange < 20) return "SIDE";  // lateral 
    return "VOLATILE"; // regime misto 
  } 

  // ===== Logs coloridos =====
  function logSignal(symbol, side, mode, price, rsi, k, d, extra = '') {
    const sideColor = side === 'CALL' ? '#22c55e' : '#ef4444';
    console.log(
      '%c[SIGNAL]%c %s %c%s%c @ %s (mode:%s) RSI:%s K:%s D:%s%s',
      'color:#f59e0b;font-weight:bold',
      'color:#9ca3af',
      symbol,
      `color:${sideColor};font-weight:bold`, side,
      'color:#9ca3af',
      String(price),
      mode || '-',
      Number(rsi).toFixed(1),
      Number(k).toFixed(1),
      Number(d).toFixed(1),
      extra ? ` | ${extra}` : ''
    );
  }
  function logResult(symbol, result, side, entry, exit, atr, move, minMove) {
    const ok = result === 'WIN';
    const resColor = ok ? '#22c55e' : '#ef4444';
    console.log(
      '%c[RESULT]%c %s %c%s%c (%s) %s→%s | move:%s | minMove:%s | atr:%s',
      'color:#22c55e',
      'color:#9ca3af',
      symbol,
      `color:${resColor};font-weight:bold`, result,
      'color:#9ca3af',
      side,
      Number(entry).toFixed(4),
      Number(exit).toFixed(4),
      Number(move).toFixed(6),
      Number(minMove).toFixed(6),
      Number(atr || 0).toFixed(6)
    );
  }
  function logLearn(symbol, msg) {
    console.log('%c[LEARN]%c %s — %s', 'color:#38bdf8', 'color:#9ca3af', symbol, msg);
  }

  // ===== Aprendizado contextual — thresholds dinâmicos =====
  function adaptiveThreshold(symbol) {
    const day = state.store[state.dayKey];
    if (!day || !Array.isArray(day.results)) return { rsiBuy: 35, rsiSell: 65 };
    const recent = day.results.filter(r => r.symbol === symbol).slice(0, 30);
    const wr = recent.length ? recent.filter(r => r.result === 'WIN').length / recent.length : 0;
    const adj = wr < 0.6 ? 5 : (wr > 0.8 ? -5 : 0);
    return { rsiBuy: 35 + adj, rsiSell: 65 - adj };
  }

  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

function scoreSignal(symbol, ctx) {
  const { sd, rsiNow, ema50, ema200, regime, nearLTB, nearLTA, atr } = ctx || {};
  if (!sd || rsiNow == null) return { score: 0 };
  let score = 0;
  // Acordo K/D (quanto mais próximos, melhor)
  const kdAgreement = 1 - Math.min(1, Math.abs(Number(sd.K) - Number(sd.D)) / 100);
  score += kdAgreement * 0.30;
  // RSI em extremos (longe de 50)
  const rsiExtreme = Math.min(1, Math.abs(Number(rsiNow) - 50) / 50);
  score += rsiExtreme * 0.20;
  // Alinhamento com EMAs
  const trendUp = ema50 && ema200 && ema50 > ema200;
  const trendDown = ema50 && ema200 && ema50 < ema200;
  const trendScore = trendUp || trendDown ? 1 : 0.5;
  score += trendScore * 0.10;
  // Proximidade de estruturas
  const nearScore = (nearLTB || nearLTA) ? 1 : 0;
  score += nearScore * 0.20;
  // Volatilidade suficiente (ATR)
  const atrScore = atr != null ? clamp((atr - 0.0001) / 0.0005, 0, 1) : 0.5;
  score += atrScore * 0.20;
  return { score: clamp(score, 0, 1), regime };
}

function announceSignals() {
    const workingTime = Date.now();
    for (const symbol of SYMBOLS) {
      if (state.entry[symbol] || state.pending[symbol]) continue;
      // 🔧 sinais destravados: sem abstain/cooldown/rate-limit
      const nowTs = Date.now();
      const closes = state.closes[symbol];
      if (!closes || closes.length < (RSI_PERIOD + STOCH_PERIOD)) continue;
      const working = closes.slice(-WORK_WINDOW);
      if (!working.length) continue;
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

      const regime = detectMarketRegime(symbol);
      // contexto para scoring
      const atrVal = atr(state.closes[symbol], ATR_PERIOD);
      const nearLTB = Number.isFinite(tr.ltb) ? Math.abs(lp - tr.ltb) / tr.ltb < 0.0012 : false;
      const nearLTA = Number.isFinite(tr.lta) ? Math.abs(lp - tr.lta) / tr.lta < 0.0012 : false;
      const ctx = { ema50, ema200, trends: tr, sd, rsiNow, atr: atrVal, regime, nearLTB, nearLTA };
      const scoreObj = scoreSignal(symbol, ctx) || { score: 0 };
      const score = Math.max(0, Math.min(1, Number(scoreObj.score) || 0));

      // 🔧 removido gating por abstenção/score mínimo

      const regimeEl = document.getElementById(`regime-${symbol}`);
      if (regimeEl) {
        regimeEl.textContent =
          regime === "SIDE" ? "📊 Lateral"
          : regime === "TREND" ? "📈 Tendencial"
          : regime === "VOLATILE" ? "⚡ Volátil"
          : regime === "FLAT" ? "🕳️ Travado"
          : "—";
      }

      // Filtro de volatilidade: evita operar mercado travado
      if (atrVal != null && atrVal < 0.00015) continue;

      let side = null;

      if (regime === "SIDE") {
        // Mercado lateral → reversão com sensibilidade adaptativa
        const nearLTB = Math.abs(lp - tr.ltb) / tr.ltb < 0.0012;
        const nearLTA = Math.abs(lp - tr.lta) / tr.lta < 0.0012;
        const { rsiBuy, rsiSell } = adaptiveThreshold(symbol);
        if (nearLTB && sd.K >= 90 && sd.D >= 90 && rsiNow >= rsiSell) side = 'PUT';
        else if (nearLTA && sd.K <= 10 && sd.D <= 10 && rsiNow <= rsiBuy) side = 'CALL';
      }
      else if (regime === "TREND") {
        // Mercado tendencial → operar rompimento
        if (lp > tr.ltb) side = 'CALL';
        else if (lp < tr.lta) side = 'PUT';
      }
      else if (regime === "VOLATILE") {
        // Mercado volátil → confirmação dupla
        if ((sd.K >= 95 && sd.D >= 95 && rsiNow >= 70 && lp < tr.ltb) ||
            (sd.K <= 5 && sd.D <= 5 && rsiNow <= 30 && lp > tr.lta)) {
          side = sd.K >= 95 ? 'PUT' : 'CALL';
        }
      }
      else if (regime === "FLAT") {
        // Mercado travado → não operar
        continue;
      }

      const lastClose = closes.at(-1);
      const prevClose = closes.at(-2) ?? lastClose;
      updateBreakHighlight(symbol);

      // Se nenhuma condição selecionou um lado, não operar
      if (!side) continue;

      // Score mínimo validado por scoreSignal() já aplicado acima

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
      // 🔧 removido rate limit por símbolo
      try { soundSignal(side); } catch (_) {}
      prependSignalItem(symbol, side, lp);
      addSignalToStore(symbol, side, lp);
      const th = adaptiveThreshold(symbol);
      try { logSignal(symbol, side, regime, lp, rsiNow, sd.K, sd.D, `score:${score.toFixed(2)} | regime:${regime} | rsiBuy:${th.rsiBuy} rsiSell:${th.rsiSell} | kOver:${state.model[symbol]?.kOver ?? 90} kUnder:${state.model[symbol]?.kUnder ?? 10} | minATR:${(state.model[symbol]?.minAtrMult ?? 0.2).toFixed(2)}`); } catch (_) {}
      try { const msg = buildSignalSpeech(symbol, side, score); speak(msg); } catch (_) {}
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
      const minMove = atrVal * (state.model[symbol]?.minAtrMult ?? 0.2); // exige movimento real proporcional ao ATR
      const diff = exitPrice - entryPrice;

      if (side === 'CALL' && diff > minMove) result = 'WIN';
      else if (side === 'PUT' && -diff > minMove) result = 'WIN';
      else result = 'LOSS';

      // ===== Atualiza Saldo =====
      let delta = 0;
      if (result === 'WIN') {
        delta = VALOR_ENTRADA * PAYOUT;
        saldoAtual += delta;
      } else {
        delta = -VALOR_ENTRADA;
        saldoAtual += delta;
      }
      updateSaldoUI();
      saveStore();
      console.log(`[BAL] ${symbol} ${result} delta:${delta.toFixed(2)} saldo:${saldoAtual.toFixed(2)}`);

      // Estatísticas por símbolo
      state.stats[symbol].total += 1;
      if (result === 'WIN') state.stats[symbol].wins += 1;
      updateStats(symbol);

      // UI e persistência
      try { result === 'WIN' ? soundWin() : soundLoss(); } catch (_) {}
      try { const msg = buildResultSpeech(symbol, result); speak(msg); } catch (_) {}
      prependResultItem(symbol, result, side, entryPrice, exitPrice);
      addResultToStore(symbol, result, side, entryPrice, exitPrice);
      console.log(`[RESULT] ${symbol} ${result} (${side}) ${entryPrice} → ${exitPrice}`);

      // aprendizado dinâmico baseado nos últimos resultados
      learn(symbol);

      // Atualiza histórico deslizante e streak
      try {
        const wl = state.trailing[symbol].winLoss;
        wl.unshift(result);
        if (wl.length > 30) wl.pop();
        // 🔧 removido lossesStreak e abstainUntil: sem pausas após perdas
      } catch (_) {}

      // 🔧 removido cooldown por barras e rate-limit pós-resultado
      const idx = state.closes[symbol]?.length || 0;
      state.pending[symbol] = null;
      if (result === 'LOSS') state.modes[symbol] = 'REVERSAO';
      
      state.entry[symbol] = null;
    }
  }

  function learn(symbol) {
    const day = state.store[state.dayKey];
    if (!day || !day.results) return;
    const all = day.results.filter(r => r.symbol === symbol);
    const last20 = all.slice(0, 20);
    const last100 = all.slice(0, 100);
    const wins20 = last20.filter(r => r.result === 'WIN').length;
    const wins100 = last100.filter(r => r.result === 'WIN').length;
    const wr20 = last20.length ? wins20 / last20.length : 0;
    const wr100 = last100.length ? wins100 / last100.length : 0;

    const m = state.model[symbol] || (state.model[symbol] = {});
    m.minAtrMult = m.minAtrMult ?? 0.20;
    m.kOver = m.kOver ?? 95;
    m.kUnder = m.kUnder ?? 5;
    m.rsiOver = m.rsiOver ?? 70;
    m.rsiUnder = m.rsiUnder ?? 30;

    let deltaMin = 0;
    if (wr20 < 0.50) deltaMin += 0.05; else if (wr20 > 0.70) deltaMin -= 0.02;
    if (wr100 < 0.50) deltaMin += 0.02; else if (wr100 > 0.70) deltaMin -= 0.01;
    m.minAtrMult = clamp(m.minAtrMult + deltaMin, 0.12, 0.50);

    if (wr20 < 0.50) {
      m.kOver = clamp((m.kOver ?? 95) + 1, 90, 99);
      m.kUnder = clamp((m.kUnder ?? 5) - 1, 1, 10);
      m.rsiOver = clamp((m.rsiOver ?? 70) + 1, 55, 80);
      m.rsiUnder = clamp((m.rsiUnder ?? 30) - 1, 20, 45);
    } else if (wr20 > 0.70) {
      m.kOver = clamp((m.kOver ?? 95) - 1, 90, 99);
      m.kUnder = clamp((m.kUnder ?? 5) + 1, 1, 10);
      m.rsiOver = clamp((m.rsiOver ?? 70) - 1, 55, 80);
      m.rsiUnder = clamp((m.rsiUnder ?? 30) + 1, 20, 45);
    }

    const last10 = all.slice(0, 10);
    const wr10 = last10.length ? last10.filter(r => r.result === 'WIN').length / last10.length : 1;
    if (wr10 < 0.50) {
      const prevMode = state.modes[symbol];
      state.modes[symbol] = prevMode === 'REVERSAO' ? 'ROMPIMENTO' : 'REVERSAO';
      updateSymbolModeUI(symbol, state.modes[symbol]);
    }

    logLearn(symbol, `wr20:${(wr20*100).toFixed(1)}% wr100:${(wr100*100).toFixed(1)}% minAtrMult:${m.minAtrMult.toFixed(2)} kO:${m.kOver} kU:${m.kUnder} rsiO:${m.rsiOver} rsiU:${m.rsiUnder}`);
    saveStore();
  }

  function adjustLearning(symbol) { 
    const day = state.store[state.dayKey]; 
    if (!day || !day.results) return; 

    const recent = day.results.filter(r => r.symbol === symbol).slice(0, 20); 
    if (recent.length < 10) return; 

    const wins = recent.filter(r => r.result === 'WIN').length; 
    const wr = (wins / recent.length) * 100; 

    if (wr < 60) { 
      state.modes[symbol] = state.modes[symbol] === 'REVERSAO' ? 'ROMPIMENTO' : 'REVERSAO'; 
      console.log(`[LEARN] ${symbol} winrate baixo (${wr.toFixed(1)}%), trocando modo para ${state.modes[symbol]}`); 
      updateSymbolModeUI(symbol, state.modes[symbol]);
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

  function initSystemToggles() {
    try {
      const elVoice = document.getElementById('toggleVoice');
      const elSounds = document.getElementById('toggleSounds');
      // 🔧 removido toggleAbstain: recurso descontinuado

      if (elVoice) {
        const v = !!(state?.settings?.voice ?? voiceEnabled);
        elVoice.checked = v;
        voiceEnabled = v;
        elVoice.addEventListener('change', () => {
          const on = !!elVoice.checked;
          state.settings.voice = on;
          voiceEnabled = on;
          saveStore();
          if (on) speak('Voz ativada');
        });
      }

      if (elSounds) {
        const sOn = state?.settings?.sounds !== false;
        elSounds.checked = sOn;
        elSounds.addEventListener('change', () => {
          state.settings.sounds = !!elSounds.checked;
          saveStore();
          if (elSounds.checked) { try { soundReconnect(); } catch (_) {} }
        });
      }

      // 🔧 removido bloco de abstenção: sem pausas após perdas

      // Sincroniza toggle legado na caixa de config, se existir
      const legacy = document.getElementById('voiceToggle');
      if (legacy) {
        const v = !!(state?.settings?.voice ?? voiceEnabled);
        legacy.checked = v;
        legacy.addEventListener('change', () => {
          const on = !!legacy.checked;
          state.settings.voice = on;
          voiceEnabled = on;
          saveStore();
          if (on) speak('Voz ativada');
          if (elVoice) elVoice.checked = on;
        });
      }
    } catch (_) { /* silencioso */ }
  }

  function populateVoices() {
    try {
      const ss = window.speechSynthesis;
      const select = document.getElementById('ttsVoiceSelect');
      if (!ss || !select) return;
      const voices = ss.getVoices ? ss.getVoices() || [] : [];

      const lower = s => (s || '').toLowerCase();
      let femaleVoices = voices.filter(v =>
        /^pt/i.test(v.lang) && (
          lower(v.name).includes('maria') ||
          lower(v.name).includes('letícia') || lower(v.name).includes('leticia') ||
          lower(v.name).includes('luciana') ||
          lower(v.name).includes('feminina') ||
          lower(v.name).includes('google') ||
          lower(v.name).includes('brasil') || lower(v.name).includes('brazil') ||
          lower(v.name).includes('camila') ||
          lower(v.name).includes('heloísa') || lower(v.name).includes('heloisa') ||
          lower(v.name).includes('fernanda') ||
          lower(v.name).includes('isabela') ||
          lower(v.name).includes('gabriela') ||
          lower(v.name).includes('vitoria') || lower(v.name).includes('vitória') ||
          lower(v.name).includes('bia') ||
          lower(v.name).includes('carla') ||
          lower(v.name).includes('paula')
        )
      );

      if (!femaleVoices.length) {
        femaleVoices = voices.filter(v => /^pt/i.test(v.lang));
      }

      if (!femaleVoices.length) {
        console.warn('Nenhuma voz pt-BR encontrada. Instale vozes femininas no sistema.');
      }

      select.innerHTML = femaleVoices.map(v => `<option value="${v.name}">${v.name} (${v.lang})</option>`).join('');
      const savedVoice = localStorage.getItem('ttsVoice');
      if (savedVoice && femaleVoices.some(v => v.name === savedVoice)) {
        select.value = savedVoice;
      } else if (femaleVoices[0]) {
        select.value = femaleVoices[0].name;
        localStorage.setItem('ttsVoice', femaleVoices[0].name);
      }
    } catch (_) { /* silencioso */ }
  }

  function initTTSControls() {
    try {
      const select = document.getElementById('ttsVoiceSelect');
      const btnTest = document.getElementById('testVoiceBtn');
      const rateSlider = document.getElementById('rateSlider');
      const pitchSlider = document.getElementById('pitchSlider');
      const volSlider = document.getElementById('volSlider');
      const rateVal = document.getElementById('rateVal');
      const pitchVal = document.getElementById('pitchVal');
      const volVal = document.getElementById('volVal');
      const ss = window.speechSynthesis;
      if (!select) return;

      const ensurePopulated = () => { try { populateVoices(); } catch (_) {} };

      if (ss && typeof ss.getVoices === 'function') {
        const have = ss.getVoices();
        if (have && have.length) ensurePopulated();
        setTimeout(ensurePopulated, 300);
        setTimeout(ensurePopulated, 1000);
      }

      // Carregar valores salvos
      const savedRate = parseFloat(localStorage.getItem('ttsRate') ?? '1.0');
      const savedPitch = parseFloat(localStorage.getItem('ttsPitch') ?? '1.0');
      const savedVol = parseFloat(localStorage.getItem('ttsVol') ?? '1.0');

      if (rateSlider && rateVal) {
        rateSlider.value = Number.isFinite(savedRate) ? savedRate : 1.0;
        rateVal.textContent = rateSlider.value;
        rateSlider.addEventListener('input', () => {
          rateVal.textContent = rateSlider.value;
          localStorage.setItem('ttsRate', rateSlider.value);
        });
      }
      if (pitchSlider && pitchVal) {
        pitchSlider.value = Number.isFinite(savedPitch) ? savedPitch : 1.0;
        pitchVal.textContent = pitchSlider.value;
        pitchSlider.addEventListener('input', () => {
          pitchVal.textContent = pitchSlider.value;
          localStorage.setItem('ttsPitch', pitchSlider.value);
        });
      }
      if (volSlider && volVal) {
        volSlider.value = Number.isFinite(savedVol) ? savedVol : 1.0;
        volVal.textContent = volSlider.value;
        volSlider.addEventListener('input', () => {
          volVal.textContent = volSlider.value;
          localStorage.setItem('ttsVol', volSlider.value);
        });
      }

      select.addEventListener('change', () => {
        const name = select.value;
        if (name) localStorage.setItem('ttsVoice', name);
        speak('Voz selecionada.');
      });

      if (btnTest) {
        btnTest.addEventListener('click', () => {
          speak('Teste de voz feminina em português do Brasil.');
        });
      }

      // Aviso discreto caso não haja vozes PT
      try {
        const voices = ss?.getVoices?.() || [];
        if (!voices.some(v => /^pt/i.test(v.lang))) {
          console.warn('Nenhuma voz pt-BR encontrada. Instale vozes femininas no sistema.');
        }
      } catch (_) { /* silencioso */ }
    } catch (_) { /* silencioso */ }
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
        state.store[state.dayKey] = { signals: [], results: [], stats: { total: 0, wins: 0, losses: 0, winrate: 0 }, saldoAtual: 0 };
        
        // ===== Resetar Banca e Parâmetros =====
        saldoAtual = 0.00;
        SALDO_INICIAL = 0.00;
        VALOR_ENTRADA = 1.00;
        PAYOUT = 0.89;
        // refletir na UI
        const valInput = document.getElementById('valorEntradaInput');
        const payInput = document.getElementById('payoutInput');
        if (valInput) valInput.value = VALOR_ENTRADA.toFixed(2);
        if (payInput) payInput.value = PAYOUT.toFixed(2);
        updateSaldoUI();
        
        saveStore();
        loadDayToUI();
        alert('✅ Dados, banca e parâmetros resetados para o padrão inicial!');
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
    initSystemToggles();
    initTTSControls();
    updateSaldoUI();
  }

  // Boot
  init();
})();