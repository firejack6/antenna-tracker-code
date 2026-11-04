/* Device location + azimuth. Go-to closes the loop on mag heading (world frame).
   PAN pot is the actuator only — its degree scale is not trusted as truth. */
const mapAzimuthSmoothingSeconds = 0.35;
function smoothMapAzimuth(previous, value, seconds) {
  if (!Number.isFinite(previous)) return (value % 360 + 360) % 360;
  const delta = ((value - previous + 540) % 360 + 360) % 360 - 180;
  const alpha = 1 - Math.exp(-Math.max(0, seconds) / mapAzimuthSmoothingSeconds);
  return (previous + alpha * delta + 360) % 360;
}
const deviceMap = (() => {
  const main = document.querySelector('main');
  const tabs = document.createElement('nav'); tabs.className = 'workspace-tabs'; tabs.setAttribute('aria-label', 'Dashboard views');
  tabs.innerHTML = '<button type="button" data-view="controls" aria-pressed="true">Controls</button><button type="button" data-view="map" aria-pressed="false">Map</button>';
  main.prepend(tabs);
  const panel = document.createElement('section'); panel.className = 'panel map-panel'; panel.hidden = true;
  panel.innerHTML = `<div class="section-heading"><h2>Device map</h2><button type="button" id="map-center" class="secondary">Center on device</button></div>
    <form id="device-location-form"><div class="map-fields">
    <label class="track-flight-select">Saved coords<select id="device-site"><option value="">Custom / enter below</option></select></label>
    <label>Latitude (°)<input id="device-latitude" type="number" min="-90" max="90" step="any" required placeholder="e.g. 41.88"></label>
    <label>Longitude (°)<input id="device-longitude" type="number" min="-180" max="180" step="any" required placeholder="e.g. -87.63"></label>
    <label>Altitude AGL (m)<input id="device-altitude" type="number" min="0" max="10000" step="any" value="0" required title="Antenna height above ground. Elevation = atan2(target AGL − this, range)."></label>
    <label>PAN→north align (°)<input id="device-pan-align" type="number" min="-360" max="360" step="any" value="0" required title="From Align click or Seed from mag."></label>
    <label>Mag declination (°)<input id="device-mag-declination" type="number" min="-360" max="360" step="any" value="0" title="Added to magnetic heading for Seed from mag (true ≈ mag + declination)."></label>
    <label>Ray length (m)<input id="device-ray-length" type="number" min="1" max="100000" step="any" value="1000" required></label>
    <label class="map-check"><input id="device-pan-invert" type="checkbox"> Invert PAN vs map azimuth</label></div>
    <div class="buttons">
      <button type="submit">Save device location</button>
      <button type="button" id="map-seed-mag" class="secondary">Seed align from mag</button>
    </div>
    <p id="device-location-status" role="status">Enter device coordinates. Saved in this browser; this is not a live GPS fix.</p></form>
    <p id="device-aim-source" class="map-aim-source" role="status">AIM SOURCE: mag heading (closed-loop). Pot = actuator only.</p>
    <p id="device-map-heading" role="status">Waiting for sensors</p>
    <p class="plot-note"><strong>Go-to / Circle / Rocket / Sim send TRACK TARGET lat lon alt</strong> — the board aims. Tune ±steps still use angle commands. <em>Align</em> / <em>Seed</em> set declination; Save also queues TRACK HOME.</p>

    <div class="track-tools" aria-label="Synthetic tracking">
      <div class="section-heading"><div><div class="eyebrow">SYNTHETIC TARGET</div><h2>Track tools</h2></div>
        <div class="buttons track-mode-buttons">
          <button type="button" data-track-mode="off" aria-pressed="true">Off</button>
          <button type="button" data-track-mode="align" aria-pressed="false">Align</button>
          <button type="button" data-track-mode="goto" aria-pressed="false">Go to click</button>
          <button type="button" data-track-mode="circle" aria-pressed="false">Circle</button>
          <button type="button" data-track-mode="rocket" aria-pressed="false">Rocket</button>
          <button type="button" id="track-run-sim" class="secondary">Replay flight</button>
          <button type="button" id="track-stop" class="secondary">Stop</button>
        </div></div>
      <p class="plot-note">Align does not move servos — it teaches the map where the dish is pointing. Go-to/Circle/Rocket/Replay send <strong>TRACK TARGET lat lon alt only</strong>. Save pushes TRACK HOME to the board. Angle targets are Tune-only. Speed/gains/feedback stay whatever you last set in Tune. Flight replay uses each file’s native timestamps (no 10&nbsp;Hz resample).</p>
      <div class="map-fields track-fields">
        <label class="track-flight-select">Flight<select id="track-flight"><option value="">Loading…</option></select></label>
        <label>Target altitude AGL (m)<input id="track-altitude" type="number" min="0" max="100000" step="any" value="500" title="Same AGL frame as device altitude. El uses (target − device)."></label>
        <label>Circle radius (m)<input id="track-radius" type="number" min="10" max="100000" step="any" value="1000"></label>
        <label>Circle rate (°/s)<input id="track-circle-rate" type="number" min="0.1" max="90" step="any" value="6"></label>
        <label>Rocket apogee (m)<input id="track-rocket-apogee" type="number" min="10" max="100000" step="any" value="2000"></label>
        <label>Rocket boost (s)<input id="track-rocket-boost" type="number" min="0.5" max="60" step="any" value="3"></label>
        <label>Rocket descent (s)<input id="track-rocket-descent" type="number" min="1" max="600" step="any" value="25"></label>
        <label>Rocket drift (m)<input id="track-rocket-drift" type="number" min="0" max="50000" step="any" value="200"></label>
      </div>
      <p id="track-status" role="status">Synthetic tracking off.</p>
    </div>

    <div class="map-viewport"><div id="device-map" aria-label="Device location and dish pointing map"></div>
    <aside class="map-pointing" aria-label="Pointing error">
      <strong id="map-pointing-title">Pointing</strong>
      <span id="map-pointing-pan">PAN —</span>
      <span id="map-pointing-tilt">TILT —</span>
      <span id="map-pointing-track">Track —</span>
      <span id="map-pointing-offset">Align —</span>
      <small id="map-pointing-hint">Align first so red can meet gold.</small>
    </aside>
    <aside class="map-elevation" aria-label="Live device elevation">
      <strong id="map-elevation-value">Elevation unavailable</strong><span id="map-elevation-target"></span>
      <svg viewBox="0 0 180 112" role="img" aria-label="Elevation side view relative to TILT zero">
        <path d="M10 82 H170" stroke="#8797aa" stroke-dasharray="4 4" fill="none"/>
        <text x="142" y="98" fill="#b0bdcb" font-size="11">0°</text>
        <g id="map-elevation-pointer"><path d="M90 82 H155 M147 77 L155 82 L147 87" stroke="#ef3038" stroke-width="4" fill="none"/></g>
        <circle cx="90" cy="82" r="5" fill="#69adff"/>
      </svg><small>Side view · relative to TILT zero</small>
    </aside></div><p id="map-tile-status" role="status"></p>
    <div class="map-track-plots" aria-label="Track distance and angle plots">
      <div>
        <h3>Distance <small>horizontal range · altitude AGL</small></h3>
        <div class="mini-legend"><span style="color:#69adff">Range m</span><span style="color:#f5bd4f">Alt m</span></div>
        <canvas id="map-distance-chart" class="chart-hoverable" role="img" aria-label="Rocket horizontal range and altitude versus time"></canvas>
      </div>
      <div>
        <h3>Azimuth <small>actual · target</small></h3>
        <div class="mini-legend"><span style="color:#ef3038">Az actual</span><span style="color:#f5bd4f">Az target</span></div>
        <canvas id="map-az-chart" class="chart-hoverable" role="img" aria-label="Tracker actual and target azimuth versus time"></canvas>
      </div>
      <div>
        <h3>Elevation <small>actual · target</small></h3>
        <div class="mini-legend"><span style="color:#69adff">El actual</span><span style="color:#a88bfa">El target</span></div>
        <canvas id="map-el-chart" class="chart-hoverable" role="img" aria-label="Tracker actual and target elevation versus time"></canvas>
      </div>
    </div>`;
  tabs.after(panel);
  const el = id => document.getElementById(id);
  let config = null, map = null, marker = null, dishRay = null, magRay = null, targetRay = null;
  let heading = null, elevation = null, target = null, panAngle = null, panTarget = null;
  let stale = true, magStale = true; // stale = servo/link; magStale = IMU/mag only
  let headingUpdatedAt = null;
  let trackMode = 'off', trackTimer = null, gotoTimer = null, trackBusy = false, lastCommandAt = 0;
  let targetMarker = null, padMarker = null, pathLine = null, pathPoints = [];
  let clickLatLng = null, runStartedAt = null, lastAim = null, alignReady = false;
  let lastHudDrawAt = 0, lastLeafletDrawAt = 0, leafletDrawTimer = null, lastPlotDrawAt = 0;
  // Rolling history for map plots (t = performance.now()/1000).
  const trackHist = [];
  const TRACK_HIST_SPAN_S = 60;
  const TRACK_HIST_MAX = 600;
  const wrap180 = deg => ((deg + 180) % 360 + 360) % 360 - 180;
  const wrap360 = deg => ((deg % 360) + 360) % 360;
  const fmtErr = deg => `${deg >= 0 ? '+' : ''}${deg.toFixed(1)}°`;
  let panFb = null; // 'MAG' | 'POT' | null from board effective_config
  let lastCommandedLat = null, lastCommandedLon = null, lastCommandedAlt = null, lastCommandedAt = 0;
  let homePushedKey = null;
  function magMapAzimuth() {
    if (!config || !Number.isFinite(heading) || magStale) return null;
    return wrap360(heading + (config.magDeclination || 0));
  }
  function dishAzimuth() {
    return magMapAzimuth();
  }
  function potDishAzimuth() {
    if (!config || !Number.isFinite(panAngle)) return null;
    return config.panInvert
      ? wrap360(config.panAlign - panAngle)
      : wrap360(panAngle + config.panAlign);
  }
  /** Absolute mag heading the FW Mag PID should chase for a true map azimuth. */
  function magHeadingForTrueAz(azTrue) {
    return wrap360(azTrue - (config?.magDeclination || 0));
  }

  function destination(latitude, longitude, bearing, metres) {
    const rad = Math.PI / 180, p = latitude * rad, l = longitude * rad, b = bearing * rad, d = metres / 6371000;
    const p2 = Math.asin(Math.max(-1, Math.min(1, Math.sin(p) * Math.cos(d) + Math.cos(p) * Math.sin(d) * Math.cos(b))));
    const l2 = l + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p), Math.cos(d) - Math.sin(p) * Math.sin(p2));
    return [p2 / rad, l2 / rad];
  }
  function haversineM(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180, p1 = lat1 * r, p2 = lat2 * r, dp = (lat2 - lat1) * r, dl = (lon2 - lon1) * r;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  function bearingDeg(lat1, lon1, lat2, lon2) {
    const r = Math.PI / 180, p1 = lat1 * r, p2 = lat2 * r, dl = (lon2 - lon1) * r;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return wrap360(Math.atan2(y, x) / r);
  }
  function azEl(lat, lon, altM) {
    if (!config) throw Error('Save a device location first.');
    if (magStale || !Number.isFinite(heading)) throw Error('Need fresh mag heading (FW Mag tracking).');
    const range = Math.max(1, haversineM(config.lat, config.lon, lat, lon));
    const azTrue = bearingDeg(config.lat, config.lon, lat, lon);
    const relAlt = altM - (Number.isFinite(config.alt) ? config.alt : 0);
    const elDeg = Math.max(-5, Math.min(85, Math.atan2(relAlt, range) * 180 / Math.PI));
    const dish = dishAzimuth();
    const azErr = Number.isFinite(dish) ? wrap180(azTrue - dish) : null;
    // Same frame as Tune Mag ±steps / track_sim: absolute magnetic heading.
    const pan = magHeadingForTrueAz(azTrue);
    return { pan, el: elDeg, azTrue, range, dish, azErr, mode: 'mag' };
  }
  async function trackApi(path, data) {
    const response = await fetch('/api/' + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), cache: 'no-store',
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(body.error || response.statusText || 'Request failed');
    return body;
  }
  function targetMoved(lat, lon, altM, opts = {}) {
    if (opts.force) return true;
    if (!Number.isFinite(lastCommandedLat)) return true;
    const minM = opts.minMoveM ?? (trackMode === 'goto' ? 2 : 8);
    const minAlt = opts.minAltDelta ?? 2;
    const moved = haversineM(lastCommandedLat, lastCommandedLon, lat, lon) >= minM;
    const altChanged = Math.abs(altM - lastCommandedAlt) >= minAlt;
    return moved || altChanged;
  }
  async function pushTrackHome(cfg = config, force = false) {
    if (!cfg) throw Error('Save a device location first.');
    const key = [cfg.lat, cfg.lon, cfg.alt || 0, cfg.magDeclination || 0, cfg.panAlign || 0, !!cfg.panInvert].join('|');
    if (!force && homePushedKey === key) return;
    await trackApi('track-home', {
      lat: cfg.lat, lon: cfg.lon, alt: cfg.alt || 0,
      mag_declination: cfg.magDeclination || 0,
      pan_align: cfg.panAlign || 0,
      pan_invert: !!cfg.panInvert,
    });
    homePushedKey = key;
  }
  async function commandTarget(lat, lon, altM, opts = {}) {
    // Tracking speaks geography only — SERVO POSITION angles are Tune-only.
    if (!targetMoved(lat, lon, altM, opts)) return false;
    // Board rejects TARGET until HOME is set (flash clears NVS; browser localStorage is not enough).
    await pushTrackHome(config, !!opts.force);
    await trackApi('track-target', { lat, lon, alt: altM });
    lastCommandedLat = lat;
    lastCommandedLon = lon;
    lastCommandedAlt = altM;
    lastCommandedAt = performance.now();
    return true;
  }
  async function stopAxes() {
    try { await trackApi('track-off', {}); } catch { /* ignore */ }
  }
  function setStatus(text) { el('track-status').textContent = text; }
  function setMode(mode) {
    const prev = trackMode;
    // Stop before flipping mode so stopTrack still sees wasSim / timers.
    if (mode === 'off' || mode === 'align') stopTrack(false);
    else if (prev === 'sim' && mode !== 'sim') stopTrack(false);
    trackMode = mode;
    panel.querySelectorAll('[data-track-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.trackMode === mode)));
    if (mode === 'off') {
      lastAim = null;
      setStatus('Synthetic tracking off.');
      draw();
    } else if (mode === 'align') {
      setStatus('Align armed — point dish at a landmark, click it. Sets mag declination (true − heading). No servo move.');
    } else if (mode === 'goto') {
      setStatus('Go-to-click armed — steers until mag meets target. Servos must be enabled.');
    } else if (mode === 'circle') setStatus('Circle armed — click a center. Orbit uses radius/rate below.');
    else if (mode === 'rocket') setStatus('Rocket armed — click a launch pad.');
  }
  function stopGotoCorrector() {
    if (gotoTimer) { clearInterval(gotoTimer); gotoTimer = null; }
  }
  function stopTrack(sendOff = true) {
    stopGotoCorrector();
    if (trackTimer) { clearInterval(trackTimer); trackTimer = null; }
    runStartedAt = null;
    lastCommandedLat = lastCommandedLon = lastCommandedAlt = null;
    lastCommandedAt = 0;
    const wasSim = trackMode === 'sim';
    if (wasSim) {
      trackApi('track-sim', { action: 'stop', off: !!sendOff }).catch(error => {
        if (sendOff) setStatus(error.message);
      });
    } else if (sendOff) {
      stopAxes().catch(error => setStatus(error.message));
    }
  }
  let flightCatalog = [];
  let siteCatalog = [];
  function fillSiteSelect(selectedId) {
    const sel = el('device-site');
    if (!sel) return;
    const keep = selectedId != null ? selectedId : sel.value;
    sel.innerHTML = '<option value="">Custom / enter below</option>';
    for (const s of siteCatalog) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = `${s.label} · ${Number(s.lat).toFixed(5)}, ${Number(s.lon).toFixed(5)}`;
      sel.appendChild(opt);
    }
    if (keep && siteCatalog.some(s => s.id === keep)) sel.value = keep;
  }
  function applySite(site, { save = false, note } = {}) {
    if (!site) return;
    el('device-latitude').value = site.lat;
    el('device-longitude').value = site.lon;
    el('device-altitude').value = Number.isFinite(site.alt) ? site.alt : 0;
    const siteSel = el('device-site');
    if (siteSel && site.id) siteSel.value = site.id;
    if (save) {
      try {
        saveConfig(read(), note || `Loaded ${site.label} — saved`);
        alignReady = true;
      } catch (error) {
        el('device-location-status').textContent = error.message;
      }
    } else {
      el('device-location-status').textContent =
        `Loaded ${site.label} (${Number(site.lat).toFixed(5)}, ${Number(site.lon).toFixed(5)}) — click Save device location to apply`;
    }
  }
  function siteForFlight(file) {
    const flight = flightCatalog.find(f => f.file === file);
    if (flight?.home?.id) {
      return siteCatalog.find(s => s.id === flight.home.id) || flight.home;
    }
    return null;
  }
  async function loadFlightList() {
    const sel = el('track-flight');
    if (!sel) return;
    try {
      const response = await fetch('/api/track-flights', { cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(body.error || response.statusText);
      flightCatalog = body.flights || [];
      siteCatalog = body.sites || [];
      fillSiteSelect(localStorage.getItem('device-site') || '');
      const prev = sel.value || localStorage.getItem('track-flight') || '';
      sel.innerHTML = '';
      if (!flightCatalog.length) {
        sel.innerHTML = '<option value="">No flights in testdata/</option>';
        return;
      }
      for (const f of flightCatalog) {
        const opt = document.createElement('option');
        opt.value = f.file;
        const mins = f.duration_s >= 60 ? `${(f.duration_s / 60).toFixed(1)} min` : `${f.duration_s.toFixed(1)} s`;
        const homeTag = f.home ? ` · ${f.home.label}` : '';
        opt.textContent = `${f.label} · ${f.points} pts · ${mins}${homeTag}`;
        sel.appendChild(opt);
      }
      const pick = flightCatalog.some(f => f.file === prev) ? prev
        : (flightCatalog.find(f => /testdata1\.csv$/i.test(f.file)) || flightCatalog[0]).file;
      sel.value = pick;
      sel.onchange = () => {
        localStorage.setItem('track-flight', sel.value);
        const site = siteForFlight(sel.value);
        if (site) applySite(site, { save: false });
      };
    } catch (error) {
      sel.innerHTML = `<option value="">${error.message}</option>`;
    }
  }
  async function startSimFlight() {
    if (!config) { setStatus('Save a device location before Replay flight.'); return; }
    const file = el('track-flight')?.value;
    if (!file) { setStatus('Pick a flight to replay.'); return; }
    stopTrack(false);
    clearPath();
    trackMode = 'sim';
    panel.querySelectorAll('[data-track-mode]').forEach(b => b.setAttribute('aria-pressed', 'false'));
    setStatus('Starting flight replay…');
    try {
      const body = await trackApi('track-sim', {
        action: 'start',
        file,
        lat: config.lat,
        lon: config.lon,
        alt: config.alt || 0,
        pan_align: config.panAlign,
        mag_declination: config.magDeclination || 0,
        pan_invert: !!config.panInvert,
      });
      localStorage.setItem('track-flight', file);
      setStatus(body.message || 'Flight replay running');
      if (Number.isFinite(body.lat) && Number.isFinite(body.lon)) {
        lastAim = { azTrue: body.az, el: body.el, range: body.range_m, lat: body.lat, lon: body.lon, altM: body.alt, pan: body.pan };
        drawTarget(body.lat, body.lon, true);
        draw();
      }
    } catch (error) {
      trackMode = 'off';
      panel.querySelectorAll('[data-track-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.trackMode === 'off')));
      setStatus(error.message);
    }
  }
  let lastSimStatus = '';
  let lastSimDrawAt = 0;
  function applyRelaySim(sim) {
    if (!sim || panel.hidden) return;
    if (sim.active) {
      if (trackMode !== 'sim') {
        trackMode = 'sim';
        panel.querySelectorAll('[data-track-mode]').forEach(b => b.setAttribute('aria-pressed', 'false'));
      }
      if (Number.isFinite(sim.lat) && Number.isFinite(sim.lon)) {
        lastAim = {
          azTrue: sim.az, el: sim.el, range: sim.range_m, lat: sim.lat, lon: sim.lon,
          altM: sim.alt, pan: sim.pan, dish: dishAzimuth(), azErr: null,
        };
        // Keep marker/path ≤ ~4 Hz — poll is faster and trail setLatLngs was a freeze vector.
        const now = performance.now();
        if (now - lastSimDrawAt >= 250) {
          lastSimDrawAt = now;
          drawTarget(sim.lat, sim.lon, true);
          draw();
        }
      }
      if (sim.message && sim.message !== lastSimStatus) {
        lastSimStatus = sim.message;
        setStatus(sim.message);
      }
    } else if (trackMode === 'sim') {
      trackMode = 'off';
      panel.querySelectorAll('[data-track-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.trackMode === 'off')));
      lastSimStatus = sim.message || 'Sim stopped';
      setStatus(lastSimStatus);
    }
  }
  function startGotoCorrector(lat, lon, altM) {
    stopGotoCorrector();
    const deadline = performance.now() + 12000;
    gotoTimer = setInterval(() => {
      if (trackMode !== 'goto' || performance.now() > deadline) {
        if (trackMode === 'goto') setStatus('Go to click · corrector stopped.');
        stopGotoCorrector();
        return;
      }
      if (magStale || stale || trackBusy || !Number.isFinite(heading)) return;
      let look;
      try { look = azEl(lat, lon, altM); }
      catch { return; }
      lastAim = { ...look, lat, lon, altM };
      draw();
      const elErr = Number.isFinite(elevation) ? look.el - elevation : 0;
      if (Number.isFinite(look.azErr) && Math.abs(look.azErr) <= 3 && Math.abs(elErr) <= 5) {
        setStatus(`Go to click · settled · mag err ${fmtErr(look.azErr)} · el ${fmtErr(elErr)}`);
        stopGotoCorrector();
        return;
      }
      // Do NOT re-fire SERVO POSITION every tick — that restarts breakaway/PID mid-move.
      // One retry only if still off after the step should have settled (~2.5 s).
      if (performance.now() - lastCommandedAt < 2500) {
        setStatus(`Go to click · settling · mag err ${fmtErr(look.azErr ?? 0)}`);
        return;
      }
      aimAt(lat, lon, altM, `Go to click · retry · mag err ${fmtErr(look.azErr ?? 0)}`, {
        fromCorrector: true, force: true,
      });
    }, 350);
  }
  function panAlignForMapAz(mapAz) {
    return config.panInvert ? wrap180(mapAz + panAngle) : wrap180(mapAz - panAngle);
  }
  function applyAlign(lat, lon) {
    if (!config) throw Error('Save a device location first.');
    if (!Number.isFinite(heading) || magStale) throw Error('Need a fresh mag heading before Align.');
    const azTrue = bearingDeg(config.lat, config.lon, lat, lon);
    const magDeclination = wrap180(azTrue - heading);
    const panAlign = Number.isFinite(panAngle) ? panAlignForMapAz(azTrue) : config.panAlign;
    saveConfig({ ...config, magDeclination, panAlign },
      `Aligned (landmark→mag): heading ${heading.toFixed(1)}° → map az ${azTrue.toFixed(1)}° · decl ${magDeclination.toFixed(1)}° · pot-align ${panAlign.toFixed(1)}° (diagnostic).`);
    alignReady = true;
    lastAim = { pan: panAngle, el: elevation, azTrue, range: haversineM(config.lat, config.lon, lat, lon), dish: azTrue, azErr: 0, lat, lon, altM: num('track-altitude', 500) };
    drawTarget(lat, lon, false);
    setStatus(`Mag declination set so dish az ${azTrue.toFixed(1)}° at this landmark.`);
    draw();
  }
  function seedAlignFromMag() {
    if (!config) throw Error('Save a device location first.');
    if (!Number.isFinite(heading) || magStale) throw Error('Need a fresh mag heading (hold still).');
    const magAz = (heading + 360) % 360;
    const panAlign = Number.isFinite(panAngle) ? panAlignForMapAz(magAz) : config.panAlign;
    saveConfig({ ...config, magDeclination: 0, panAlign },
      `Seeded: declination 0 · map az = mag ${magAz.toFixed(1)}° · pot-align ${Number.isFinite(panAlign) ? panAlign.toFixed(1) : '—'}° (diagnostic). Landmark Align if mag≠true north.`);
    alignReady = true;
    setStatus(`Mag seed · decl=0 · go-to will chase mag ${magAz.toFixed(1)}°.`);
    draw();
  }
  function drawTarget(lat, lon, trail = false, label = null) {
    if (!map) return;
    if (!targetMarker) {
      targetMarker = L.circleMarker([lat, lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#f5bd4f', fillOpacity: 1 });
      targetMarker.bindTooltip('', { permanent: true, direction: 'top', offset: [0, -10], className: 'map-target-tip' });
    } else targetMarker.setLatLng([lat, lon]);
    if (!map.hasLayer(targetMarker)) targetMarker.addTo(map);
    if (label != null) targetMarker.setTooltipContent(label);
    if (trail) {
      pathPoints.push([lat, lon]);
      if (pathPoints.length > 400) pathPoints.shift();
      if (!pathLine) pathLine = L.polyline(pathPoints, { color: '#f5bd4f', weight: 3, opacity: 0.85 });
      else pathLine.setLatLngs(pathPoints);
      if (!map.hasLayer(pathLine)) pathLine.addTo(map);
    }
  }
  function drawPad(lat, lon) {
    if (!map) return;
    if (!padMarker) padMarker = L.circleMarker([lat, lon], { radius: 6, color: '#fff', weight: 2, fillColor: '#8797aa', fillOpacity: 1 });
    else padMarker.setLatLng([lat, lon]);
    if (!map.hasLayer(padMarker)) padMarker.addTo(map);
  }
  function clearPath() {
    pathPoints = [];
    trackHist.length = 0;
    if (pathLine && map?.hasLayer(pathLine)) map.removeLayer(pathLine);
    if (padMarker && map?.hasLayer(padMarker)) map.removeLayer(padMarker);
    if (targetMarker) targetMarker.setTooltipContent('');
  }
  function recordTrackSample() {
    if (!lastAim || !Number.isFinite(lastAim.lat)) return;
    const t = performance.now() / 1000;
    const dish = dishAzimuth();
    trackHist.push({
      t,
      range: Number.isFinite(lastAim.range) ? lastAim.range : null,
      alt: Number.isFinite(lastAim.altM) ? lastAim.altM : null,
      azActual: Number.isFinite(dish) ? dish : null,
      azTarget: Number.isFinite(lastAim.azTrue) ? lastAim.azTrue : null,
      elActual: Number.isFinite(elevation) ? elevation : null,
      elTarget: Number.isFinite(lastAim.el) ? lastAim.el : null,
    });
    const cutoff = t - TRACK_HIST_SPAN_S;
    while (trackHist.length && (trackHist.length > TRACK_HIST_MAX || trackHist[0].t < cutoff)) trackHist.shift();
  }
  function paintTrackChart(canvasId, series, options = {}) {
    const canvas = el(canvasId);
    if (!canvas || panel.hidden) return;
    const box = canvas.getBoundingClientRect();
    if (!box.width) return;
    const dpr = window.devicePixelRatio || 1;
    const width = box.width, height = box.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const pad = { left: 48, right: 10, top: 12, bottom: 22 };
    const w = width - pad.left - pad.right, h = height - pad.top - pad.bottom;
    const span = TRACK_HIST_SPAN_S;
    const now = performance.now() / 1000;
    const wrapBreak = options.wrapBreak;
    const points = series.map(s => s.filter(p => p && now - p.t <= span && Number.isFinite(p.v)));
    const values = points.flatMap(pts => pts.map(p => p.v));
    let low = 0, high = 1;
    if (values.length) {
      low = Math.min(...values);
      high = Math.max(...values);
      if (low === high) { low -= 1; high += 1; }
      const margin = (high - low) * 0.12 || 1;
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
      ctx.fillText('Waiting for track target…', pad.left + w / 2, pad.top + h / 2);
      return;
    }
    const xOf = t => pad.left + ((t - (now - span)) / span) * w;
    const yOf = v => pad.top + (1 - (v - low) / (high - low)) * h;
    points.forEach((pts, i) => {
      if (pts.length < 2) return;
      ctx.strokeStyle = options.colors?.[i] || '#61e2bd';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      let drawing = false, prev = null;
      for (const p of pts) {
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
        })),
      });
    }
  }
  function paintTrackPlots() {
    if (panel.hidden) return;
    const range = [], alt = [], azA = [], azT = [], elA = [], elT = [];
    for (const s of trackHist) {
      if (Number.isFinite(s.range)) range.push({ t: s.t, v: s.range });
      if (Number.isFinite(s.alt)) alt.push({ t: s.t, v: s.alt });
      if (Number.isFinite(s.azActual)) azA.push({ t: s.t, v: s.azActual });
      if (Number.isFinite(s.azTarget)) azT.push({ t: s.t, v: s.azTarget });
      if (Number.isFinite(s.elActual)) elA.push({ t: s.t, v: s.elActual });
      if (Number.isFinite(s.elTarget)) elT.push({ t: s.t, v: s.elTarget });
    }
    paintTrackChart('map-distance-chart', [range, alt], {
      colors: ['#69adff', '#f5bd4f'], labels: ['Range m', 'Alt m'], decimals: 0,
    });
    paintTrackChart('map-az-chart', [azA, azT], {
      colors: ['#ef3038', '#f5bd4f'], labels: ['Az actual', 'Az target'],
      decimals: 1, wrapBreak: 180,
    });
    paintTrackChart('map-el-chart', [elA, elT], {
      colors: ['#69adff', '#a88bfa'], labels: ['El actual', 'El target'],
      decimals: 1,
    });
  }
  /** Always paint synthetic lat/lon/alt on the map — independent of mag/servo. */
  function showSynthetic(lat, lon, altM, note = null) {
    if (!config) return null;
    const range = Math.max(1, haversineM(config.lat, config.lon, lat, lon));
    const azTrue = bearingDeg(config.lat, config.lon, lat, lon);
    const relAlt = altM - (Number.isFinite(config.alt) ? config.alt : 0);
    const elDeg = Math.max(-5, Math.min(85, Math.atan2(relAlt, range) * 180 / Math.PI));
    const dish = dishAzimuth();
    const azErr = Number.isFinite(dish) ? wrap180(azTrue - dish) : null;
    lastAim = {
      pan: Number.isFinite(heading) ? magHeadingForTrueAz(azTrue) : null,
      el: elDeg, azTrue, range, dish, azErr, mode: 'mag', lat, lon, altM,
    };
    const label = Number.isFinite(altM) ? `${altM.toFixed(0)} m` : '';
    drawTarget(lat, lon, true, label);
    draw();
    if (note) setStatus(`${note} · az ${azTrue.toFixed(1)}° el ${elDeg.toFixed(1)}°`);
    return lastAim;
  }
  function num(id, fallback) {
    const v = el(id).valueAsNumber;
    return Number.isFinite(v) ? v : fallback;
  }
  async function aimAt(lat, lon, altM, note, opts = {}) {
    showSynthetic(lat, lon, altM, null);
    const look = lastAim;
    draw();
    const now = performance.now();
    if (!opts.force && (now - lastCommandAt < 150 || trackBusy)) {
      setStatus(`${note} · az ${look?.azTrue?.toFixed(1) ?? '—'}° el ${look?.el?.toFixed(1) ?? '—'}°`);
      return look;
    }
    trackBusy = true; lastCommandAt = now;
    try {
      const sent = await commandTarget(lat, lon, altM, {
        force: !!opts.force,
        minMoveM: opts.minMoveM ?? (trackMode === 'goto' ? 2 : 8),
        minAltDelta: opts.minAltDelta ?? 2,
      });
      setStatus(sent
        ? `${note} · TARGET ${lat.toFixed(5)}, ${lon.toFixed(5)} · ${altM.toFixed(0)} m · az ${look?.azTrue?.toFixed(1) ?? '—'}°`
        : `${note} · holding · az ${look?.azTrue?.toFixed(1) ?? '—'}° · err ${fmtErr(look?.azErr ?? 0)}`);
      if (trackMode === 'goto' && !opts.fromCorrector) startGotoCorrector(lat, lon, altM);
    } catch (error) {
      setStatus(`${note} · ${error.message}`);
    } finally { trackBusy = false; }
    return look;
  }
  function startLoop(tick) {
    stopTrack(false);
    clearPath();
    runStartedAt = performance.now() / 1000;
    trackTimer = setInterval(() => {
      try { tick(performance.now() / 1000 - runStartedAt); }
      catch (error) { setStatus(error.message); stopTrack(true); }
    }, 150);
  }
  function startCircle(centerLat, centerLon) {
    const radius = num('track-radius', 1000), rate = num('track-circle-rate', 6), alt = num('track-altitude', 500);
    startLoop(t => {
      const bearing = (rate * t) % 360;
      const [lat, lon] = destination(centerLat, centerLon, bearing, radius);
      aimAt(lat, lon, alt, `Circle ${rate}°/s · r ${radius} m`);
    });
  }
  function startRocket(padLat, padLon) {
    const apogee = num('track-rocket-apogee', 2000);
    const boost = Math.max(0.5, num('track-rocket-boost', 3));
    const descent = Math.max(1, num('track-rocket-descent', 25));
    const drift = Math.max(0, num('track-rocket-drift', 200));
    const driftBearing = Math.random() * 360;
    init();
    drawPad(padLat, padLon);
    showSynthetic(padLat, padLon, 0, 'Rocket pad marked');
    startLoop(t => {
      let alt, fracHoriz = 0, phase;
      if (t <= boost) {
        const u = t / boost;
        alt = apogee * (1 - (1 - u) * (1 - u));
        fracHoriz = 0.15 * u;
        phase = 'boost';
      } else if (t <= boost + descent) {
        const u = (t - boost) / descent;
        alt = apogee * Math.max(0, 1 - u);
        fracHoriz = 0.15 + 0.85 * u;
        phase = 'descent';
      } else {
        setStatus('Rocket flight complete.');
        stopTrack(true);
        return;
      }
      const [lat, lon] = destination(padLat, padLon, driftBearing, drift * fracHoriz);
      // aimAt paints the rocket marker/trail before commanding (works even if mag is stale).
      aimAt(lat, lon, alt, `Rocket ${phase} · ${alt.toFixed(0)} m`).catch(error => setStatus(error.message));
    });
  }
  function onMapClick(event) {
    if (trackMode === 'off') return;
    if (!config) { setStatus('Save a device location before tracking.'); return; }
    clickLatLng = event.latlng;
    const alt = num('track-altitude', 500);
    if (trackMode === 'align') {
      try { applyAlign(clickLatLng.lat, clickLatLng.lng); }
      catch (error) { setStatus(error.message); }
      return;
    }
    if (trackMode === 'goto') {
      stopTrack(false); clearPath();
      aimAt(clickLatLng.lat, clickLatLng.lng, alt, 'Go to click', { force: true })
        .catch(error => setStatus(error.message));
      return;
    }
    if (trackMode === 'circle') {
      startCircle(clickLatLng.lat, clickLatLng.lng);
      return;
    }
    if (trackMode === 'rocket') {
      startRocket(clickLatLng.lat, clickLatLng.lng);
    }
  }

  function setRay(layer, bearingDeg, lengthM) {
    if (!map || !config || !layer || !Number.isFinite(bearingDeg)) {
      if (layer && map?.hasLayer(layer)) map.removeLayer(layer);
      return;
    }
    const origin = [config.lat, config.lon];
    layer.setLatLngs([origin, destination(config.lat, config.lon, bearingDeg, lengthM)]);
    if (!map.hasLayer(layer)) layer.addTo(map);
  }
  function drawHud() {
    const elevationValid = Number.isFinite(elevation) && !stale;
    el('map-elevation-value').textContent = Number.isFinite(elevation) ? `Elevation ${elevation.toFixed(1)}°${stale ? ' · STALE' : ''}` : 'Elevation unavailable';
    el('map-elevation-target').textContent = Number.isFinite(target) ? `Target ${target.toFixed(1)}°` : '';
    el('map-elevation-pointer').setAttribute('visibility', elevationValid ? 'visible' : 'hidden');
    if (elevationValid) el('map-elevation-pointer').setAttribute('transform', `rotate(${-elevation} 90 82)`);
    const dish = dishAzimuth();
    // In FW Mag mode motion.angle is mag heading, not pot — don't invent a pot-diag ray from it.
    const usingMagFb = panFb === 'MAG';
    const potDish = usingMagFb ? null : potDishAzimuth();
    const panCmd = Number.isFinite(panTarget) ? panTarget : lastAim?.pan;
    const panErr = Number.isFinite(panAngle) && Number.isFinite(panCmd) ? wrap180(panCmd - panAngle) : null;
    const tiltCmd = Number.isFinite(target) ? target : lastAim?.el;
    const tiltErr = Number.isFinite(elevation) && Number.isFinite(tiltCmd) ? tiltCmd - elevation : null;
    const trackAzErr = lastAim && Number.isFinite(dish) ? wrap180(lastAim.azTrue - dish) : null;
    const trackElErr = lastAim && Number.isFinite(elevation) ? lastAim.el - elevation : null;
    const fbLabel = usingMagFb ? 'MAG' : 'POT';
    el('map-pointing-pan').textContent = Number.isFinite(panAngle)
      ? `${fbLabel} ${panAngle.toFixed(1)}°${usingMagFb ? ' (FW feedback)' : ' (actuator)'}${Number.isFinite(panCmd) ? ` → ${panCmd.toFixed(1)}° · servo ${fmtErr(panErr)}` : ''}${stale ? ' · STALE' : ''}`
      : `${fbLabel} unavailable`;
    el('map-pointing-tilt').textContent = Number.isFinite(elevation)
      ? `TILT ${elevation.toFixed(1)}°${Number.isFinite(tiltCmd) ? ` → ${tiltCmd.toFixed(1)}° · err ${fmtErr(tiltErr)}` : ''}`
      : 'TILT unavailable';
    el('map-pointing-track').textContent = lastAim && Number.isFinite(trackAzErr)
      ? `Track (mag→gold) az ${fmtErr(trackAzErr)} · el ${fmtErr(trackElErr)} · tgt ${lastAim.azTrue.toFixed(1)}°`
      : 'Track — no target yet';
    el('map-pointing-offset').textContent = config
      ? `Decl ${config.magDeclination.toFixed(1)}° · map-mag ${Number.isFinite(dish) ? dish.toFixed(1) + '°' : '—'}${Number.isFinite(potDish) ? ` · pot-diag ${potDish.toFixed(1)}°` : (usingMagFb ? ' · pot-diag off (FW Mag)' : '')}${config.panInvert ? ' · INVERT' : ''}`
      : 'Save location first';
    const miss = Number.isFinite(trackAzErr) && Math.abs(trackAzErr) > 3;
    el('map-pointing-hint').textContent = gotoTimer
      ? 'Correcting on mag — waiting for red to meet gold.'
      : miss
        ? 'Mag≠gold — Go to click (or Align declination on a landmark).'
        : usingMagFb
          ? 'Success = mag (red) on gold. FW Mag PID closes on heading.'
          : 'Success = mag on gold. Pot degrees are not world truth.';
    el('map-pointing-title').textContent = magStale ? 'Pointing · MAG STALE' : (gotoTimer ? 'Pointing · CORRECTING' : (miss ? 'Pointing · MISS' : (usingMagFb ? 'Pointing · FW Mag' : 'Pointing')));
    el('device-aim-source').textContent = Number.isFinite(dish)
      ? (usingMagFb
        ? `AIM: FW Mag ${Number.isFinite(panAngle) ? panAngle.toFixed(1) + '°' : '—'} → ${Number.isFinite(panCmd) ? panCmd.toFixed(1) + '°' : '—'} · map az ${dish.toFixed(1)}° (decl ${config?.magDeclination ?? 0}°).`
        : `AIM: mag ${dish.toFixed(1)}° (decl ${config?.magDeclination ?? 0}°). Pot ${Number.isFinite(panAngle) ? panAngle.toFixed(1) + '°' : '—'} = FW Pot feedback.${config?.panInvert ? ' INVERT.' : ''}`)
      : 'AIM: waiting for mag heading.';
    el('device-map-heading').textContent = Number.isFinite(dish)
      ? `Mag(red) ${dish.toFixed(1)}° · heading ${heading.toFixed(1)}° + decl ${config.magDeclination.toFixed(1)}°${magStale ? ' · STALE' : ''}`
      : `Mag ray waiting${magStale ? ' · STALE' : ''}`;
  }
  function drawLeaflet() {
    if (!map || !config || panel.hidden) return;
    const dish = dishAzimuth();
    const potDish = panFb === 'MAG' ? null : potDishAzimuth();
    marker.setLatLng([config.lat, config.lon]);
    setRay(dishRay, !magStale ? dish : null, config.length);
    setRay(magRay, !stale ? potDish : null, config.length * 0.85);
    setRay(targetRay, lastAim && !magStale ? lastAim.azTrue : null, Math.min(config.length, Math.max(50, lastAim?.range || config.length)));
  }
  function draw(force = false) {
    const now = performance.now();
    // Text HUD up to ~8 Hz; Leaflet geometry is more expensive — keep ≤4 Hz.
    if (force || now - lastHudDrawAt >= 120) {
      lastHudDrawAt = now;
      drawHud();
    }
    if (force || now - lastPlotDrawAt >= 200) {
      lastPlotDrawAt = now;
      recordTrackSample();
      paintTrackPlots();
    }
    if (!map || !config || panel.hidden) return;
    if (force || now - lastLeafletDrawAt >= 250) {
      lastLeafletDrawAt = now;
      if (leafletDrawTimer) { clearTimeout(leafletDrawTimer); leafletDrawTimer = null; }
      drawLeaflet();
    } else if (!leafletDrawTimer) {
      leafletDrawTimer = setTimeout(() => {
        leafletDrawTimer = null;
        lastLeafletDrawAt = performance.now();
        drawLeaflet();
      }, 250 - (now - lastLeafletDrawAt));
    }
  }
  function init() {
    if (map) return;
    if (!window.L) { el('map-tile-status').textContent = 'Map library unavailable. Restart the dashboard script and refresh.'; return; }
    map = L.map('device-map').setView(config ? [config.lat, config.lon] : [20, 0], config ? 15 : 2);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>' })
      .on('tileerror', () => el('map-tile-status').textContent = 'Map tiles unavailable. Coordinates and dish ray remain usable.')
      .on('tileload', () => el('map-tile-status').textContent = '').addTo(map);
    marker = L.circleMarker([0, 0], { radius: 8, color: '#ffffff', weight: 2, fillColor: '#1676d2', fillOpacity: 1 });
    dishRay = L.polyline([], { color: '#ef3038', weight: 4, interactive: false });
    magRay = L.polyline([], { color: '#e8eef7', weight: 2, interactive: false, dashArray: '6 8' });
    targetRay = L.polyline([], { color: '#f5bd4f', weight: 3, interactive: false, dashArray: '2 8' });
    if (config) marker.addTo(map);
    map.on('click', onMapClick);
    draw(true);
  }
  tabs.addEventListener('click', event => {
    const button = event.target.closest('[data-view]'); if (!button) return;
    const view = button.dataset.view;
    const showMap = view === 'map';
    document.body.classList.toggle('map-view', showMap);
    document.body.classList.toggle('tune-view', view === 'tune');
    panel.hidden = !showMap;
    tabs.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    if (typeof panTune !== 'undefined') panTune.setVisible(view === 'tune');
    if (showMap) {
      // Let the map-view CSS settle before Leaflet measures the container.
      requestAnimationFrame(() => {
        init();
        requestAnimationFrame(() => map?.invalidateSize(false));
      });
    }
  });
  function read() {
    const c = {
      lat: el('device-latitude').valueAsNumber,
      lon: el('device-longitude').valueAsNumber,
      alt: el('device-altitude').valueAsNumber,
      panAlign: el('device-pan-align').valueAsNumber,
      magDeclination: el('device-mag-declination').valueAsNumber,
      length: el('device-ray-length').valueAsNumber,
      panInvert: el('device-pan-invert').checked,
    };
    const nums = { lat: c.lat, lon: c.lon, alt: c.alt, panAlign: c.panAlign, magDeclination: c.magDeclination, length: c.length };
    if (!Object.values(nums).every(Number.isFinite) || Math.abs(c.lat) > 90 || Math.abs(c.lon) > 180 ||
        c.alt < 0 || c.alt > 10000 ||
        Math.abs(c.panAlign) > 360 || Math.abs(c.magDeclination) > 360 || c.length < 1 || c.length > 100000) {
      throw Error('Enter valid coordinates, altitude, align, mag declination and line length.');
    }
    return c;
  }
  function saveConfig(next, note) {
    config = next;
    localStorage.setItem('tracker-device-location', JSON.stringify({
      lat: config.lat, lon: config.lon, alt: config.alt, panAlign: config.panAlign, magDeclination: config.magDeclination,
      length: config.length, panInvert: !!config.panInvert,
    }));
    el('device-latitude').value = config.lat;
    el('device-longitude').value = config.lon;
    el('device-altitude').value = config.alt;
    el('device-pan-align').value = config.panAlign;
    el('device-mag-declination').value = config.magDeclination;
    el('device-ray-length').value = config.length;
    el('device-pan-invert').checked = !!config.panInvert;
    el('device-location-status').textContent = note ||
      `Device location: ${config.lat.toFixed(6)}, ${config.lon.toFixed(6)} · alt ${config.alt.toFixed(1)} m AGL · PAN→north ${config.panAlign}° · decl ${config.magDeclination}°${config.panInvert ? ' · INVERT' : ''} · saved`;
    init(); if (map) { marker.addTo(map); map.setView([config.lat, config.lon], map.getZoom() || 15); } draw();
    homePushedKey = null;
    pushTrackHome(config, true).then(() => {
      el('device-location-status').textContent =
        `${el('device-location-status').textContent} · TRACK HOME queued`;
    }).catch(error => {
      el('device-location-status').textContent =
        `${note || 'Saved locally'} · board HOME not sent: ${error.message}`;
    });
  }
  el('device-location-form').addEventListener('submit', event => {
    event.preventDefault();
    try {
      saveConfig(read());
      alignReady = true;
      const siteId = el('device-site')?.value;
      if (siteId) localStorage.setItem('device-site', siteId);
    } catch (error) { el('device-location-status').textContent = error.message; }
  });
  el('device-site').addEventListener('change', () => {
    const id = el('device-site').value;
    localStorage.setItem('device-site', id || '');
    if (!id) {
      el('device-location-status').textContent = 'Custom coordinates — edit fields below, then Save.';
      return;
    }
    const site = siteCatalog.find(s => s.id === id);
    if (site) applySite(site, { save: false });
  });
  el('map-seed-mag').addEventListener('click', () => {
    try { seedAlignFromMag(); }
    catch (error) { el('device-location-status').textContent = error.message; }
  });
  el('map-center').addEventListener('click', () => { if (config) { init(); map?.setView([config.lat, config.lon], map.getZoom()); } });
  panel.querySelectorAll('[data-track-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.trackMode)));
  el('track-run-sim').addEventListener('click', () => { startSimFlight().catch(error => setStatus(error.message)); });
  loadFlightList();
  el('track-stop').addEventListener('click', () => {
    stopTrack(true);
    setMode('off');
    setStatus('Stopped — axes OFF queued.');
  });
  try {
    const saved = JSON.parse(localStorage.getItem('tracker-device-location'));
    if (saved) {
      const panAlign = Number.isFinite(saved.panAlign) ? saved.panAlign : 0;
      el('device-latitude').value = saved.lat;
      el('device-longitude').value = saved.lon;
      el('device-altitude').value = Number.isFinite(saved.alt) ? saved.alt : 0;
      el('device-pan-align').value = panAlign;
      el('device-mag-declination').value = Number.isFinite(saved.magDeclination) ? saved.magDeclination : (Number.isFinite(saved.offset) ? saved.offset : 0);
      el('device-ray-length').value = saved.length;
      el('device-pan-invert').checked = !!saved.panInvert;
      config = read();
      alignReady = Number.isFinite(saved.panAlign);
      el('device-location-status').textContent = alignReady
        ? `Device location: ${config.lat.toFixed(6)}, ${config.lon.toFixed(6)} · alt ${config.alt.toFixed(1)} m AGL · PAN→north ${config.panAlign}° · decl ${config.magDeclination}°${config.panInvert ? ' · INVERT' : ''} · saved`
        : `Device location: ${config.lat.toFixed(6)}, ${config.lon.toFixed(6)} · Seed from mag or landmark Align`;
    }
  } catch { config = null; }
  return {
    update(value, magIsStale, tiltAngle = null, targetAngle = null, panDeg = null, panCmd = null, linkIsStale = magIsStale, feedback = null) {
      const now = performance.now() / 1000;
      magStale = !!magIsStale;
      stale = !!linkIsStale;
      if (feedback === 'MAG' || feedback === 1 || feedback === '1') panFb = 'MAG';
      else if (feedback === 'POT' || feedback === 0 || feedback === '0') panFb = 'POT';
      const reset = magStale || headingUpdatedAt === null || now - headingUpdatedAt > 1;
      heading = Number.isFinite(value) ? smoothMapAzimuth(reset ? null : heading, value, headingUpdatedAt === null ? 0 : now - headingUpdatedAt) : null;
      headingUpdatedAt = now;
      elevation = tiltAngle; target = targetAngle;
      panAngle = Number.isFinite(panDeg) ? panDeg : null;
      panTarget = Number.isFinite(panCmd) ? panCmd : null;
      // While Map is hidden, skip draw entirely — Controls poll was driving Leaflet updates for nothing.
      if (!panel.hidden) draw();
    },
    applyRelaySim,
    seedAlignFromMag,
    destination,
  };
})();
