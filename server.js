const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const WebSocket = require('ws');
const protobuf = require('protobufjs');

const PORT = process.env.PORT || 3000;
const SYMBOL = 'ZECUSDT';
const MEXC_WS = 'wss://wbs-api.mexc.com/ws';
const CHANNEL = `spot@public.limit.depth.v3.api.pb@${SYMBOL}@20`;
const SPREAD_RATE = Number(process.env.LL_SPREAD_PERCENT || 1.5) / 100;
const LIVE_TRADING = process.env.ENABLE_LIVE_TRADING === 'true';
const MAX_HEDGE_USDT = Number(process.env.MAX_HEDGE_USDT || 1000);
const processedTrades = new Map();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, symbol: SYMBOL, spreadPercent: SPREAD_RATE * 100, liveTrading: LIVE_TRADING }));

function requireInternalAuth(req, res, next) {
  const expected = process.env.HEDGE_WEBHOOK_SECRET;
  const supplied = req.get('x-hedge-secret');
  if (!expected || !supplied || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return res.status(401).json({ error: 'Unauthorized hedge request' });
  }
  next();
}

async function placeMexcMarketOrder({ side, quantity, quoteOrderQty, clientOrderId }) {
  const apiKey = process.env.MEXC_API_KEY;
  const secret = process.env.MEXC_API_SECRET;
  if (!apiKey || !secret) throw new Error('MEXC trade credentials are not configured');
  const params = new URLSearchParams({
    symbol: SYMBOL,
    side,
    type: 'MARKET',
    newClientOrderId: clientOrderId,
    recvWindow: '5000',
    timestamp: String(Date.now())
  });
  if (side === 'BUY') params.set('quoteOrderQty', String(quoteOrderQty));
  else params.set('quantity', String(quantity));
  const signature = crypto.createHmac('sha256', secret).update(params.toString()).digest('hex');
  params.set('signature', signature);
  const response = await fetch('https://api.mexc.com/api/v3/order', {
    method: 'POST',
    headers: { 'X-MEXC-APIKEY': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const result = await response.json();
  if (!response.ok || result.code) throw new Error(result.msg || `MEXC order failed (${response.status})`);
  return result;
}

// Call only from the trusted Lovely Legends backend after its customer order is accepted.
app.post('/api/hedge', requireInternalAuth, async (req, res) => {
  const { tradeId, customerSide, quantity, quoteAmount } = req.body || {};
  const side = String(customerSide || '').toUpperCase();
  const qty = Number(quantity);
  const quote = Number(quoteAmount);
  if (!tradeId || !['BUY', 'SELL'].includes(side)) return res.status(400).json({ error: 'tradeId and customerSide (BUY/SELL) are required' });
  if (processedTrades.has(tradeId)) return res.json(processedTrades.get(tradeId));
  if (side === 'BUY' && (!Number.isFinite(quote) || quote <= 0 || quote > MAX_HEDGE_USDT)) return res.status(400).json({ error: `quoteAmount must be between 0 and ${MAX_HEDGE_USDT} USDT` });
  if (side === 'SELL' && (!Number.isFinite(qty) || qty <= 0)) return res.status(400).json({ error: 'A positive quantity is required for SELL' });

  const tradeHash = crypto.createHash('sha256').update(String(tradeId)).digest('hex').slice(0, 20);
  const clientOrderId = `ll_${tradeHash}`;
  try {
    const hedge = LIVE_TRADING
      ? await placeMexcMarketOrder({ side, quantity: qty, quoteOrderQty: quote, clientOrderId })
      : { simulated: true, symbol: SYMBOL, side, type: 'MARKET', quantity: side === 'SELL' ? qty : undefined, quoteOrderQty: side === 'BUY' ? quote : undefined };
    const response = { ok: true, live: LIVE_TRADING, tradeId, hedge };
    processedTrades.set(tradeId, response);
    if (processedTrades.size > 5000) processedTrades.delete(processedTrades.keys().next().value);
    res.json(response);
  } catch (error) {
    res.status(502).json({ ok: false, tradeId, error: error.message });
  }
});

const server = http.createServer(app);
const browserWss = new WebSocket.Server({ server, path: '/orderbook' });
let lastBook = null;
let mexcState = 'connecting';
let mexcSocket;
let reconnectTimer;
let pingTimer;
let reconnectAttempt = 0;

function send(client, message) {
  if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
}

function broadcast(message) {
  for (const client of browserWss.clients) send(client, message);
}

browserWss.on('connection', (client) => {
  send(client, { type: 'status', state: mexcState });
  if (lastBook) send(client, lastBook);
});

async function fetchSnapshot() {
  const response = await fetch(`https://api.mexc.com/api/v3/depth?symbol=${SYMBOL}&limit=20`);
  if (!response.ok) throw new Error(`Snapshot HTTP ${response.status}`);
  const data = await response.json();
  publishBook(data.asks, data.bids, Date.now(), 'snapshot');
}

function publishBook(asks, bids, timestamp, source = 'websocket') {
  if (!Array.isArray(asks) || !Array.isArray(bids)) return;
  lastBook = {
    type: 'book',
    symbol: SYMBOL,
    source,
    timestamp: Number(timestamp) || Date.now(),
    spreadPercent: SPREAD_RATE * 100,
    marketAsks: asks.map((row) => Array.isArray(row) ? row : [row.price, row.quantity]),
    marketBids: bids.map((row) => Array.isArray(row) ? row : [row.price, row.quantity]),
    asks: asks.map((row) => {
      const item = Array.isArray(row) ? row : [row.price, row.quantity];
      return [(Number(item[0]) * (1 + SPREAD_RATE)).toFixed(8), item[1]];
    }),
    bids: bids.map((row) => {
      const item = Array.isArray(row) ? row : [row.price, row.quantity];
      return [(Number(item[0]) * (1 - SPREAD_RATE)).toFixed(8), item[1]];
    })
  };
  broadcast(lastBook);
}

async function startMexc() {
  clearTimeout(reconnectTimer);
  clearInterval(pingTimer);
  mexcState = 'connecting';
  broadcast({ type: 'status', state: mexcState });

  const root = await protobuf.load(path.join(__dirname, 'proto', 'PushDataV3ApiWrapper.proto'));
  const PushData = root.lookupType('PushDataV3ApiWrapper');
  mexcSocket = new WebSocket(MEXC_WS);
  mexcSocket.binaryType = 'arraybuffer';

  mexcSocket.on('open', () => {
    reconnectAttempt = 0;
    mexcState = 'live';
    broadcast({ type: 'status', state: mexcState });
    mexcSocket.send(JSON.stringify({ method: 'SUBSCRIPTION', params: [CHANNEL] }));
    pingTimer = setInterval(() => {
      if (mexcSocket.readyState === WebSocket.OPEN) {
        mexcSocket.send(JSON.stringify({ method: 'PING' }));
      }
    }, 20000);
  });

  mexcSocket.on('message', (raw, isBinary) => {
    try {
      if (!isBinary) return;
      const decoded = PushData.toObject(PushData.decode(new Uint8Array(raw)), {
        longs: Number,
        defaults: false
      });
      const depth = decoded.publicLimitDepths || decoded.publicLimitDepth;
      if (depth) publishBook(depth.asks, depth.bids, decoded.sendTime || decoded.createTime);
    } catch (error) {
      console.error('MEXC message decode failed:', error.message);
    }
  });

  const reconnect = () => {
    clearInterval(pingTimer);
    if (mexcState !== 'offline') {
      mexcState = 'reconnecting';
      broadcast({ type: 'status', state: mexcState });
    }
    const delay = Math.min(30000, 1000 * (2 ** reconnectAttempt++));
    reconnectTimer = setTimeout(() => startMexc().catch(scheduleAfterFailure), delay);
  };

  mexcSocket.on('close', reconnect);
  mexcSocket.on('error', (error) => console.error('MEXC WebSocket:', error.message));
}

function scheduleAfterFailure(error) {
  console.error('MEXC connection failed:', error.message);
  mexcState = 'reconnecting';
  broadcast({ type: 'status', state: mexcState });
  reconnectTimer = setTimeout(() => startMexc().catch(scheduleAfterFailure), 5000);
}

server.listen(PORT, () => {
  console.log(`Lovely Legends order book running on http://localhost:${PORT}`);
  fetchSnapshot().catch((error) => console.error(error.message));
  startMexc().catch(scheduleAfterFailure);
});

process.on('SIGTERM', () => {
  mexcState = 'offline';
  clearInterval(pingTimer);
  clearTimeout(reconnectTimer);
  if (mexcSocket) mexcSocket.close();
  server.close(() => process.exit(0));
});
