const path = require('path');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const protobuf = require('protobufjs');

const PORT = process.env.PORT || 3000;
const SYMBOL = 'ZECUSDT';
const MEXC_WS = 'wss://wbs-api.mexc.com/ws';
const CHANNEL = `spot@public.limit.depth.v3.api.pb@${SYMBOL}@20`;

const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true, symbol: SYMBOL }));

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
    asks: asks.map((row) => Array.isArray(row) ? row : [row.price, row.quantity]),
    bids: bids.map((row) => Array.isArray(row) ? row : [row.price, row.quantity])
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
