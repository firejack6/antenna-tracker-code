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
      <label class="track-ops-field track-ops-check" title="After Search gap with no TRACK TARGET, sweep an expanding spiral from the last aim. Gap/speed in Advanced.">
        <input id="track-search-ops" type="checkbox" checked>
        Spiral search
      </label>
      <button type="button" id="map-center" class="secondary">Center</button>
    </div>
    <div class="track-source" aria-label="Track data source">
      <nav class="track-source-tabs" role="tablist" aria-label="Data source">
        <button type="button" role="tab" data-track-source="adsb" aria-selected="true">ADS-B</button>
        <button type="button" role="tab" data-track-source="opensky" aria-selected="false">OpenSky</button>
        <button type="button" role="tab" data-track-source="angles" aria-selected="false">Angle hold</button>
        <button type="button" role="tab" data-track-source="playback" aria-selected="false">Playback</button>
      </nav>
      <div class="track-source-panel track-ops" data-track-source-panel="adsb">
        <label class="track-ops-field" title="6-hex ICAO24 / Mode S address">ICAO24<input id="track-adsb-icao" type="text" maxlength="6" placeholder="0d10fe" autocomplete="off" spellcheck="false"></label>
        <label class="track-ops-field" title="Local dump1090/readsb on the LAN (aircraft.json) or SBS TCP">Source<select id="track-adsb-source"><option value="json">Local JSON (IP)</option><option value="sbs">SBS TCP</option></select></label>
        <label class="track-ops-field" id="track-adsb-host-wrap" title="dump1090/readsb host — polls http://IP:port/data/aircraft.json">Host IP<input id="track-adsb-host" type="text" value="127.0.0.1" placeholder="127.0.0.1" spellcheck="false" autocomplete="off"></label>
        <label class="track-ops-field" id="track-adsb-port-wrap" title="HTTP port for aircraft.json (usually 8080)">Port<input id="track-adsb-port" type="number" min="1" max="65535" step="1" value="8080" aria-label="ADS-B JSON HTTP port"></label>
        <label class="track-ops-field" id="track-adsb-sbs-wrap" hidden title="BaseStation TCP from dump1090 --net">SBS host:port<input id="track-adsb-sbs" type="text" value="127.0.0.1:30003" spellcheck="false"></label>
        <label class="track-ops-field track-ops-poll" title="Poll local ADS-B decoder. Independent of Start tracking. 0.5 s = 2 Hz.">
          ADS-B poll
          <span class="track-poll-row">
            <input id="track-adsb-poll" type="checkbox">
            <input id="track-adsb-interval" type="number" min="0.25" max="30" step="0.25" value="0.5" aria-label="ADS-B poll interval seconds">
            <span class="track-poll-unit">s</span>
          </span>
        </label>
        <p class="plot-note track-source-hint">Local dump1090/readsb → http://IP:8080/data/aircraft.json (uses lat/lon or lastPosition). Poll = watch @ 2 Hz default. Start tracking = TRACK TARGET + point.</p>
        <div class="track-feed-log-wrap">
          <div class="track-feed-log-head">
            <strong>Feed log</strong>
            <button type="button" id="track-adsb-log-clear" class="secondary">Clear</button>
          </div>
          <pre id="track-adsb-log" class="track-feed-log" aria-live="polite">Waiting for local ADS-B…</pre>
        </div>
      </div>
      <div class="track-source-panel track-ops" data-track-source-panel="opensky" hidden>
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
      <div class="track-source-panel track-ops" data-track-source-panel="angles" hidden>
        <label class="track-ops-field" title="True-north azimuth (map frame). Declination applied on the board for Mag PAN.">Azimuth true (°)<input id="track-hold-az" type="number" min="0" max="360" step="0.1" value="0"></label>
        <label class="track-ops-field" title="Elevation above horizon (−5…85°)">Elevation (°)<input id="track-hold-el" type="number" min="-5" max="85" step="0.1" value="20"></label>
        <label class="track-ops-field" title="Ground range from site — used with elev to get target altitude">Range (m)<input id="track-hold-range" type="number" min="1" max="100000" step="1" value="1000"></label>
        <button type="button" id="track-hold-seed" class="secondary" title="Copy current dish az/el into the boxes (does not start tracking)">Seed from dish</button>
        <button type="button" id="track-hold-update" title="Apply az/el/range as TRACK TARGET. Starts hold if needed; retargets while holding.">Update aim</button>
        <p id="track-hold-preview" class="plot-note track-source-hint" role="status">Enter az / el / range to preview GPS target.</p>
        <p class="plot-note track-source-hint">Set az / el / range → Update aim (or Start tracking). Seed only copies the dish into the boxes.</p>
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
        <h3>Elevation <small id="map-el-chart-sub">dish · GPS · pot V</small></h3>
        <div class="mini-legend"><span style="color:#69adff">El dish</span><span style="color:#a88bfa">El GPS</span><span id="map-el-cmd-legend" style="color:#61e2bd" hidden>El predict</span><span style="color:#f0a060">Tilt pot V</span></div>
        <canvas id="map-el-chart" class="chart-hoverable" role="img" aria-label="Dish elevation, GPS elevation, and tilt pot voltage versus time"></canvas>
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
      <label>Search gap (s)<input id="track-search-gap" type="number" min="0.5" max="60" step="0.5" value="3" title="Seconds without TRACK TARGET before spiral search. Live OpenSky/ADS-B pointing auto-extends this past the poll interval so search does not steal the dish."></label>
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
  let tiltPotV = null;
  let stale = true, magStale = true; // stale = servo/link; magStale = IMU/mag only
  let headingUpdatedAt = null;
  let trackMode = 'off', trackTimer = null, gotoTimer = null, trackBusy = false, lastCommandAt = 0;
  let targetMarker = null, padMarker = null, pathLine = null, pathPoints = [];
  let clickLatLng = null, runStartedAt = null, lastAim = null, alignReady = false;
  let lastSimIndex = -1;
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
  /** Inverse of azEl(): true az + elev + ground range → lat/lon/alt at site. */
  function coordsFromAzEl(azTrue, elDeg, groundRangeM) {
    if (!config) throw Error('Save a device location first.');
    const range = Math.max(1, Number(groundRangeM));
    if (!Number.isFinite(range)) throw Error('Range must be a finite number of metres.');
    const az = wrap360(Number(azTrue));
    const el = Math.max(-5, Math.min(85, Number(elDeg)));
    if (!Number.isFinite(az) || !Number.isFinite(el)) throw Error('Azimuth and elevation must be finite.');
    const relAlt = range * Math.tan(el * Math.PI / 180);
    const altM = (Number.isFinite(config.alt) ? config.alt : 0) + relAlt;
    const [lat, lon] = destination(config.lat, config.lon, az, range);
    return { lat, lon, altM, range, azTrue: az, el };
  }
  function holdParams() {
    const az = el('track-hold-az')?.valueAsNumber;
    const elev = el('track-hold-el')?.valueAsNumber;
    const range = el('track-hold-range')?.valueAsNumber;
    return coordsFromAzEl(az, elev, range);
  }
  function refreshHoldPreview() {
    const box = el('track-hold-preview');
    if (!box) return;
    try {
      const p = holdParams();
      const mag = magHeadingForTrueAz(p.azTrue);
      box.textContent =
        `Target ${p.lat.toFixed(6)}, ${p.lon.toFixed(6)} · alt ${p.altM.toFixed(1)} m` +
        ` · ground ${p.range.toFixed(0)} m · true az ${p.azTrue.toFixed(1)}°` +
        (Number.isFinite(mag) ? ` · mag ${mag.toFixed(1)}°` : '');
    } catch (error) {
      box.textContent = error.message;
    }
  }
  const HOLD_INPUT_IDS = ['track-hold-az', 'track-hold-el', 'track-hold-range'];
  function holdInputFocused() {
    const active = document.activeElement;
    return !!active && HOLD_INPUT_IDS.some(id => active.id === id);
  }
  function seedHoldFromDish() {
    // Explicit user action only — never call this from the hold loop / telemetry.
    const azTrue = dishAzimuth();
    if (!Number.isFinite(azTrue)) throw Error('Need a fresh dish azimuth (mag / pan feedback).');
    if (!Number.isFinite(elevation)) throw Error('Need a fresh elevation (TILT).');
    el('track-hold-az').value = azTrue.toFixed(1);
    el('track-hold-el').value = elevation.toFixed(1);
    // Leave range alone unless empty/invalid — do not wipe a user range on seed.
    if (!Number.isFinite(el('track-hold-range')?.valueAsNumber) || el('track-hold-range').valueAsNumber < 1) {
      el('track-hold-range').value = '5000';
    }
    try {
      localStorage.setItem('track-hold-az', el('track-hold-az').value);
      localStorage.setItem('track-hold-el', el('track-hold-el').value);
      localStorage.setItem('track-hold-range', el('track-hold-range').value);
    } catch { /* ignore */ }
    refreshHoldPreview();
  }
  let searchToggleSyncing = false;
  function syncSearchToggles(on) {
    const want = !!on;
    searchToggleSyncing = true;
    if (el('track-search') && el('track-search').checked !== want) el('track-search').checked = want;
    if (el('track-search-ops') && el('track-search-ops').checked !== want) el('track-search-ops').checked = want;
    searchToggleSyncing = false;
    try { localStorage.setItem('track-search', want ? '1' : '0'); } catch { /* ignore */ }
  }
  async function pushTrackSearch(opts = {}) {
    const enabled = opts.enabled != null ? !!opts.enabled
      : !!(el('track-search-ops')?.checked ?? el('track-search')?.checked);
    // syncUi:false for temporary session overrides (angle hold / live-feed gap) so
    // the user's checkbox preference is not overwritten.
    if (opts.syncUi !== false) syncSearchToggles(enabled);
    const searchSpeed = el('track-search-speed')?.valueAsNumber;
    const userGap = el('track-search-gap')?.valueAsNumber;
    let gap = Number.isFinite(opts.gap) ? opts.gap
      : (Number.isFinite(userGap) ? userGap : 3);
    // Live feeds with slow polls must not fall into spiral search between updates.
    if (enabled && Number.isFinite(opts.minGap) && opts.minGap > gap) gap = opts.minGap;
    gap = Math.max(0.5, Math.min(60, gap));
    await trackApi('track-search', {
      enabled,
      speed: Number.isFinite(searchSpeed) ? searchSpeed : 30,
      gap,
    });
    return { enabled, gap };
  }
  function persistHoldInputs(point) {
    if (!point) return;
    try {
      localStorage.setItem('track-hold-az', String(point.azTrue));
      localStorage.setItem('track-hold-el', String(point.el));
      localStorage.setItem('track-hold-range', String(point.range));
    } catch { /* ignore */ }
  }
  function holdNote(point) {
    return `Angle hold · true az ${point.azTrue.toFixed(1)}° el ${point.el.toFixed(1)}° · ${point.range.toFixed(0)} m`;
  }
  let lastHoldAimKey = '';
  function holdAimKey(point) {
    return `${point.azTrue.toFixed(3)}|${point.el.toFixed(3)}|${point.range.toFixed(1)}`;
  }
  async function aimHoldFromInputs({ force = false, ignoreFocus = false } = {}) {
    // Never rewrite the input boxes here — only read them.
    if (!ignoreFocus && holdInputFocused()) return null;
    let point;
    try { point = holdParams(); }
    catch { return null; }
    const key = holdAimKey(point);
    const changed = key !== lastHoldAimKey;
    if (!changed && !force) return point;
    persistHoldInputs(point);
    refreshHoldPreview();
    const note = holdNote(point);
    // Always force TARGET when the hold point changed so small az edits still send.
    // Only mark the key after a successful send so a failed TARGET is retried.
    await aimAt(point.lat, point.lon, point.altM, note, { force: true });
    lastHoldAimKey = key;
    return point;
  }
  async function startAngleHold() {
    if (!servosArmed()) {
      setStatus('Enable servos first, then Update aim for angle hold.');
      return;
    }
    await ensureSiteForStart();
    const point = holdParams();
    persistHoldInputs(point);
    lastHoldAimKey = '';
    stopTrack(false);
    clearPath();
    openskyPointing = false;
    adsbPointing = false;
    syncOpenskyPollUi(false);
    syncAdsbPollUi(false);
    // Fixed aim — spiral search would walk az/el as cos/sin and look like tgt "hunting".
    try { await pushTrackSearch({ enabled: false, syncUi: false }); } catch { /* older FW */ }
    trackMode = 'hold';
    document.querySelectorAll('[data-track-mode]').forEach(b => b.setAttribute('aria-pressed', 'false'));
    refreshStartLabel();
    refreshHoldPreview();
    // Keep TARGET alive; only re-send when az/el/range actually change.
    startLoop(() => {
      if (holdInputFocused()) return;
      aimHoldFromInputs({ force: false }).catch(error => setStatus(error.message));
    });
    await aimHoldFromInputs({ force: true, ignoreFocus: true });
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
    await trackApi('track-predict', { enabled });
    if (Number.isFinite(lead)) await trackApi('track-lead', { lead });
    // Don't stomp a live-feed-extended search gap while OpenSky/ADS-B/hold is pointing.
    if (trackMode !== 'hold' && !openskyPointing && !adsbPointing) {
      await pushTrackSearch();
    }
    localStorage.setItem('track-predict', enabled ? '1' : '0');
    if (Number.isFinite(lead)) localStorage.setItem('track-lead', String(lead));
    const searchSpeed = el('track-search-speed')?.valueAsNumber;
    const searchGap = el('track-search-gap')?.valueAsNumber;
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
    // forceHome only when site/decl actually changed — re-pushing HOME also
    // re-asserts SERVO FEEDBACK PAN MAG, which used to stopOutput + reset the
    // mag filter and made the following TARGET fail (PID never armed).
    await pushTrackHome(config, !!opts.forceHome);
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
    document.querySelectorAll('[data-track-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.trackMode === mode)));
    if (mode === 'off') {
      lastAim = null;
      lastSimIndex = -1;
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
  let adsbPointing = false;
  function livePointing() {
    return (trackSource === 'opensky' && openskyPointing)
      || (trackSource === 'adsb' && adsbPointing);
  }
  function refreshStartLabel() {
    const btn = el('track-run-sim');
    if (!btn) return;
    // Keep Start armed during hold — Tune Apply kills PWM mid-hold and used to
    // leave this stuck on disabled "Holding…".
    if (trackMode === 'hold' && trackSource === 'angles') {
      btn.textContent = 'Restart hold';
      btn.disabled = false;
      return;
    }
    const busy = (trackSource === 'opensky' || trackSource === 'adsb')
      ? livePointing()
      : trackMode === 'sim';
    btn.textContent = busy ? 'Tracking…' : 'Start tracking';
    btn.disabled = busy;
  }
  async function updateAngleAim() {
    try {
      if (trackMode === 'hold') {
        const point = await aimHoldFromInputs({ force: true, ignoreFocus: true });
        if (!point) throw Error('Enter valid az / el / range first.');
        setStatus(`Updated aim · ${holdNote(point)}`);
        return;
      }
      await startAngleHold();
    } catch (error) {
      if (trackMode !== 'hold') trackMode = 'off';
      refreshStartLabel();
      setStatus(error.message);
      refreshHoldPreview();
    }
  }
  let trackSource = 'adsb'; // 'adsb' | 'opensky' | 'angles' | 'playback'
  function setTrackSource(source) {
    if (!['adsb', 'opensky', 'angles', 'playback'].includes(source)) source = 'adsb';
    trackSource = source;
    document.querySelectorAll('[data-track-source]').forEach(btn => {
      btn.setAttribute('aria-selected', String(btn.dataset.trackSource === source));
    });
    document.querySelectorAll('[data-track-source-panel]').forEach(panelEl => {
      panelEl.hidden = panelEl.dataset.trackSourcePanel !== source;
    });
    try { localStorage.setItem('track-source', source); } catch { /* ignore */ }
    const hints = {
      adsb: 'ADS-B: local dump1090/readsb by IP. Poll = watch. Start tracking = point.',
      opensky: 'OpenSky: Poll = watch positions. Start tracking = feed TRACK TARGET and point (servos on).',
      angles: 'Angle hold: set az / el / range → Update aim (TRACK TARGET hold).',
      playback: 'Playback: pick a flight CSV, enable servos, Start.',
    };
    if (!livePointing() && trackMode !== 'sim' && trackMode !== 'hold') setStatus(hints[source] || '');
    if (source === 'angles') refreshHoldPreview();
  }
  function syncAdsbSourceUi() {
    const mode = el('track-adsb-source')?.value || 'json';
    const json = mode === 'json';
    if (el('track-adsb-host-wrap')) el('track-adsb-host-wrap').hidden = !json;
    if (el('track-adsb-port-wrap')) el('track-adsb-port-wrap').hidden = !json;
    if (el('track-adsb-sbs-wrap')) el('track-adsb-sbs-wrap').hidden = mode !== 'sbs';
  }
  function adsbJsonUrl(host, port) {
    const h = String(host || '').trim();
    const p = Number(port);
    if (!h) throw Error('ADS-B host IP required (e.g. 127.0.0.1).');
    if (!Number.isFinite(p) || p < 1 || p > 65535) throw Error('ADS-B port must be 1–65535.');
    return `http://${h}:${p}/data/aircraft.json`;
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
    adsbPointing = false;
    syncAdsbPollUi(false);
    // Keep spiral search from owning the dish between slow OpenSky polls.
    if (point) {
      try {
        const need = interval + 10;
        if (need > 60) {
          await pushTrackSearch({ enabled: false, syncUi: false });
          appendOpenskyLog(`search off while pointing — poll ${interval}s ≥ board max search gap`);
        } else {
          const s = await pushTrackSearch({ minGap: need, syncUi: false });
          appendOpenskyLog(`search gap ≥ ${s.gap.toFixed(0)}s while pointing (poll ${interval}s)`);
        }
      } catch { /* older FW */ }
    }
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
      source: 'opensky',
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
    if (note) {
      setStatus(note);
      appendOpenskyLog(note);
    }
  }
  let adsbPollSyncing = false;
  function syncAdsbPollUi(on) {
    const box = el('track-adsb-poll');
    if (box && box.checked !== !!on) {
      adsbPollSyncing = true;
      box.checked = !!on;
      adsbPollSyncing = false;
    }
    try { localStorage.setItem('track-adsb-enable', on ? '1' : '0'); } catch { /* ignore */ }
  }
  function appendAdsbLog(line) {
    const log = el('track-adsb-log');
    if (!log) return;
    const ts = new Date().toLocaleTimeString();
    const next = `${ts}  ${line}`;
    const prev = log.dataset.empty === '1' || /^Waiting for local ADS-B/.test(log.textContent || '')
      ? []
      : (log.textContent || '').split('\n').filter(Boolean);
    prev.unshift(next);
    log.dataset.empty = '0';
    log.textContent = prev.slice(0, 100).join('\n');
  }
  function adsbParams() {
    const icao24 = (el('track-adsb-icao')?.value || '').trim().toLowerCase();
    const interval = el('track-adsb-interval')?.valueAsNumber;
    const adsbSource = el('track-adsb-source')?.value || 'json';
    if (!/^[0-9a-f]{6}$/.test(icao24)) {
      throw Error('ICAO24 must be 6 hex characters (e.g. a1b2c3).');
    }
    if (!Number.isFinite(interval) || interval < 0.25 || interval > 30) {
      throw Error('ADS-B poll interval must be 0.25–30 seconds.');
    }
    if (adsbSource === 'sbs') {
      const raw = (el('track-adsb-sbs')?.value || '127.0.0.1:30003').trim();
      const m = raw.match(/^([^:\s]+):(\d+)$/);
      if (!m) throw Error('SBS host:port required (e.g. 127.0.0.1:30003).');
      return { icao24, interval, adsbSource, host: m[1], port: Number(m[2]) };
    }
    const host = (el('track-adsb-host')?.value || '127.0.0.1').trim();
    const port = el('track-adsb-port')?.valueAsNumber;
    const url = adsbJsonUrl(host, Number.isFinite(port) ? port : 8080);
    return { icao24, interval, adsbSource, host, port: Number.isFinite(port) ? port : 8080, url };
  }
  async function startAdsbFeed({ point = false, clearTrail = true } = {}) {
    const params = adsbParams();
    if (point) await ensureSiteForStart();
    else await ensureSiteConfig();
    stopTrack(false);
    if (clearTrail) clearPath();
    trackMode = 'sim';
    openskyPointing = false;
    adsbPointing = !!point;
    syncOpenskyPollUi(false);
    if (point) {
      try {
        const s = await pushTrackSearch({ minGap: params.interval + 5, syncUi: false });
        appendAdsbLog(`search gap ≥ ${s.gap.toFixed(0)}s while pointing (poll ${params.interval}s)`);
      } catch { /* older FW */ }
    }
    document.querySelectorAll('[data-track-mode]').forEach(b => b.setAttribute('aria-pressed', 'false'));
    refreshStartLabel();
    lastLoggedSimKey = '';
    const mode = point ? 'pointing' : 'observe';
    const where = params.adsbSource === 'sbs'
      ? `sbs://${params.host}:${params.port}`
      : params.url;
    appendAdsbLog(`${mode} ${params.icao24} · every ${params.interval}s · ${where}`);
    setStatus(point
      ? `ADS-B tracking ${params.icao24}…`
      : `ADS-B polling ${params.icao24} every ${params.interval}s (observe)…`);
    try {
      localStorage.setItem('track-adsb-icao', params.icao24);
      localStorage.setItem('track-adsb-interval', String(params.interval));
      localStorage.setItem('track-adsb-source', params.adsbSource);
      if (params.adsbSource === 'json') {
        localStorage.setItem('track-adsb-host', params.host);
        localStorage.setItem('track-adsb-port', String(params.port));
        localStorage.setItem('track-adsb-url', params.url);
      } else if (params.host) {
        localStorage.setItem('track-adsb-sbs', `${params.host}:${params.port}`);
      }
    } catch { /* ignore */ }
    const payload = {
      action: 'start',
      source: 'adsb',
      icao24: params.icao24,
      interval: params.interval,
      idle_stop: 600,
      point: !!point,
      adsb_source: params.adsbSource,
      lat: config.lat,
      lon: config.lon,
      alt: config.alt || 0,
      mag_declination: config.magDeclination || 0,
    };
    if (params.adsbSource === 'json') payload.adsb_url = params.url;
    else {
      payload.adsb_host = params.host;
      payload.adsb_port = params.port;
    }
    const body = await trackApi('track-sim', payload);
    syncAdsbPollUi(true);
    adsbPointing = !!point;
    refreshStartLabel();
    setStatus(body.message || (point ? `Tracking ${params.icao24}` : `Polling ${params.icao24}`));
    if (body.message) appendAdsbLog(body.message);
    if (Number.isFinite(body.lat) && Number.isFinite(body.lon)) {
      lastAim = {
        azTrue: body.az, el: body.el, range: body.range_m, lat: body.lat, lon: body.lon,
        altM: body.alt, pan: body.pan,
      };
      drawTarget(body.lat, body.lon, true);
      draw();
    }
  }
  function stopAdsbPoll({ sendOff = true, note = 'ADS-B poll stopped' } = {}) {
    const wasSim = trackMode === 'sim';
    if (wasSim) stopTrack(sendOff);
    trackMode = 'off';
    adsbPointing = false;
    lastSimIndex = -1;
    document.querySelectorAll('[data-track-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.trackMode === 'off')));
    refreshStartLabel();
    syncAdsbPollUi(false);
    if (note) {
      setStatus(note);
      appendAdsbLog(note);
    }
  }
  async function startSimFlight() {
    if (trackSource === 'angles') {
      // Full re-arm (HOME + TARGET). Update aim is the in-hold retarget control.
      // Restart hold after Tune Apply / STOP must not sit on a dead session.
      try {
        await startAngleHold();
      } catch (error) {
        if (trackMode !== 'hold') trackMode = 'off';
        refreshStartLabel();
        setStatus(error.message);
        refreshHoldPreview();
      }
      return;
    }
    if (trackSource === 'adsb') {
      if (!servosArmed()) {
        setStatus('Enable servos first, then Start tracking to point at the ADS-B target.');
        return;
      }
      try {
        await startAdsbFeed({ point: true, clearTrail: true });
        appendAdsbLog('pointing on — TRACK TARGET enabled');
      } catch (error) {
        adsbPointing = false;
        refreshStartLabel();
        if (!el('track-adsb-poll')?.checked) trackMode = 'off';
        setStatus(error.message);
        appendAdsbLog(`error: ${error.message}`);
      }
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
    adsbPointing = false;
    document.querySelectorAll('[data-track-mode]').forEach(b => b.setAttribute('aria-pressed', 'false'));
    refreshStartLabel();
    syncOpenskyPollUi(false);
    syncAdsbPollUi(false);
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
  function liveFeedKind(sim) {
    const file = String(sim?.file || '');
    if (file.startsWith('adsb:')) return 'adsb';
    if (file.startsWith('opensky:')) return 'opensky';
    if (trackSource === 'adsb' || trackSource === 'opensky') return trackSource;
    return null;
  }
  function logLiveSim(sim, { freshSample = false } = {}) {
    const kind = liveFeedKind(sim);
    if (!kind) return;
    const file = String(sim?.file || '');
    let line = '';
    if (Number.isFinite(sim.lat) && Number.isFinite(sim.lon) && freshSample) {
      const who = sim.callsign || sim.icao24 || file.replace(/^(opensky|adsb):/, '') || 'ac';
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
    const key = `${kind}|${sim.index ?? ''}|${line}`;
    if (key === lastLoggedSimKey) return;
    lastLoggedSimKey = key;
    if (kind === 'adsb') appendAdsbLog(line);
    else appendOpenskyLog(line);
  }
  function showLiveFeedLog(kind = trackSource) {
    const source = kind === 'adsb' ? 'adsb' : 'opensky';
    setTrackSource(source);
    const log = el(source === 'adsb' ? 'track-adsb-log' : 'track-opensky-log');
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
      const file = String(sim.file || '');
      if (file.startsWith('opensky:')) {
        syncOpenskyPollUi(true);
        syncAdsbPollUi(false);
        if (typeof sim.pointing === 'boolean' && sim.pointing !== openskyPointing) {
          openskyPointing = sim.pointing;
          adsbPointing = false;
          refreshStartLabel();
        }
      } else if (file.startsWith('adsb:')) {
        syncAdsbPollUi(true);
        syncOpenskyPollUi(false);
        if (typeof sim.pointing === 'boolean' && sim.pointing !== adsbPointing) {
          adsbPointing = sim.pointing;
          openskyPointing = false;
          refreshStartLabel();
        }
      }
      const idx = Number.isFinite(sim.index) ? sim.index : -1;
      const freshSample = idx >= 0 && idx !== lastSimIndex;
      if (freshSample) lastSimIndex = idx;
      if (Number.isFinite(sim.lat) && Number.isFinite(sim.lon)) {
        const ground = config
          ? haversineM(config.lat, config.lon, sim.lat, sim.lon)
          : sim.range_m;
        lastAim = {
          azTrue: sim.az, el: sim.el,
          range: Number.isFinite(sim.range_m) ? sim.range_m : ground,
          lat: sim.lat, lon: sim.lon,
          altM: sim.alt, pan: sim.pan, dish: dishAzimuth(), azErr: null,
        };
        // Keep marker/path ≤ ~4 Hz — poll is faster and trail setLatLngs was a freeze vector.
        const now = performance.now();
        if (now - lastSimDrawAt >= 250) {
          lastSimDrawAt = now;
          const tip = sim.callsign || sim.icao24 || null;
          drawTarget(sim.lat, sim.lon, true, tip);
          draw();
        }
      }
      logLiveSim(sim, { freshSample });
      if (sim.message && sim.message !== lastSimStatus) {
        lastSimStatus = sim.message;
        setStatus(sim.message);
      }
    } else if (trackMode === 'sim') {
      const file = String(sim.file || '');
      const wasOpensky = file.startsWith('opensky:') || el('track-opensky-poll')?.checked;
      const wasAdsb = file.startsWith('adsb:') || el('track-adsb-poll')?.checked;
      trackMode = 'off';
      openskyPointing = false;
      adsbPointing = false;
      lastSimIndex = -1;
      document.querySelectorAll('[data-track-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.trackMode === 'off')));
      refreshStartLabel();
      if (wasOpensky) syncOpenskyPollUi(false);
      if (wasAdsb) syncAdsbPollUi(false);
      lastSimStatus = sim.message || 'Sim stopped';
      setStatus(lastSimStatus);
      logLiveSim(sim);
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
    const t = performance.now() / 1000;
    const dish = dishAzimuth();
    const azPredict = trueAzFromPanCmd(panTarget);
    // TILT telemetry is displayAngle-flipped to elevation-up (same as lastAim.el).
    const elPredict = Number.isFinite(target) ? target : null;
    const hasAim = lastAim && Number.isFinite(lastAim.lat);
    const hasEl = Number.isFinite(elevation) || Number.isFinite(tiltPotV);
    if (!hasAim && !hasEl) return;
    trackHist.push({
      t,
      range: hasAim && Number.isFinite(lastAim.range) ? lastAim.range : null,
      alt: hasAim && Number.isFinite(lastAim.altM) ? lastAim.altM : null,
      azActual: Number.isFinite(dish) ? dish : null,
      azTarget: hasAim && Number.isFinite(lastAim.azTrue) ? lastAim.azTrue : null,
      azPredict: Number.isFinite(azPredict) ? azPredict : null,
      elActual: Number.isFinite(elevation) ? elevation : null,
      elTarget: hasAim && Number.isFinite(lastAim.el) ? lastAim.el : null,
      elPredict: Number.isFinite(elPredict) ? elPredict : null,
      potV: Number.isFinite(tiltPotV) ? tiltPotV : null,
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
    const rightFlags = options.right || [];
    const hasRight = rightFlags.some(Boolean);
    const pad = { left: 48, right: hasRight ? 48 : 10, top: 12, bottom: 22 };
    const w = width - pad.left - pad.right, h = height - pad.top - pad.bottom;
    const span = TRACK_HIST_SPAN_S;
    const now = performance.now() / 1000;
    const wrapBreak = options.wrapBreak;
    const points = series.map(s => s.filter(p => p && now - p.t <= span && Number.isFinite(p.v)));
    const leftVals = points.flatMap((pts, i) => rightFlags[i] ? [] : pts.map(p => p.v));
    const rightVals = points.flatMap((pts, i) => rightFlags[i] ? pts.map(p => p.v) : []);
    const scaleOf = (values, fallbackSpan = 1) => {
      let low = 0, high = 1;
      if (values.length) {
        low = Math.min(...values);
        high = Math.max(...values);
        if (low === high) { low -= fallbackSpan; high += fallbackSpan; }
        const margin = (high - low) * 0.12 || fallbackSpan;
        low -= margin; high += margin;
      }
      return { low, high };
    };
    const left = scaleOf(leftVals, 1);
    const right = scaleOf(rightVals, 0.05);
    ctx.font = '10px Segoe UI, sans-serif';
    for (let i = 0; i < 4; i++) {
      const y = pad.top + h * i / 3;
      ctx.strokeStyle = '#263448';
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width - pad.right, y); ctx.stroke();
      ctx.fillStyle = '#91a4bb'; ctx.textAlign = 'right';
      ctx.fillText((left.high - (left.high - left.low) * i / 3).toFixed(options.decimals ?? 1), pad.left - 6, y + 3);
      if (hasRight) {
        ctx.fillStyle = '#f0a060'; ctx.textAlign = 'left';
        ctx.fillText((right.high - (right.high - right.low) * i / 3).toFixed(options.rightDecimals ?? 3), width - pad.right + 6, y + 3);
      }
    }
    ctx.fillStyle = '#91a4bb'; ctx.textAlign = 'left';
    ctx.fillText(`−${span}s`, pad.left, height - 4);
    ctx.textAlign = 'right'; ctx.fillText('now', width - pad.right, height - 4);
    if (!leftVals.length && !rightVals.length) {
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for track / tilt…', pad.left + w / 2, pad.top + h / 2);
      return;
    }
    const xOf = t => pad.left + ((t - (now - span)) / span) * w;
    const yOf = (v, useRight) => {
      const lo = useRight ? right.low : left.low;
      const hi = useRight ? right.high : left.high;
      return pad.top + (1 - (v - lo) / (hi - lo)) * h;
    };
    points.forEach((pts, i) => {
      if (pts.length < 2) return;
      const useRight = !!rightFlags[i];
      ctx.strokeStyle = options.colors?.[i] || '#61e2bd';
      ctx.lineWidth = useRight ? 1.4 : 1.6;
      ctx.beginPath();
      let drawing = false, prev = null;
      for (const p of pts) {
        const wrapJump = prev && wrapBreak && !useRight && Math.abs(p.v - prev.v) > wrapBreak;
        const timeJump = prev && (p.t - prev.t) > 2;
        if (wrapJump || timeJump) drawing = false;
        const x = xOf(p.t), y = yOf(p.v, useRight);
        if (!drawing) { ctx.moveTo(x, y); drawing = true; }
        else ctx.lineTo(x, y);
        prev = p;
      }
      ctx.stroke();
    });
    if (typeof ChartHover !== 'undefined') {
      ChartHover.finish(ctx, canvas, {
        pad, width, height, low: left.low, high: left.high, lowR: right.low, highR: right.high,
        decimals: options.decimals ?? 1,
        t0: now - span, t1: now,
        series: points.map((pts, i) => ({
          label: options.labels?.[i] || `Trace ${i + 1}`,
          color: options.colors?.[i] || '#61e2bd',
          points: pts,
          right: !!rightFlags[i],
          decimals: rightFlags[i] ? (options.rightDecimals ?? 3) : (options.decimals ?? 1),
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
    if (elSub) elSub.textContent = on ? 'dish · GPS · predict · pot V' : 'dish · GPS · pot V';
    if (azLeg) azLeg.hidden = !on;
    if (elLeg) elLeg.hidden = !on;
  }
  function paintTrackPlots() {
    if (panel.hidden) return;
    syncPredictPlotChrome();
    const showPredict = predictPlotEnabled();
    const range = [], alt = [], azA = [], azT = [], azP = [], elA = [], elT = [], elP = [], pot = [];
    for (const s of trackHist) {
      if (Number.isFinite(s.range)) range.push({ t: s.t, v: s.range });
      if (Number.isFinite(s.alt)) alt.push({ t: s.t, v: s.alt });
      if (Number.isFinite(s.azActual)) azA.push({ t: s.t, v: s.azActual });
      if (Number.isFinite(s.azTarget)) azT.push({ t: s.t, v: s.azTarget });
      if (showPredict && Number.isFinite(s.azPredict)) azP.push({ t: s.t, v: s.azPredict });
      if (Number.isFinite(s.elActual)) elA.push({ t: s.t, v: s.elActual });
      if (Number.isFinite(s.elTarget)) elT.push({ t: s.t, v: s.elTarget });
      if (showPredict && Number.isFinite(s.elPredict)) elP.push({ t: s.t, v: s.elPredict });
      if (Number.isFinite(s.potV)) pot.push({ t: s.t, v: s.potV });
    }
    paintTrackChart('map-distance-chart', [range, alt], {
      colors: ['#69adff', '#f5bd4f'], labels: ['Range m', 'Alt m'], decimals: 0,
    });
    paintTrackChart('map-az-chart', showPredict ? [azA, azT, azP] : [azA, azT], {
      colors: showPredict ? ['#ef3038', '#f5bd4f', '#61e2bd'] : ['#ef3038', '#f5bd4f'],
      labels: showPredict ? ['Az FW', 'Az GPS', 'Az predict'] : ['Az FW', 'Az GPS'],
      decimals: 1, wrapBreak: 180,
    });
    const elSeries = showPredict ? [elA, elT, elP, pot] : [elA, elT, pot];
    paintTrackChart('map-el-chart', elSeries, {
      colors: showPredict
        ? ['#69adff', '#a88bfa', '#61e2bd', '#f0a060']
        : ['#69adff', '#a88bfa', '#f0a060'],
      labels: showPredict
        ? ['El dish', 'El GPS', 'El predict', 'Tilt pot V']
        : ['El dish', 'El GPS', 'Tilt pot V'],
      decimals: 1,
      rightDecimals: 3,
      right: showPredict ? [false, false, false, true] : [false, false, true],
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
        forceHome: !!opts.forceHome,
        minMoveM: opts.minMoveM ?? (trackMode === 'goto' ? 2 : 8),
        minAltDelta: opts.minAltDelta ?? 2,
      });
      setStatus(sent
        ? `${note} · TARGET ${lat.toFixed(5)}, ${lon.toFixed(5)} · ${altM.toFixed(0)} m · az ${look?.azTrue?.toFixed(1) ?? '—'}°`
        : `${note} · holding · az ${look?.azTrue?.toFixed(1) ?? '—'}° · err ${fmtErr(look?.azErr ?? 0)}`);
      if (trackMode === 'goto' && !opts.fromCorrector) startGotoCorrector(lat, lon, altM);
      return look;
    } catch (error) {
      setStatus(`${note} · ${error.message}`);
      throw error;
    } finally { trackBusy = false; }
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
      aimAt(lat, lon, alt, `Circle ${rate}°/s · r ${radius} m`).catch(error => setStatus(error.message));
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
  function rayLengthM() {
    // Red dish ray length = ground range to the target (same as gold tip when aimed).
    // lastAim.range / sim.range_m are horizontal metres (feeds used to send slant).
    if (config && lastAim && Number.isFinite(lastAim.lat) && Number.isFinite(lastAim.lon)) {
      const ground = haversineM(config.lat, config.lon, lastAim.lat, lastAim.lon);
      if (Number.isFinite(ground) && ground >= 1) return Math.min(ground, 200000);
    }
    const range = lastAim?.range;
    if (Number.isFinite(range) && range >= 1) return Math.min(range, 200000);
    if (map && config) {
      try {
        const b = map.getBounds();
        const span = map.distance(b.getSouthWest(), b.getNorthEast());
        if (Number.isFinite(span) && span > 0) return Math.min(Math.max(span * 0.55, 500), 200000);
      } catch { /* fall through */ }
    }
    return 10000;
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
    map.on('zoomend moveend', () => draw(true));
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
      panInvert: false,
    };
    const nums = { lat: c.lat, lon: c.lon, alt: c.alt, magDeclination: c.magDeclination };
    if (!Object.values(nums).every(Number.isFinite) || Math.abs(c.lat) > 90 || Math.abs(c.lon) > 180 ||
        c.alt < 0 || c.alt > 10000 ||
        Math.abs(c.magDeclination) > 360) {
      throw Error('Enter valid coordinates, altitude, and mag declination.');
    }
    return c;
  }
  function saveConfig(next, note) {
    config = next;
    localStorage.setItem('tracker-device-location', JSON.stringify({
      lat: config.lat, lon: config.lon, alt: config.alt, panAlign: config.panAlign, magDeclination: config.magDeclination,
      panInvert: !!config.panInvert,
    }));
    el('device-latitude').value = config.lat;
    el('device-longitude').value = config.lon;
    el('device-altitude').value = config.alt;
    el('device-pan-align').value = config.panAlign;
    el('device-mag-declination').value = config.magDeclination;
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
    syncSearchToggles(localStorage.getItem('track-search') !== '0');
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
  async function onSearchToggle(fromOps) {
    if (searchToggleSyncing) return;
    const on = !!(fromOps ? el('track-search-ops') : el('track-search'))?.checked;
    syncSearchToggles(on);
    // Angle hold keeps search forced off for the session; don't fight it from the UI.
    if (trackMode === 'hold') {
      setStatus(`Spiral search ${on ? 'on' : 'off'} (applies after angle hold Stop)`);
      return;
    }
    try {
      await pushTrackSearch({ enabled: on });
      setStatus(`Spiral search ${on ? 'on' : 'off'}`);
    } catch (error) {
      setStatus(error.message);
    }
  }
  el('track-search')?.addEventListener('change', () => { onSearchToggle(false); });
  el('track-search-ops')?.addEventListener('change', () => { onSearchToggle(true); });
  el('track-search-gap').addEventListener('change', () => {
    pushTrackSearch().then((s) => setStatus(`Search gap ${s.gap.toFixed(1)} s`)).catch(error => setStatus(error.message));
  });
  el('track-search-speed').addEventListener('change', () => {
    pushTrackSearch().then(() => setStatus(`Search speed ${el('track-search-speed').valueAsNumber.toFixed(0)} °/s`)).catch(error => setStatus(error.message));
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
    const savedAdsbIcao = (localStorage.getItem('track-adsb-icao') || savedIcao || '').trim().toLowerCase();
    if (/^[0-9a-f]{6}$/.test(savedAdsbIcao) && el('track-adsb-icao')) el('track-adsb-icao').value = savedAdsbIcao;
    const savedAdsbInterval = parseFloat(localStorage.getItem('track-adsb-interval'));
    if (el('track-adsb-interval') && Number.isFinite(savedAdsbInterval)) {
      el('track-adsb-interval').value = String(Math.min(30, Math.max(0.25, savedAdsbInterval)));
    }
    const savedAdsbSource = localStorage.getItem('track-adsb-source');
    if (el('track-adsb-source') && (savedAdsbSource === 'json' || savedAdsbSource === 'sbs')) {
      el('track-adsb-source').value = savedAdsbSource;
    }
    let savedAdsbHost = (localStorage.getItem('track-adsb-host') || '').trim();
    let savedAdsbPort = parseFloat(localStorage.getItem('track-adsb-port'));
    // Migrate older full-URL saves → host/port fields.
    if (!savedAdsbHost) {
      const legacyUrl = localStorage.getItem('track-adsb-url') || '';
      const m = legacyUrl.match(/^https?:\/\/([^/:]+)(?::(\d+))?/i);
      if (m) {
        savedAdsbHost = m[1];
        if (!Number.isFinite(savedAdsbPort) && m[2]) savedAdsbPort = Number(m[2]);
      }
    }
    if (el('track-adsb-host')) el('track-adsb-host').value = savedAdsbHost || '127.0.0.1';
    if (el('track-adsb-port')) {
      el('track-adsb-port').value = String(Number.isFinite(savedAdsbPort) ? savedAdsbPort : 8080);
    }
    const savedAdsbSbs = localStorage.getItem('track-adsb-sbs');
    if (el('track-adsb-sbs') && savedAdsbSbs) el('track-adsb-sbs').value = savedAdsbSbs;
    if (el('track-adsb-poll')) el('track-adsb-poll').checked = false;
    syncAdsbSourceUi();
    // Prefer setup_env.py → local_defaults.json when the browser has no saved host yet.
    fetch('/api/local-defaults', { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) return;
      const body = await response.json().catch(() => ({}));
      if (!body || !body.ok) return;
      try {
        if (el('track-adsb-host') && body.adsb_host && !localStorage.getItem('track-adsb-host')) {
          el('track-adsb-host').value = String(body.adsb_host);
        }
        if (el('track-adsb-port') && Number.isFinite(Number(body.adsb_port)) && !localStorage.getItem('track-adsb-port')) {
          el('track-adsb-port').value = String(body.adsb_port);
        }
        if (el('track-adsb-interval') && Number.isFinite(Number(body.adsb_poll_interval))
            && localStorage.getItem('track-adsb-interval') == null) {
          el('track-adsb-interval').value = String(body.adsb_poll_interval);
        }
        if (el('opensky-client-id') && body.opensky_client_id
            && (!el('opensky-client-id').value || el('opensky-client-id').value === 'your-opensky-client-id')) {
          el('opensky-client-id').value = String(body.opensky_client_id);
        }
      } catch { /* ignore */ }
    }).catch(() => {});
    const savedSource = localStorage.getItem('track-source');
    const savedHoldAz = parseFloat(localStorage.getItem('track-hold-az'));
    const savedHoldEl = parseFloat(localStorage.getItem('track-hold-el'));
    const savedHoldRange = parseFloat(localStorage.getItem('track-hold-range'));
    if (el('track-hold-az') && Number.isFinite(savedHoldAz)) el('track-hold-az').value = String(savedHoldAz);
    if (el('track-hold-el') && Number.isFinite(savedHoldEl)) el('track-hold-el').value = String(savedHoldEl);
    if (el('track-hold-range') && Number.isFinite(savedHoldRange) && savedHoldRange >= 1) {
      el('track-hold-range').value = String(savedHoldRange);
    }
    if (savedSource === 'opensky') setTrackSource('opensky');
    else if (savedSource === 'playback') setTrackSource('playback');
    else if (savedSource === 'angles') setTrackSource('angles');
    else setTrackSource('adsb');
  } catch {
    setTrackSource('adsb');
  }
  document.querySelectorAll('[data-track-source]').forEach(btn => {
    btn.addEventListener('click', () => setTrackSource(btn.dataset.trackSource));
  });
  HOLD_INPUT_IDS.forEach(id => {
    const input = el(id);
    if (!input) return;
    // Preview while typing; retarget only on commit so Seed/loop can't stomp mid-edit.
    input.addEventListener('input', () => {
      refreshHoldPreview();
      try {
        const v = input.value;
        if (id === 'track-hold-az') localStorage.setItem('track-hold-az', v);
        else if (id === 'track-hold-el') localStorage.setItem('track-hold-el', v);
        else localStorage.setItem('track-hold-range', v);
      } catch { /* ignore */ }
    });
    input.addEventListener('change', () => {
      if (trackMode !== 'hold') return;
      // ignoreFocus: change often fires while the box still has focus.
      aimHoldFromInputs({ force: true, ignoreFocus: true }).catch(error => setStatus(error.message));
    });
  });
  el('track-hold-seed')?.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    try {
      seedHoldFromDish();
      setStatus('Copied dish az/el into the boxes. Click Update aim to point there.');
    } catch (error) {
      setStatus(error.message);
    }
  });
  el('track-hold-update')?.addEventListener('click', () => {
    updateAngleAim().catch(error => setStatus(error.message));
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
  el('track-adsb-source')?.addEventListener('change', () => {
    syncAdsbSourceUi();
    try { localStorage.setItem('track-adsb-source', el('track-adsb-source').value); } catch { /* ignore */ }
    if (el('track-adsb-poll')?.checked) {
      startAdsbFeed({ point: adsbPointing, clearTrail: false }).catch(error => {
        stopAdsbPoll({ note: `error: ${error.message}` });
        setStatus(error.message);
      });
    }
  });
  el('track-adsb-icao')?.addEventListener('change', () => {
    const v = (el('track-adsb-icao').value || '').trim().toLowerCase();
    try {
      if (/^[0-9a-f]{6}$/.test(v)) localStorage.setItem('track-adsb-icao', v);
      else if (!v) localStorage.removeItem('track-adsb-icao');
    } catch { /* ignore */ }
    if (el('track-adsb-poll')?.checked) {
      startAdsbFeed({ point: adsbPointing, clearTrail: false }).catch(error => {
        stopAdsbPoll({ note: `error: ${error.message}` });
        setStatus(error.message);
      });
    }
  });
  el('track-adsb-poll')?.addEventListener('change', () => {
    if (adsbPollSyncing) return;
    const on = !!el('track-adsb-poll').checked;
    if (on) {
      startAdsbFeed({ point: false, clearTrail: !adsbPointing }).catch(error => {
        syncAdsbPollUi(false);
        setStatus(error.message);
        appendAdsbLog(`error: ${error.message}`);
      });
    } else {
      stopAdsbPoll();
    }
  });
  el('track-adsb-interval')?.addEventListener('change', () => {
    const v = el('track-adsb-interval').valueAsNumber;
    try {
      if (Number.isFinite(v)) localStorage.setItem('track-adsb-interval', String(v));
    } catch { /* ignore */ }
    if (el('track-adsb-poll')?.checked) {
      startAdsbFeed({ point: adsbPointing, clearTrail: false }).catch(error => {
        stopAdsbPoll({ note: `error: ${error.message}` });
        setStatus(error.message);
      });
    }
  });
  function restartAdsbIfPolling() {
    if (!el('track-adsb-poll')?.checked) return;
    startAdsbFeed({ point: adsbPointing, clearTrail: false }).catch(error => {
      stopAdsbPoll({ note: `error: ${error.message}` });
      setStatus(error.message);
    });
  }
  el('track-adsb-host')?.addEventListener('change', () => {
    try { localStorage.setItem('track-adsb-host', (el('track-adsb-host').value || '').trim()); } catch { /* ignore */ }
    restartAdsbIfPolling();
  });
  el('track-adsb-port')?.addEventListener('change', () => {
    const p = el('track-adsb-port').valueAsNumber;
    try {
      if (Number.isFinite(p)) localStorage.setItem('track-adsb-port', String(p));
    } catch { /* ignore */ }
    restartAdsbIfPolling();
  });
  el('track-adsb-sbs')?.addEventListener('change', () => {
    try { localStorage.setItem('track-adsb-sbs', el('track-adsb-sbs').value || ''); } catch { /* ignore */ }
    restartAdsbIfPolling();
  });
  el('track-opensky-log-clear')?.addEventListener('click', () => {
    const log = el('track-opensky-log');
    if (!log) return;
    log.dataset.empty = '1';
    log.textContent = 'Waiting for OpenSky polls…';
    lastLoggedSimKey = '';
  });
  el('track-adsb-log-clear')?.addEventListener('click', () => {
    const log = el('track-adsb-log');
    if (!log) return;
    log.dataset.empty = '1';
    log.textContent = 'Waiting for local ADS-B…';
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
  /** Shared by Track Stop, Tune STOP, Tune Apply (gain edits), and auto-stop. */
  function stopTrackingUi({ silent = false, panOff = true } = {}) {
    const keepOpensky = trackSource === 'opensky' && !!el('track-opensky-poll')?.checked;
    const keepAdsb = trackSource === 'adsb' && !!el('track-adsb-poll')?.checked;
    const wasOpenskyPointing = openskyPointing;
    const wasAdsbPointing = adsbPointing;
    const wasHold = trackMode === 'hold';
    const wasLive = wasHold || wasOpenskyPointing || wasAdsbPointing || trackMode === 'sim';
    stopTrack(true);
    setMode('off');
    openskyPointing = false;
    adsbPointing = false;
    lastHoldAimKey = '';
    refreshStartLabel();
    // Same Stop on Tune: clear mag corrector / settle watch and force PAN OFF.
    if (panOff && typeof panTune !== 'undefined') panTune.stopMotion?.();
    // Restore Advanced search prefs after hold / live-feed gap override.
    if (wasHold || wasOpenskyPointing || wasAdsbPointing) {
      pushTrackSearch().catch(() => {});
    }
    if (keepAdsb) {
      startAdsbFeed({ point: false, clearTrail: false }).then(() => {
        if (!silent) {
          setStatus(wasAdsbPointing ? 'Pointing stopped — still polling ADS-B (observe).' : 'ADS-B observe running.');
        }
      }).catch(error => {
        syncAdsbPollUi(false);
        if (!silent) setStatus(error.message);
      });
    } else if (keepOpensky) {
      // Drop back to observe-only so Poll stays on without pointing.
      startOpenskyFeed({ point: false, clearTrail: false }).then(() => {
        if (!silent) {
          setStatus(wasOpenskyPointing ? 'Pointing stopped — still polling OpenSky (observe).' : 'OpenSky observe running.');
        }
      }).catch(error => {
        syncOpenskyPollUi(false);
        if (!silent) setStatus(error.message);
      });
    } else {
      syncOpenskyPollUi(false);
      syncAdsbPollUi(false);
      if (!silent) setStatus('Stopped — axes OFF queued.');
    }
    return wasLive;
  }
  el('track-stop').addEventListener('click', () => stopTrackingUi());
  try {
    const saved = JSON.parse(localStorage.getItem('tracker-device-location'));
    if (saved) {
      const panAlign = Number.isFinite(saved.panAlign) ? saved.panAlign : 0;
      el('device-latitude').value = saved.lat;
      el('device-longitude').value = saved.lon;
      el('device-altitude').value = Number.isFinite(saved.alt) ? saved.alt : 0;
      el('device-pan-align').value = panAlign;
      el('device-mag-declination').value = Number.isFinite(saved.magDeclination) ? saved.magDeclination : (Number.isFinite(saved.offset) ? saved.offset : 0);
      el('device-pan-invert').checked = !!saved.panInvert;
      config = read();
      alignReady = true; // Mag track needs site + decl only; pot align retired.
      el('device-location-status').textContent =
        `Device location: ${config.lat.toFixed(6)}, ${config.lon.toFixed(6)} · alt ${config.alt.toFixed(1)} m AGL · decl ${config.magDeclination}° · Mag track · saved`;
    }
  } catch { config = null; }
  setWorkspaceView('track');
  return {
    update(value, magIsStale, tiltAngle = null, targetAngle = null, panDeg = null, panCmd = null, linkIsStale = magIsStale, feedback = null, potVolts = null) {
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
      tiltPotV = Number.isFinite(potVolts) ? potVolts : null;
      refreshArmChip();
      // While Track is hidden, skip draw entirely — Advanced/Tune poll was driving Leaflet for nothing.
      if (!panel.hidden) draw();
    },
    applyRelaySim,
    seedAlignFromMag,
    destination,
    setWorkspaceView,
    stopTrackingUi,
  };
})();
