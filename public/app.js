const $ = (id) => document.getElementById(id);
const state = { asks: [], bids: [], marketAsks: [], marketBids: [], rows: 12, view: 'both', lastMid: 0, reconnects: 0 };

function num(value, digits = 4) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
}

function compact(value) {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 }).format(value);
}

function renderRows(target, rows, reverse = false) {
  const selected = rows.slice(0, state.rows);
  const totals = selected.map(([p, q]) => Number(p) * Number(q));
  const max = Math.max(...totals, 1);
  const viewRows = reverse ? [...selected].reverse() : selected;
  target.innerHTML = viewRows.map(([price, qty]) => {
    const total = Number(price) * Number(qty);
    return `<div class="order-row" style="--depth:${Math.max(3, total / max * 100)}%"><span class="price">${num(price, 2)}</span><span>${num(qty, 4)}</span><span>${num(total, 2)}</span></div>`;
  }).join('');
}

function render() {
  const asks = state.asks.slice().sort((a, b) => Number(a[0]) - Number(b[0]));
  const bids = state.bids.slice().sort((a, b) => Number(b[0]) - Number(a[0]));
  if (!asks.length || !bids.length) return;
  const bestAsk = Number(asks[0][0]);
  const bestBid = Number(bids[0][0]);
  const mid = (bestAsk + bestBid) / 2;
  const spread = bestAsk - bestBid;
  const marketBestAsk = Number(state.marketAsks?.[0]?.[0]);
  const marketBestBid = Number(state.marketBids?.[0]?.[0]);
  const marketMid = Number.isFinite(marketBestAsk + marketBestBid) ? (marketBestAsk + marketBestBid) / 2 : mid;
  const bidVolume = bids.reduce((sum, [, q]) => sum + Number(q), 0);
  const askVolume = asks.reduce((sum, [, q]) => sum + Number(q), 0);
  const totalVolume = bidVolume + askVolume || 1;
  const buyPct = bidVolume / totalVolume * 100;

  renderRows($('asks'), asks, true);
  renderRows($('bids'), bids);
  $('asks').style.display = state.view === 'bids' ? 'none' : 'block';
  $('bids').style.display = state.view === 'asks' ? 'none' : 'block';
  $('midPrice').textContent = num(mid, 2);
  $('lastPrice').textContent = `${num(marketMid, 2)} USDT`;
  $('llBuy').textContent = `${num(bestBid, 2)} USDT`;
  $('llSell').textContent = `${num(bestAsk, 2)} USDT`;
  $('visibleDepth').textContent = `${asks.length + bids.length} levels`;
  $('bestBid').textContent = num(bestBid, 2);
  $('bestAsk').textContent = num(bestAsk, 2);
  $('bidVolume').textContent = `${compact(bidVolume)} ZEC`;
  $('askVolume').textContent = `${compact(askVolume)} ZEC`;
  $('buyPct').textContent = `${buyPct.toFixed(1)}%`;
  $('sellPct').textContent = `${(100 - buyPct).toFixed(1)}%`;
  $('buyMeter').style.width = `${buyPct}%`;
  $('sellMeter').style.width = `${100 - buyPct}%`;
  const arrow = $('priceArrow');
  arrow.textContent = state.lastMid && mid !== state.lastMid ? (mid > state.lastMid ? '↗' : '↘') : '↔';
  arrow.style.color = mid < state.lastMid ? 'var(--red)' : 'var(--green)';
  $('midPrice').style.color = mid < state.lastMid ? 'var(--red)' : 'var(--green)';
  state.lastMid = mid;
}

function setStatus(value) {
  const el = $('status');
  const labels = { live: 'Live', connecting: 'Connecting', reconnecting: 'Reconnecting', offline: 'Offline' };
  el.className = `status ${value}`;
  el.querySelector('span').textContent = labels[value] || value;
}

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/orderbook`);
  setStatus('connecting');
  socket.onopen = () => { state.reconnects = 0; };
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'status') setStatus(message.state);
    if (message.type === 'book') {
      state.asks = message.asks;
      state.bids = message.bids;
      state.marketAsks = message.marketAsks || [];
      state.marketBids = message.marketBids || [];
      $('updated').textContent = `Updated ${new Date(message.timestamp).toLocaleTimeString()}`;
      render();
    }
  };
  socket.onclose = () => {
    setStatus('reconnecting');
    const delay = Math.min(15000, 1000 * 2 ** state.reconnects++);
    setTimeout(connect, delay);
  };
  socket.onerror = () => socket.close();
}

$('rowCount').addEventListener('change', (event) => { state.rows = Number(event.target.value); render(); });
document.querySelectorAll('.view').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.view').forEach((item) => item.classList.toggle('active', item === button));
  state.view = button.dataset.view;
  render();
}));
document.querySelector('.star').addEventListener('click', (event) => {
  event.currentTarget.textContent = event.currentTarget.textContent === '★' ? '☆' : '★';
  event.currentTarget.style.color = event.currentTarget.textContent === '★' ? 'var(--gold)' : '';
});

connect();
