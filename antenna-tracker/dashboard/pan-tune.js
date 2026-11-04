/* PAN position tuning workspace: step moves, live plots, schedule/PID sliders. */
const panTune = (() => {
  const main = document.querySelector('main');
  const tabs = document.querySelector('.workspace-tabs');
  if (!tabs) return { update() {}, paint() {}, setVisible() {} };

  const tuneBtn = document.createElement('button');
  tuneBtn.type = 'button';
  tuneBtn.dataset.view = 'tune';
  tuneBtn.setAttribute('aria-pressed', 'false');
  tuneBtn.textContent = 'Tune';
  tabs.append(tuneBtn);

  const panel = document.createElement('section');
  panel.className = 'panel tune-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="section-heading">
      <div><div class="eyebrow">PAN POSITION</div><h2>Live tune</h2></div>
      <div class="buttons tune-actions">
        <button type="button" id="tune-stop" class="estop">STOP</button>
        <button type="button" id="tune-auto-stop" class="secondary" aria-pressed="true" title="AUTO-STOP after 5s if |err| > 7° in the 3–5s window">Auto-stop</button>
        <button type="button" id="tune-mag-mode" class="secondary" aria-pressed="false" title="Firmware PAN position PID feedback: Mag heading vs Pot">Mag position</button>
        <button type="button" id="tune-hand" class="secondary" aria-pressed="false">Hand cal</button>
        <button type="button" id="tune-align" class="secondary">Align</button>
        <button type="button" id="tune-save" class="secondary">Save PAN settings</button>
      </div>
    </div>
    <p id="tune-status" role="status">Firmware position feedback: Pot (default). Toggle Mag position to close the on-ESP PID on mag heading — Save PAN to persist.</p>
    <div class="tune-readout" id="tune-readout">Waiting for telemetry</div>

    <div class="tune-hand-panel" id="tune-hand-panel" hidden>
      <strong>Hand cal · PWM off — spin by hand</strong>
      <p class="plot-note">Spin several full turns. Finds the pot’s linear band (excludes the flat/seam) for vmin/vmax, and mag oval for soft-iron. Mag heading is atan2 (circle) unless soft-iron is applied.</p>
      <div class="buttons">
        <button type="button" id="tune-hand-reset-ext">Reset extrema</button>
        <button type="button" id="tune-hand-apply-pot">Apply pot vmin/vmax</button>
        <button type="button" id="tune-hand-apply-mag">Apply mag soft-iron</button>
        <button type="button" id="tune-hand-clear-mag" class="secondary">Clear mag cal</button>
        <button type="button" id="tune-hand-mark-start">Mark start (visual scale)</button>
        <button type="button" id="tune-hand-mark-end">Mark end</button>
        <button type="button" id="tune-hand-exit" class="secondary">Exit hand cal</button>
      </div>
      <p id="tune-hand-readout" role="status">Not recording yet.</p>
    </div>

    <div class="tune-steps" aria-label="Relative targets">
      <strong>Relative step <span id="tune-scale-label">(mag °)</span></strong>
      ${['-180','-90','-10','+10','+90','+180'].map(v =>
        `<button type="button" data-tune-step="${v}">${v}°</button>`).join('')}
      <label id="tune-abs-label">Absolute mag (°)<input id="tune-absolute" type="number" min="0" max="360" step="0.1" value="0"></label>
      <button type="button" id="tune-go-abs">Go absolute</button>
      <button type="button" id="tune-characterize" class="secondary">Char +90° pot</button>
      <label>Visual ° moved<input id="tune-visual-deg" type="number" min="1" max="360" step="0.5" placeholder="e.g. 120"></label>
      <button type="button" id="tune-scale-apply" class="secondary">Apply visual scale</button>
      <button type="button" id="tune-scale-reset" class="secondary">Reset scale</button>
    </div>

    <div class="tune-plots">
      <div>
        <h3>Angle · degrees</h3>
        <div class="tune-legend" data-tune-legend="angle" aria-label="Angle traces"></div>
        <canvas id="tune-angle-chart" role="img" aria-label="Target pot and mag angles"></canvas>
      </div>
      <div>
        <h3>Control · µs from neutral</h3>
        <div class="tune-legend" data-tune-legend="pid" aria-label="Control traces"></div>
        <canvas id="tune-pid-chart" role="img" aria-label="PID and feedforward terms"></canvas>
      </div>
      <div>
        <h3>Schedule · near vs far</h3>
        <div class="tune-legend" data-tune-legend="schedule" aria-label="Schedule traces"></div>
        <canvas id="tune-schedule-chart" role="img" aria-label="Near vs far schedule and error"></canvas>
      </div>
    </div>

    <div class="tune-controls">
      <div class="tune-group">
        <h3>Far PID <button type="button" class="secondary" data-tune-apply="pid">Apply</button></h3>
        ${slider('kp', 'Far Kp', 0, 0.5, 0.005)}
        ${slider('ki', 'Ki', 0, 1, 0.01)}
        ${slider('kd', 'Kd', 0, 5, 0.05)}
        ${slider('ilimit', 'I limit (µs)', 0, 200, 1)}
        ${slider('cap', 'Far cap (µs)', 1, 250, 1)}
        ${slider('tolerance', 'Tolerance (°)', 0.1, 10, 0.1)}
      </div>
      <div class="tune-group">
        <h3>Schedule / near <button type="button" class="secondary" data-tune-apply="schedule">Apply</button></h3>
        ${slider('kp_near', 'Near Kp', 0, 0.5, 0.005)}
        ${slider('cap_near', 'Near cap (µs)', 1, 250, 1)}
        ${slider('schedule_deg', 'Schedule span (°)', 1, 180, 1)}
        ${slider('brk_min_scale', 'Breakaway min scale', 0, 1, 0.05)}
        ${slider('settle_deg', 'Settle DB band (°)', 1, 90, 0.5)}
      </div>
      <div class="tune-group">
        <h3>Breakaway + deadband <button type="button" class="secondary" data-tune-apply="breakaway">Apply spike</button>
          <button type="button" class="secondary" data-tune-apply="deadband">Apply DB</button></h3>
        ${slider('offset_us', 'Spike offset (µs)', 0, 250, 1)}
        ${slider('duration_ms', 'Spike duration (ms)', 0, 500, 1)}
        ${slider('dbplus', 'DB above neutral (µs)', 0, 200, 1)}
        ${slider('dbminus', 'DB below neutral (µs)', 0, 200, 1)}
      </div>
      <div class="tune-group">
        <h3>Ramp / speed <button type="button" class="secondary" data-tune-apply="ramp">Apply ramp</button>
          <button type="button" class="secondary" data-tune-apply="speed">Apply speed</button></h3>
        <label class="tune-check"><input id="tune-ramp-enabled" type="checkbox"> Enable target ramp</label>
        ${slider('ramp_rate', 'Ramp rate (°/s)', 0.1, 360, 1)}
        ${slider('speed', 'Speed limit (°/s)', 0, 360, 1)}
      </div>
    </div>
    <p class="plot-note"><strong>Mag position</strong> toggles firmware PAN PID feedback (Pot ↔ Mag heading) via <code>SERVO FEEDBACK PAN</code>; Save PAN to persist. Soft-iron from Hand cal is pushed to the ESP when applied. Pot+mag fusion is skipped until pot min/max/flat works.</p>
  `;
  tabs.after(panel);

  function slider(key, label, min, max, step) {
    return `<label class="tune-slider">${label}
      <span class="tune-slider-row">
        <input type="range" data-tune="${key}" min="${min}" max="${max}" step="${step}" value="${min}">
        <input type="number" data-tune-num="${key}" min="${min}" max="${max}" step="${step}" value="${min}">
      </span>
    </label>`;
  }

  const el = id => document.getElementById(id);
  let visible = false;
  let heading = null;
  let headingAt = null;
  let statusTimer = null;
  // Last commanded step — compare potΔ (what PID sees) vs magΔ (world).
  let stepMark = null;
  let handCal = false;
  let handStart = null;
  let handEnd = null;
  let handLeanWas = null;
  let handSweep = null;
  // Firmware position PID feedback source (SERVO FEEDBACK PAN / ATS1 pan_fb).
  let fwFeedback = 'POT'; // 'POT' | 'MAG'
  let magTarget = null;
  let magTimer = null;
  // At 5s: STOP if |err| exceeded this limit anytime in the 3–5s window.
  const SETTLE_CHECK_MS = 5000;
  const SETTLE_WINDOW_START_MS = 3000;
  const SETTLE_AUTO_STOP_DEG = 7;
  let autoStopEnabled = true;
  let settleWatch = null; // { kind, tol, armedAt, errs:[{t,v}] }
  let settleTimer = null;
  let settleStopBusy = false;
  let wasPositionActive = false;
  let moveArmedAt = 0; // performance.now when we last commanded position
  const magTargetHist = [];
  const SCALE_KEY = 'tracker-pan-mag-scale';
  const MAG_SOFT_KEY = 'tracker-pan-mag-softiron';
  const ADC_FS = 5.0;
  // magΔ/potΔ from characterization. Steps command world° → potΔ = worldΔ / scale.
  let magScale = (() => {
    try {
      const v = Number(localStorage.getItem(SCALE_KEY));
      return Number.isFinite(v) && v > 0.25 && v < 4 ? v : 1;
    } catch { return 1; }
  })();
  let magSoft = (() => {
    try {
      const s = JSON.parse(localStorage.getItem(MAG_SOFT_KEY) || 'null');
      if (s && [s.cx, s.cy, s.sx, s.sy].every(Number.isFinite) && s.sx > 0 && s.sy > 0) return s;
    } catch {}
    return null;
  })();

  function saveScale(v) {
    magScale = v;
    try { localStorage.setItem(SCALE_KEY, String(v)); } catch {}
    refreshScaleLabel();
  }

  function saveMagSoft(s) {
    magSoft = s;
    try {
      if (s) localStorage.setItem(MAG_SOFT_KEY, JSON.stringify(s));
      else localStorage.removeItem(MAG_SOFT_KEY);
    } catch {}
  }

  function fwMag() { return fwFeedback === 'MAG'; }

  function refreshScaleLabel() {
    const label = el('tune-scale-label');
    const absLabel = el('tune-abs-label');
    const modeBtn = el('tune-mag-mode');
    if (modeBtn) {
      modeBtn.setAttribute('aria-pressed', String(fwMag()));
      modeBtn.title = fwMag()
        ? 'Firmware PAN PID feedback = Mag heading (click for Pot)'
        : 'Firmware PAN PID feedback = Pot (click for Mag heading)';
    }
    if (absLabel) {
      absLabel.childNodes[0].textContent = fwMag() ? 'Absolute mag (°)' : 'Absolute pot (°)';
    }
    if (!label) return;
    const soft = magSoft ? ' · soft-iron' : '';
    if (fwMag()) {
      label.textContent = `(FW mag PID${soft})`;
      return;
    }
    label.textContent = magScale === 1
      ? `(pot ° · scale 1${soft})`
      : `(world→pot ×${magScale.toFixed(3)}${soft})`;
  }

  function applyMagLegend() {
    if (fwMag()) {
      hiddenTraces.angle.delete(0);
      hiddenTraces.angle.delete(3);
      hiddenTraces.angle.add(1);
      hiddenTraces.angle.add(4);
    } else {
      hiddenTraces.angle.delete(2);
      hiddenTraces.angle.add(3);
      hiddenTraces.angle.add(4);
    }
    syncLegendPressed('angle');
  }

  async function setFirmwareFeedback(mode) {
    const next = String(mode).toUpperCase();
    if (next !== 'POT' && next !== 'MAG') throw Error('Feedback mode must be POT or MAG');
    stopMagCorrector();
    await api('servo-feedback', { axis: 'PAN', mode: next });
    fwFeedback = next;
    refreshScaleLabel();
    applyMagLegend();
    setStatus(fwMag()
      ? 'Firmware Mag position ON — PAN PID closes on heading. Save PAN to persist.'
      : 'Firmware Mag position OFF — PAN PID closes on pot. Save PAN to persist.');
    paint();
  }

  function stopMagCorrector() {
    if (magTimer) { clearInterval(magTimer); magTimer = null; }
    magTarget = null;
  }

  function clearSettleWatch() {
    if (settleTimer != null) {
      clearTimeout(settleTimer);
      settleTimer = null;
    }
    settleWatch = null;
  }

  // Feedback angle the firmware PID is closing on (mag mode: filtered heading in
  // motion.angle; pot mode: pot degrees). Never mix with the browser UI heading EMA.
  function panFeedbackAngle(sample) {
    const motion = sample?.servo_motion?.PAN;
    if (Number.isFinite(motion?.angle)) return motion.angle;
    if (fwMag() && Number.isFinite(heading)) return heading;
    return null;
  }

  // Pointing error = commanded target − PID feedback (same frame). Prefer this
  // over servo_pid.error — when position is inactive ATS1 reports CR speed-error.
  function panPointingError(sample, { allowWatchTarget = false } = {}) {
    const pos = sample?.servo_position?.PAN;
    const pid = sample?.servo_pid?.PAN;
    let target = null;
    if (pos?.active && Number.isFinite(pos.target)) target = pos.target;
    else if (pid?.mode === 1 && Number.isFinite(pid.setpoint)) target = pid.setpoint;
    else if (allowWatchTarget && Number.isFinite(settleWatch?.target)) target = settleWatch.target;
    if (!Number.isFinite(target)) return null;
    const measured = panFeedbackAngle(sample);
    if (!Number.isFinite(measured)) return null;
    return wrap180(target - measured);
  }

  function settleError(sample) {
    const signed = panPointingError(sample, { allowWatchTarget: true });
    if (Number.isFinite(signed)) return Math.abs(signed);
    const pid = sample?.servo_pid?.PAN;
    if (pid?.mode === 1 && Number.isFinite(pid.error)) return Math.abs(pid.error);
    return null;
  }

  async function forceStop(reason, { auto = false } = {}) {
    stopMagCorrector();
    clearSettleWatch();
    const text = auto ? `AUTO-STOP (5s rule) · ${reason}` : reason;
    setStatus(text);
    const statusEl = el('tune-status');
    if (statusEl && auto) {
      statusEl.classList.add('tune-auto-stop');
      setTimeout(() => statusEl.classList.remove('tune-auto-stop'), 8000);
    }
    if (settleStopBusy) return;
    settleStopBusy = true;
    try {
      await api('servo', { axis: 'PAN', off: true });
    } catch (error) {
      setStatus(`${text} · OFF failed: ${error.message}`);
      try { await api('servo', { axis: 'PAN', off: true }); } catch { /* second try */ }
    } finally {
      settleStopBusy = false;
    }
  }

  function evaluateSettleWatch() {
    settleTimer = null;
    const watch = settleWatch;
    settleWatch = null;
    if (!watch || handCal) return;
    const lo = watch.armedAt + SETTLE_WINDOW_START_MS;
    const hi = watch.armedAt + SETTLE_CHECK_MS;
    const window = watch.errs.filter((e) => e.t >= lo && e.t <= hi);
    let maxErr = 0;
    for (const e of window) maxErr = Math.max(maxErr, e.v);
    const exceeded = window.some((e) => e.v > watch.tol);
    if (exceeded) {
      forceStop(
        `|err| > ${watch.tol}° in 3–5s window (max ${maxErr.toFixed(1)}° · n=${window.length})`,
        { auto: true }
      );
      return;
    }
    if (!window.length) {
      forceStop('no pointing-error samples in 3–5s window', { auto: true });
      return;
    }
    setStatus(
      `Settle OK · 3–5s stayed ≤ ${watch.tol}° ` +
      `(max ${maxErr.toFixed(1)}° · n=${window.length})`
    );
  }

  function armSettleWatch() {
    clearSettleWatch();
    if (!autoStopEnabled) return;
    const tol = SETTLE_AUTO_STOP_DEG;
    const sample = latest();
    const pos = sample?.servo_position?.PAN;
    const pid = sample?.servo_pid?.PAN;
    let target = null;
    if (Number.isFinite(pos?.target)) target = pos.target;
    else if (pid?.mode === 1 && Number.isFinite(pid.setpoint)) target = pid.setpoint;
    settleWatch = {
      tol,
      armedAt: performance.now(),
      errs: [],
      target,
    };
    settleTimer = setTimeout(evaluateSettleWatch, SETTLE_CHECK_MS);
    const prev = el('tune-status')?.textContent || '';
    setStatus(`${prev} · settle check @5s (AUTO-STOP if |err|>${tol}° in 3–5s)`);
  }

  function checkSettleWatch(sample) {
    if (!settleWatch || handCal) return;
    const pos = sample?.servo_position?.PAN;
    if (pos?.active && Number.isFinite(pos.target)) settleWatch.target = pos.target;
    const err = settleError(sample);
    if (!Number.isFinite(err)) return;
    settleWatch.errs.push({ t: performance.now(), v: err });
    if (settleWatch.errs.length > 2000) settleWatch.errs.splice(0, settleWatch.errs.length - 1000);
  }

  function latestFirmwareStopHint() {
    const lines = window.dashboard?.recentLogs?.() || [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = String(lines[i] || '');
      if (/Servo error|output stopped|unavailable|overspeed|E-stop|disabled/i.test(line)) return line;
    }
    return null;
  }

  // Position active→idle without our AUTO-STOP: firmware (or manual OFF) ended the move.
  function watchFirmwarePositionEnd(sample) {
    const active = !!sample?.servo_position?.PAN?.active;
    const pid = sample?.servo_pid?.PAN;
    if (wasPositionActive && !active) {
      const ageMs = moveArmedAt ? performance.now() - moveArmedAt : null;
      const hint = latestFirmwareStopHint();
      const age = Number.isFinite(ageMs) ? ` after ${(ageMs / 1000).toFixed(1)}s` : '';
      // Don't clobber an AUTO-STOP banner we just showed.
      const cur = el('tune-status')?.textContent || '';
      if (!/AUTO-STOP/i.test(cur)) {
        setStatus(
          `FW ended position${age}` +
          (hint ? ` · ${hint}` : ' · no Servo error in log (PID reset / OFF / link)')
        );
        el('tune-status')?.classList.add('tune-auto-stop');
        setTimeout(() => el('tune-status')?.classList.remove('tune-auto-stop'), 10000);
      }
      clearSettleWatch();
    } else if (active && pid?.mode === 1) {
      // Still in position mode but PWM terms collapsed while pointing error is large:
      // firmware thinks |err| ≤ tolerance (false settle) — not an AUTO-STOP.
      const point = panPointingError(sample);
      const req = pid.request;
      const tol = sample?.servo_position?.PAN?.tolerance ?? 1.5;
      if (Number.isFinite(point) && Math.abs(point) > Math.max(tol, 5) &&
          Number.isFinite(req) && Math.abs(req) < 1 &&
          Number.isFinite(pid.p) && Math.abs(pid.p) < 0.1) {
        const cur = el('tune-status')?.textContent || '';
        if (!/false-settle|AUTO-STOP|FW ended/i.test(cur)) {
          setStatus(
            `FW false-settle · pointing |err| ${Math.abs(point).toFixed(1)}° but PID output≈0 ` +
            `(firmware |err| ≤ tol ${tol}° — check feedback frame)`
          );
        }
      }
    }
    wasPositionActive = active;
  }

  function resetHandSweep() {
    handSweep = {
      vMin: null, vMax: null, vN: 0, vLive: null,
      potPrev: null, unwrapped: 0, turns: 0,
      magPrev: null, magUnwrapped: 0,
      // {u, v}: u = mag-unwrapped degrees (motion truth), v = pot volts.
      // Pot-angle can't detect flat — mapped angle freezes when volts flat.
      path: [],
      magPts: [],
      flat: null,
    };
  }

  // Continuous pots have a dead flat/seam where |dV/dθ|≈0 (or rails). Use the
  // linear band edges for vmin/vmax — not the absolute voltage extrema.
  function analyzePotFlat(sweep) {
    const path = sweep?.path;
    if (!path || path.length < 30) return null;
    const slopes = [];
    for (let i = 1; i < path.length; i++) {
      const du = path[i].u - path[i - 1].u;
      if (Math.abs(du) < 0.35) continue; // need real dish motion (mag)
      slopes.push({
        u: path[i].u,
        v: path[i].v,
        s: Math.abs((path[i].v - path[i - 1].v) / du),
      });
    }
    if (slopes.length < 20) return null;
    const sortedS = slopes.map(p => p.s).sort((a, b) => a - b);
    const median = sortedS[Math.floor(sortedS.length / 2)];
    const thr = Math.max(0.0005, median * 0.18); // V/deg — flat if well below typical slope
    let flatDeg = 0, flatSamples = 0;
    const linearV = [];
    for (let i = 0; i < slopes.length; i++) {
      const du = i ? Math.abs(slopes[i].u - slopes[i - 1].u) : 0;
      if (slopes[i].s < thr) {
        flatDeg += du;
        flatSamples += 1;
      } else {
        linearV.push(slopes[i].v);
      }
    }
    if (linearV.length < 10) return null;
    linearV.sort((a, b) => a - b);
    const lo = linearV[Math.floor(linearV.length * 0.02)];
    const hi = linearV[Math.min(linearV.length - 1, Math.floor(linearV.length * 0.98))];
    const magTravel = Math.abs(sweep.magUnwrapped) || Math.abs(path.at(-1).u - path[0].u);
    return {
      thr,
      medianSlope: median,
      flatDeg,
      flatFrac: flatDeg / Math.max(1e-3, magTravel),
      linearVmin: lo,
      linearVmax: hi,
      absVmin: sweep.vMin,
      absVmax: sweep.vMax,
      flatSamples,
      linearN: linearV.length,
    };
  }

  function panVoltsFromSample(sample) {
    if (!sample) return null;
    const raw = sample.adc_mean?.[6] ?? sample.adc?.[6];
    if (!Number.isFinite(raw)) return null;
    return raw * ADC_FS / 4096;
  }

  function horizontalMag(accel, mag) {
    if (!Array.isArray(accel) || !Array.isArray(mag) || accel.length < 3 || mag.length < 3) return null;
    if (!accel.every(Number.isFinite) || !mag.every(Number.isFinite)) return null;
    if (Math.hypot(accel[0], accel[1], accel[2]) < 0.1) return null;
    const [ax, ay, az] = accel;
    const roll = Math.atan2(ay, az);
    const pitch = Math.atan2(-ax, Math.hypot(ay, az));
    const [mx, my, mz] = mag;
    const hx = mx * Math.cos(pitch) + mz * Math.sin(pitch);
    const hy = mx * Math.sin(roll) * Math.sin(pitch) + my * Math.cos(roll)
      - mz * Math.sin(roll) * Math.cos(pitch);
    if (Math.hypot(hx, hy) < 1e-6) return null;
    return [hx, hy];
  }

  function headingFromSoft(hx, hy) {
    let x = hx, y = hy;
    if (magSoft) {
      x = (hx - magSoft.cx) / magSoft.sx;
      y = (hy - magSoft.cy) / magSoft.sy;
    }
    return (Math.atan2(-y, x) * 180 / Math.PI + 360) % 360;
  }

  function fitMagSoft(pts) {
    if (!pts || pts.length < 40) return null;
    let sx = 0, sy = 0;
    for (const [x, y] of pts) { sx += x; sy += y; }
    const cx = sx / pts.length, cy = sy / pts.length;
    let vx = 0, vy = 0;
    for (const [x, y] of pts) {
      vx += (x - cx) ** 2;
      vy += (y - cy) ** 2;
    }
    const rx = Math.sqrt(vx / pts.length), ry = Math.sqrt(vy / pts.length);
    if (!(rx > 1e-6) || !(ry > 1e-6)) return null;
    const ecc = 1 - Math.min(rx, ry) / Math.max(rx, ry);
    return { cx, cy, sx: rx, sy: ry, ecc, n: pts.length };
  }

  function ingestHandSample(sample) {
    if (!handCal || !handSweep || !sample) return;
    const volts = panVoltsFromSample(sample);
    if (Number.isFinite(volts)) {
      handSweep.vLive = volts;
      handSweep.vN += 1;
      handSweep.vMin = handSweep.vMin == null ? volts : Math.min(handSweep.vMin, volts);
      handSweep.vMax = handSweep.vMax == null ? volts : Math.max(handSweep.vMax, volts);
    }
    const pot = sample.servo_motion?.PAN?.angle;
    if (Number.isFinite(pot)) {
      if (Number.isFinite(handSweep.potPrev)) {
        let d = pot - handSweep.potPrev;
        if (d > 180) d -= 360;
        else if (d < -180) d += 360;
        handSweep.unwrapped += d;
        handSweep.turns = Math.abs(handSweep.unwrapped) / 360;
      }
      handSweep.potPrev = pot;
    }
    const hxy = horizontalMag(sample.accel, sample.mag);
    if (hxy) {
      if (handSweep.magPts.length < 4000) handSweep.magPts.push(hxy);
      // Soft-iron not required for flat detect — raw heading is fine as a motion clock.
      const hdg = headingFromSoft(hxy[0], hxy[1]);
      if (Number.isFinite(handSweep.magPrev)) {
        let d = wrap180(hdg - handSweep.magPrev);
        handSweep.magUnwrapped += d;
      }
      handSweep.magPrev = hdg;
      // Mag advances through the seam while pot volts sit flat → detect dead zone.
      if (Number.isFinite(volts) && handSweep.path.length < 8000) {
        const last = handSweep.path.at(-1);
        if (!last || Math.abs(handSweep.magUnwrapped - last.u) >= 0.4 || Math.abs(volts - last.v) >= 0.002) {
          handSweep.path.push({ u: handSweep.magUnwrapped, v: volts });
        }
      }
    }
    if (handSweep.vN % 15 === 0) handSweep.flat = analyzePotFlat(handSweep);
  }

  function updateHandReadout() {
    const out = el('tune-hand-readout');
    if (!out) return;
    const pot = latest()?.servo_motion?.PAN?.angle;
    const live = Number.isFinite(pot) ? pot.toFixed(2) + '°' : '—';
    const s = handSweep;
    const flat = s?.flat || (s ? analyzePotFlat(s) : null);
    if (s) s.flat = flat;
    let vPart = ' · V — (waiting for ADC CH6 — lean off / stream on)';
    if (s && Number.isFinite(s.vMin) && Number.isFinite(s.vMax)) {
      vPart = ` · V ${Number.isFinite(s.vLive) ? s.vLive.toFixed(3) : '—'} abs [${s.vMin.toFixed(3)}…${s.vMax.toFixed(3)}]`;
      if (flat && Number.isFinite(flat.linearVmin)) {
        vPart += ` · linear [${flat.linearVmin.toFixed(3)}…${flat.linearVmax.toFixed(3)}]` +
          ` · flat ~${flat.flatDeg.toFixed(0)}° (${(100 * flat.flatFrac).toFixed(0)}%)`;
      } else {
        vPart += ` (${s.vN} samples · spin for flat detect)`;
      }
    }
    const turnPart = s ? ` · ~${s.turns.toFixed(2)} turns` : '';
    const softFit = s ? fitMagSoft(s.magPts) : null;
    const magPart = softFit
      ? ` · mag oval ecc ${softFit.ecc.toFixed(2)} (n=${softFit.n}${magSoft ? ', soft-iron ON' : ''})`
      : ` · mag oval — spin more (${s?.magPts.length || 0} pts)`;
    let markPart = '';
    if (Number.isFinite(handStart)) {
      const fromStart = Number.isFinite(pot) ? wrap180(pot - handStart) : null;
      const span = Number.isFinite(handEnd) ? wrap180(handEnd - handStart) : null;
      markPart = ` · visual mark start ${handStart.toFixed(1)}°` +
        (Number.isFinite(fromStart) ? ` Δ ${fromStart >= 0 ? '+' : ''}${fromStart.toFixed(1)}°` : '') +
        (Number.isFinite(span) ? ` span ${span >= 0 ? '+' : ''}${span.toFixed(1)}°` : '');
    }
    out.textContent = `Pot ${live}${vPart}${turnPart}${magPart}${markPart}`;
  }

  async function setHandCal(on) {
    handCal = !!on;
    const btn = el('tune-hand');
    const panel = el('tune-hand-panel');
    if (btn) btn.setAttribute('aria-pressed', String(handCal));
    if (panel) panel.hidden = !handCal;
    document.body.classList.toggle('tune-hand-cal', handCal);
    if (handCal) {
      handStart = null;
      handEnd = null;
      resetHandSweep();
      await api('servo', { axis: 'PAN', off: true });
      // Need CH6 ADC batches for true pot voltage extrema (lean hides them).
      const lean = latest()?.effective_config?.adc_stream === 0;
      handLeanWas = lean;
      if (lean) {
        try { await api('adc-stream', { enabled: true }); }
        catch (error) { setStatus(`Hand cal: could not enable ADC stream (${error.message})`); }
      }
      hiddenTraces.angle.delete(2);
      hiddenTraces.angle.delete(4);
      syncLegendPressed('angle');
      setStatus('Hand cal ON · PWM off · spin several full turns for pot V min/max + mag oval. Then Apply.');
      updateHandReadout();
      paint();
    } else {
      if (handLeanWas) {
        try { await api('adc-stream', { enabled: false }); } catch {}
      }
      handLeanWas = null;
      setStatus('Hand cal OFF. Enable servos if needed, then use steps again.');
    }
  }

  // Mag mode: show Mag tgt / Mag heading / Pot. Pot mode: Mag→pot off by default.
  const hiddenTraces = {
    angle: new Set([1, 4]), // setpoint + Mag→pot off; Error° stays on
    pid: new Set(),
    // Eff cap / phase / raw blend swamp the Near↔Far mode trace.
    schedule: new Set([1, 3, 4]),
  };
  // Smoothed mag history (not per-sample raw) so Mag→pot doesn't thrash after Align.
  const magHist = [];
  const magPotHist = [];
  const legendDefs = {
    angle: [
      ['Mag/pot tgt', '#a88bfa'], ['Setpoint', '#65b5ff'], ['Pot', '#4bd3b5'],
      ['Mag heading', '#f5bd4f'], ['Mag→pot', '#ff788a'], ['Error°', '#ff9d5b'],
    ],
    pid: [
      ['Output', '#4bd3b5'], ['Request', '#f5bd4f'], ['P', '#ff788a'],
      ['I', '#a88bfa'], ['FF+DB', '#65b5ff'], ['Startup', '#ff9d5b'],
    ],
    schedule: [
      ['|Error|°', '#69adff'], ['Blend 0–1', '#61e2bd'], ['Eff Kp', '#f0b76b'],
      ['Eff cap', '#ff788a'], ['Phase', '#a88bfa'],
      // 0 = near gains, 1 = far gains (blend ≥ 0.5).
      ['Far mode', '#e7eef8'],
    ],
  };

  function setStatus(text) {
    el('tune-status').textContent = text;
  }

  function wrap180(deg) {
    return ((deg + 180) % 360 + 360) % 360 - 180;
  }

  // Circular mean of magHist over the last `seconds` (angles wrap at 360°).
  function meanHeadingWindow(seconds = 3) {
    const now = Date.now() / 1000;
    const tCut = now - seconds;
    let sx = 0, sy = 0, n = 0;
    for (const p of magHist) {
      if (!p || p.t < tCut || !Number.isFinite(p.v)) continue;
      const rad = p.v * Math.PI / 180;
      sx += Math.cos(rad);
      sy += Math.sin(rad);
      n += 1;
    }
    if (n < 3) return null;
    return { heading: (Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360, n };
  }

  // Map value into the continuous neighborhood of ref (so 359° overlays pot≈0°, not +360).
  function unwrapTo(ref, value) {
    if (!Number.isFinite(value)) return null;
    if (!Number.isFinite(ref)) return value;
    return ref + wrap180(value - ref);
  }

  function potAt(potSeries, t) {
    if (!potSeries?.length) return null;
    for (let i = potSeries.length - 1; i >= 0; i--) {
      if (Number.isFinite(potSeries[i].v) && potSeries[i].t <= t) return potSeries[i].v;
    }
    for (const p of potSeries) if (Number.isFinite(p.v)) return p.v;
    return null;
  }

  async function api(path, data) {
    const response = await fetch('/api/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data), cache: 'no-store',
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(body.error || response.statusText || 'Request failed');
    return body;
  }

  function readLocation() {
    try {
      return JSON.parse(localStorage.getItem('tracker-device-location') || 'null') || null;
    } catch { return null; }
  }

  function mapAlign() {
    const saved = readLocation();
    if (!saved) return { panAlign: 0, decl: 0, invert: false };
    return {
      panAlign: Number.isFinite(saved.panAlign) ? saved.panAlign : 0,
      decl: Number.isFinite(saved.magDeclination) ? saved.magDeclination
        : (Number.isFinite(saved.offset) ? saved.offset : 0),
      invert: !!saved.panInvert,
    };
  }

  function magAsPot(headingDeg) {
    if (!Number.isFinite(headingDeg)) return null;
    const { panAlign, decl, invert } = mapAlign();
    const mapAz = (headingDeg + decl + 360) % 360;
    return invert ? (panAlign - mapAz + 360) % 360 : (mapAz - panAlign + 360) % 360;
  }

  function pruneHist(list, now, span = 90) {
    while (list.length && now - list[0].t > span) list.shift();
  }

  function rebuildMagPotHist() {
    magPotHist.length = 0;
    for (const p of magHist) {
      const v = magAsPot(p.v);
      if (Number.isFinite(v)) magPotHist.push({ t: p.t, v });
    }
  }

  function syncLegendPressed(key) {
    panel.querySelectorAll(`[data-tune-legend="${key}"] .tune-legend-item`).forEach((button, index) => {
      button.setAttribute('aria-pressed', String(!hiddenTraces[key].has(index)));
    });
  }

  function buildLegends() {
    for (const [key, entries] of Object.entries(legendDefs)) {
      const host = panel.querySelector(`[data-tune-legend="${key}"]`);
      if (!host) continue;
      host.replaceChildren();
      entries.forEach(([label, color], index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tune-legend-item';
        button.style.setProperty('--swatch', color);
        button.setAttribute('aria-pressed', String(!hiddenTraces[key].has(index)));
        button.innerHTML = `<span class="tune-swatch" aria-hidden="true"></span>${label}`;
        button.addEventListener('click', () => {
          if (hiddenTraces[key].has(index)) hiddenTraces[key].delete(index);
          else hiddenTraces[key].add(index);
          button.setAttribute('aria-pressed', String(!hiddenTraces[key].has(index)));
          paint();
        });
        host.append(button);
      });
    }
  }
  buildLegends();

  function latest() {
    return window.dashboard?.latest?.() || null;
  }

  function samples() {
    return window.dashboard?.samples?.() || [];
  }

  function syncPair(key, value) {
    const range = panel.querySelector(`[data-tune="${key}"]`);
    const num = panel.querySelector(`[data-tune-num="${key}"]`);
    if (range && Number.isFinite(value)) range.value = value;
    if (num && Number.isFinite(value)) num.value = Number(value.toPrecision(6));
  }

  function readNum(key) {
    return panel.querySelector(`[data-tune-num="${key}"]`)?.valueAsNumber;
  }

  function pullFromTelemetry(sample) {
    if (!sample) return;
    const pos = sample.servo_position?.PAN || {};
    const cfg = sample.effective_config || {};
    const motion = sample.servo_motion?.PAN || {};
    if (cfg.pan_fb === 1 || cfg.pan_fb === '1' || cfg.pan_fb === 'MAG') {
      if (fwFeedback !== 'MAG') {
        fwFeedback = 'MAG';
        stopMagCorrector();
        refreshScaleLabel();
        applyMagLegend();
      }
    } else if (cfg.pan_fb === 0 || cfg.pan_fb === '0' || cfg.pan_fb === 'POT') {
      if (fwFeedback !== 'POT') {
        fwFeedback = 'POT';
        refreshScaleLabel();
        applyMagLegend();
      }
    }
    syncPair('kp', pos.kp ?? cfg.pan_kp);
    syncPair('ki', pos.ki ?? cfg.pan_ki);
    syncPair('kd', pos.kd ?? cfg.pan_kd);
    syncPair('ilimit', pos.ilimit);
    syncPair('cap', pos.cap);
    syncPair('tolerance', pos.tolerance);
    syncPair('dbplus', pos.dbplus ?? cfg.pan_dbplus);
    syncPair('dbminus', pos.dbminus ?? cfg.pan_dbminus);
    syncPair('offset_us', cfg.pan_breakaway_us);
    syncPair('duration_ms', cfg.pan_breakaway_ms);
    syncPair('kp_near', cfg.pan_kp_near);
    syncPair('cap_near', cfg.pan_cap_near);
    syncPair('schedule_deg', cfg.pan_schedule_deg);
    syncPair('brk_min_scale', cfg.pan_brk_min_scale);
    syncPair('settle_deg', cfg.pan_settle_deg);
    syncPair('ramp_rate', pos.ramprate ?? cfg.pan_ramp_rate);
    syncPair('speed', motion.limit ?? cfg.pan_speed);
    const rampBox = el('tune-ramp-enabled');
    if (rampBox && document.activeElement !== rampBox) {
      const rampOn = pos.ramp === 1 || cfg.pan_ramp === 1;
      if (pos.ramp != null || cfg.pan_ramp != null) rampBox.checked = !!rampOn;
    }
  }

  function blendFor(absErr, scheduleDeg) {
    if (!(absErr > 0) || !(scheduleDeg > 0)) return 0;
    return Math.min(1, absErr / scheduleDeg);
  }

  function paintChart(canvasId, series, options = {}) {
    const canvas = el(canvasId);
    if (!canvas || !visible) return;
    const box = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (!box.width) return;
    const width = box.width, height = box.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const pad = { left: 46, right: 10, top: 12, bottom: 22 };
    const w = width - pad.left - pad.right, h = height - pad.top - pad.bottom;
    const span = Number(document.getElementById('window')?.value || 30);
    const now = Date.now() / 1000;
    const hidden = options.hidden || new Set();
    const wrapBreak = options.wrapBreak;
    const points = series.map((s, i) => hidden.has(i) ? [] : s.filter(p => p && now - p.t <= span));
    const values = [];
    for (const pts of points) {
      for (const p of pts) if (Number.isFinite(p.v)) values.push(p.v);
    }
    let low = 0, high = 1;
    if (values.length) {
      low = Math.min(...values);
      high = Math.max(...values);
      if (low === high) { low -= 1; high += 1; }
      const margin = (high - low) * 0.12;
      low -= margin; high += margin;
    }
    ctx.font = '10px Segoe UI, sans-serif';
    for (let i = 0; i < 4; i++) {
      const y = pad.top + h * i / 3;
      ctx.strokeStyle = '#263448';
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
      ctx.fillStyle = '#91a4bb'; ctx.textAlign = 'right';
      ctx.fillText((high - (high - low) * i / 3).toFixed(options.decimals ?? 1), pad.left - 6, y + 3);
    }
    ctx.fillStyle = '#91a4bb'; ctx.textAlign = 'left';
    ctx.fillText(`−${span}s`, pad.left, height - 4);
    ctx.textAlign = 'right'; ctx.fillText('now', width - pad.right, height - 4);
    if (!values.length) {
      ctx.textAlign = 'center';
      ctx.fillText('Select a trace in the legend', pad.left + w / 2, pad.top + h / 2);
      return;
    }
    const xOf = t => pad.left + ((t - (now - span)) / span) * w;
    const yOf = v => pad.top + (1 - (v - low) / (high - low)) * h;
    points.forEach((pts, i) => {
      if (pts.length < 2) return;
      ctx.strokeStyle = options.colors?.[i] || '#61e2bd';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      let drawing = false;
      let prev = null;
      for (const p of pts) {
        if (!Number.isFinite(p.v)) { drawing = false; prev = null; continue; }
        const wrapJump = prev && wrapBreak && Math.abs(p.v - prev.v) > wrapBreak;
        const timeJump = prev && (p.t - prev.t) > 2;
        if (wrapJump || timeJump) drawing = false;
        const x = xOf(p.t), y = yOf(p.v);
        if (!drawing) { ctx.moveTo(x, y); drawing = true; }
        else ctx.lineTo(x, y);
        prev = p;
      }
      ctx.stroke();
    });
    if (typeof ChartHover !== 'undefined') {
      ChartHover.finish(ctx, canvas, {
        pad, width, height, low, high,
        decimals: options.decimals ?? 1,
        t0: now - span, t1: now,
        series: points.map((pts, i) => ({
          label: options.labels?.[i] || `Trace ${i + 1}`,
          color: options.colors?.[i] || '#61e2bd',
          points: pts,
        })).filter((_, i) => !hidden.has(i)),
      });
    }
  }

  function paint() {
    if (!visible) return;
    const hist = samples();
    const cfg = latest()?.effective_config || {};
    const scheduleDeg = cfg.pan_schedule_deg ?? readNum('schedule_deg') ?? 45;
    const kpFar = cfg.pan_kp ?? readNum('kp') ?? 3;
    const kpNear = cfg.pan_kp_near ?? readNum('kp_near') ?? 0.9;
    const capFar = latest()?.servo_position?.PAN?.cap ?? readNum('cap') ?? 200;
    const capNear = cfg.pan_cap_near ?? readNum('cap_near') ?? 100;

    const angleSeries = [[], [], [], [], [], []];
    const pidSeries = [[], [], [], [], [], []];
    const schedSeries = [[], [], [], [], [], []];

    for (const sample of hist) {
      const t = sample.received_at ?? sample.plot_at;
      if (!Number.isFinite(t)) continue;
      const motion = sample.servo_motion?.PAN;
      const pid = sample.servo_pid?.PAN;
      const pos = sample.servo_position?.PAN;
      const pot = motion?.angle;
      const target = pos?.active ? pos.target : null;
      const setpoint = pid?.mode === 1 ? pid.setpoint : null;
      // In mag mode, purple "tgt" is mag target (filled from magTargetHist below).
      angleSeries[0].push({ t, v: target });
      angleSeries[1].push({ t, v: setpoint });
      angleSeries[2].push({ t, v: pot });
      // Signed pointing error (target − feedback). Not raw servo_pid.error (CR idle ≈ 0).
      angleSeries[5].push({ t, v: panPointingError(sample) });

      pidSeries[0].push({ t, v: pid?.output });
      pidSeries[1].push({ t, v: pid?.request });
      pidSeries[2].push({ t, v: pid?.p });
      pidSeries[3].push({ t, v: pid?.i });
      pidSeries[4].push({ t, v: pid?.ff });
      pidSeries[5].push({ t, v: pid?.startup });

      const signed = panPointingError(sample);
      const err = Number.isFinite(signed) ? Math.abs(signed) : null;
      const blend = Number.isFinite(err) ? blendFor(err, scheduleDeg) : null;
      schedSeries[0].push({ t, v: err });
      schedSeries[1].push({ t, v: blend });
      schedSeries[2].push({ t, v: Number.isFinite(blend) ? kpNear + (kpFar - kpNear) * blend : null });
      schedSeries[3].push({ t, v: Number.isFinite(blend) ? capNear + (capFar - capNear) * blend : null });
      schedSeries[4].push({ t, v: pid?.phase });
      // 0 = near, 1 = far (same blend threshold the schedule uses mid-way).
      schedSeries[5].push({ t, v: Number.isFinite(blend) ? (blend >= 0.5 ? 1 : 0) : null });
    }
    if (fwMag()) {
      // Plot the same FW feedback used for Error° (motion.angle), not UI-smoothed magHist.
      const tgtRef = Number.isFinite(magTarget) ? magTarget : (angleSeries[0].at(-1)?.v);
      angleSeries[3] = hist.map((sample) => {
        const t = sample.received_at ?? sample.plot_at;
        const v = panFeedbackAngle(sample);
        if (!Number.isFinite(t) || !Number.isFinite(v)) return null;
        return { t, v: unwrapTo(tgtRef ?? v, v) };
      }).filter(Boolean);
    } else {
      angleSeries[3] = magHist.slice();
    }
    // Mag→pot is [0,360); unwrap onto pot so Align overlay isn't plotted 360° away at the wrap.
    angleSeries[4] = magPotHist.map(p => ({
      t: p.t,
      v: unwrapTo(potAt(angleSeries[2], p.t), p.v),
    }));

    paintChart('tune-angle-chart', angleSeries, {
      colors: legendDefs.angle.map(([, c]) => c),
      labels: legendDefs.angle.map(([label]) => label),
      decimals: 1, hidden: hiddenTraces.angle, wrapBreak: 180,
    });
    paintChart('tune-pid-chart', pidSeries, {
      colors: legendDefs.pid.map(([, c]) => c),
      labels: legendDefs.pid.map(([label]) => label),
      decimals: 1, hidden: hiddenTraces.pid,
    });
    paintChart('tune-schedule-chart', schedSeries, {
      colors: legendDefs.schedule.map(([, c]) => c),
      labels: legendDefs.schedule.map(([label]) => label),
      decimals: 2, hidden: hiddenTraces.schedule,
    });
  }

  function updateReadout(sample, magHeading) {
    if (!sample) {
      el('tune-readout').textContent = 'Waiting for telemetry';
      return;
    }
    const motion = sample.servo_motion?.PAN || {};
    const pid = sample.servo_pid?.PAN || {};
    const pos = sample.servo_position?.PAN || {};
    const cfg = sample.effective_config || {};
    const signedErr = panPointingError(sample);
    const err = Number.isFinite(signedErr) ? Math.abs(signedErr) : null;
    const blend = Number.isFinite(err) ? blendFor(err, cfg.pan_schedule_deg || 45) : null;
    const fb = panFeedbackAngle(sample);
    const pot = Number.isFinite(fb) ? fb.toFixed(2) + '°' : '—';
    const tgtNum = pos.active && Number.isFinite(pos.target) ? pos.target : null;
    const tgt = Number.isFinite(tgtNum) ? tgtNum.toFixed(2) + '°' : 'idle';
    const mag = Number.isFinite(magHeading) ? magHeading.toFixed(1) + '°' : '—';
    const magPotRaw = magAsPot(magHeading);
    const magPot = unwrapTo(fb, magPotRaw);
    const magErr = Number.isFinite(magPotRaw) && Number.isFinite(fb)
      ? wrap180(magPotRaw - fb) : null;
    const signedShow = Number.isFinite(tgtNum) && Number.isFinite(fb) ? wrap180(tgtNum - fb) : signedErr;
    let stepNote = '';
    if (stepMark && Number.isFinite(motion.angle)) {
      const potDelta = wrap180(motion.angle - stepMark.pot);
      const magDelta = Number.isFinite(magPotRaw)
        ? wrap180(magPotRaw - stepMark.magPot) : null;
      stepNote = ` · step potΔ ${potDelta >= 0 ? '+' : ''}${potDelta.toFixed(1)}°` +
        (Number.isFinite(magDelta) ? ` magΔ ${magDelta >= 0 ? '+' : ''}${magDelta.toFixed(1)}°` : '');
      if (Number.isFinite(err) && err <= (pos.tolerance || 2) && !stepMark.reported &&
          Math.abs(potDelta) > 2) {
        stepMark.reported = true;
        const ratio = Number.isFinite(magDelta) && Math.abs(potDelta) > 5
          ? Math.abs(magDelta / potDelta) : null;
        if (stepMark.characterize) {
          stepMark.potDeltaMeasured = potDelta;
          const vis = el('tune-visual-deg');
          if (vis && Number.isFinite(magDelta)) vis.placeholder = `mag~${Math.abs(magDelta).toFixed(0)}?`;
          setStatus(
            `Char settle · potΔ ${potDelta.toFixed(1)}°` +
            (Number.isFinite(magDelta) ? ` · magΔ ${magDelta.toFixed(1)}° (mag is NOT trustworthy for scale)` : '') +
            `. Enter visual ° moved, then Apply visual scale.`
          );
        } else {
          setStatus(
            `Settled · potΔ ${potDelta >= 0 ? '+' : ''}${potDelta.toFixed(1)}°` +
            (Number.isFinite(magDelta) ? ` · magΔ ${magDelta >= 0 ? '+' : ''}${magDelta.toFixed(1)}°` : '') +
            (Number.isFinite(stepMark.worldDelta) ? ` · cmd world ${stepMark.worldDelta >= 0 ? '+' : ''}${stepMark.worldDelta}°` : '') +
            (magScale !== 1 ? ` · scale ${magScale.toFixed(3)}×` : '')
          );
        }
      }
    }
    const fwLabel = fwMag() ? 'FW Mag' : 'FW Pot';
    const errTxt = Number.isFinite(signedShow)
      ? `err ${signedShow >= 0 ? '+' : ''}${signedShow.toFixed(2)}° (tgt−fb)`
      : 'err —';
    el('tune-readout').textContent =
      `${fwLabel} · ` +
      (fwMag()
        ? `fb ${pot} · target ${tgt} · ${errTxt}` +
          (Number.isFinite(magHeading) ? ` · ui-hdg ${mag}` : '')
        : `Pot ${pot} · target ${tgt} · mag ${mag}` +
          (Number.isFinite(magPot) ? ` · mag→pot ${magPot.toFixed(1)}°` : '') +
          (Number.isFinite(magErr) ? ` · alignΔ ${magErr >= 0 ? '+' : ''}${magErr.toFixed(1)}°` : '') +
          ` · ${errTxt}`) +
      stepNote +
      ` · blend ${Number.isFinite(blend) ? blend.toFixed(2) : '—'}` +
      ` · phase ${pid.phase ?? '—'} · req ${Number.isFinite(pid.request) ? pid.request.toFixed(1) + ' µs' : '—'}` +
      ` · spike ${cfg.pan_breakaway_us ?? '—'} µs / ${cfg.pan_breakaway_ms ?? '—'} ms`;
  }

  function markStep(potAngle, meta = {}) {
    const magPot = magAsPot(heading);
    stepMark = {
      pot: potAngle,
      magPot: Number.isFinite(magPot) ? magPot : null,
      reported: false,
      worldDelta: meta.worldDelta,
      potDelta: meta.potDelta,
      characterize: !!meta.characterize,
    };
  }

  async function goRelative(worldDelta, options = {}) {
    if (handCal) await setHandCal(false);
    const sample = latest();
    const ang = sample?.servo_motion?.PAN?.angle;

    // Firmware MAG PID: command heading directly (same units the PID measures).
    if (fwMag() && !options.rawPot && !options.characterize) {
      if (!Number.isFinite(heading)) throw Error('Need fresh mag heading for FW Mag feedback.');
      const target = ((heading + worldDelta) % 360 + 360) % 360;
      if (Number.isFinite(ang)) markStep(ang, { worldDelta, potDelta: null, characterize: false, magStart: heading });
      await api('servo-position', { axis: 'PAN', angle: target });
      moveArmedAt = performance.now();
      wasPositionActive = true;
      setStatus(`FW Mag step ${worldDelta >= 0 ? '+' : ''}${worldDelta}° · hdg ${heading.toFixed(1)}° → tgt ${target.toFixed(1)}°`);
      armSettleWatch();
      return;
    }

    if (!Number.isFinite(ang)) throw Error('Need fresh PAN pot angle');

    // Characterize uses raw pot degrees; pot-mode steps scale world→pot if set.
    const potDelta = options.rawPot ? worldDelta : worldDelta / magScale;
    const target = ((ang + potDelta) % 360 + 360) % 360;
    markStep(ang, {
      worldDelta: options.rawPot ? null : worldDelta,
      potDelta,
      characterize: !!options.characterize,
    });
    await api('servo-position', { axis: 'PAN', angle: target });
    if (options.characterize) {
      setStatus(`Characterize: +${worldDelta}° pot from ${ang.toFixed(2)}° → ${target.toFixed(2)}°. Hold still until settle…`);
    } else {
      setStatus(
        `Queued pot ${potDelta >= 0 ? '+' : ''}${potDelta.toFixed(2)}° ` +
        `(scale ${magScale.toFixed(3)}×) → ${target.toFixed(2)}°.`
      );
    }
    moveArmedAt = performance.now();
    wasPositionActive = true;
    armSettleWatch();
  }

  async function characterizeScale() {
    setStatus('Characterize: commanding +90° pot (unscaled). Keep mag clear of metal…');
    await goRelative(90, { rawPot: true, characterize: true });
  }

  async function apply(kind) {
    if (kind === 'pid') {
      await api('servo-pid', {
        axis: 'PAN',
        kp: readNum('kp'), ki: readNum('ki'), kd: readNum('kd'),
        ilimit: readNum('ilimit'), cap: readNum('cap'), tolerance: readNum('tolerance'),
      });
      setStatus('Far PID applied (output stopped). Save PAN to persist.');
    } else if (kind === 'schedule') {
      await api('servo-schedule', {
        axis: 'PAN',
        kp_near: readNum('kp_near'), cap_near: readNum('cap_near'),
        schedule_deg: readNum('schedule_deg'), brk_min_scale: readNum('brk_min_scale'),
        settle_deg: readNum('settle_deg'),
      });
      setStatus('Schedule applied (output stopped). Save PAN to persist.');
    } else if (kind === 'breakaway') {
      await api('servo-breakaway', {
        axis: 'PAN', offset_us: readNum('offset_us'), duration_ms: readNum('duration_ms'),
      });
      setStatus('Breakaway applied (output stopped). Save PAN to persist.');
    } else if (kind === 'deadband') {
      await api('servo-deadband', {
        axis: 'PAN', dbplus: readNum('dbplus'), dbminus: readNum('dbminus'),
      });
      setStatus('Deadband applied (output stopped). Save PAN to persist.');
    } else if (kind === 'ramp') {
      await api('servo-ramp', {
        axis: 'PAN',
        enabled: el('tune-ramp-enabled').checked,
        rate: readNum('ramp_rate'),
      });
      setStatus(`Ramp ${el('tune-ramp-enabled').checked ? 'enabled' : 'disabled'} @ ${readNum('ramp_rate')} °/s (output stopped).`);
    } else if (kind === 'speed') {
      await api('servo-speed', { axis: 'PAN', speed: readNum('speed') });
      setStatus(`Speed limit ${readNum('speed')} °/s queued.`);
    }
  }

  // Sync range ↔ number inputs
  panel.querySelectorAll('[data-tune]').forEach(range => {
    const key = range.dataset.tune;
    const num = panel.querySelector(`[data-tune-num="${key}"]`);
    range.addEventListener('input', () => { if (num) num.value = range.value; });
    num?.addEventListener('input', () => {
      if (Number.isFinite(num.valueAsNumber)) range.value = num.valueAsNumber;
    });
  });

  refreshScaleLabel();
  el('tune-mag-mode').addEventListener('click', async () => {
    try {
      await setFirmwareFeedback(fwMag() ? 'POT' : 'MAG');
    } catch (error) { setStatus(error.message); }
  });
  panel.querySelectorAll('[data-tune-step]').forEach(button => {
    button.addEventListener('click', async () => {
      try { await goRelative(Number(button.dataset.tuneStep)); }
      catch (error) { setStatus(error.message); }
    });
  });
  el('tune-characterize').addEventListener('click', async () => {
    try { await characterizeScale(); }
    catch (error) { setStatus(error.message); }
  });
  el('tune-scale-apply').addEventListener('click', () => {
    try {
      const visual = el('tune-visual-deg').valueAsNumber;
      const handSpan = Number.isFinite(handStart) && Number.isFinite(handEnd)
        ? wrap180(handEnd - handStart) : null;
      const potDelta = Number.isFinite(handSpan) && Math.abs(handSpan) >= 5
        ? handSpan
        : (stepMark?.potDeltaMeasured ?? stepMark?.potDelta);
      if (!Number.isFinite(visual) || visual < 5) throw Error('Enter visual degrees moved (e.g. 90).');
      if (!Number.isFinite(potDelta) || Math.abs(potDelta) < 5) {
        throw Error('Need a potΔ — Hand cal mark start/end, or Char +90° pot.');
      }
      const ratio = Math.abs(visual / potDelta);
      if (ratio < 0.25 || ratio > 4) throw Error(`Implausible scale ${ratio.toFixed(2)}× — check visual entry.`);
      saveScale(ratio);
      setStatus(
        `Scale ${ratio.toFixed(3)}× from visual ${visual}° / potΔ ${Math.abs(potDelta).toFixed(1)}°. ` +
        `Relative +90° will command pot +${(90 / ratio).toFixed(1)}°.`
      );
    } catch (error) { setStatus(error.message); }
  });
  el('tune-scale-reset').addEventListener('click', () => {
    saveScale(1);
    setStatus('Scale reset to 1× (relative steps = pot degrees again).');
  });
  el('tune-hand').addEventListener('click', async () => {
    try { await setHandCal(!handCal); }
    catch (error) { setStatus(error.message); }
  });
  el('tune-hand-exit').addEventListener('click', async () => {
    try { await setHandCal(false); }
    catch (error) { setStatus(error.message); }
  });
  el('tune-hand-reset-ext').addEventListener('click', () => {
    resetHandSweep();
    updateHandReadout();
    setStatus('Extrema reset — keep spinning.');
  });
  el('tune-hand-apply-pot').addEventListener('click', async () => {
    try {
      const s = handSweep;
      if (!s || !Number.isFinite(s.vMin) || !Number.isFinite(s.vMax) || s.vMax - s.vMin < 0.1) {
        throw Error('Need ≥0.1 V pot range — spin more with ADC stream on.');
      }
      if (s.turns < 0.8) throw Error(`Only ~${s.turns.toFixed(2)} turns — spin at least one full turn.`);
      const flat = analyzePotFlat(s) || s.flat;
      // Prefer linear-band edges so the flat/seam is not stretched into "degrees".
      let rawMin = s.vMin, rawMax = s.vMax, usedLinear = false;
      if (flat && Number.isFinite(flat.linearVmin) && flat.linearVmax - flat.linearVmin >= 0.1) {
        rawMin = flat.linearVmin;
        rawMax = flat.linearVmax;
        usedLinear = true;
      }
      const cfg = latest()?.pan_config;
      if (!cfg) throw Error('Need fresh pan_config telemetry.');
      const margin = Math.max(0.005, (rawMax - rawMin) * 0.005);
      const vmin = Math.max(0, rawMin - margin);
      const vmax = Math.min(3.5, rawMax + margin);
      if (vmax - vmin < 0.1) throw Error('Clamped voltage span too small.');
      await api('pan', {
        action: 'configure',
        neutral: cfg.neutral, polarity: cfg.polarity,
        vmin, vmax, span: cfg.span, zero: cfg.zero,
        amin: cfg.amin, amax: cfg.amax,
      });
      setStatus(
        `PAN pot range applied · vmin ${vmin.toFixed(4)} V · vmax ${vmax.toFixed(4)} V` +
        (usedLinear
          ? ` · linear band (excluded ~${flat.flatDeg.toFixed(0)}° flat/seam; abs was ${s.vMin.toFixed(3)}–${s.vMax.toFixed(3)})`
          : ` · abs extrema (flat not clear yet)`) +
        ` · ~${s.turns.toFixed(2)} turns. Save PAN to persist.`
      );
    } catch (error) { setStatus(error.message); }
  });
  el('tune-hand-apply-mag').addEventListener('click', async () => {
    try {
      const fit = fitMagSoft(handSweep?.magPts);
      if (!fit) throw Error('Need more mag samples — spin ≥1 turn with clear sky/no steel nearby.');
      if (handSweep.turns < 0.8) throw Error(`Only ~${handSweep.turns.toFixed(2)} turns — spin at least one full turn.`);
      const soft = { cx: fit.cx, cy: fit.cy, sx: fit.sx, sy: fit.sy };
      saveMagSoft(soft);
      try {
        await api('servo-magsoft', { axis: 'PAN', ...soft });
      } catch (error) {
        setStatus(
          `Browser soft-iron saved, firmware push failed (${error.message}). ` +
          `Update/flash firmware for FW Mag soft-iron.`
        );
        refreshScaleLabel();
        rebuildMagPotHist();
        paint();
        return;
      }
      refreshScaleLabel();
      setStatus(
        `Mag soft-iron applied (browser + firmware) · ecc was ${fit.ecc.toFixed(2)} · ` +
        `center (${fit.cx.toFixed(1)}, ${fit.cy.toFixed(1)}) · scales ${fit.sx.toFixed(1)}/${fit.sy.toFixed(1)}. ` +
        `Save PAN to persist on ESP.`
      );
      rebuildMagPotHist();
      paint();
    } catch (error) { setStatus(error.message); }
  });
  el('tune-hand-clear-mag').addEventListener('click', async () => {
    saveMagSoft(null);
    try { await api('servo-magsoft', { axis: 'PAN', clear: true }); }
    catch { /* older firmware */ }
    refreshScaleLabel();
    setStatus('Mag soft-iron cleared — back to raw atan2 circle. Save PAN to persist.');
    rebuildMagPotHist();
    paint();
  });
  el('tune-hand-mark-start').addEventListener('click', () => {
    const pot = latest()?.servo_motion?.PAN?.angle;
    if (!Number.isFinite(pot)) { setStatus('Need fresh pot angle.'); return; }
    handStart = pot;
    handEnd = null;
    updateHandReadout();
    setStatus(`Hand start marked at pot ${pot.toFixed(2)}°. Spin by hand, then Mark end.`);
  });
  el('tune-hand-mark-end').addEventListener('click', () => {
    const pot = latest()?.servo_motion?.PAN?.angle;
    if (!Number.isFinite(handStart)) { setStatus('Mark start first.'); return; }
    if (!Number.isFinite(pot)) { setStatus('Need fresh pot angle.'); return; }
    handEnd = pot;
    const span = wrap180(handEnd - handStart);
    stepMark = { pot: handStart, potDeltaMeasured: span, potDelta: span, reported: true, characterize: false };
    updateHandReadout();
    setStatus(
      `Hand end pot ${pot.toFixed(2)}° · span ${span >= 0 ? '+' : ''}${span.toFixed(1)}° pot. ` +
      `Enter visual ° moved, then Apply visual scale.`
    );
  });
  el('tune-go-abs').addEventListener('click', async () => {
    try {
      if (handCal) await setHandCal(false);
      const angle = el('tune-absolute').valueAsNumber;
      if (!Number.isFinite(angle)) throw Error('Enter an absolute angle');
      const ang = latest()?.servo_motion?.PAN?.angle;
      if (fwMag()) {
        if (!Number.isFinite(heading)) throw Error('Need fresh mag heading.');
        if (Number.isFinite(ang)) markStep(ang, { magStart: heading });
        await api('servo-position', { axis: 'PAN', angle });
        moveArmedAt = performance.now();
        wasPositionActive = true;
        setStatus(`FW Mag absolute → ${angle.toFixed(1)}° (from hdg ${heading.toFixed(1)}°)`);
        armSettleWatch();
        return;
      }
      if (Number.isFinite(ang)) markStep(ang);
      await api('servo-position', { axis: 'PAN', angle });
      moveArmedAt = performance.now();
      wasPositionActive = true;
      setStatus(`Queued absolute PAN → ${angle.toFixed(2)}° (pot frame).`);
      armSettleWatch();
    } catch (error) { setStatus(error.message); }
  });
  el('tune-auto-stop').addEventListener('click', () => {
    autoStopEnabled = !autoStopEnabled;
    el('tune-auto-stop').setAttribute('aria-pressed', String(autoStopEnabled));
    if (!autoStopEnabled) clearSettleWatch();
    setStatus(autoStopEnabled
      ? `Auto-stop ON · STOP at 5s if |err|>${SETTLE_AUTO_STOP_DEG}° in 3–5s window`
      : 'Auto-stop OFF · moves will not be cut off by the 5s rule');
  });
  el('tune-stop').addEventListener('click', async () => {
    try {
      stopMagCorrector();
      clearSettleWatch();
      await api('servo', { axis: 'PAN', off: true });
      setStatus(handCal ? 'PAN OFF (still in hand cal).' : 'PAN OFF · mag corrector stopped.');
    } catch (error) { setStatus(error.message); }
  });
  el('tune-align').addEventListener('click', () => {
    try {
      const pot = latest()?.servo_motion?.PAN?.angle;
      const avg = meanHeadingWindow(3);
      if (!avg) throw Error('Need ~3s of mag history (hold still, then Align).');
      if (!Number.isFinite(pot)) throw Error('Need a fresh PAN pot angle.');
      const alignHeading = avg.heading;
      const saved = readLocation() || {};
      const invert = !!saved.panInvert;
      const decl = Number.isFinite(saved.magDeclination) ? saved.magDeclination
        : (Number.isFinite(saved.offset) ? saved.offset : 0);
      const mapAz = (alignHeading + decl + 360) % 360;
      const panAlign = invert ? wrap180(mapAz + pot) : wrap180(mapAz - pot);
      const next = {
        lat: Number.isFinite(saved.lat) ? saved.lat : 0,
        lon: Number.isFinite(saved.lon) ? saved.lon : 0,
        length: Number.isFinite(saved.length) ? saved.length : 1000,
        panInvert: invert,
        magDeclination: decl,
        panAlign,
      };
      localStorage.setItem('tracker-device-location', JSON.stringify(next));
      for (const [id, value] of [
        ['device-pan-align', next.panAlign],
        ['device-mag-declination', next.magDeclination],
        ['device-latitude', next.lat],
        ['device-longitude', next.lon],
        ['device-ray-length', next.length],
      ]) {
        const input = document.getElementById(id);
        if (input && Number.isFinite(value)) input.value = value;
      }
      const invertBox = document.getElementById('device-pan-invert');
      if (invertBox) invertBox.checked = !!next.panInvert;
      rebuildMagPotHist();
      // Show Mag→pot vs pot after align; keep raw mag heading off (different frame).
      hiddenTraces.angle.delete(4);
      hiddenTraces.angle.add(3);
      syncLegendPressed('angle');
      const check = magAsPot(alignHeading);
      const delta = Number.isFinite(check) ? wrap180(check - pot) : null;
      setStatus(
        `Aligned · 3s avg mag ${alignHeading.toFixed(1)}° (n=${avg.n}) · Δ ${Number.isFinite(delta) ? (delta >= 0 ? '+' : '') + delta.toFixed(2) + '°' : '—'} ` +
        `(mag→pot ${Number.isFinite(check) ? unwrapTo(pot, check).toFixed(1) : '—'}° ≈ pot ${pot.toFixed(1)}°) · PAN→north ${panAlign.toFixed(1)}°.`
      );
      paint();
    } catch (error) { setStatus(error.message); }
  });
  el('tune-save').addEventListener('click', async () => {
    try {
      await api('pan', { action: 'save' });
      setStatus('PAN settings save queued (NVS).');
    } catch (error) { setStatus(error.message); }
  });
  panel.querySelectorAll('[data-tune-apply]').forEach(button => {
    button.addEventListener('click', async () => {
      try { await apply(button.dataset.tuneApply); }
      catch (error) { setStatus(error.message); }
    });
  });

  // Hook into existing tab clicks (device-map owns the nav).
  tabs.addEventListener('click', event => {
    const button = event.target.closest('[data-view]');
    if (!button) return;
    const view = button.dataset.view;
    visible = view === 'tune';
    panel.hidden = !visible;
    document.body.classList.toggle('tune-view', visible);
    if (view !== 'map') document.body.classList.remove('map-view');
    if (visible) {
      pullFromTelemetry(latest());
      requestAnimationFrame(paint);
    }
  });

  // When map tab shows, hide tune (device-map sets map-view). Do not mutate body.class
  // here — that re-enters this observer and can lock up Firefox with the map-view CSS.
  const observer = new MutationObserver(() => {
    if (document.body.classList.contains('map-view') && visible) {
      visible = false;
      panel.hidden = true;
    }
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });

  return {
    setVisible(show) {
      visible = !!show;
      panel.hidden = !visible;
      document.body.classList.toggle('tune-view', visible);
      if (visible) {
        pullFromTelemetry(latest());
        requestAnimationFrame(paint);
      }
    },
    update(magHeading, sample) {
      const nowPerf = performance.now() / 1000;
      const t = sample?.received_at ?? sample?.plot_at ?? Date.now() / 1000;
      ingestHandSample(sample);
      // Prefer soft-iron-corrected heading from raw mag when available.
      let useHeading = magHeading;
      const hxy = horizontalMag(sample?.accel, sample?.mag);
      if (hxy) useHeading = headingFromSoft(hxy[0], hxy[1]);
      if (Number.isFinite(useHeading)) {
        if (headingAt == null || nowPerf - headingAt > 1 || !Number.isFinite(heading)) heading = useHeading;
        else {
          const delta = wrap180(useHeading - heading);
          heading = (heading + delta * 0.35 + 360) % 360;
        }
        headingAt = nowPerf;
        magHist.push({ t, v: heading });
        const posTgt = sample?.servo_position?.PAN;
        if (fwMag() && posTgt?.active && Number.isFinite(posTgt.target)) {
          magTarget = posTgt.target;
          magTargetHist.push({ t, v: posTgt.target });
        }
        const magPot = magAsPot(heading);
        if (Number.isFinite(magPot)) magPotHist.push({ t, v: magPot });
        pruneHist(magHist, t);
        pruneHist(magPotHist, t);
        pruneHist(magTargetHist, t);
      }
      if (visible && sample && document.activeElement?.closest?.('.tune-controls') == null) {
        // Refresh slider reported values when not editing.
        if (!statusTimer) {
          statusTimer = setTimeout(() => {
            statusTimer = null;
            pullFromTelemetry(latest());
          }, 400);
        }
      }
      updateReadout(sample, heading);
      checkSettleWatch(sample);
      watchFirmwarePositionEnd(sample);
      if (handCal) updateHandReadout();
      if (visible) paint();
    },
    paint,
  };
})();
