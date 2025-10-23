/*
  Crypto Shield Pro — JavaScript (no frameworks)
  - Busca candles da Binance
  - Calcula RSI(14), SMA9 e SMA21
  - Determina sinal (COMPRA / VENDA / NEUTRO), força e probabilidade
  - Atualiza UI e log técnico
*/

// Utilidades
const $ = (sel) => document.querySelector(sel);
const nowStr = () => new Date().toLocaleString('pt-BR');
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

// Mapeamentos
const symbolMap = {
  'BTC/USDT': 'BTCUSDT',
  'ETH/USDT': 'ETHUSDT',
  'XRP/USDT': 'XRPUSDT',
  'ADA/USDT': 'ADAUSDT',
  'SOL/USDT': 'SOLUSDT',
};

// Persistência simples
function loadPrefs(){
  try{
    const a = localStorage.getItem('csp_asset');
    const i = localStorage.getItem('csp_interval');
    if(a) $('#asset').value = a;
    if(i) $('#interval').value = i;
  }catch{}
}
function savePrefs(){
  try{
    localStorage.setItem('csp_asset', $('#asset').value);
    localStorage.setItem('csp_interval', $('#interval').value);
  }catch{}
}

// Binance API
async function fetchKlines(symbol, interval, limit=100){
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, {mode:'cors'});
  if(!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  // Extrair OHLC + times + volumes
  const opens = [], highs = [], lows = [], closes = [], times = [], volumes = [], closeTimes = [];
  for(const row of data){
    times.push(row[0]); // open time
    opens.push(parseFloat(row[1]));
    highs.push(parseFloat(row[2]));
    lows.push(parseFloat(row[3]));
    closes.push(parseFloat(row[4]));
    volumes.push(parseFloat(row[5]));
    closeTimes.push(row[6]);
  }
  return {opens, highs, lows, closes, times, volumes, closeTimes};
}

// Indicadores
function sma(values, period){
  if(values.length < period) return null;
  const sum = values.slice(values.length - period).reduce((a,b)=>a+b,0);
  return sum / period;
}

// Manter versão simples anterior para comparação
function rsiSimple(values, period=14){
  if(values.length < period+1) return null;
  const diffs = [];
  for(let i=1;i<values.length;i++) diffs.push(values[i]-values[i-1]);
  const recent = diffs.slice(diffs.length - period);
  let gains = 0, losses = 0;
  recent.forEach(d=>{ if(d>0) gains+=d; else losses-=d; });
  const avgGain = gains/period;
  const avgLoss = losses/period;
  if(avgLoss === 0) return 100;
  const rs = avgGain/avgLoss;
  return 100 - (100 / (1 + rs));
}

