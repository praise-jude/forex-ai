/**
 * Canvas price chart: candlesticks or line, hairline grid, right-side price
 * axis, and a crosshair tooltip showing OHLC for the hovered candle.
 */
(function () {
  "use strict";

  const COLORS = {
    up: "#0ca30c",
    down: "#d03b3b",
    line: "#3987e5",
    grid: "#2c2c2a",
    baseline: "#383835",
    label: "#898781",
    crosshair: "#898781",
  };

  const PAD = { top: 12, right: 64, bottom: 8, left: 8 };

  class PriceChart {
    constructor(canvas, tooltipEl) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.tooltip = tooltipEl;
      this.mode = "candles";
      this.candles = [];
      this.formatPrice = (v) => v.toFixed(5);
      this.hoverX = null;

      canvas.addEventListener("mousemove", (e) => {
        const rect = canvas.getBoundingClientRect();
        this.hoverX = e.clientX - rect.left;
        this.hoverY = e.clientY - rect.top;
        this.draw();
      });
      canvas.addEventListener("mouseleave", () => {
        this.hoverX = null;
        this.tooltip.hidden = true;
        this.draw();
      });
      window.addEventListener("resize", () => this.draw());
    }

    update(candles, formatPrice) {
      this.candles = candles;
      if (formatPrice) this.formatPrice = formatPrice;
      this.draw();
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const { clientWidth: w, clientHeight: h } = this.canvas;
      if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
        this.canvas.width = w * dpr;
        this.canvas.height = h * dpr;
      }
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w, h };
    }

    draw() {
      const { w, h } = this.resize();
      const ctx = this.ctx;
      ctx.clearRect(0, 0, w, h);
      if (!this.candles.length) return;

      const plotW = w - PAD.left - PAD.right;
      const plotH = h - PAD.top - PAD.bottom;
      const candles = this.candles;

      let min = Infinity, max = -Infinity;
      for (const c of candles) {
        if (c.l < min) min = c.l;
        if (c.h > max) max = c.h;
      }
      const range = Math.max(max - min, 1e-9);
      min -= range * 0.05;
      max += range * 0.05;

      const y = (v) => PAD.top + plotH * (1 - (v - min) / (max - min));
      const slot = plotW / candles.length;
      const x = (i) => PAD.left + slot * (i + 0.5);

      // grid + price labels
      ctx.font = "11px system-ui, sans-serif";
      ctx.textBaseline = "middle";
      const gridLines = 5;
      for (let i = 0; i <= gridLines; i++) {
        const v = min + ((max - min) * i) / gridLines;
        const gy = Math.round(y(v)) + 0.5;
        ctx.strokeStyle = COLORS.grid;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(PAD.left, gy);
        ctx.lineTo(w - PAD.right, gy);
        ctx.stroke();
        ctx.fillStyle = COLORS.label;
        ctx.fillText(this.formatPrice(v), w - PAD.right + 8, gy);
      }

      if (this.mode === "line") {
        ctx.strokeStyle = COLORS.line;
        ctx.lineWidth = 2;
        ctx.lineJoin = "round";
        ctx.beginPath();
        candles.forEach((c, i) => {
          if (i === 0) ctx.moveTo(x(i), y(c.c));
          else ctx.lineTo(x(i), y(c.c));
        });
        ctx.stroke();
      } else {
        const bodyW = Math.max(2, Math.min(9, slot * 0.6));
        candles.forEach((c, i) => {
          const cx = x(i);
          const color = c.c >= c.o ? COLORS.up : COLORS.down;
          ctx.strokeStyle = color;
          ctx.fillStyle = color;
          // wick
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(cx, y(c.h));
          ctx.lineTo(cx, y(c.l));
          ctx.stroke();
          // body (min 1px tall so dojis stay visible)
          const top = y(Math.max(c.o, c.c));
          const bottom = y(Math.min(c.o, c.c));
          ctx.fillRect(cx - bodyW / 2, top, bodyW, Math.max(1, bottom - top));
        });
      }

      // latest-price marker line
      const last = candles[candles.length - 1];
      const ly = Math.round(y(last.c)) + 0.5;
      ctx.strokeStyle = COLORS.baseline;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(PAD.left, ly);
      ctx.lineTo(w - PAD.right, ly);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = last.c >= last.o ? COLORS.up : COLORS.down;
      ctx.fillText(this.formatPrice(last.c), w - PAD.right + 8, ly);

      // crosshair + tooltip
      if (this.hoverX !== null && this.hoverX > PAD.left && this.hoverX < w - PAD.right) {
        const i = Math.min(
          candles.length - 1,
          Math.max(0, Math.floor((this.hoverX - PAD.left) / slot))
        );
        const c = candles[i];
        const cx = Math.round(x(i)) + 0.5;
        ctx.strokeStyle = COLORS.crosshair;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(cx, PAD.top);
        ctx.lineTo(cx, h - PAD.bottom);
        ctx.stroke();
        ctx.setLineDash([]);

        const f = this.formatPrice;
        this.tooltip.innerHTML =
          "O <strong>" + f(c.o) + "</strong> H <strong>" + f(c.h) +
          "</strong> L <strong>" + f(c.l) + "</strong> C <strong>" + f(c.c) + "</strong>";
        this.tooltip.hidden = false;
        const tw = this.tooltip.offsetWidth;
        const left = Math.min(Math.max(this.hoverX - tw / 2, 4), w - tw - 4);
        this.tooltip.style.left = left + "px";
        this.tooltip.style.top = "6px";
      }
    }
  }

  window.FX.PriceChart = PriceChart;
})();
