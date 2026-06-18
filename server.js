const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');

// --- Whale wallet saver ---
const WHALE_MIN_NOTIONAL = 100_000;
const WHALE_FILE = path.join(__dirname, 'whales.json');

let whaleSet = new Set();
if (fs.existsSync(WHALE_FILE)) {
  try {
    const existing = JSON.parse(fs.readFileSync(WHALE_FILE, 'utf8'));
    whaleSet = new Set(existing);
  } catch(e) {}
}

function saveWhaleAddress(addr) {
  if (!addr || whaleSet.has(addr)) return;
  whaleSet.add(addr);
  fs.writeFileSync(WHALE_FILE, JSON.stringify([...whaleSet], null, 2));
}

// --- In-memory DB ---
const trades = [];
let tradeId = 0;

function addTrade(trade) {
  tradeId++;
  const entry = { id: tradeId, ...trade, saved_at: Date.now() };
  trades.unshift(entry); // newest first
  if (trades.length > 10000) trades.pop(); // cap at 10k
  return entry;
}

function queryTrades({ minSize = 0, page = 1, pageSize = 20 }) {
  const filtered = trades.filter(t => t.notional >= minSize);
  const total = filtered.length;
  const start = (page - 1) * pageSize;
  const items = filtered.slice(start, start + pageSize);

  // stats only on filtered
  let longNotional = 0, shortNotional = 0;
  for (const t of filtered) {
    if (t.side === 'B') longNotional += t.notional; // B = Buy = Long
    else shortNotional += t.notional;
  }
  const totalNotional = longNotional + shortNotional;
  const longPct = totalNotional > 0 ? (longNotional / totalNotional * 100).toFixed(1) : '0.0';
  const shortPct = totalNotional > 0 ? (shortNotional / totalNotional * 100).toFixed(1) : '0.0';

  return {
    items,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
    stats: {
      longPct,
      shortPct,
      longNotional: longNotional.toFixed(2),
      shortNotional: shortNotional.toFixed(2),
      totalNotional: totalNotional.toFixed(2),
      count: filtered.length,
    }
  };
}

// --- Hyperliquid WebSocket ---
let currentPrice = {};
let wsConnected = false;

function connectWS() {
  console.log('[WS] Connecting to Hyperliquid...');
  const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');

  ws.on('open', () => {
    wsConnected = true;
    console.log('[WS] Connected');
    ws.send(JSON.stringify({
      method: 'subscribe',
      subscription: { type: 'trades', coin: 'BTC' }
    }));
    ws.send(JSON.stringify({
      method: 'subscribe',
      subscription: { type: 'allMids' }
    }));
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.channel === 'allMids' && msg.data?.mids) {
        currentPrice['BTC'] = parseFloat(msg.data.mids['BTC']) || currentPrice['BTC'];
      }

      if (msg.channel === 'trades' && Array.isArray(msg.data)) {
        for (const t of msg.data) {
          const price = parseFloat(t.px);
          const size = parseFloat(t.sz);
          const notional = price * size;
          const second = Math.floor(t.time / 1000);
          const maker = t.users?.[0] || '';
          const taker = t.users?.[1] || '';

          
          const existing = trades.find(e => {
            const sec = Math.floor(e.time / 1000) === second;
            const side = e.side === t.side && e.coin === t.coin;
            const sameMaker = maker && e.users?.[0] === maker;
            const sameTaker = taker && (e.users?.[0] === taker || e.users?.includes(taker));
            return sec && side && (sameMaker || sameTaker);
          });

          if (existing) {
            existing.size = parseFloat((existing.size + size).toFixed(8));
            existing.notional = parseFloat((existing.notional + notional).toFixed(2));
            existing.price = parseFloat(((existing.price + price) / 2).toFixed(2));
            if (taker && !existing.users.includes(taker)) existing.users.push(taker);
            existing.merged = (existing.merged || 1) + 1;
       
            if (existing.notional >= WHALE_MIN_NOTIONAL) {
              for (const addr of existing.users) saveWhaleAddress(addr);
            }
          } else {
            if (notional >= WHALE_MIN_NOTIONAL) {
              for (const addr of t.users || []) saveWhaleAddress(addr);
            }
            addTrade({
              coin: t.coin,
              side: t.side,
              price,
              size,
              notional,
              time: t.time,
              hash: t.hash,
              tid: t.tid,
              users: [...(t.users || [])],
              merged: 1,
            });
          }
        }
      }
    } catch (e) {
    
    }
  });

  ws.on('close', () => {
    wsConnected = false;
    console.log('[WS] Disconnected, reconnecting in 3s...');
    setTimeout(connectWS, 3000);
  });

  ws.on('error', (e) => {
    console.error('[WS] Error:', e.message);
  });
}

// --- Express API ---
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/trades', (req, res) => {
  const minSize = parseFloat(req.query.minSize) || 0;
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 20;
  res.json(queryTrades({ minSize, page, pageSize }));
});

app.get('/api/status', (req, res) => {
  res.json({ connected: wsConnected, totalTrades: trades.length, btcPrice: currentPrice['BTC'] || null });
});

const server = http.createServer(app);
const PORT = 3000;
server.listen(PORT, () => {
  console.log(`[HTTP] Server running at http://localhost:${PORT}`);
  connectWS();
});