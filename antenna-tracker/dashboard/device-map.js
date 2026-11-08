/* Device location + azimuth. Map red ray / Az FW = firmware feedback→map
   (Mag: motion.angle+decl). Never substitute browser mag for the dish ray. */
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
  tabs.innerHTML = '<button type="button" data-view="track" aria-pressed="true">Track</button><button type="button" data-view="sensors" aria-pressed="false">Sensors</button><button type="button" data-view="advanced" aria-pressed="false">Advanced</button>';
  main.prepend(tabs);
  // Keep Connect at the top of main on every tab.
  const connection = document.querySelector('.connection');
  if (connection) tabs.after(connection);

  // Track (default): ops bar + map + plots
  const panel = document.createElement('section'); panel.className = 'panel map-panel';
  panel.innerHTML = `
    <div class="track-ops" aria-label="Tracking controls">
      <button type="button" id="track-arm" class="track-chip secondary">Enable servos</button>
      <label class="track-ops-field">Site<select id="track-site-ops"><option value="">Custom (Advanced)</option></select></label>
      <button type="button" id="track-save-site" class="secondary" title="Save current lat/lon/alt under a name in the Site list">Save location</button>
      <button type="button" id="track-run-sim">Start tracking</button>
      <button type="button" id="track-stop" class="secondary">Stop</button>
      <button type="button" id="map-center" class="secondary">Center</button>
      <button type="button" id="track-dropout-warn" class="track-dropout-lamp" aria-live="polite" title="Track data lamp — click to open the OpenSky feed log">DATA</button>
    </div>
    <div class="track-source" aria-label="Track data source">
      <nav class="track-source-tabs" role="tablist" aria-label="Data source">
        <button type="button" role="tab" data-track-source="serial" aria-selected="false">Serial</button>
        <button type="button" role="tab" data-track-source="opensky" aria-selected="true">OpenSky</button>
        <button type="button" role="tab" data-track-source="playback" aria-selected="false">Playback</button>
      </nav>
      <div class="track-source-panel" data-track-source-panel="serial" hidden>
        <p class="plot-note">Radio / serial GPS → TRACK TARGET is not wired yet. Board link stays under <strong>Connect</strong> above. Use OpenSky or Playback for now.</p>
      </div>
      <div class="track-source-panel track-ops" data-track-source-panel="opensky">
        <label class="track-ops-field" title="6-hex ICAO24 / Mode S address">ICAO24<input id="track-icao" type="text" maxlength="6" placeholder="406f72" autocomplete="off" spellcheck="false"></label>
        <label class="track-ops-field track-ops-poll" title="Toggle OpenSky polling on/off (min 5s authenticated / 10s anonymous). Independent of Start tracking.">
          OpenSky poll
          <span class="track-poll-row">
            <input id="track-opensky-poll" type="checkbox">
            <input id="track-opensky-interval" type="number" min="5" max="120" step="1" value="5" aria-label="Poll interval seconds">
            <span class="track-poll-unit">s</span>
          </span>
        </label>
        <p class="plot-note track-source-hint">Poll = watch positions in the log/map. Start tracking = send TRACK TARGET and point (servos on). Credentials in Advanced.</p>
        <div class="track-feed-log-wrap">
          <div class="track-feed-log-head">
            <strong>Feed log</strong>
            <button type="button" id="track-opensky-log-clear" class="secondary">Clear</button>
          </div>
          <pre id="track-opensky-log" class="track-feed-log" aria-live="polite">Waiting for OpenSky polls…</pre>
        </div>
      </div>
      <div class="track-source-panel track-ops" data-track-source-panel="playback" hidden>
        <label class="track-ops-field">Flight CSV<select id="track-flight"><option value="">Loading…</option></select></label>
        <p class="plot-note track-source-hint">Fake / recorded flight replay (realtime radio-feed process).</p>
      </div>
    </div>
    <p id="track-status" role="status">Pick OpenSky or Playback, set site, enable servos, then Start tracking.</p>
    <p id="device-aim-source" class="map-aim-source" role="status">FW feedback: waiting for board pan_fb…</p>
    <p id="device-map-heading" role="status">Waiting for sensors</p>
    <div class="map-viewport"><div id="device-map" aria-label="Device location and dish pointing map"></div>
    <aside class="map-pointing" aria-label="Pointing error">
      <strong id="map-pointing-title">Pointing</strong>
      <span id="map-pointing-pan">PAN —</span>
      <span id="map-pointing-tilt">TILT —</span>
      <span id="map-pointing-track">Track —</span>
      <span id="map-pointing-offset">Align —</span>
      <small id="map-pointing-hint">Align in Advanced if gold does not meet red.</small>
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
        <h3>Distance <small>range · alt</small></h3>
        <div class="mini-legend"><span style="color:#69adff">Range m</span><span style="color:#f5bd4f">Alt m</span></div>
        <canvas id="map-distance-chart" class="chart-hoverable" role="img" aria-label="Rocket horizontal range and altitude versus time"></canvas>
      </div>
      <div>
        <h3>Azimuth <small id="map-az-chart-sub">FW dish · GPS</small></h3>
        <div class="mini-legend"><span style="color:#ef3038">Az FW</span><span style="color:#f5bd4f">Az GPS</span><span id="map-az-cmd-legend" style="color:#61e2bd" hidden>Az predict</span></div>
        <canvas id="map-az-chart" class="chart-hoverable" role="img" aria-label="Dish and GPS target azimuth versus time"></canvas>
      </div>
      <div>
        <h3>Elevation <small id="map-el-chart-sub">dish · GPS</small></h3>
        <div class="mini-legend"><span style="color:#69adff">El dish</span><span style="color:#a88bfa">El GPS</span><span id="map-el-cmd-legend" style="color:#61e2bd" hidden>El predict</span></div>
        <canvas id="map-el-chart" class="chart-hoverable" role="img" aria-label="Dish and GPS target elevation versus time"></canvas>
      </div>
    </div>`;
  (connection || tabs).after(panel);

  // Advanced: site/HOME, predict, synthetic modes (health/ADC stay in main, shown via CSS)
  const advanced = document.createElement('section');
  advanced.className = 'panel advanced-panel';
  advanced.hidden = true;
  advanced.innerHTML = `
    <div class="section-heading"><div><div class="eyebrow">SETUP</div><h2>Site and HOME</h2></div></div>
    <form id="device-location-form"><div class="map-fields">
      <label class="track-flight-select">Saved coords<select id="device-site"><option value="">Custom / enter below</option></select></label>
      <label>Latitude (°)<input id="device-latitude" type="number" min="-90" max="90" step="any" required placeholder="e.g. 41.88"></label>
      <label>Longitude (°)<input id="device-longitude" type="number" min="-180" max="180" step="any" required placeholder="e.g. -87.63"></label>
      <label>Altitude AGL (m)<input id="device-altitude" type="number" min="0" max="10000" step="any" value="0" required></label>
      <label>Mag declination (°)<input id="device-mag-declination" type="number" min="-360" max="360" step="any" value="0" title="true ≈ mag + decl. Landmark Align sets this. TRACK ignores pot align."></label>
      <label>Ray length (m)<input id="device-ray-length" type="number" min="1" max="100000" step="any" value="1000" required></label>
      <input id="device-pan-align" type="hidden" value="0">
      <input id="device-pan-invert" type="checkbox" hidden>
    </div>
    <div class="buttons">
      <button type="submit">Save device location</button>
      <button type="button" id="device-save-named-site" class="secondary" title="Add current coordinates to the Site dropdown (same catalog as playback homes)">Save as named site</button>
      <button type="button" id="map-seed-mag" class="secondary" title="Set declination 0 (assume mag ≈ true north). Prefer landmark Align if mag≠true.">Seed decl=0 from mag</button>
    </div>
    <p id="device-location-status" role="status">Enter device coordinates. Tracking uses mag heading − declination (no pot align).</p></form>

    <div class="section-heading" style="margin-top:28px"><div><div class="eyebrow">OPENSKY</div><h2>Aircraft API credentials</h2></div></div>
    <form id="opensky-creds-form" class="map-fields track-fields">
      <label>Client ID<input id="opensky-client-id" type="text" autocomplete="off" spellcheck="false" value="your-opensky-client-id"></label>
      <label>Client secret<input id="opensky-client-secret" type="password" autocomplete="new-password" placeholder="paste secret — leave blank to keep saved"></label>
      <div class="buttons" style="grid-column:1/-1">
        <button type="submit">Save OpenSky credentials</button>
      </div>
      <p id="opensky-creds-status" class="plot-note" style="grid-column:1/-1" role="status">Saved locally in dashboard/opensky_credentials.json (gitignored).</p>
    </form>

    <div class="section-heading" style="margin-top:28px"><div><div class="eyebrow">PREDICT</div><h2>Lead settings</h2></div></div>
    <div class="map-fields track-fields">
      <label class="map-check"><input id="track-predict" type="checkbox" checked> Predict (lead target)</label>
      <label>Lead (s)<input id="track-lead" type="number" min="0" max="2.5" step="0.05" value="0.35" title="Extra prediction lead. Board also adds ~0.15s latency + half the GPS interval."></label>
      <label class="map-check"><input id="track-search" type="checkbox" checked title="After the gap below with no parsable TRACK TARGET, sweep an expanding spiral from the last aim"> Spiral search on data loss</label>
      <label>Search gap (s)<input id="track-search-gap" type="number" min="0.5" max="60" step="0.5" value="3" title="Seconds without a parsable TRACK TARGET before spiral search starts."></label>
      <label>Search speed (°/s)<input id="track-search-speed" type="number" min="5" max="120" step="1" value="30" title="Spiral phase rate. Higher = faster sweep. Arms expand ~6° per turn up to 40°."></label>
    </div>

    <div class="track-tools" aria-label="Synthetic tracking extras">
      <div class="section-heading"><div><div class="eyebrow">SYNTHETIC</div><h2>Map click modes</h2></div>
        <div class="buttons track-mode-buttons">
          <button type="button" data-track-mode="off" aria-pressed="true">Off</button>
          <button type="button" data-track-mode="align" aria-pressed="false">Align</button>
          <button type="button" data-track-mode="goto" aria-pressed="false">Go to click</button>
          <button type="button" data-track-mode="circle" aria-pressed="false">Circle</button>
          <button type="button" data-track-mode="rocket" aria-pressed="false">Rocket</button>
        </div></div>
      <div class="map-fields track-fields">
        <label>Target altitude AGL (m)<input id="track-altitude" type="number" min="0" max="100000" step="any" value="500"></label>
        <label>Circle radius (m)<input id="track-radius" type="number" min="10" max="100000" step="any" value="1000"></label>
        <label>Circle rate (°/s)<input id="track-circle-rate" type="number" min="0.1" max="90" step="any" value="6"></label>
        <label>Rocket apogee (m)<input id="track-rocket-apogee" type="number" min="10" max="100000" step="any" value="2000"></label>
        <label>Rocket boost (s)<input id="track-rocket-boost" type="number" min="0.5" max="60" step="any" value="3"></label>
        <label>Rocket descent (s)<input id="track-rocket-descent" type="number" min="1" max="600" step="any" value="25"></label>
        <label>Rocket drift (m)<input id="track-rocket-drift" type="number" min="0" max="50000" step="any" value="200"></label>
      </div>
      <p class="plot-note">Align / Go-to / Circle / Rocket use map clicks. Flight replay lives on the Track tab.</p>
    </div>
    <p class="plot-note">Connection, health, servo PWM, PID and raw monitor are below on this tab. ADC / GPIO / IMU / sampling live on Sensors. Recording and orientation live on Track.</p>`;
  panel.after(advanced);
  // Keep Save stream + orientation on the Track surface (DOM order under the map/plots).
  const recordingPanel = document.querySelector('.recording-panel');
  const orientationPanel = document.querySelector('.orientation-panel');
  if (recordingPanel) panel.after(recordingPanel);
  if (orientationPanel) (recordingPanel || panel).after(orientationPanel);
  const el = id => document.getElementById(id);
  let config = null, map = null, marker = null, dishRay = null, magRay = null, targetRay = null;
  let heading = null, elevation = null, target = null, panAngle = null, panTarget = null;
  let stale = true, magStale = true; // stale = servo/link; magStale = IMU/mag only
  let headingUpdatedAt = null;
  let trackMode = 'off', trackTimer = null, gotoTimer = null, trackBusy = false, lastCommandAt = 0;
  let targetMarker = null, padMarker = null, pathLine = null, pathPoints = [];
  let clickLatLng = null, runStartedAt = null, lastAim = null, alignReady = false;
  let lastTargetAt = 0; // performance.now() when last parsable rocket fix arrived
  let lastSimIndex = -1;
  const TRACK_DROPOUT_WARN_S = 3;
  let lastHudDrawAt = 0, lastLeafletDrawAt = 0, leafletDrawTimer = null, lastPlotDrawAt = 0;
  // Rolling history for map plots (t = performance.now()/1000).
  const trackHist = [];
  const TRACK_HIST_SPAN_S = 60;
  const TRACK_HIST_MAX = 600;
  const wrap180 = deg => ((deg + 180) % 360 + 360) % 360 - 180;
  const wrap360 = deg => ((deg % 360) + 360) % 360;
  const fmtErr = deg => `${deg >= 0 ? '+' : ''}${deg.toFixed(1)}°`;
  let panFb = null; // 'MAG' | 'POT' | null from board effective_config.pan_fb
  let lastCommandedLat = null, lastCommandedLon = null, lastCommandedAlt = null, lastCommandedAt = 0;
  let homePushedKey = null;
  /** Browser-only mag→map (NOT the FW PID measurement — may disagree with panAngle). */
  function browserMagMapAzimuth() {
    if (!config || !Number.isFinite(heading) || magStale) return null;
    return wrap360(heading + (config.magDeclination || 0));
  }
  /**
   * Dish map azimuth from what the firmware is actually closing on:
   * Mag → motion.angle (filtered heading) + decl; Pot → pot° + align (world only if align set).
   */
  function dishAzimuth() {
    if (!config) return null;
    if (panFb === 'MAG') {
      if (!Number.isFinite(panAngle) || stale) return null;
      return wrap360(panAngle + (config.magDeclination || 0));
    }
    if (panFb === 'POT') {
      if (!Number.isFinite(panAngle) || stale) return null;
      // Without pot→north align, pot degrees are not a world azimuth.
      if (!Number.isFinite(config.panAlign) || (config.panAlign === 0 && !config.panInvert)) {
        return null;
      }
      return config.panInvert
        ? wrap360(config.panAlign - panAngle)
        : wrap360(panAngle + config.panAlign);
    }
    return null;
  }
  /** Board PAN position target → true/map azimuth (same frame as dishAzimuth). */
  function trueAzFromPanCmd(panCmd) {
    if (!config || !Number.isFinite(panCmd)) return null;
    if (panFb === 'MAG') return wrap360(panCmd + (config.magDeclination || 0));
    if (panFb !== 'POT') return null;
    if (!Number.isFinite(config.panAlign) || (config.panAlign === 0 && !config.panInvert)) return null;
    if (config.panInvert) return wrap360((config.panAlign || 0) - panCmd);
    return wrap360(panCmd + (config.panAlign || 0));
  }
  /** Absolute mag heading the FW Mag PID should chase for a true map azimuth. */
  function magHeadingForTrueAz(azTrue) {
    return wrap360(azTrue - (config?.magDeclination || 0));
  }
  function fwFeedbackLabel() {
    if (panFb === 'MAG') return 'MAG';
    if (panFb === 'POT') return 'POT';
    return 'UNKNOWN';
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
    if (panFb === 'POT') throw Error('Board FW feedback is POT — enable Mag (Start tracking / track-home) before aiming.');
    if (panFb === 'MAG') {
      if (stale || !Number.isFinite(panAngle)) throw Error('Need fresh FW Mag measure (motion.angle).');
    } else if (magStale || !Number.isFinite(heading)) {
      throw Error('Need fresh mag heading (board pan_fb unknown).');
    }
    const range = Math.max(1, haversineM(config.lat, config.lon, lat, lon));
    const azTrue = bearingDeg(config.lat, config.lon, lat, lon);
    const relAlt = altM - (Number.isFinite(config.alt) ? config.alt : 0);
    const elDeg = Math.max(-5, Math.min(85, Math.atan2(relAlt, range) * 180 / Math.PI));
    const dish = dishAzimuth();
    const azErr = Number.isFinite(dish) ? wrap180(azTrue - dish) : null;
    // Same frame as FW Mag PID: absolute magnetic heading.
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
  async function pushTrackPredict() {
    const enabled = !!el('track-predict')?.checked;
    const lead = el('track-lead')?.valueAsNumber;
    const search = !!el('track-search')?.checked;
    const searchSpeed = el('track-search-speed')?.valueAsNumber;
    const searchGap = el('track-search-gap')?.valueAsNumber;
    await trackApi('track-predict', { enabled });
    if (Number.isFinite(lead)) await trackApi('track-lead', { lead });
    await trackApi('track-search', {
      enabled: search,
      speed: Number.isFinite(searchSpeed) ? searchSpeed : 30,
      gap: Number.isFinite(searchGap) ? searchGap : 3,
    });
    localStorage.setItem('track-predict', enabled ? '1' : '0');
    if (Number.isFinite(lead)) localStorage.setItem('track-lead', String(lead));
    localStorage.setItem('track-search', search ? '1' : '0');
    if (Number.isFinite(searchSpeed)) localStorage.setItem('track-search-speed', String(searchSpeed));
    if (Number.isFinite(searchGap)) localStorage.setItem('track-search-gap', String(searchGap));
  }
  async function pushTrackHome(cfg = config, force = false) {
    if (!cfg) throw Error('Save a device location first.');
    // Mag-only: HOME + decl. Relay forces SERVO FEEDBACK PAN MAG; pot align unused.
    const key = [cfg.lat, cfg.lon, cfg.alt || 0, cfg.magDeclination || 0].join('|');
    if (!force && homePushedKey === key) return;
    await trackApi('track-home', {
      lat: cfg.lat, lon: cfg.lon, alt: cfg.alt || 0,
      mag_declination: cfg.magDeclination || 0,
    });
    homePushedKey = key;
    try { await pushTrackPredict(); } catch { /* predict optional until board flashed */ }
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
    noteTargetFix();
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
    document.querySelectorAll('[data-track-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.trackMode === mode)));
    if (mode === 'off') {
      lastAim = null;
      lastTargetAt = 0;
      lastSimIndex = -1;
      setStatus('Synthetic tracking off.');
      refreshDropoutWarn();
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
    const keep = selectedId != null ? selectedId : (el('device-site')?.value || el('track-site-ops')?.value || '');
    for (const sel of [el('device-site'), el('track-site-ops')]) {
      if (!sel) continue;
      const blank = sel.id === 'track-site-ops' ? 'Custom (Advanced)' : 'Custom / enter below';
      sel.innerHTML = `<option value="">${blank}</option>`;
      for (const s of siteCatalog) {
        const opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = `${s.label} · ${Number(s.lat).toFixed(5)}, ${Number(s.lon).toFixed(5)}`;
        sel.appendChild(opt);
      }
      if (keep && siteCatalog.some(s => s.id === keep)) sel.value = keep;
    }
  }
  function syncSiteSelects(fromId) {
    const id = el(fromId)?.value || '';
    for (const other of ['device-site', 'track-site-ops']) {
      if (other !== fromId && el(other)) el(other).value = id;
    }
    localStorage.setItem('device-site', id);
  }
  function applySite(site, { save = false, note } = {}) {
    if (!site) return;
    el('device-latitude').value = site.lat;
    el('device-longitude').value = site.lon;
    el('device-altitude').value = Number.isFinite(site.alt) ? site.alt : 0;
    if (site.id) {
      if (el('device-site')) el('device-site').value = site.id;
      if (el('track-site-ops')) el('track-site-ops').value = site.id;
      localStorage.setItem('device-site', site.id);
    }
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
  function coordsForNamedSite() {
    try {
      const c = read();
      return { lat: c.lat, lon: c.lon, alt: c.alt };
    } catch {
      if (config) return { lat: config.lat, lon: config.lon, alt: config.alt };
      throw Error('Enter lat/lon/alt in Advanced (or load a site) before saving.');
    }
  }
  async function saveNamedSite() {
    const coords = coordsForNamedSite();
    const suggested = (el('device-site')?.selectedOptions?.[0]?.textContent || '')
      .replace(/\s·\s.*/, '').trim();
    const label = window.prompt('Name for this site location:', suggested && suggested !== 'Custom / enter below' && suggested !== 'Custom (Advanced)' ? suggested : '');
    if (label == null) return;
    const name = label.trim();
    if (!name) throw Error('Site name required');
    const response = await fetch('/api/track-site', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: name, lat: coords.lat, lon: coords.lon, alt: coords.alt }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(body.error || response.statusText);
    siteCatalog = body.sites || siteCatalog;
    const site = body.site;
    if (!site) throw Error('Server did not return the saved site');
    fillSiteSelect(site.id);
    applySite(site, { save: true, note: `Saved site “${site.label}”` });
    setStatus(`Saved site “${site.label}” · ${Number(site.lat).toFixed(5)}, ${Number(site.lon).toFixed(5)}`);
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
      const replay = document.createElement('optgroup');
      replay.label = 'Flight replay';
      for (const f of flightCatalog) {
        const opt = document.createElement('option');
        opt.value = f.file;
        const mins = f.duration_s >= 60 ? `${(f.duration_s / 60).toFixed(1)} min` : `${f.duration_s.toFixed(1)} s`;
        const homeTag = f.home ? ` · ${f.home.label}` : '';
        opt.textContent = `${f.label} · ${mins}${homeTag}`;
        replay.appendChild(opt);
      }
      sel.appendChild(replay);
      const live = document.createElement('optgroup');
      live.label = 'Live streams (soon)';
      live.disabled = true;
      const liveOpt = document.createElement('option');
      liveOpt.textContent = 'Coming soon';
      live.appendChild(liveOpt);
      sel.appendChild(live);
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
  function servosArmed() {
    const safety = document.getElementById('servo-safety-state')?.textContent || '';
    return /Enabled/i.test(safety) && !/E-STOP/i.test(safety);
  }
  async function ensureSiteConfig() {
    const siteId = el('track-site-ops')?.value || el('device-site')?.value;
    if (siteId) {
      const site = siteCatalog.find(s => s.id === siteId);
      if (site) {
        applySite(site, { save: false });
        try {
          saveConfig(read(), `Site ${site.label}`);
          alignReady = true;
        } catch (error) {
          throw Error(error.message || 'Invalid site coordinates');
        }
      }
    }
    if (!config) throw Error('Choose a site (or save device location in Advanced) before starting.');
  }
  async function ensureSiteForStart() {
    await ensureSiteConfig();
    await pushTrackHome(config, true);
    try { await pushTrackPredict(); } catch { /* board may be on older firmware */ }
  }
  let openskyPointing = false;
  function refreshStartLabel() {
    const btn = el('track-run-sim');
    if (!btn) return;
    const busy = trackSource === 'opensky' ? openskyPointing : trackMode === 'sim';
    btn.textContent = busy ? 'Tracking…' : 'Start tracking';
    btn.disabled = busy;
  }
  let trackSource = 'opensky'; // 'serial' | 'opensky' | 'playback'
  function setTrackSource(source) {
    if (!['serial', 'opensky', 'playback'].includes(source)) source = 'opensky';
    trackSource = source;
    document.querySelectorAll('[data-track-source]').forEach(btn => {
      btn.setAttribute('aria-selected', String(btn.dataset.trackSource === source));
    });
    document.querySelectorAll('[data-track-source-panel]').forEach(panelEl => {
      panelEl.hidden = panelEl.dataset.trackSourcePanel !== source;
    });
    try { localStorage.setItem('track-source', source); } catch { /* ignore */ }
    const hints = {
      serial: 'Serial radio GPS feed not wired yet — use OpenSky or Playback.',
      opensky: 'OpenSky: Poll = watch positions. Start tracking = feed TRACK TARGET and point (servos on).',
      playback: 'Playback: pick a flight CSV, enable servos, Start.',
    };
    if (!(trackSource === 'opensky' ? openskyPointing : trackMode === 'sim')) setStatus(hints[source] || '');
  }
  let openskyPollSyncing = false;
  function syncOpenskyPollUi(on) {
    const box = el('track-opensky-poll');
    if (box && box.checked !== !!on) {
      openskyPollSyncing = true;
      box.checked = !!on;
      openskyPollSyncing = false;
    }
    try { localStorage.setItem('track-opensky-enable', on ? '1' : '0'); } catch { /* ignore */ }
  }
  function openskyParams() {
    const icao24 = (el('track-icao')?.value || '').trim().toLowerCase();
    const interval = el('track-opensky-interval')?.valueAsNumber;
    if (!/^[0-9a-f]{6}$/.test(icao24)) {
      throw Error('ICAO24 must be 6 hex characters (e.g. 406f72).');
    }
    if (!Number.isFinite(interval) || interval < 5 || interval > 120) {
      throw Error('OpenSky poll interval must be 5–120 seconds.');
    }
    return { icao24, interval };
  }
  async function startOpenskyFeed({ point = false, clearTrail = true } = {}) {
    const { icao24, interval } = openskyParams();
    if (point) await ensureSiteForStart();
    else await ensureSiteConfig();
    stopTrack(false);
    if (clearTrail) clearPath();
    trackMode = 'sim';
    openskyPointing = !!point;
    document.querySelectorAll('[data-track-mode]').forEach(b => b.setAttribute('aria-pressed', 'false'));
    refreshStartLabel();
    lastLoggedSimKey = '';
    const mode = point ? 'pointing' : 'observe';
    appendOpenskyLog(`${mode} ${icao24} · every ${interval}s · site ${config.lat.toFixed(5)}, ${config.lon.toFixed(5)}`);
    setStatus(point
      ? `OpenSky tracking ${icao24}…`
      : `OpenSky polling ${icao24} every ${interval}s (observe)…`);
    try {
      localStorage.setItem('track-icao', icao24);
      localStorage.setItem('track-opensky-interval', String(interval));
    } catch { /* ignore */ }
    const body = await trackApi('track-sim', {
      action: 'start',
      icao24,
      interval,
      idle_stop: 600,
      point: !!point,
      lat: config.lat,
      lon: config.lon,
      alt: config.alt || 0,
      mag_declination: config.magDeclination || 0,
    });
    syncOpenskyPollUi(true);
    openskyPointing = !!point;
    refreshStartLabel();
    setStatus(body.message || (point ? `Tracking ${icao24}` : `Polling ${icao24}`));
    if (body.message) appendOpenskyLog(body.message);
    if (Number.isFinite(body.lat) && Number.isFinite(body.lon)) {
      lastAim = {
        azTrue: body.az, el: body.el, range: body.range_m, lat: body.lat, lon: body.lon,
        altM: body.alt, pan: body.pan,
      };
      noteTargetFix();
      drawTarget(body.lat, body.lon, true);
      draw();
    }
  }
  async function startOpenskyPoll() {
    await startOpenskyFeed({ point: false, clearTrail: !openskyPointing });
  }
  function stopOpenskyPoll({ sendOff = true, note = 'OpenSky poll stopped' } = {}) {
    const wasSim = trackMode === 'sim';
    if (wasSim) stopTrack(sendOff);
    trackMode = 'off';
    openskyPointing = false;
    lastSimIndex = -1;
    document.querySelectorAll('[data-track-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.trackMode === 'off')));
    refreshStartLabel();
    syncOpenskyPollUi(false);
    refreshDropoutWarn();
    if (note) {
      setStatus(note);
      appendOpenskyLog(note);
    }
  }
  async function startSimFlight() {
    if (trackSource === 'serial') {
      setStatus('Serial GPS feed is not wired yet. Switch to OpenSky or Playback.');
      return;
    }
    if (trackSource === 'opensky') {
      if (!servosArmed()) {
        setStatus('Enable servos first, then Start tracking to point at the OpenSky target.');
        return;
      }
      try {
        await startOpenskyFeed({ point: true, clearTrail: true });
        appendOpenskyLog('pointing on — TRACK TARGET enabled');
      } catch (error) {
        openskyPointing = false;
        refreshStartLabel();
        if (!el('track-opensky-poll')?.checked) {
          trackMode = 'off';
        }
        setStatus(error.message);
        appendOpenskyLog(`error: ${error.message}`);
      }
      return;
    }
    const file = el('track-flight')?.value;
    if (!file) {
      setStatus('Pick a flight CSV under Playback.');
      return;
    }
    if (!servosArmed()) {
      setStatus('Enable servos first (ops bar or Advanced), then Start tracking.');
      return;
    }
    setStatus('Preparing track…');
    try {
      await ensureSiteForStart();
    } catch (error) {
      setStatus(error.message);
      return;
    }
    stopTrack(false);
    clearPath();
    trackMode = 'sim';
    openskyPointing = false;
    document.querySelectorAll('[data-track-mode]').forEach(b => b.setAttribute('aria-pressed', 'false'));
    refreshStartLabel();
    syncOpenskyPollUi(false);
    setStatus('Starting playback…');
    try {
      localStorage.setItem('track-flight', file);
      const body = await trackApi('track-sim', {
        action: 'start',
        file,
        lat: config.lat,
        lon: config.lon,
        alt: config.alt || 0,
        mag_declination: config.magDeclination || 0,
      });
      setStatus(body.message || 'Tracking');
      if (Number.isFinite(body.lat) && Number.isFinite(body.lon)) {
        lastAim = { azTrue: body.az, el: body.el, range: body.range_m, lat: body.lat, lon: body.lon, altM: body.alt, pan: body.pan };
        noteTargetFix();
        drawTarget(body.lat, body.lon, true);
        draw();
      }
    } catch (error) {
      trackMode = 'off';
      document.querySelectorAll('[data-track-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.trackMode === 'off')));
      refreshStartLabel();
      setStatus(error.message);
    }
  }
  function setWorkspaceView(view) {
    const showTrack = view === 'track' || view === 'map';
    const showAdvanced = view === 'advanced' || view === 'controls';
    const showTune = view === 'tune';
    const showSensors = view === 'sensors';
    const active = showTrack ? 'track' : showSensors ? 'sensors' : showAdvanced ? 'advanced' : showTune ? 'tune' : view;
    document.body.classList.toggle('track-view', showTrack);
    document.body.classList.toggle('map-view', showTrack); // app.js light-poll path
    document.body.classList.toggle('advanced-view', showAdvanced);
    document.body.classList.toggle('tune-view', showTune);
    document.body.classList.toggle('sensors-view', showSensors);
    panel.hidden = !showTrack;
    advanced.hidden = !showAdvanced;
    tabs.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === active)));
    if (typeof panTune !== 'undefined') panTune.setVisible(showTune);
    if (showTrack) {
      requestAnimationFrame(() => {
        init();
        requestAnimationFrame(() => map?.invalidateSize(false));
      });
    }
  }
  function refreshArmChip() {
    const chip = el('track-arm');
    if (!chip) return;
    const armed = servosArmed();
    chip.textContent = armed ? 'STOP' : 'Enable servos';
    chip.classList.toggle('track-chip-live', false);
    chip.classList.toggle('track-arm-needs-enable', !armed);
    chip.classList.toggle('track-arm-stop', armed);
    chip.classList.toggle('secondary', !armed);
    chip.classList.toggle('estop', armed);
    if (armed) {
      chip.disabled = !!document.getElementById('servo-disable')?.disabled;
      chip.title = 'Disable servos';
    } else {
      chip.disabled = !!document.getElementById('servo-enable')?.disabled;
      chip.title = 'Enable servos';
    }
  }
  let lastSimStatus = '';
  let lastSimDrawAt = 0;
  let lastLoggedSimKey = '';
  function appendOpenskyLog(line) {
    const log = el('track-opensky-log');
    if (!log) return;
    const ts = new Date().toLocaleTimeString();
    const next = `${ts}  ${line}`;
    const prev = log.dataset.empty === '1' || /^Waiting for OpenSky/.test(log.textContent || '')
      ? []
      : (log.textContent || '').split('\n').filter(Boolean);
    prev.unshift(next);
    log.dataset.empty = '0';
    log.textContent = prev.slice(0, 100).join('\n');
  }
  function logOpenskySim(sim, { freshSample = false } = {}) {
    const file = String(sim?.file || '');
    if (!file.startsWith('opensky:') && trackSource !== 'opensky') return;
    let line = '';
    if (Number.isFinite(sim.lat) && Number.isFinite(sim.lon) && freshSample) {
      const who = sim.callsign || sim.icao24 || file.replace(/^opensky:/, '') || 'ac';
      const alt = Number.isFinite(sim.alt) ? `${sim.alt.toFixed(0)} m` : 'alt —';
      const az = Number.isFinite(sim.az) ? `az ${sim.az.toFixed(0)}°` : '';
      const elev = Number.isFinite(sim.el) ? `el ${sim.el.toFixed(0)}°` : '';
      const rng = Number.isFinite(sim.range_m) ? `${sim.range_m.toFixed(0)} m` : '';
      line = `${who}  ${sim.lat.toFixed(5)}, ${sim.lon.toFixed(5)}  ${alt}`
        + (az || elev ? `  ${[az, elev].filter(Boolean).join(' ')}` : '')
        + (rng ? `  range ${rng}` : '');
    } else if (sim.message && sim.message !== lastSimStatus) {
      line = sim.message;
    }
    if (!line) return;
    const key = `${sim.index ?? ''}|${line}`;
    if (key === lastLoggedSimKey) return;
    lastLoggedSimKey = key;
    appendOpenskyLog(line);
  }
  function showOpenskyLog() {
    setTrackSource('opensky');
    const log = el('track-opensky-log');
    log?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    log?.classList.add('track-feed-log-flash');
    setTimeout(() => log?.classList.remove('track-feed-log-flash'), 900);
  }
  function applyRelaySim(sim) {
    if (!sim || panel.hidden) return;
    if (sim.active) {
      if (trackMode !== 'sim') {
        trackMode = 'sim';
        document.querySelectorAll('[data-track-mode]').forEach(b => b.setAttribute('aria-pressed', 'false'));
        refreshStartLabel();
      }
      if (String(sim.file || '').startsWith('opensky:')) {
        syncOpenskyPollUi(true);
        if (typeof sim.pointing === 'boolean' && sim.pointing !== openskyPointing) {
          openskyPointing = sim.pointing;
          refreshStartLabel();
        }
      }
      const idx = Number.isFinite(sim.index) ? sim.index : -1;
      const freshSample = idx >= 0 && idx !== lastSimIndex;
      if (freshSample) lastSimIndex = idx;
      if (Number.isFinite(sim.lat) && Number.isFinite(sim.lon)) {
        lastAim = {
          azTrue: sim.az, el: sim.el, range: sim.range_m, lat: sim.lat, lon: sim.lon,
          altM: sim.alt, pan: sim.pan, dish: dishAzimuth(), azErr: null,
        };
        if (freshSample) noteTargetFix();
        // Keep marker/path ≤ ~4 Hz — poll is faster and trail setLatLngs was a freeze vector.
        const now = performance.now();
        if (now - lastSimDrawAt >= 250) {
          lastSimDrawAt = now;
          const tip = sim.callsign || sim.icao24 || null;
          drawTarget(sim.lat, sim.lon, true, tip);
          draw();
        } else {
          refreshDropoutWarn();
        }
      } else {
        refreshDropoutWarn();
      }
      logOpenskySim(sim, { freshSample });
      if (sim.message && sim.message !== lastSimStatus) {
        lastSimStatus = sim.message;
        setStatus(sim.message);
      }
    } else if (trackMode === 'sim') {
      const wasOpensky = String(sim.file || '').startsWith('opensky:') || el('track-opensky-poll')?.checked;
      trackMode = 'off';
      openskyPointing = false;
      lastSimIndex = -1;
      document.querySelectorAll('[data-track-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.trackMode === 'off')));
      refreshStartLabel();
      if (wasOpensky) syncOpenskyPollUi(false);
      lastSimStatus = sim.message || 'Sim stopped';
      setStatus(lastSimStatus);
      logOpenskySim(sim);
      refreshDropoutWarn();
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
    // Prefer FW Mag heading (what TRACK uses) over browser IMU estimate.
    const alignHdg = panFb === 'MAG' && Number.isFinite(panAngle) && !stale
      ? panAngle
      : heading;
    if (!Number.isFinite(alignHdg) || (panFb !== 'MAG' && magStale)) {
      throw Error('Need a fresh mag heading before Align.');
    }
    const azTrue = bearingDeg(config.lat, config.lon, lat, lon);
    // Landmark Align only sets mag declination (true − heading). No pot panAlign.
    const magDeclination = wrap180(azTrue - alignHdg);
    saveConfig({ ...config, magDeclination, panAlign: 0, panInvert: false },
      `Aligned (landmark→mag): heading ${alignHdg.toFixed(1)}° → map az ${azTrue.toFixed(1)}° · decl ${magDeclination.toFixed(1)}°.`);
    alignReady = true;
    lastAim = { pan: panAngle, el: elevation, azTrue, range: haversineM(config.lat, config.lon, lat, lon), dish: azTrue, azErr: 0, lat, lon, altM: num('track-altitude', 500) };
    drawTarget(lat, lon, false);
    setStatus(`Mag declination set so dish az ${azTrue.toFixed(1)}° at this landmark.`);
    draw();
  }
  function seedAlignFromMag() {
    if (!config) throw Error('Save a device location first.');
    const seedHdg = panFb === 'MAG' && Number.isFinite(panAngle) && !stale
      ? panAngle
      : heading;
    if (!Number.isFinite(seedHdg) || (panFb !== 'MAG' && magStale)) {
      throw Error('Need a fresh mag heading (hold still).');
    }
    const magAz = wrap360(seedHdg);
    saveConfig({ ...config, magDeclination: 0, panAlign: 0, panInvert: false },
      `Seeded decl=0 · map az = mag ${magAz.toFixed(1)}°. Landmark Align if mag≠true north.`);
    alignReady = true;
    setStatus(`Mag seed · decl=0 · track/go-to chase mag heading ${magAz.toFixed(1)}°.`);
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
    const azPredict = trueAzFromPanCmd(panTarget);
    // TILT telemetry is displayAngle-flipped to elevation-up (same as lastAim.el).
    const elPredict = Number.isFinite(target) ? target : null;
    trackHist.push({
      t,
      range: Number.isFinite(lastAim.range) ? lastAim.range : null,
      alt: Number.isFinite(lastAim.altM) ? lastAim.altM : null,
      azActual: Number.isFinite(dish) ? dish : null,
      azTarget: Number.isFinite(lastAim.azTrue) ? lastAim.azTrue : null,
      azPredict: Number.isFinite(azPredict) ? azPredict : null,
      elActual: Number.isFinite(elevation) ? elevation : null,
      elTarget: Number.isFinite(lastAim.el) ? lastAim.el : null,
      elPredict: Number.isFinite(elPredict) ? elPredict : null,
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
  function predictPlotEnabled() {
    return !!el('track-predict')?.checked;
  }
  function syncPredictPlotChrome() {
    const on = predictPlotEnabled();
    const azSub = el('map-az-chart-sub');
    const elSub = el('map-el-chart-sub');
    const azLeg = el('map-az-cmd-legend');
    const elLeg = el('map-el-cmd-legend');
    if (azSub) azSub.textContent = on ? 'FW dish · GPS · predict' : 'FW dish · GPS';
    if (elSub) elSub.textContent = on ? 'dish · GPS · predict' : 'dish · GPS';
    if (azLeg) azLeg.hidden = !on;
    if (elLeg) elLeg.hidden = !on;
  }
  function paintTrackPlots() {
    if (panel.hidden) return;
    syncPredictPlotChrome();
    const showPredict = predictPlotEnabled();
    const range = [], alt = [], azA = [], azT = [], azP = [], elA = [], elT = [], elP = [];
    for (const s of trackHist) {
      if (Number.isFinite(s.range)) range.push({ t: s.t, v: s.range });
      if (Number.isFinite(s.alt)) alt.push({ t: s.t, v: s.alt });
      if (Number.isFinite(s.azActual)) azA.push({ t: s.t, v: s.azActual });
      if (Number.isFinite(s.azTarget)) azT.push({ t: s.t, v: s.azTarget });
      if (showPredict && Number.isFinite(s.azPredict)) azP.push({ t: s.t, v: s.azPredict });
      if (Number.isFinite(s.elActual)) elA.push({ t: s.t, v: s.elActual });
      if (Number.isFinite(s.elTarget)) elT.push({ t: s.t, v: s.elTarget });
      if (showPredict && Number.isFinite(s.elPredict)) elP.push({ t: s.t, v: s.elPredict });
    }
    paintTrackChart('map-distance-chart', [range, alt], {
      colors: ['#69adff', '#f5bd4f'], labels: ['Range m', 'Alt m'], decimals: 0,
    });
    paintTrackChart('map-az-chart', showPredict ? [azA, azT, azP] : [azA, azT], {
      colors: showPredict ? ['#ef3038', '#f5bd4f', '#61e2bd'] : ['#ef3038', '#f5bd4f'],
      labels: showPredict ? ['Az FW', 'Az GPS', 'Az predict'] : ['Az FW', 'Az GPS'],
      decimals: 1, wrapBreak: 180,
    });
    paintTrackChart('map-el-chart', showPredict ? [elA, elT, elP] : [elA, elT], {
      colors: showPredict ? ['#69adff', '#a88bfa', '#61e2bd'] : ['#69adff', '#a88bfa'],
      labels: showPredict ? ['El dish', 'El GPS', 'El predict'] : ['El dish', 'El GPS'],
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
    const cmdMap = trueAzFromPanCmd(Number.isFinite(panTarget) ? panTarget : lastAim?.pan);
    const browserMag = browserMagMapAzimuth();
    const usingMagFb = panFb === 'MAG';
    const usingPotFb = panFb === 'POT';
    const fbLabel = fwFeedbackLabel();
    const panCmd = Number.isFinite(panTarget) ? panTarget : lastAim?.pan;
    const panErr = Number.isFinite(panAngle) && Number.isFinite(panCmd) ? wrap180(panCmd - panAngle) : null;
    const tiltCmd = Number.isFinite(target) ? target : lastAim?.el;
    const tiltErr = Number.isFinite(elevation) && Number.isFinite(tiltCmd) ? tiltCmd - elevation : null;
    const trackAzErr = lastAim && Number.isFinite(dish) ? wrap180(lastAim.azTrue - dish) : null;
    const trackElErr = lastAim && Number.isFinite(elevation) ? lastAim.el - elevation : null;
    el('map-pointing-pan').textContent = Number.isFinite(panAngle)
      ? `FW ${fbLabel} ${panAngle.toFixed(1)}°${Number.isFinite(panCmd) ? ` → cmd ${panCmd.toFixed(1)}° · err ${fmtErr(panErr)}` : ''}${stale ? ' · STALE' : ''}`
      : `FW ${fbLabel} measure unavailable`;
    el('map-pointing-tilt').textContent = Number.isFinite(elevation)
      ? `TILT ${elevation.toFixed(1)}°${Number.isFinite(tiltCmd) ? ` → ${tiltCmd.toFixed(1)}° · err ${fmtErr(tiltErr)}` : ''}`
      : 'TILT unavailable';
    el('map-pointing-track').textContent = lastAim && Number.isFinite(trackAzErr)
      ? `Track (FW→gold) az ${fmtErr(trackAzErr)} · el ${fmtErr(trackElErr)} · tgt ${lastAim.azTrue.toFixed(1)}°`
      : lastAim
        ? `Track tgt ${lastAim.azTrue.toFixed(1)}° · FW map az unknown (${fbLabel})`
        : 'Track — no target yet';
    el('map-pointing-offset').textContent = config
      ? `Decl ${config.magDeclination.toFixed(1)}° · FW map ${Number.isFinite(dish) ? dish.toFixed(1) + '°' : '—'} · cmd map ${Number.isFinite(cmdMap) ? cmdMap.toFixed(1) + '°' : '—'}${Number.isFinite(browserMag) ? ` · browser mag ${browserMag.toFixed(1)}°` : ''}`
      : 'Save location first';
    const miss = Number.isFinite(trackAzErr) && Math.abs(trackAzErr) > 3;
    el('map-pointing-hint').textContent = usingPotFb
      ? 'Board is on Pot feedback — red ray is not mag closed-loop. Enable Mag (track home does this) or Tune → Mag position.'
      : gotoTimer
        ? 'Correcting — waiting for red (FW measure) to meet gold.'
        : miss
          ? 'FW≠gold — Go to click (or Align declination on a landmark).'
          : usingMagFb
            ? 'Red = FW Mag measure. Gold = target. Dashed white = FW command.'
            : 'Waiting for board pan_fb (MAG/POT).';
    el('map-pointing-title').textContent = stale
      ? 'Pointing · LINK STALE'
      : gotoTimer
        ? `Pointing · CORRECTING · FW ${fbLabel}`
        : miss
          ? `Pointing · MISS · FW ${fbLabel}`
          : `Pointing · FW ${fbLabel}`;
    if (usingMagFb && Number.isFinite(panAngle)) {
      el('device-aim-source').textContent =
        `FW feedback: MAG · measure ${panAngle.toFixed(1)}° → cmd ${Number.isFinite(panCmd) ? panCmd.toFixed(1) + '°' : '—'} · map ${Number.isFinite(dish) ? dish.toFixed(1) + '°' : '—'} (decl ${config?.magDeclination ?? 0}°)`;
    } else if (usingPotFb && Number.isFinite(panAngle)) {
      el('device-aim-source').textContent =
        `FW feedback: POT · pot ${panAngle.toFixed(1)}° → cmd ${Number.isFinite(panCmd) ? panCmd.toFixed(1) + '°' : '—'} · NOT mag closed-loop${Number.isFinite(browserMag) ? ` · browser mag map ${browserMag.toFixed(1)}° (display only)` : ''}`;
    } else {
      el('device-aim-source').textContent = `FW feedback: ${fbLabel} · waiting for measure`;
    }
    el('device-map-heading').textContent = Number.isFinite(dish)
      ? `Red(FW) ${dish.toFixed(1)}°${Number.isFinite(cmdMap) ? ` · cmd ${cmdMap.toFixed(1)}°` : ''}${Number.isFinite(browserMag) ? ` · browser ${browserMag.toFixed(1)}°` : ''}${stale ? ' · STALE' : ''}`
      : usingPotFb
        ? `No FW world az (Pot, no align)${Number.isFinite(browserMag) ? ` · browser mag ${browserMag.toFixed(1)}°` : ''}`
        : `FW dish ray waiting${stale ? ' · STALE' : ''}`;
  }
  function refreshDropoutWarn() {
    const lamp = el('track-dropout-warn');
    if (!lamp) return;
    const tracking = trackMode === 'sim' || trackMode === 'goto' || trackMode === 'circle' || trackMode === 'rocket';
    const ageS = lastTargetAt ? (performance.now() - lastTargetAt) / 1000 : Infinity;
    const drop = tracking && lastTargetAt > 0 && ageS > TRACK_DROPOUT_WARN_S;
    lamp.classList.toggle('track-dropout-on', drop);
    lamp.textContent = drop ? `NO DATA ${ageS.toFixed(0)}s` : 'DATA';
    lamp.title = drop
      ? `No parsable track data for ${ageS.toFixed(1)}s (warn after ${TRACK_DROPOUT_WARN_S}s)`
      : `Lights when no parsable track data for over ${TRACK_DROPOUT_WARN_S}s`;
  }
  function noteTargetFix() {
    lastTargetAt = performance.now();
    refreshDropoutWarn();
  }
  function rayLengthM() {
    // Prefer horizontal range to the live target so the red ray meets the gold line tip.
    const range = lastAim?.range;
    if (Number.isFinite(range) && range >= 1) return Math.min(range, 100000);
    return config?.length || 1000;
  }
  function drawLeaflet() {
    if (!map || !config || panel.hidden) return;
    const dish = dishAzimuth();
    const cmdMap = trueAzFromPanCmd(Number.isFinite(panTarget) ? panTarget : lastAim?.pan);
    const len = rayLengthM();
    marker.setLatLng([config.lat, config.lon]);
    // Red = FW measure (active feedback → map). White dashed = FW command.
    // Never draw browser mag as the dish ray — that lied when FW was on Pot.
    setRay(dishRay, !stale ? dish : null, len);
    setRay(magRay, !stale ? cmdMap : null, len * 0.85);
    // Gold dashed: tracker site → rocket (last GPS/sim fix), not an azimuth ray.
    if (targetRay) {
      if (lastAim && Number.isFinite(lastAim.lat) && Number.isFinite(lastAim.lon)) {
        targetRay.setLatLngs([[config.lat, config.lon], [lastAim.lat, lastAim.lon]]);
        if (!map.hasLayer(targetRay)) targetRay.addTo(map);
      } else {
        targetRay.setLatLngs([]);
        if (map.hasLayer(targetRay)) map.removeLayer(targetRay);
      }
    }
    refreshDropoutWarn();
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
    setWorkspaceView(button.dataset.view);
  });
  function read() {
    const c = {
      lat: el('device-latitude').valueAsNumber,
      lon: el('device-longitude').valueAsNumber,
      alt: el('device-altitude').valueAsNumber,
      panAlign: 0, // pot-era; Mag TRACK ignores align
      magDeclination: el('device-mag-declination').valueAsNumber,
      length: el('device-ray-length').valueAsNumber,
      panInvert: false,
    };
    const nums = { lat: c.lat, lon: c.lon, alt: c.alt, magDeclination: c.magDeclination, length: c.length };
    if (!Object.values(nums).every(Number.isFinite) || Math.abs(c.lat) > 90 || Math.abs(c.lon) > 180 ||
        c.alt < 0 || c.alt > 10000 ||
        Math.abs(c.magDeclination) > 360 || c.length < 1 || c.length > 100000) {
      throw Error('Enter valid coordinates, altitude, mag declination and line length.');
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
      `Device location: ${config.lat.toFixed(6)}, ${config.lon.toFixed(6)} · alt ${config.alt.toFixed(1)} m AGL · decl ${config.magDeclination}° · Mag track · saved`;
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
    syncSiteSelects('device-site');
    const id = el('device-site').value;
    if (!id) {
      el('device-location-status').textContent = 'Custom coordinates — edit fields below, then Save.';
      return;
    }
    const site = siteCatalog.find(s => s.id === id);
    if (site) applySite(site, { save: false });
  });
  el('track-site-ops').addEventListener('change', () => {
    syncSiteSelects('track-site-ops');
    const id = el('track-site-ops').value;
    if (!id) return;
    const site = siteCatalog.find(s => s.id === id);
    if (site) applySite(site, { save: false });
  });
  el('track-save-site').addEventListener('click', () => {
    saveNamedSite().catch(error => setStatus(error.message));
  });
  el('device-save-named-site').addEventListener('click', () => {
    saveNamedSite().catch(error => {
      el('device-location-status').textContent = error.message;
    });
  });
  el('track-arm').addEventListener('click', () => {
    if (servosArmed()) {
      const stop = document.getElementById('servo-disable');
      if (stop && !stop.disabled) stop.click();
      else setStatus('Cannot disable servos right now.');
      return;
    }
    const enable = document.getElementById('servo-enable');
    if (enable && !enable.disabled) enable.click();
    else setStatus('Connect and wait for servo state, then Enable.');
  });
  el('map-seed-mag').addEventListener('click', () => {
    try { seedAlignFromMag(); }
    catch (error) { el('device-location-status').textContent = error.message; }
  });
  el('map-center').addEventListener('click', () => { if (config) { init(); map?.setView([config.lat, config.lon], map.getZoom()); } });
  advanced.querySelectorAll('[data-track-mode]').forEach(button => button.addEventListener('click', () => setMode(button.dataset.trackMode)));
  el('track-run-sim').addEventListener('click', () => { startSimFlight().catch(error => setStatus(error.message)); });
  try {
    const savedLead = parseFloat(localStorage.getItem('track-lead'));
    if (Number.isFinite(savedLead)) el('track-lead').value = savedLead;
    el('track-predict').checked = localStorage.getItem('track-predict') !== '0';
    el('track-search').checked = localStorage.getItem('track-search') !== '0';
    const savedSearchSpeed = parseFloat(localStorage.getItem('track-search-speed'));
    if (Number.isFinite(savedSearchSpeed)) el('track-search-speed').value = savedSearchSpeed;
    const savedSearchGap = parseFloat(localStorage.getItem('track-search-gap'));
    if (Number.isFinite(savedSearchGap)) el('track-search-gap').value = savedSearchGap;
    syncPredictPlotChrome();
  } catch { /* ignore */ }
  el('track-predict').addEventListener('change', () => {
    syncPredictPlotChrome();
    paintTrackPlots();
    pushTrackPredict().then(() => setStatus(`Predict ${el('track-predict').checked ? 'on' : 'off'}`)).catch(error => setStatus(error.message));
  });
  el('track-lead').addEventListener('change', () => {
    pushTrackPredict().then(() => setStatus(`Lead ${el('track-lead').valueAsNumber.toFixed(2)} s`)).catch(error => setStatus(error.message));
  });
  el('track-search').addEventListener('change', () => {
    pushTrackPredict().then(() => setStatus(`Spiral search ${el('track-search').checked ? 'on' : 'off'}`)).catch(error => setStatus(error.message));
  });
  el('track-search-gap').addEventListener('change', () => {
    pushTrackPredict().then(() => setStatus(`Search gap ${el('track-search-gap').valueAsNumber.toFixed(1)} s`)).catch(error => setStatus(error.message));
  });
  el('track-search-speed').addEventListener('change', () => {
    pushTrackPredict().then(() => setStatus(`Search speed ${el('track-search-speed').valueAsNumber.toFixed(0)} °/s`)).catch(error => setStatus(error.message));
  });
  loadFlightList();
  try {
    const savedIcao = (localStorage.getItem('track-icao') || '').trim().toLowerCase();
    if (/^[0-9a-f]{6}$/.test(savedIcao) && el('track-icao')) el('track-icao').value = savedIcao;
    const savedInterval = parseFloat(localStorage.getItem('track-opensky-interval'));
    if (el('track-opensky-interval') && Number.isFinite(savedInterval)) {
      el('track-opensky-interval').value = String(Math.min(120, Math.max(5, savedInterval)));
    }
    if (el('track-opensky-poll')) el('track-opensky-poll').checked = false;
    const savedSource = localStorage.getItem('track-source');
    setTrackSource(savedSource === 'playback' || savedSource === 'serial' || savedSource === 'opensky'
      ? savedSource
      : 'opensky');
  } catch {
    setTrackSource('opensky');
  }
  document.querySelectorAll('[data-track-source]').forEach(btn => {
    btn.addEventListener('click', () => setTrackSource(btn.dataset.trackSource));
  });
  el('track-icao')?.addEventListener('change', () => {
    const v = (el('track-icao').value || '').trim().toLowerCase();
    try {
      if (/^[0-9a-f]{6}$/.test(v)) localStorage.setItem('track-icao', v);
      else if (!v) localStorage.removeItem('track-icao');
    } catch { /* ignore */ }
    if (el('track-opensky-poll')?.checked) {
      startOpenskyPoll().catch(error => {
        stopOpenskyPoll({ note: `error: ${error.message}` });
        setStatus(error.message);
      });
    }
  });
  el('track-opensky-poll')?.addEventListener('change', () => {
    if (openskyPollSyncing) return;
    const on = !!el('track-opensky-poll').checked;
    if (on) {
      startOpenskyPoll().catch(error => {
        syncOpenskyPollUi(false);
        setStatus(error.message);
        appendOpenskyLog(`error: ${error.message}`);
      });
    } else {
      stopOpenskyPoll();
    }
  });
  el('track-opensky-interval')?.addEventListener('change', () => {
    const v = el('track-opensky-interval').valueAsNumber;
    try {
      if (Number.isFinite(v)) localStorage.setItem('track-opensky-interval', String(v));
    } catch { /* ignore */ }
    if (el('track-opensky-poll')?.checked) {
      startOpenskyPoll().catch(error => {
        stopOpenskyPoll({ note: `error: ${error.message}` });
        setStatus(error.message);
      });
    }
  });
  el('track-dropout-warn')?.addEventListener('click', () => showOpenskyLog());
  el('track-opensky-log-clear')?.addEventListener('click', () => {
    const log = el('track-opensky-log');
    if (!log) return;
    log.dataset.empty = '1';
    log.textContent = 'Waiting for OpenSky polls…';
    lastLoggedSimKey = '';
  });
  async function refreshOpenskyCredsStatus() {
    const status = el('opensky-creds-status');
    const idBox = el('opensky-client-id');
    if (!status) return;
    try {
      const response = await fetch('/api/opensky-credentials', { cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(body.error || response.statusText);
      if (idBox && body.client_id) idBox.value = body.client_id;
      status.textContent = body.has_secret
        ? `Authenticated client “${body.client_id}” · secret saved on disk (gitignored).`
        : `Client “${body.client_id || '—'}” · paste client secret below and Save.`;
    } catch (error) {
      status.textContent = `OpenSky creds: ${error.message}`;
    }
  }
  el('opensky-creds-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const status = el('opensky-creds-status');
    try {
      const body = await trackApi('opensky-credentials', {
        client_id: el('opensky-client-id')?.value || 'your-opensky-client-id',
        client_secret: el('opensky-client-secret')?.value || '',
      });
      if (el('opensky-client-secret')) el('opensky-client-secret').value = '';
      if (status) {
        status.textContent = body.has_secret
          ? `Saved “${body.client_id}” with secret → ${body.path}`
          : `Saved “${body.client_id}” (no new secret — kept previous or still empty).`;
      }
    } catch (error) {
      if (status) status.textContent = error.message;
    }
  });
  refreshOpenskyCredsStatus();
  el('track-stop').addEventListener('click', () => {
    const keepPoll = trackSource === 'opensky' && !!el('track-opensky-poll')?.checked;
    const wasPointing = openskyPointing;
    stopTrack(true);
    setMode('off');
    openskyPointing = false;
    refreshStartLabel();
    if (keepPoll) {
      // Drop back to observe-only so Poll stays on without pointing.
      startOpenskyFeed({ point: false, clearTrail: false }).then(() => {
        setStatus(wasPointing ? 'Pointing stopped — still polling OpenSky (observe).' : 'OpenSky observe running.');
      }).catch(error => {
        syncOpenskyPollUi(false);
        setStatus(error.message);
      });
    } else {
      syncOpenskyPollUi(false);
      setStatus('Stopped — axes OFF queued.');
    }
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
      alignReady = true; // Mag track needs site + decl only; pot align retired.
      el('device-location-status').textContent =
        `Device location: ${config.lat.toFixed(6)}, ${config.lon.toFixed(6)} · alt ${config.alt.toFixed(1)} m AGL · decl ${config.magDeclination}° · Mag track · saved`;
    }
  } catch { config = null; }
  setWorkspaceView('track');
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
      refreshArmChip();
      // While Track is hidden, skip draw entirely — Advanced/Tune poll was driving Leaflet for nothing.
      if (!panel.hidden) draw();
    },
    applyRelaySim,
    seedAlignFromMag,
    destination,
    setWorkspaceView,
  };
})();
