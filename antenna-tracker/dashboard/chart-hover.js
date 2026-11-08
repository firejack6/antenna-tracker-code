/* Shared crosshair + value tooltip for canvas time-series plots. */
(() => {
  function nearest(points, t) {
    if (!points?.length) return null;
    let best = null, bestDist = Infinity;
    for (const p of points) {
      if (!Number.isFinite(p?.t) || !Number.isFinite(p?.v)) continue;
      const d = Math.abs(p.t - t);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    return best;
  }

  function bind(canvas) {
    if (!canvas || canvas._chartHoverBound) return;
    canvas._chartHoverBound = true;
    canvas.classList.add('chart-hoverable');
    canvas.addEventListener('mousemove', (event) => {
      const box = canvas.getBoundingClientRect();
      canvas._hoverX = event.clientX - box.left;
      canvas._hoverY = event.clientY - box.top;
    });
    canvas.addEventListener('mouseleave', () => {
      canvas._hoverX = null;
      canvas._hoverY = null;
    });
  }

  /** Draw crosshair + readout using geometry from the just-finished paint. */
  function finish(ctx, canvas, meta) {
    bind(canvas);
    if (!ctx || !canvas || !meta) return;
    const { pad, width, height, t0, t1, decimals = 1, series = [] } = meta;
    const x = canvas._hoverX;
    if (x == null || !(t1 > t0)) return;
    const plotLeft = pad.left;
    const plotRight = width - pad.right;
    const plotTop = pad.top;
    const plotBottom = height - pad.bottom;
    if (x < plotLeft || x > plotRight) return;

    const frac = (x - plotLeft) / (plotRight - plotLeft);
    const t = t0 + frac * (t1 - t0);
    const age = t1 - t;

    ctx.save();
    ctx.strokeStyle = '#91a4bb88';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, plotTop);
    ctx.lineTo(x, plotBottom);
    ctx.stroke();
    ctx.setLineDash([]);

    const lines = [`−${age.toFixed(2)}s`];
    const rowColors = ['#91a4bb'];
    for (const trace of series) {
      const hit = nearest(trace.points, t);
      if (!hit) continue;
      const places = Number.isFinite(trace.decimals) ? trace.decimals : decimals;
      const text = Number.isFinite(hit.v) ? hit.v.toFixed(places) : '—';
      lines.push(`${trace.label}: ${text}`);
      rowColors.push(trace.color || '#e7eef8');
      const low = trace.right ? (meta.lowR ?? meta.low) : meta.low;
      const high = trace.right ? (meta.highR ?? meta.high) : meta.high;
      const y = plotTop + (1 - (hit.v - low) / (high - low)) * (plotBottom - plotTop);
      if (Number.isFinite(y) && y >= plotTop && y <= plotBottom) {
        ctx.fillStyle = trace.color || '#e7eef8';
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.font = '11px Segoe UI, sans-serif';
    const padX = 10, padY = 8, lineH = 15;
    let boxW = 0;
    for (const line of lines) boxW = Math.max(boxW, ctx.measureText(line).width);
    boxW += padX * 2;
    const boxH = padY * 2 + lines.length * lineH;
    let boxX = x + 12;
    let boxY = (canvas._hoverY ?? plotTop) - boxH / 2;
    if (boxX + boxW > width - 4) boxX = x - 12 - boxW;
    if (boxX < 4) boxX = 4;
    boxY = Math.max(4, Math.min(boxY, height - boxH - 4));

    ctx.fillStyle = '#0e1724f2';
    ctx.strokeStyle = '#3d536b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(boxX, boxY, boxW, boxH, 6);
    else ctx.rect(boxX, boxY, boxW, boxH);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => {
      ctx.fillStyle = rowColors[i] || '#e7eef8';
      ctx.fillText(line, boxX + padX, boxY + padY + i * lineH);
    });
    ctx.restore();
  }

  window.ChartHover = { bind, finish };
})();
