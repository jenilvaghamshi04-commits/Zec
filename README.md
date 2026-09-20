# Lovely Legends — ZEC/USDT Order Book

A production-ready, responsive ZEC/USDT Spot order-book page. The Node server connects to MEXC's public WebSocket, decodes its Protocol Buffer feed, and broadcasts clean JSON to the browser.

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
5. No environment variables or API keys are required.

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

Public MEXC market data does not require an API key. This page displays market data only and does not place orders.
