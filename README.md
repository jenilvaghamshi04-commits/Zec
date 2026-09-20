# Lovely Legends — ZEC/USDT Order Book

A production-ready, responsive ZEC/USDT Spot order-book page. The Node server connects to MEXC's public WebSocket, decodes its Protocol Buffer feed, applies the Lovely Legends 1.5% spread, and broadcasts clean JSON to the browser.

## Pricing rule

- Lovely Legends bids = MEXC bids × `0.985`
- Lovely Legends asks = MEXC asks × `1.015`
- Example at a $100 reference price: `$98.50` buy and `$101.50` sell

Set a different percentage with `LL_SPREAD_PERCENT`; the default is `1.5`.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Deploy on Render

1. Upload this project to GitHub.
2. Create a new **Web Service** on Render.
3. Build command: `npm install`
4. Start command: `npm start`
5. No environment variables or API keys are required for market data.

The server automatically uses Render's `PORT` environment variable.

## Integrating into Lovely Legends

The browser receives normalized updates from `/orderbook`:

```json
{
  "type": "book",
  "symbol": "ZECUSDT",
  "asks": [["price", "quantity"]],
  "bids": [["price", "quantity"]],
  "timestamp": 1700000000000
}
```

Public MEXC market data does not require an API key. Real orders can only be routed through the protected server endpoint described below.

## MEXC hedge routing

The trusted Lovely Legends backend can call `POST /api/hedge` after accepting a customer trade. A customer `BUY` triggers a MEXC market `BUY` at available asks. A customer `SELL` triggers a MEXC market `SELL` at available bids.

Required header: `x-hedge-secret: <HEDGE_WEBHOOK_SECRET>`

Example customer BUY:

```json
{
  "tradeId": "unique-ll-trade-id",
  "customerSide": "BUY",
  "quoteAmount": 100
}
```

Environment variables:

```text
HEDGE_WEBHOOK_SECRET=use-a-long-random-secret
MEXC_API_KEY=trade-only-api-key
MEXC_API_SECRET=trade-only-api-secret
ENABLE_LIVE_TRADING=false
MAX_HEDGE_USDT=1000
LL_SPREAD_PERCENT=1.5
```

The hedge endpoint is simulated by default. Set `ENABLE_LIVE_TRADING=true` only after testing, limiting the API key to Spot trading, adding an IP allowlist, and setting an appropriate `MAX_HEDGE_USDT`. `tradeId` is used for duplicate-request protection.
