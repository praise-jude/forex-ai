/**
 * Trading logic + UI wiring: account state, orders, open-position P/L,
 * history, and localStorage persistence.
 */
(function () {
  "use strict";

  const UNITS_PER_LOT = 100000;
  const STORAGE_KEY = "forex-trading-state-v1";
  const START_BALANCE = 10000;

  const market = new FX.Market();
  const chart = new FX.PriceChart(
    document.getElementById("chart"),
    document.getElementById("chart-tooltip")
  );

  const $ = (id) => document.getElementById(id);
  const usd = (v) =>
    (v < 0 ? "-$" : "$") +
    Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  let state = load() || {
    balance: START_BALANCE,
    positions: [],
    history: [],
    nextId: 1,
  };
  let selected = "EUR/USD";

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  /** Unrealized P/L of a position in USD at current prices. */
  function positionPl(pos) {
    const close = pos.side === "buy" ? market.bid(pos.symbol) : market.ask(pos.symbol);
    const diff = pos.side === "buy" ? close - pos.openPrice : pos.openPrice - close;
    const plQuote = diff * pos.lots * UNITS_PER_LOT;
    return { close, plUsd: plQuote * market.usdRate(market.quoteCurrency(pos.symbol)) };
  }

  function openPl() {
    return state.positions.reduce((sum, p) => sum + positionPl(p).plUsd, 0);
  }

  function place(side) {
    const lots = parseFloat($("lot-size").value);
    if (!(lots >= 0.01 && lots <= 10)) {
      note("Lot size must be between 0.01 and 10.");
      return;
    }
    if (state.balance + openPl() <= 0) {
      note("Account equity is depleted — reset the account to keep practicing.");
      return;
    }
    const openPrice = side === "buy" ? market.ask(selected) : market.bid(selected);
    state.positions.push({
      id: state.nextId++,
      symbol: selected,
      side,
      lots,
      openPrice,
      openedAt: Date.now(),
    });
    note(
      (side === "buy" ? "Bought " : "Sold ") + lots.toFixed(2) + " lots " + selected +
      " @ " + market.format(selected, openPrice)
    );
    save();
    render();
  }

  function closePosition(id) {
    const idx = state.positions.findIndex((p) => p.id === id);
    if (idx === -1) return;
    const pos = state.positions[idx];
    const { close, plUsd } = positionPl(pos);
    state.positions.splice(idx, 1);
    state.balance += plUsd;
    state.history.unshift({
      closedAt: Date.now(),
      symbol: pos.symbol,
      side: pos.side,
      lots: pos.lots,
      openPrice: pos.openPrice,
      closePrice: close,
      plUsd,
    });
    if (state.history.length > 50) state.history.pop();
    note("Closed " + pos.symbol + " for " + usd(plUsd) + ".");
    save();
    render();
  }

  function note(msg) {
    $("order-note").textContent = msg;
  }

  /* ---------- rendering ---------- */

  function renderWatchlist() {
    const list = $("pair-list");
    if (!list.childElementCount) {
      for (const pair of market.pairs.values()) {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.className = "pair-row";
        btn.dataset.symbol = pair.symbol;
        btn.innerHTML =
          '<span class="pair-name"></span><span class="pair-price"></span>';
        btn.querySelector(".pair-name").textContent = pair.symbol;
        btn.addEventListener("click", () => {
          selected = pair.symbol;
          render();
        });
        li.appendChild(btn);
        list.appendChild(li);
      }
    }
    for (const btn of list.querySelectorAll(".pair-row")) {
      const pair = market.get(btn.dataset.symbol);
      const priceEl = btn.querySelector(".pair-price");
      priceEl.textContent = market.format(pair.symbol, pair.mid);
      priceEl.classList.toggle("tick-up", pair.mid > pair.prevMid);
      priceEl.classList.toggle("tick-down", pair.mid < pair.prevMid);
      btn.classList.toggle("active", pair.symbol === selected);
    }
  }

  function renderChartPanel() {
    const bid = market.bid(selected);
    const ask = market.ask(selected);
    $("chart-pair").textContent = selected;
    $("chart-bid").textContent = market.format(selected, bid);
    $("chart-ask").textContent = market.format(selected, ask);
    $("chart-spread").textContent =
      "Spread " + market.get(selected).spreadPips.toFixed(1) + " pips";
    $("sell-price").textContent = market.format(selected, bid);
    $("buy-price").textContent = market.format(selected, ask);
    chart.update(market.series(selected), (v) => market.format(selected, v));
  }

  function renderStats() {
    const pl = openPl();
    $("stat-balance").textContent = usd(state.balance);
    $("stat-equity").textContent = usd(state.balance + pl);
    const plEl = $("stat-open-pl");
    plEl.textContent = usd(pl);
    plEl.style.color = pl > 0.005 ? "var(--up)" : pl < -0.005 ? "var(--down)" : "";
  }

  function renderPositions() {
    const body = $("positions-body");
    body.innerHTML = "";
    if (!state.positions.length) {
      body.innerHTML =
        '<tr class="empty-row"><td colspan="7">No open positions — place an order above.</td></tr>';
      return;
    }
    for (const pos of state.positions) {
      const { close, plUsd } = positionPl(pos);
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + pos.symbol + "</td>" +
        '<td class="side-' + pos.side + '">' + pos.side.toUpperCase() + "</td>" +
        "<td>" + pos.lots.toFixed(2) + "</td>" +
        "<td>" + market.format(pos.symbol, pos.openPrice) + "</td>" +
        "<td>" + market.format(pos.symbol, close) + "</td>" +
        '<td class="' + (plUsd >= 0 ? "pl-up" : "pl-down") + '">' + usd(plUsd) + "</td>" +
        '<td><button class="btn btn-close">Close</button></td>';
      tr.querySelector(".btn-close").addEventListener("click", () => closePosition(pos.id));
      body.appendChild(tr);
    }
  }

  function renderHistory() {
    const body = $("history-body");
    body.innerHTML = "";
    if (!state.history.length) {
      body.innerHTML =
        '<tr class="empty-row"><td colspan="7">No closed trades yet.</td></tr>';
      return;
    }
    for (const t of state.history) {
      const tr = document.createElement("tr");
      tr.innerHTML =
        "<td>" + new Date(t.closedAt).toLocaleTimeString() + "</td>" +
        "<td>" + t.symbol + "</td>" +
        '<td class="side-' + t.side + '">' + t.side.toUpperCase() + "</td>" +
        "<td>" + t.lots.toFixed(2) + "</td>" +
        "<td>" + market.format(t.symbol, t.openPrice) + "</td>" +
        "<td>" + market.format(t.symbol, t.closePrice) + "</td>" +
        '<td class="' + (t.plUsd >= 0 ? "pl-up" : "pl-down") + '">' + usd(t.plUsd) + "</td>";
      body.appendChild(tr);
    }
  }

  function render() {
    renderWatchlist();
    renderChartPanel();
    renderStats();
    renderPositions();
    renderHistory();
  }

  /* ---------- events ---------- */

  $("btn-buy").addEventListener("click", () => place("buy"));
  $("btn-sell").addEventListener("click", () => place("sell"));

  $("lot-size").addEventListener("input", () => {
    const lots = parseFloat($("lot-size").value);
    $("lot-units").textContent = Number.isFinite(lots)
      ? Math.round(lots * UNITS_PER_LOT).toLocaleString("en-US") + " units"
      : "";
  });

  $("btn-reset").addEventListener("click", () => {
    if (!confirm("Reset the account to $10,000 and clear all trades?")) return;
    state = { balance: START_BALANCE, positions: [], history: [], nextId: 1 };
    note("Account reset to " + usd(START_BALANCE) + ".");
    save();
    render();
  });

  $("btn-candles").addEventListener("click", () => {
    chart.mode = "candles";
    $("btn-candles").classList.add("active");
    $("btn-line").classList.remove("active");
    chart.draw();
  });

  $("btn-line").addEventListener("click", () => {
    chart.mode = "line";
    $("btn-line").classList.add("active");
    $("btn-candles").classList.remove("active");
    chart.draw();
  });

  market.onTick(render);
  market.start();
  render();
})();