// RSI de Wilder (padrão de mercado)
function rsi(values, period = 14){
  // Wilder RSI (suavização exponencial dos ganhos/perdas)
  if(values.length < period + 1) return null;
  let gains = 0, losses = 0;
  for(let i = 1; i <= period; i++){
    const ch = values[i] - values[i-1];
    if(ch >= 0) gains += ch; else losses -= ch;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for(let i = period + 1; i < values.length; i++){
    const ch = values[i] - values[i-1];
    const gain = ch > 0 ? ch : 0;
    const loss = ch < 0 ? -ch : 0;
    // Wilder smoothing
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if(avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// Série de SMA (para plot e backtest)
function smaSeries(values, period){
  const out = new Array(values.length).fill(null);
  let runSum = 0;
  for(let i = 0; i < values.length; i++){
    runSum += values[i];
    if(i >= period) runSum -= values[i - period];
    if(i >= period - 1) out[i] = runSum / period;
  }
  return out;
}

// Série de RSI por candle (usa RSI Wilder já implementado)
function rsiSeries(values, period=14){
  const n = values.length;
  const arr = new Array(n).fill(null);
  for(let i=0; i<n; i++){
    const slice = values.slice(0, i+1);
    arr[i] = rsi(slice, period);
  }
  return arr;
}

// Determinação de sinal, força e probabilidade
function determineSignal({rsiNow, sma9Now, sma21Now, sma9Prev, sma21Prev}, strategy){
  const crossedUp = sma9Prev !== null && sma21Prev !== null && sma9Prev <= sma21Prev && sma9Now > sma21Now;
  const crossedDown = sma9Prev !== null && sma21Prev !== null && sma9Prev >= sma21Prev && sma9Now < sma21Now;
  let signal = 'NEUTRO';
  if(strategy === 'RSI Strategy'){
    if(rsiNow < 30) signal = 'COMPRA'; else if(rsiNow > 70) signal = 'VENDA';
  } else if(strategy === 'Moving Average Cross'){
    if(crossedUp) signal = 'COMPRA'; else if(crossedDown) signal = 'VENDA';
  } else { // Combined
    if(rsiNow < 30 && crossedUp) signal = 'COMPRA';
    else if(rsiNow > 70 && crossedDown) signal = 'VENDA';
  }
  // Força do sinal: distância do limiar + magnitude do cross
  const distRSI = signal==='COMPRA' ? (30 - rsiNow) : signal==='VENDA' ? (rsiNow - 70) : 0;
  const diffSMA = Math.abs(sma9Now - sma21Now);
  const relDiff = diffSMA / sma21Now; // magnitude relativa
  let strength = 'FRACO';
  if(relDiff > 0.003 && Math.abs(distRSI) > 5) strength = 'FORTE';
  else if(relDiff > 0.0015 || Math.abs(distRSI) > 2) strength = 'MÉDIO';
  // Probabilidade (heurística)
  let probBase = 50;
  probBase += clamp(relDiff*100, 0, 15);
  probBase += clamp(Math.abs(distRSI), 0, 15);
  if(signal === 'NEUTRO') probBase = 50;
  const prob = clamp(Math.round(probBase), 40, 90);
  return {signal, strength, prob};
}

// UI
function setProcessing(on){
  $('#processing').classList.toggle('hidden', !on);
  $('#run').disabled = on;
}
function updateUI({signal, strength, prob}){
  const sEl = $('#signal');
  const strEl = $('#strength');
  const pEl = $('#prob');
  sEl.textContent = signal;
  strEl.textContent = strength;
  pEl.textContent = prob + '%';
  // barra: mapear prob (50->neutro, >50->mais vermelho no fim)
  $('#bar-fill').style.width = clamp(prob,0,100) + '%';
  const statusCard = document.querySelector('.status');
  statusCard.classList.toggle('glow-strong', strength === 'FORTE');
}
function logTechnical({rsiNow, sma9Now, sma21Now, signal}){
  const txt = `RSI: ${rsiNow?.toFixed(2)} | SMA9: ${sma9Now?.toFixed(2)} | SMA21: ${sma21Now?.toFixed(2)} \nSinal: ${signal}`;
  $('#log').textContent = txt;
}
function setLastRun(){ $('#last-run').textContent = nowStr(); }

// Fluxo principal
async function runAnalysis(){
  try{
    setProcessing(true);
    savePrefs();
    const assetLabel = $('#asset').value;
    const symbol = symbolMap[assetLabel];
    const interval = $('#interval').value;
    const strategy = $('#strategy').value;

    const {opens, highs, lows, closes, times} = await fetchKlines(symbol, interval, 100);
    if(closes.length < 30){ throw new Error('Poucos dados retornados'); }

    // Calcular indicadores (RSI Wilder)
    const rsiNow = rsi(closes, 14);
    const sma9Now = sma(closes, 9);
    const sma21Now = sma(closes, 21);
    const sma9Prev = sma(closes.slice(0, closes.length-1), 9);
    const sma21Prev = sma(closes.slice(0, closes.length-1), 21);

    // já temos closes; agora calc séries para plot
    const sma9Arr = smaSeries(closes, 9);
    const sma21Arr = smaSeries(closes, 21);

    // probabilidade: mistura heurística atual + mini-backtest
    const backtestProb = miniBacktest(closes);
    const {signal, strength, prob: heurProb} =
      determineSignal({rsiNow, sma9Now, sma21Now, sma9Prev, sma21Prev}, strategy);

    // combine (peso maior para backtest, mas sem ignorar heurística)
    const combinedProb = Math.round((backtestProb*0.65) + (heurProb*0.35));
    updateUI({signal, strength, prob: combinedProb});

    // gráfico
    drawChart({
      opens, highs, lows, closes,
      sma9Arr, sma21Arr
    });

    logTechnical({rsiNow, sma9Now, sma21Now, signal});
    setLastRun();
  } catch(err){
    console.error(err);
    $('#log').textContent = `Erro: ${err.message || err}`;
    updateUI({signal:'NEUTRO', strength:'FRACO', prob:50});
  } finally {
    setProcessing(false);
  }
}

// Mini-backtest para estimativa de probabilidade
function miniBacktest(closes){
  // regra simples: COMPRA se RSI<30 e cruzamento SMA9↑SMA21, VENDA se RSI>70 e cruzamento SMA9↓SMA21
  // avaliação: +1 se após 3 candles o preço foi na direção do sinal (>0 para compra, <0 para venda)
  if(closes.length < 60) return 50;
  const sma9 = smaSeries(closes, 9);
  const sma21 = smaSeries(closes, 21);

  let hits = 0, total = 0;
  for(let i = 22; i < closes.length - 3; i++){
    // RSI no ponto i com Wilder
    const r = rsi(closes.slice(0, i+1), 14);
    const s9Now = sma9[i], s21Now = sma21[i];
    const s9Prev = sma9[i-1], s21Prev = sma21[i-1];
    if([r, s9Now, s21Now, s9Prev, s21Prev].some(v => v == null)) continue;

    const crossedUp = s9Prev <= s21Prev && s9Now > s21Now;
    const crossedDown = s9Prev >= s21Prev && s9Now < s21Now;

    let sig = 'NEUTRO';
    if(r < 30 && crossedUp) sig = 'COMPRA';
    else if(r > 70 && crossedDown) sig = 'VENDA';

    if(sig !== 'NEUTRO'){
      const ret = closes[i+3] - closes[i];
      const ok = (sig === 'COMPRA' && ret > 0) || (sig === 'VENDA' && ret < 0);
      if(ok) hits++;
      total++;
    }
  }
  if(total === 0) return 50;
  // mapear para 45–90 para não prometer demais
  const pct = (hits / total) * 100;
  return clamp(Math.round(45 + (pct * 0.45)), 45, 90);
}

// Inicialização
function safeStreamUpdate(){
  try{
    const assetLabel = document.getElementById('asset').value;
    const symbol = symbolMap[assetLabel];
    const interval = document.getElementById('interval').value;
    startKlineStream(symbol, interval);
  }catch(e){
    console.error('safeStreamUpdate error', e);
  }
}


// Desenho do gráfico de candles + SMA9/SMA21 + painel RSI
function drawChart({opens, highs, lows, closes, sma9Arr, sma21Arr}){
  const cvs = document.getElementById('chart');
  if(!cvs) return;
  const ctx = cvs.getContext('2d');
  const W = cvs.width, H = cvs.height;
  ctx.clearRect(0,0,W,H);

  const n = closes.length;
  const padL = 40, padR = 20, padT = 20, padB = 20;

  // dividir em 75% preço, 25% RSI dentro da área útil
  const usableH = H - padT - padB;
  const hPrice = Math.floor(usableH * 0.75);
  const priceTop = padT;
  const priceBot = padT + hPrice - 4; // ligeiro espaço para divisor

  const hRSI = usableH - hPrice;
  const rsiTop = priceBot + 4 + 6; // separação visual
  const rsiBot = H - padB;

  // --- Painel de preços (candles + SMAs) ---
  const minP = Math.min(...lows.filter(Number.isFinite));
  const maxP = Math.max(...highs.filter(Number.isFinite));
  const hY = (maxP - minP) || 1;
  const x = i => padL + (i * ((W - padL - padR) / Math.max(1, (n - 1))));
  const yPrice = p => priceTop + (maxP - p) * ((priceBot - priceTop) / hY);

  // grid leve (apenas no painel superior)
  ctx.strokeStyle = 'rgba(0,255,174,0.08)';
  ctx.lineWidth = 1;
  for(let k=0;k<6;k++){
    const yy = priceTop + (k/5)*(priceBot - priceTop);
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W-padR, yy); ctx.stroke();
  }

  // candles
  const barW = Math.max(2, (W - padL - padR) / n * 0.6);
  for(let i=0;i<n;i++){
    const up = closes[i] >= opens[i];
    ctx.strokeStyle = up ? '#08e3a5' : '#ff4d4d';
    ctx.fillStyle = ctx.strokeStyle;
    // pavio
    ctx.beginPath();
    ctx.moveTo(x(i), yPrice(highs[i]));
    ctx.lineTo(x(i), yPrice(lows[i]));
    ctx.stroke();
    // corpo
    const y1 = yPrice(opens[i]), y2 = yPrice(closes[i]);
    const top = Math.min(y1, y2), hBody = Math.max(1, Math.abs(y1 - y2));
    ctx.fillRect(x(i) - barW/2, top, barW, hBody);
  }

  // SMA 9
  ctx.strokeStyle = '#00ffae';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for(let i=0;i<n;i++){
    if(sma9Arr[i] == null) continue;
    const xx = x(i), yy = yPrice(sma9Arr[i]);
    if(i===0 || sma9Arr[i-1]==null) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
  }
  ctx.stroke();

  // SMA 21
  ctx.strokeStyle = '#ffd166';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for(let i=0;i<n;i++){
    if(sma21Arr[i] == null) continue;
    const xx = x(i), yy = yPrice(sma21Arr[i]);
    if(i===0 || sma21Arr[i-1]==null) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
  }
  ctx.stroke();

  // divisor entre painéis
  ctx.strokeStyle = 'rgba(0,255,174,0.15)';
  ctx.beginPath(); ctx.moveTo(padL, priceBot + 4); ctx.lineTo(W-padR, priceBot + 4); ctx.stroke();

  // --- Painel de RSI ---
  const rsiArr = rsiSeries(closes, 14);
  drawRSIPanel(ctx, rsiArr, padL, padR, rsiTop, rsiBot);
}

function drawRSIPanel(ctx, rsiArr, padL, padR, yTop, yBot){
  const W = ctx.canvas.width;
  const n = rsiArr.length;
  const x = i => padL + i * ((W - padL - padR) / Math.max(1, (n - 1)));
  const y = v => yTop + (100 - v) * ((yBot - yTop) / 100);

  // Faixa 30–70
  ctx.fillStyle = 'rgba(0,255,174,0.08)';
  ctx.fillRect(padL, y(70), W - padL - padR, y(30)-y(70));

  // Linhas horizontais e labels
  ctx.strokeStyle = 'rgba(0,255,174,0.15)';
  [30,50,70].forEach(v=>{
    const yy = y(v);
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(W-padR, yy); ctx.stroke();
    ctx.fillStyle = '#9fb6ab';
    ctx.font = '10px Poppins'; ctx.textAlign = 'right';
    ctx.fillText(v, W-padR-2, yy-2);
  });

  // Linha RSI
  ctx.strokeStyle = '#00ffae';
  ctx.lineWidth = 1.8;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  for(let i=0;i<n;i++){
    const v=rsiArr[i]; if(v==null) continue;
    const xx=x(i), yy=y(v);
    if(i===0||rsiArr[i-1]==null) ctx.moveTo(xx,yy); else ctx.lineTo(xx,yy);
  }
  ctx.stroke();
}

// Data store e WebSocket
let ws = null;
let md = { opens:[], highs:[], lows:[], closes:[], times:[], volumes:[], lastCloseTime: null };
const intervalMsMap = { '1m': 60000, '5m': 300000, '15m': 900000 };
let pollTimer = null;
let wsAttempts = 0;
let wsUse443 = false;
function clearPolling(){
  if(pollTimer){ clearInterval(pollTimer); pollTimer = null; }
}

function avgVolume(arr, period){
  if(!arr || arr.length===0) return 0;
  const n = Math.min(arr.length, period);
  const slice = arr.slice(arr.length - n);
  const sum = slice.reduce((a,b)=>a+b,0);
  return sum / n;
}

function calcCandleCountdown(interval){
  const ms = intervalMsMap[interval] || 60000;
  const base = md.lastCloseTime ?? ((md.times[md.times.length-1] || Date.now()) + ms);
  const remainingMs = Math.max(0, base - Date.now());
  return Math.floor(remainingMs / 1000);
}

async function fetchDepth(symbol){
  const url = `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=50`;
  const res = await fetch(url, {mode:'cors'});
  if(!res.ok) throw new Error(`Depth HTTP ${res.status}`);
  const data = await res.json();
  const sumSide = (arr) => (arr||[]).reduce((acc, pair)=> acc + parseFloat(pair[1]), 0);
  const bidsVol = sumSide(data.bids);
  const asksVol = sumSide(data.asks);
  return {bidsVol, asksVol};
}

async function bootstrapStream(){
  try{
    const assetLabel = document.getElementById('asset').value;
    const symbol = symbolMap[assetLabel];
    const interval = document.getElementById('interval').value;
    const {opens, highs, lows, closes, times, volumes, closeTimes} = await fetchKlines(symbol, interval, 100);
    md.opens = opens; md.highs = highs; md.lows = lows; md.closes = closes; md.times = times; md.volumes = volumes;
    md.lastCloseTime = closeTimes?.[closeTimes.length-1] ?? null;
    const sma9Arr = smaSeries(closes, 9);
    const sma21Arr = smaSeries(closes, 21);
    drawChart({opens, highs, lows, closes, sma9Arr, sma21Arr});
    startCountdownTimer(interval);
    startKlineStream(symbol, interval);
  }catch(err){ console.error(err); }
}

function startPolling(symbol, interval){
  clearPolling();
  pollTimer = setInterval(async ()=>{
    try{
      const {opens, highs, lows, closes, volumes} = await fetchKlines(symbol, interval, 100);
      md.opens = opens; md.highs = highs; md.lows = lows; md.closes = closes; md.volumes = volumes;
      const sma9Arr = smaSeries(md.closes, 9);
      const sma21Arr = smaSeries(md.closes, 21);
      drawChart({opens: md.opens, highs: md.highs, lows: md.lows, closes: md.closes, sma9Arr, sma21Arr});
      const tl = calcCandleCountdown(interval);
      const cEl = document.getElementById('countdown');
      if(cEl) cEl.textContent = tl > 0 ? `Expira em ${tl}s` : 'Fechando...';
    }catch(e){ console.error('Polling error', e); }
  }, 5000);
}
function scheduleReconnect(symbol, interval){
  const backoff = Math.min(30000, 2000 * (++wsAttempts));
  if(wsAttempts >= 2) wsUse443 = true; // trocar para porta 443 após 2 tentativas
  setWsStatus(`Tentando reconectar em ${Math.round(backoff/1000)}s...`);
  setTimeout(()=>{
    try{
      startKlineStream(symbol, interval);
    }catch(e){ console.error('Reconnect attempt failed', e); }
  }, backoff);
}
function startKlineStream(symbol, interval){
  try{ if(ws) ws.close(); }catch{}
  clearPolling();
  wsAttempts = 0;
  const streamName = `${symbol.toLowerCase()}@kline_${interval}`;
  const host = wsUse443 ? 'wss://stream.binance.com:443/ws/' : 'wss://stream.binance.com:9443/ws/';
  ws = new WebSocket(`${host}${streamName}`);
  ws.onopen = ()=>{ setWsStatus(`WS conectado: ${symbol}@${interval}`); wsAttempts = 0; clearPolling(); startCountdownTimer(interval); };
  ws.onmessage = (ev)=>{
    try{
      const msg = JSON.parse(ev.data);
      if(!msg.k) return;
      const k = msg.k;
      const o = parseFloat(k.o), h = parseFloat(k.h), l = parseFloat(k.l), c = parseFloat(k.c), v = parseFloat(k.v);
      const isClosed = k.x;
      const lastIdx = md.closes.length - 1;
      if(isClosed){
        md.opens.push(o); md.highs.push(h); md.lows.push(l); md.closes.push(c); md.volumes.push(v); md.times.push(k.t);
        md.lastCloseTime = k.T;
        if(md.closes.length > 100){
          md.opens.shift(); md.highs.shift(); md.lows.shift(); md.closes.shift(); md.volumes.shift(); md.times.shift();
        }
      }else{
        if(lastIdx >= 0){
          md.opens[lastIdx] = o; md.highs[lastIdx] = h; md.lows[lastIdx] = l; md.closes[lastIdx] = c; md.volumes[lastIdx] = v;
        }
        md.lastCloseTime = k.T;
      }
      const sma9Arr = smaSeries(md.closes, 9);
      const sma21Arr = smaSeries(md.closes, 21);
      drawChart({opens: md.opens, highs: md.highs, lows: md.lows, closes: md.closes, sma9Arr, sma21Arr});
      const tl = calcCandleCountdown(interval);
      const cEl = document.getElementById('countdown');
      if(cEl) cEl.textContent = tl > 0 ? `Expira em ${tl}s` : 'Fechando...';
    }catch(e){ console.error('WS onmessage error', e); }
  };
  ws.onerror = (err)=>{
    setWsStatus(`WS erro: ${err?.message || 'desconhecido'}`);
    console.error('WS error', err);
  };
  ws.onclose = (ev)=>{
    setWsStatus('WS fechado. Iniciando fallback via polling...');
    console.warn('WS closed');
    startPolling(symbol, interval);
    scheduleReconnect(symbol, interval);
  };
}

// ATL (Adaptive Trend Learning) — memória local
let trendMemory = [];
let lastAnalysisCtx = { signal: null, direction: null, slope: 0, touches: 0, closePrice: null, timestamp: null };
let lastATLResult = null; // 'WIN' | 'LOSS' | null

function loadTrendMemory(){
  try { trendMemory = JSON.parse(localStorage.getItem('trendMemory') || '[]'); } catch { trendMemory = []; }
  return trendMemory;
}
function saveTrendMemory(){
  try { localStorage.setItem('trendMemory', JSON.stringify(trendMemory.slice(-200))); } catch {}
}
function purgeOldTrendMemory(){
  const maxAgeMs = 3*24*60*60*1000; // 72h
  const now = Date.now();
  trendMemory = (trendMemory || []).filter(t => now - (t.timestamp||0) < maxAgeMs);
  saveTrendMemory();
}
function computeDirectionAccuracy(direction){
  const items = (trendMemory || []).filter(t => t.direction === direction);
  const total = items.length;
  const wins = items.filter(t => t.result === 'WIN').length;
  const accuracy = total > 0 ? wins / total : 0.5;
  return { accuracy, wins, total };
}
function adjustProbWithATL(baseProb, direction){
  const { accuracy } = computeDirectionAccuracy(direction);
  const adjusted = Math.round(baseProb * (0.8 + accuracy * 0.4));
  return clamp(adjusted, 40, 95);
}
function recordATLOutcomeFromLastCtx(currentClose){
  if(!lastAnalysisCtx || !lastAnalysisCtx.signal || lastAnalysisCtx.closePrice == null) return;
  const dir = lastAnalysisCtx.direction; // 'LTA' | 'LTB'
  let result = 'LOSS';
  if(lastAnalysisCtx.signal === 'COMPRA' && currentClose > lastAnalysisCtx.closePrice) result = 'WIN';
  else if(lastAnalysisCtx.signal === 'VENDA' && currentClose < lastAnalysisCtx.closePrice) result = 'WIN';
  lastATLResult = result;
  // salvar entrada
  trendMemory.push({
    slope: lastAnalysisCtx.slope,
    direction: dir,
    touches: lastAnalysisCtx.touches,
    result,
    timestamp: Date.now()
  });
  purgeOldTrendMemory();
}
function makeDirectionFromSignal(sig){
  if(sig === 'COMPRA') return 'LTA';
  if(sig === 'VENDA') return 'LTB';
  return 'NEUTRO';
}
function estimateSlopeNormalized(closes){
  const n = closes.length;
  if(n < 2) return 0;
  const prev = closes[n-2];
  const now = closes[n-1];
  const denom = Math.max(1e-8, prev);
  return (now - prev) / denom; // ~ variação percentual
}

async function analyzeNow(){
  try{
    setProcessing(true);
    savePrefs();
    const assetLabel = document.getElementById('asset').value;
    const symbol = symbolMap[assetLabel];
    const interval = document.getElementById('interval').value;

    // ATL boot + purge
    loadTrendMemory();
    purgeOldTrendMemory();

    // garantir dados suficientes
    if(md.closes.length < 30){
      const {opens, highs, lows, closes, times, volumes, closeTimes} = await fetchKlines(symbol, interval, 100);
      md.opens = opens; md.highs = highs; md.lows = lows; md.closes = closes; md.times = times; md.volumes = volumes;
      md.lastCloseTime = closeTimes?.[closeTimes.length-1] ?? null;
      const sma9Arr = smaSeries(closes, 9);
      const sma21Arr = smaSeries(closes, 21);
      drawChart({opens, highs, lows, closes, sma9Arr, sma21Arr});
    }

    // Se existir contexto anterior, avaliar resultado com o último close
    const currentClose = md.closes[md.closes.length-1];
    recordATLOutcomeFromLastCtx(currentClose);

    const {bidsVol, asksVol} = await fetchDepth(symbol);

    const rsiNow = rsi(md.closes, 14);
    const sma9Now = sma(md.closes, 9);
    const sma21Now = sma(md.closes, 21);
    const sma9Prev = sma(md.closes.slice(0, md.closes.length-1), 9);
    const sma21Prev = sma(md.closes.slice(0, md.closes.length-1), 21);
    const volNow = md.volumes[md.volumes.length-1] ?? 0;
    const volAvg = avgVolume(md.volumes, 20);

    const crossedUp = sma9Prev<=sma21Prev && sma9Now>sma21Now;
    const crossedDown = sma9Prev>=sma21Prev && sma9Now<sma21Now;
    const bookDiff = (bidsVol-asksVol)/Math.max(1,(bidsVol+asksVol));
    const volDiff  = (volNow-volAvg)/Math.max(1,volAvg);
    const timeLeft = calcCandleCountdown(interval);

    const strategy = document.getElementById('strategy').value;

    let signal='NEUTRO';
    let winChance, buyPct, sellPct, strength;

    if (strategy === 'Smart Adaptive Signal') {
      const rsiScore = rsiNow < 30 ? 0.8 : rsiNow > 70 ? -0.8 : 0;
      const maScore = sma9Now > sma21Now ? 0.6 : sma9Now < sma21Now ? -0.6 : 0;
      const volumeScore = clamp(volDiff, -1, 1);
      const bookScore = clamp(bookDiff, -1, 1);
      const score = (rsiScore * 0.25) + (maScore * 0.35) + (volumeScore * 0.2) + (bookScore * 0.2);
      if (score > 0.25) signal = 'COMPRA'; else if (score < -0.25) signal = 'VENDA';
      const baseProb = clamp(Math.round(50 + (score * 50)), 40, 95);

      const direction = makeDirectionFromSignal(signal);
      const probAdj = direction !== 'NEUTRO' ? adjustProbWithATL(baseProb, direction) : baseProb;
      winChance = probAdj;

      buyPct = clamp(Math.round(50 + (bookScore * 50)), 0, 100);
      sellPct = 100 - buyPct;
      strength = Math.abs(score) > 0.6 ? 'FORTE' : Math.abs(score) > 0.3 ? 'MÉDIO' : 'FRACO';

      updateUI({signal, strength, prob: winChance});
      const bsEl = document.getElementById('buy-sell');
      if(bsEl) bsEl.textContent = `${buyPct}% / ${sellPct}%`;
      const sEl = document.getElementById('signal');
      if(sEl) sEl.style.color = signal==='COMPRA' ? '#08e3a5' : signal==='VENDA' ? '#ff4d4d' : '#ffd166';

      const { accuracy: accLTA } = computeDirectionAccuracy('LTA');
      const { accuracy: accLTB } = computeDirectionAccuracy('LTB');
      const lastTxt = lastATLResult ? lastATLResult : '—';
      document.getElementById('log').textContent =
        `Estratégia: Smart Adaptive\n` +
        `RSI: ${rsiNow.toFixed(2)} | SMA9: ${sma9Now.toFixed(2)} | SMA21: ${sma21Now.toFixed(2)}\n` +
        `Vol: ${volNow.toFixed(2)} / ${volAvg.toFixed(2)} | Book Δ ${(bookDiff * 100).toFixed(1)}%\n` +
        `Score: ${(score * 100).toFixed(1)} | ${signal} (${winChance}% chance)\n` +
        `Histórico LTA: ${(accLTA*100).toFixed(0)}% acerto | LTB: ${(accLTB*100).toFixed(0)}% acerto | Último resultado: ${lastTxt}`;
    } else {
      if(rsiNow<30 && crossedUp && bidsVol>asksVol) signal='COMPRA';
      else if(rsiNow>70 && crossedDown && asksVol>bidsVol) signal='VENDA';

      const baseProb = clamp(Math.round(50 + bookDiff*30 + volDiff*20), 40, 95);
      const direction = makeDirectionFromSignal(signal);
      const probAdj = direction !== 'NEUTRO' ? adjustProbWithATL(baseProb, direction) : baseProb;
      winChance = probAdj;

      buyPct = clamp(Math.round(50 + (bookDiff*50)), 0, 100);
      sellPct = 100 - buyPct;
      strength = 'MÉDIO';

      updateUI({signal, strength, prob: winChance});
      const bsEl = document.getElementById('buy-sell');
      if(bsEl) bsEl.textContent = `${buyPct.toFixed(1)}% / ${sellPct.toFixed(1)}%`;
      const sEl = document.getElementById('signal');
      if(sEl) sEl.style.color = signal==='COMPRA' ? '#08e3a5' : signal==='VENDA' ? '#ff4d4d' : '#ffd166';

      const { accuracy: accLTA } = computeDirectionAccuracy('LTA');
      const { accuracy: accLTB } = computeDirectionAccuracy('LTB');
      const lastTxt = lastATLResult ? lastATLResult : '—';
      document.getElementById('log').textContent =
        `RSI: ${rsiNow?.toFixed(2)} | Vol: ${volNow?.toFixed(2)}/${volAvg?.toFixed(2)} | Book Δ ${(bookDiff*100).toFixed(1)}%\n`+
        `Sinal: ${signal} | WinChance: ${winChance}% | Compra: ${buyPct.toFixed(1)}% | Venda: ${sellPct.toFixed(1)}%\n`+
        `Expira em ${timeLeft}s\n`+
        `Histórico LTA: ${(accLTA*100).toFixed(0)}% acerto | LTB: ${(accLTB*100).toFixed(0)}% acerto | Último resultado: ${lastTxt}`;
    }

    // Atualizar contexto para próxima avaliação ATL (apenas se houver sinal decisivo)
    if(signal !== 'NEUTRO'){
      lastAnalysisCtx.signal = signal;
      lastAnalysisCtx.direction = makeDirectionFromSignal(signal);
      lastAnalysisCtx.slope = estimateSlopeNormalized(md.closes);
      lastAnalysisCtx.touches = 3; // placeholder até MTM completo
      lastAnalysisCtx.closePrice = md.closes[md.closes.length-1];
      lastAnalysisCtx.timestamp = Date.now();
    }

    setLastRun();
  }catch(err){
    console.error(err);
    document.getElementById('log').textContent = `Erro: ${err.message || err}`;
  }finally{
    setProcessing(false);
  }
}

let lastWsStatusTs = 0;
function setWsStatus(text){
  const el = document.getElementById('ws-status');
  if(!el) return;
  const now = Date.now();
  if(el.textContent === text && (now - lastWsStatusTs) < 800) return;
  el.textContent = text;
  lastWsStatusTs = now;
}
// Adiciona indicador Auto ON/OFF ao lado do ws-status
function setAutoIndicator(on){
  const wsEl = document.getElementById('ws-status');
  if(!wsEl) return;
  let ind = document.getElementById('auto-indicator');
  if(!ind){
    ind = document.createElement('span');
    ind.id = 'auto-indicator';
    ind.style.marginLeft = '8px';
    wsEl.appendChild(ind);
  }
  ind.textContent = on ? '🟢 Auto ON' : '⚪ Auto OFF';
}
// Countdown fluido a cada 1s
let countdownTimer = null;
function clearCountdownTimer(){
  if(countdownTimer){ clearInterval(countdownTimer); countdownTimer = null; }
}
function startCountdownTimer(interval){
  clearCountdownTimer();
  countdownTimer = setInterval(()=>{
    const tl = calcCandleCountdown(interval);
    const cEl = document.getElementById('countdown');
    if(cEl) cEl.textContent = tl > 0 ? `Expira em ${tl}s` : 'Fechando...';
  }, 1000);
}
let autoMode = false;
let autoTimer = null;
let unloadGuardHandler = null;
function setUnloadGuard(enable){
  if(enable && !unloadGuardHandler){
    unloadGuardHandler = (e)=>{ e.preventDefault(); e.returnValue=''; };
    window.addEventListener('beforeunload', unloadGuardHandler);
  } else if(!enable && unloadGuardHandler){
    window.removeEventListener('beforeunload', unloadGuardHandler);
    unloadGuardHandler = null;
  }
}
function setAutoMode(on){
  autoMode = on;
  const btn = document.getElementById('auto-toggle');
  if(btn){
    btn.textContent = on ? '⏸️ Parar Automático' : '🤖 Iniciar Automático';
    btn.style.background = on
      ? 'linear-gradient(90deg,#ff4d4d,#ff8080)'
      : 'linear-gradient(90deg,var(--accent),var(--accent-soft))';
  }
  setAutoIndicator(on);
  setUnloadGuard(on);
  if(on){
    if(autoTimer) clearInterval(autoTimer);
    autoTimer = setInterval(async ()=>{
      try {
        const tl = calcCandleCountdown(document.getElementById('interval').value);
        if (tl <= 1) {
          await analyzeNow();
        } else {
          const logEl = document.getElementById('log');
          if (logEl) {
            const lines = (logEl.textContent || '').split('\n').filter(l => !l.startsWith('Aguardando fechamento do candle'));
            logEl.textContent = [...lines, `Aguardando fechamento do candle (${tl}s)...`].join('\n');
          }
        }
      } catch(err){
        console.error('Auto analyze error:', err);
      }
    }, 1000);
  } else {
    if(autoTimer) clearInterval(autoTimer);
  }
}


function drawATLChart(){
  const cvs = document.getElementById('atl-chart');
  if(!cvs) return;
  const ctx = cvs.getContext('2d');
  const W = cvs.width, H = cvs.height;
  ctx.clearRect(0,0,W,H);
  const trendMemory = loadTrendMemory();
  const last = trendMemory.slice(-50);
  if(!last.length) return;
  const acc = [];
  let wins=0;
  for(let i=0;i<last.length;i++){
    if(last[i].result==='WIN') wins++;
    acc.push((wins/(i+1))*100);
  }
  const x = i => (i/(last.length-1)) * (W-20) + 10;
  const y = v => H - (v/100) * (H-10) - 5;
  ctx.strokeStyle='#00ffae';
  ctx.lineWidth=2;
  ctx.shadowColor='rgba(0,255,174,0.4)';
  ctx.shadowBlur=6;
  ctx.beginPath();
  for(let i=0;i<acc.length;i++){
    const xx=x(i), yy=y(acc[i]);
    if(i===0) ctx.moveTo(xx,yy); else ctx.lineTo(xx,yy);
  }
  ctx.stroke();
  ctx.shadowBlur=0;
  // 50% reference line
  ctx.strokeStyle='rgba(255,77,77,0.3)';
  ctx.setLineDash([4,3]);
  ctx.beginPath();
  ctx.moveTo(10, y(50));
  ctx.lineTo(W-10, y(50));
  ctx.stroke();
  ctx.setLineDash([]);
  // points
  for(let i=0;i<last.length;i++){
    ctx.fillStyle = last[i].result==='WIN' ? '#00d494' : '#ff4d4d';
    ctx.beginPath();
    ctx.arc(x(i), y(acc[i]), 3, 0, Math.PI*2);
    ctx.fill();
  }
  // summary text
  const accLTA = computeDirectionAccuracy('LTA');
  const accLTB = computeDirectionAccuracy('LTB');
  const summary = document.getElementById('atl-summary');
  if(summary) summary.textContent = `Performance (últimos ${last.length} sinais) — LTA: ${(accLTA.accuracy*100).toFixed(1)}% | LTB: ${(accLTB.accuracy*100).toFixed(1)}%`;
}
// Inicialização única (DOMContentLoaded)
window.addEventListener('DOMContentLoaded', () => {
  try {
    loadPrefs();
    const runBtnEl = document.getElementById('run');
    if (runBtnEl) runBtnEl.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); runAnalysis(); });

    const analyzeBtn = document.getElementById('analyze');
    if (analyzeBtn) analyzeBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); analyzeNow(); });

    bootstrapStream();

    const runBtn = document.getElementById('analyze');
    if (runBtn && !document.getElementById('auto-toggle')) {
      const autoBtn = document.createElement('button');
      autoBtn.id = 'auto-toggle';
      autoBtn.className = 'btn-primary';
      autoBtn.type = 'button';
      autoBtn.style.marginLeft = '8px';
      autoBtn.innerHTML = '🤖 Iniciar Automático';
      autoBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); setAutoMode(!autoMode); });
      runBtn.insertAdjacentElement('afterend', autoBtn);
    }
    setAutoIndicator(false);

    const onChange = () => {
      savePrefs();
      const wasAuto = autoMode;
      if (wasAuto) setAutoMode(false);
      safeStreamUpdate();
      if (wasAuto) setAutoMode(true);
    };
    const assetEl = document.getElementById('asset');
    const intervalEl = document.getElementById('interval');
    assetEl?.addEventListener('change', onChange);
    intervalEl?.addEventListener('change', onChange);

    // Render inicial do painel ATL a partir da memória existente
    try { drawATLChart(); } catch(e) { console.warn('ATL chart initial draw fail', e); }
  } catch(err) {
    console.error('DOMContentLoaded init error', err);
  }
});

// ✅ Atualiza o gráfico sempre que a memória muda
const _orig_recordATLOutcomeFromLastCtx = recordATLOutcomeFromLastCtx;
recordATLOutcomeFromLastCtx = function(){
  const res = _orig_recordATLOutcomeFromLastCtx.apply(this, arguments);
  try { drawATLChart(); } catch(e) { console.warn('ATL chart draw fail', e); }
  return res;
};

// ✅ Atualiza o gráfico após análise
const _orig_analyzeNow = analyzeNow;
analyzeNow = async function(){
  const r = await _orig_analyzeNow.apply(this, arguments);
  try { drawATLChart(); } catch(e) { console.warn('ATL chart update fail', e); }
  return r;
};