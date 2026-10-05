'use strict';
const $ = id => document.getElementById(id);
const colors = ['#61e2bd', '#69adff', '#f0b76b'];
const channelColors = ['#61e2bd', '#69adff', '#f0b76b', '#e886e8', '#ff7878', '#b5ce63', '#66d9ef', '#c5a1ff', '#f7d154', '#ff9cb3', '#85c9a7', '#a9bfff', '#f59f62', '#d1b88b', '#b1e4f3', '#e0a6ca'];
let recordingBusy = false;
for (const action of ['start', 'stop']) $('record-' + action).addEventListener('click', async () => {
  recordingBusy = true; render();
  try {
    const result = await api('/api/recording/' + action, action === 'start' ? {scaling: channelScaling} : {});
    state.recording = result;
    $('record-message').textContent = action === 'start' ? 'Recording started. Live viewing continues.' : 'CSV saved. Live viewing continues.';
  } catch (error) { $('record-message').textContent = error.message; }
  finally { recordingBusy = false; render(); }
});
// 2.5 V reference, with ADC_DOUBLE_RANGE enabled in the firmware.
const ADC_FULL_SCALE = 5.0;
const adcToVolts = raw => raw == null ? null : raw * ADC_FULL_SCALE / 4096;
let channelScaling = structuredClone(CHANNEL_SCALING_DEFAULTS);
const validScaling = rows => Array.isArray(rows) && rows.length === 16 && rows.every(row =>
  row && Number.isFinite(row.m) && Number.isFinite(row.b) && typeof row.unit === 'string' && row.unit.length <= 12 &&
  Number.isFinite(row.m * ADC_FULL_SCALE + row.b));
try {
  const saved = JSON.parse(localStorage.getItem('adc-channel-scaling'));
  if (validScaling(saved)) channelScaling = saved;
} catch { /* Use file defaults if storage is unavailable or invalid. */ }
const scaledAdc = (raw, channel) => raw == null ? null : adcToVolts(raw) * channelScaling[channel].m + channelScaling[channel].b;
function fillScalingFields() {
  for (let i = 0; i < 16; i++) {
    for (const key of ['m', 'b', 'unit']) $(`scaling-${i}-${key}`).value = channelScaling[i][key];
  }
}
for (let i = 0; i < 16; i++) {
  const row = document.createElement('div');
  row.className = 'scaling-row';
  row.innerHTML = `<strong>CH ${i}</strong><label>m<input id="scaling-${i}-m" type="number" step="any" required></label><label>b<input id="scaling-${i}-b" type="number" step="any" required></label><label>Unit<input id="scaling-${i}-unit" maxlength="12"></label>`;
  $('scaling-fields').append(row);
}
fillScalingFields();
$('scaling-form').addEventListener('submit', event => {
  event.preventDefault();
  const rows = Array.from({length: 16}, (_, i) => ({
    m: $(`scaling-${i}-m`).valueAsNumber, b: $(`scaling-${i}-b`).valueAsNumber,
    unit: $(`scaling-${i}-unit`).value.trim()
  }));
  if (!validScaling(rows)) { $('scaling-message').textContent = 'Enter finite slopes and offsets for all channels.'; return; }
  channelScaling = rows;
  try {
    localStorage.setItem('adc-channel-scaling', JSON.stringify(rows));
    $('scaling-message').textContent = 'Scaling applied and saved in this browser.';
  } catch { $('scaling-message').textContent = 'Scaling applied for this page; browser storage is unavailable.'; }
  render();
});
$('scaling-reset').addEventListener('click', () => {
  channelScaling = structuredClone(CHANNEL_SCALING_DEFAULTS);
  try { localStorage.removeItem('adc-channel-scaling'); } catch { /* Storage unavailable. */ }
  fillScalingFields(); render();
  $('scaling-message').textContent = 'File defaults restored.';
});
let samples = [], logs = [], cursor = 0, session = -1, state = null, busy = false, relayUp = false;
let selectedChannel = 0;
let diagnosticBusy = false, diagnosticRequested = null;
$('adc-diagnostic-form').addEventListener('submit', async event => {
  event.preventDefault();
  const channel = Number($('adc-diagnostic-channel').value);
  diagnosticBusy = true; diagnosticRequested = channel; render();
  try {
    await api('/api/adc-channel', {channel});
    $('adc-diagnostic-message').textContent = 'Selection queued; waiting for board confirmation.';
    if (channel >= 0) {
      selectedChannel = channel; $('adc-channel').value = channel;
      selectedTraces.clear(); selectedTraces.add(channel); saveTraces();
    }
  } catch (error) { diagnosticRequested = null; $('adc-diagnostic-message').textContent = error.message; }
  finally { diagnosticBusy = false; render(); }
});
const selectedTraces = new Set([0]);
try {
  const saved = JSON.parse(localStorage.getItem('adc-graph-traces'));
  if (Array.isArray(saved) && saved.every(i => Number.isInteger(i) && i >= 0 && i < 16)) {
    selectedTraces.clear(); saved.forEach(i => selectedTraces.add(i));
  }
} catch {}
const hiddenAxes = {feedback: new Set(), accel: new Set(), gyro: new Set(), mag: new Set()};
function saveTraces() {
  try { localStorage.setItem('adc-graph-traces', JSON.stringify([...selectedTraces])); } catch {}
}
function traceButton(parent, label, color, checked, toggle) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'trace-toggle'; button.style.setProperty('--trace-color', color);
  button.innerHTML = '<span class="trace-swatch" aria-hidden="true"></span><span></span>';
  button.lastElementChild.textContent = label;
  button.setAttribute('aria-pressed', String(checked));
  button.addEventListener('click', toggle); parent.append(button);
  return button;
}
let pendingConnection = null;
const rememberedPorts = {};
try {
  for (const mode of ['remote', 'direct']) {
    const port = localStorage.getItem(`adc-last-port-${mode}`);
    if (port && port.length <= 250) rememberedPorts[mode] = port;
  }
} catch { /* Port memory remains available for this page. */ }
const fmt = value => Number.isFinite(value) ? value.toFixed(3) : '—';
const gpioLabels = {46: 'Servo power good', 4: 'Hall C', 13: 'Hall B', 14: 'Hall A'};
const servoPresets = {};
try { Object.assign(servoPresets, JSON.parse(localStorage.getItem('servo-ui-presets') || '{}')); } catch {}
function presetsFor(axis, config) {
  const defaults = {min: config.umin ?? config.pmin, center: config.ucenter ?? (axis === 'TILT' && config.pmin <= 2400 && config.pmax >= 2400 ? 2400 : config.pcenter), max: config.umax ?? config.pmax};
  const saved = servoPresets[axis];
  return validPresets(saved, config) ? saved : defaults;
}
function validPresets(values, config) {
  return values && ['min', 'center', 'max'].every(key => Number.isInteger(values[key])) &&
    config.pmin <= values.min && values.min <= values.center && values.center <= values.max && values.max <= config.pmax;
}
for (const [axis, pin] of [['PAN', 1], ['TILT', 2], ['S3', 3]]) {
  const form = document.createElement('form'); form.id = `servo-${axis}`; form.className = 'servo-form';
  form.innerHTML = `<strong>${axis} · GPIO ${pin} · A${pin - 1}/D${pin + 16}</strong><div class="servo-fields"><label>Pulse width (µs)<input id="servo-${axis}-pulse" type="number" step="1" required disabled></label><label>Frequency (Hz)<input id="servo-${axis}-frequency" type="number" step="1" required disabled></label></div><div class="buttons"><button type="submit" disabled>Command</button><button type="button" data-off class="secondary" disabled>Off</button>${['min','center','max'].map(key => `<button type="button" data-preset="${key}" class="secondary" disabled>${key.charAt(0).toUpperCase() + key.slice(1)}</button>`).join('')}</div><p id="servo-${axis}-reported">Waiting for servo telemetry</p><p id="servo-${axis}-command" role="status"></p>`;
  $('servo-controls').append(form);
  const settings = document.createElement('details');
  settings.innerHTML = `<summary>Button presets (µs)</summary><div class="servo-fields">${['min','center','max'].map(key => `<label>${key}<input data-setting="${key}" type="number" step="1"></label>`).join('')}</div><div class="buttons"><button type="button" data-save-presets>Save presets</button><button type="button" data-reset-presets>Reset presets</button></div><p data-preset-status role="status">Presets fill fields; click Command to move. Absolute limits still apply.</p>`;
  form.append(settings);
  settings.querySelector('[data-save-presets]').addEventListener('click', () => {
    const config = state?.latest?.servos?.[axis];
    if (!config) return;
    const values = Object.fromEntries([...settings.querySelectorAll('[data-setting]')].map(input => [input.dataset.setting, input.valueAsNumber]));
    if (!validPresets(values, config)) {
      settings.querySelector('[data-preset-status]').textContent = `Use ${config.pmin} ≤ Min ≤ Center ≤ Max ≤ ${config.pmax} µs.`;
      return;
    }
    servoPresets[axis] = values;
    try { localStorage.setItem('servo-ui-presets', JSON.stringify(servoPresets)); } catch {}
    settings.querySelector('[data-preset-status]').textContent = 'Presets saved in this browser. No movement commanded.';
    render();
  });
  settings.querySelector('[data-reset-presets]').addEventListener('click', () => {
    delete servoPresets[axis];
    try { localStorage.setItem('servo-ui-presets', JSON.stringify(servoPresets)); } catch {}
    delete settings.dataset.config;
    settings.querySelector('[data-preset-status]').textContent = 'Defaults restored. No movement commanded.';
    render();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    sendServo({axis, pulse: $(`servo-${axis}-pulse`).valueAsNumber, frequency: $(`servo-${axis}-frequency`).valueAsNumber});
  });
  form.querySelector('[data-off]').addEventListener('click', () => sendServo({axis, off: true}));
  for (const button of form.querySelectorAll('[data-preset]')) button.addEventListener('click', () => {
    const config = (samples.at(-1) || state?.latest)?.servos?.[axis];
    if (!config) return;
    $(`servo-${axis}-pulse`).value = presetsFor(axis, config)[button.dataset.preset];
    $(`servo-${axis}-frequency`).value = config[`f${button.dataset.preset}`];
  });
}
let servoBusy = false;
let lastServoAxis = null;
let safetyBusy = false;
for (const [id, action] of [['servo-enable', 'ENABLE'], ['servo-disable', 'DISABLE'], ['servo-estop', 'ESTOP'], ['servo-clear', 'CLEAR']]) {
  $(id).addEventListener('click', async () => {
    safetyBusy = true; render();
    try {
      await api('/api/servo-safety', {action});
      $('servo-safety-message').textContent = `${action} queued; waiting for board confirmation`;
    } catch (error) { $('servo-safety-message').textContent = error.message; }
    finally { safetyBusy = false; render(); }
  });
}
let rangesBusy = false, rangeSignature = '';
$('ranges-form').addEventListener('submit', async event => {
  event.preventDefault(); rangesBusy = true; render();
  try {
    const result = await api('/api/ranges', {accel: Number($('accel-range').value), gyro: Number($('gyro-range').value)});
    $('ranges-message').textContent = result.message;
  } catch (error) { $('ranges-message').textContent = error.message; }
  finally { rangesBusy = false; render(); }
});
async function sendServo(command) {
  lastServoAxis = command.axis;
  servoBusy = true; render();
  try {
    const result = await api('/api/servo', command);
    $('servo-message').textContent = `${command.axis}: ${result.message}`;
  } catch (error) { $('servo-message').textContent = error.message; }
  finally { servoBusy = false; render(); }
}
for (const pin of [46, 4, 13, 14]) {
  const card = document.createElement('div');
  card.className = 'gpio-card'; card.id = `gpio-${pin}`;
  card.innerHTML = `<small>GPIO ${pin} · ${gpioLabels[pin]}</small><strong>—</strong>`;
  $('gpio-grid').append(card);
}

for (let i = 0; i < 16; i++) {
  const card = document.createElement('button');
  card.className = 'adc-card'; card.type = 'button'; card.id = `ch${i}`;
  card.innerHTML = `<span class="adc-top"><span>CH ${String(i).padStart(2, '0')}</span><span>RAW</span></span><span class="adc-number">—</span><progress class="adc-bar" max="4095" value="0" aria-label="Channel ${i} level"></progress>`;
  if (CHANNEL_LABELS[i]) {
    const label = document.createElement('span');
    label.className = 'adc-label'; label.textContent = CHANNEL_LABELS[i];
    card.querySelector('.adc-top').after(label);
  }
  const toggle = () => {
    selectedChannel = i; $('adc-channel').value = i;
    if (selectedTraces.has(i)) selectedTraces.delete(i); else selectedTraces.add(i);
    saveTraces(); render();
  };
  card.addEventListener('click', toggle);
  const legend = traceButton($('adc-legend'), `CH${i}`, channelColors[i], selectedTraces.has(i), toggle);
  legend.id = `trace-ch${i}`;
  $('adc-grid').append(card);
  $('adc-channel').add(new Option(`CH ${i}${CHANNEL_LABELS[i] ? ' · ' + CHANNEL_LABELS[i] : ''}`, i));
  $('adc-diagnostic-channel').add(new Option(`CH ${i}${CHANNEL_LABELS[i] ? ' · ' + CHANNEL_LABELS[i] : ''}`, i));
}
for (const key of ['feedback', 'accel', 'gyro', 'mag']) {
  const legend = document.createElement('div'); legend.id = `${key}-legend`; legend.className = 'trace-legend';
  $(`${key}-chart`).before(legend);
  if (key === 'feedback') document.querySelector('.feedback-legend').remove();
  const labels = key === 'feedback' ? ['S3 FB · CH5', 'PAN FB · CH6', 'TILT FB · CH7'] : ['X', 'Y', 'Z'];
  labels.forEach((label, axis) => traceButton(legend, label, key === 'feedback' ? channelColors[axis + 5] : colors[axis], true, () => {
    if (hiddenAxes[key].has(axis)) hiddenAxes[key].delete(axis); else hiddenAxes[key].add(axis);
    render();
  }));
}
for (const key of ['accel', 'gyro', 'mag']) {
  for (const axis of ['X', 'Y', 'Z']) {
    const el = document.createElement('div');
    el.innerHTML = `<small>${axis}</small><strong>—</strong>`;
    $(`${key}-values`).append(el);
  }
}

function sourceChanged() {
  const mode = $('mode').value;
  $('agent-field').hidden = mode !== 'remote'; $('agent').required = mode === 'remote';
  for (const id of ['port-field', 'baud-field', 'find']) $(id).hidden = mode === 'demo';
  $('port').required = mode !== 'demo';
  $('source-hint').textContent = {
    remote: 'Connect through your running PlatformIO agent. Close any other monitor using the same port.',
    direct: 'Connect the Nano by USB to this computer. Close PlatformIO Serial Monitor before connecting.',
    demo: 'Simulated data for exploring the dashboard. No hardware or remote agent is used.'
  }[mode];
  $('port').value = rememberedPorts[mode] || ''; $('ports').replaceChildren(); $('notice').textContent = '';
}
$('mode').addEventListener('change', sourceChanged);
$('adc-channel').addEventListener('change', () => {
  selectedChannel = Number($('adc-channel').value); selectedTraces.clear(); selectedTraces.add(selectedChannel); saveTraces(); render();
});
$('adc-units').addEventListener('change', render);
$('window').addEventListener('change', render);
sourceChanged();

async function api(path, data) {
  const response = await fetch(path, { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || response.statusText);
  return result;
}
function options() { return {mode: $('mode').value, agent: $('agent').value, port: $('port').value, baud: Number($('baud').value)}; }
function updateButtons() {
  const active = state && ['connected', 'connecting'].includes(state.status);
  $('connect').disabled = busy || active || !relayUp;
  $('disconnect').disabled = busy || !relayUp || !state || state.status === 'disconnected';
  for (const id of ['mode', 'agent', 'port', 'baud', 'find']) $(id).disabled = busy || active || !relayUp;
  $('export').disabled = !samples.length;
}
async function action(fn) {
  busy = true; $('notice').textContent = ''; updateButtons();
  try { await fn(); } catch (error) { $('notice').textContent = error.message; }
  finally { busy = false; updateButtons(); }
}
$('connection-form').addEventListener('submit', event => {
  event.preventDefault();
  action(async () => {
    const connection = options();
    await api('/api/connect', connection);
    pendingConnection = connection.mode === 'demo' ? null : connection;
    state = {...state, status: 'connecting', message: 'Opening source…'};
  });
});
$('disconnect').addEventListener('click', () => action(async () => {
  await api('/api/disconnect', {});
  state = {...state, status: 'disconnected', message: 'Disconnected'};
}));
$('find').addEventListener('click', () => action(async () => {
  $('notice').textContent = 'Looking for serial ports…';
  const {ports} = await api('/api/ports', options());
  $('ports').replaceChildren();
  for (const p of ports) $('ports').append(new Option(`${p.port} — ${p.description}`, p.port));
  if (ports.length === 1) $('port').value = ports[0].port;
  $('notice').textContent = ports.length ? `Found ${ports.length} port(s): ${ports.map(p => p.port).join(', ')}. Select one in Serial port.` : 'No ports found. Check the USB cable and remote agent.';
}));

async function poll() {
  try {
    const response = await fetch(`/api/state?since=${cursor}`, {cache: 'no-store'});
    if (!response.ok) throw new Error('Relay unavailable');
    const next = await response.json();
    if (next.cursor < cursor) {
      samples = []; logs = []; cursor = 0; session = -1;
      // Fetch the restarted server's complete buffer on the next poll.
      state = next; relayUp = true; render();
      return;
    }
    if (next.session !== session) {
      samples = []; logs = []; session = next.session;
    }
    state = next; relayUp = true;
    if (pendingConnection && next.status === 'connected' && next.mode === pendingConnection.mode) {
      const {mode, port} = pendingConnection;
      rememberedPorts[mode] = port.trim();
      try { localStorage.setItem(`adc-last-port-${mode}`, port.trim()); } catch { /* Storage unavailable. */ }
      pendingConnection = null;
    } else if (['error', 'disconnected'].includes(next.status)) {
      pendingConnection = null;
    }
    samples.push(...next.samples); samples = samples.slice(-10000);
    logs.push(...next.logs.map(line => line.text)); logs = logs.slice(-400);
    cursor = next.cursor;
    $('log').textContent = logs.length ? logs.join('\n') : 'Waiting for serial output…';
    if ($('follow').checked) $('log').scrollTop = $('log').scrollHeight;
    render();
  } catch (error) {
    relayUp = false; $('status').textContent = 'Relay offline'; $('status').className = 'badge warn';
    $('connection-message').textContent = 'Cannot reach the local relay. Restart start-dashboard.ps1; this page will reconnect.';
    document.body.classList.add('stale');
  } finally {
    updateButtons();
    setTimeout(poll, 40);
  }
}

function render() {
  const recording = state?.recording;
  $('record-start').disabled = !relayUp || recordingBusy || recording?.active || recording?.finishing || state?.status !== 'connected';
  $('record-stop').disabled = !relayUp || recordingBusy || !(recording?.active || recording?.finishing);
  $('record-status').textContent = recording?.error || (recording?.filename ?
    `${recording.active ? 'Recording' : recording.finishing ? 'Finishing' : 'Saved'} ${Number(recording.rows).toLocaleString()} rows · ${recording.path}` : 'Live viewing continues with recording off.');
  $('record-download').hidden = !recording?.filename || recording.active || recording.finishing;
  if (recording?.filename) $('record-download').href = `/api/recording/download?file=${encodeURIComponent(recording.filename)}`;
  const rawMode = $('adc-units').value === 'raw';
  const scaling = channelScaling[selectedChannel];
  $('adc-range').textContent = rawMode ? '12-bit · 0–4095 counts' : `0–${ADC_FULL_SCALE} V input · y = m × volts + b · CH ${selectedChannel}: ${scaling.unit || 'scaled value'}`;
  const latest = samples.at(-1) || state?.latest;
  const age = latest ? Math.max(0, Date.now() / 1000 - latest.received_at) : Infinity;
  const stale = !relayUp || state?.status !== 'connected' || age > 3;
  const safety = state?.servo_safety;
  const safetyFresh = safety && Date.now() / 1000 - safety.received_at <= 3;
  const connected = relayUp && state?.status === 'connected';
  const safetyPending = state?.safety_command && ['queued', 'sent', 'timeout'].includes(state.safety_command.state);
  $('servo-enable').disabled = !connected || !safetyFresh || safetyBusy || safetyPending || !!safety?.estop || !!safety?.armed;
  $('servo-clear').disabled = !connected || !safetyFresh || safetyBusy || safetyPending || !safety?.estop;
  $('servo-disable').disabled = !connected;
  $('servo-estop').disabled = !connected;
  $('servo-safety-state').textContent = !safetyFresh ? 'Servo state unconfirmed' : safety.estop ? 'E-STOP LATCHED · all PWM off' : safety.armed ? 'Enabled · commands allowed' : 'Disabled · all PWM off';
  $('servo-safety-state').classList.toggle('stopped', !!safety?.estop);
  if (state?.safety_command) $('servo-safety-message').textContent = state.safety_command.message;
  document.body.classList.toggle('stale', stale);
  const ranges = latest?.ranges;
  for (const id of ['accel-range', 'gyro-range', 'apply-ranges']) $(id).disabled = stale || busy || rangesBusy || ranges?.ready !== 1;
  if (ranges) {
    const signature = JSON.stringify([session, ranges.accel, ranges.gyro]);
    if (signature !== rangeSignature) {
      $('accel-range').value = ranges.accel; $('gyro-range').value = ranges.gyro; rangeSignature = signature;
    }
    $('ranges-reported').textContent = `${stale ? 'Last reported' : 'Reported'}: acceleration ±${ranges.accel} g · gyro ±${ranges.gyro} °/s · BMM350 ±${ranges.mag} µT${ranges.ready ? '' : ' · BMI323 unavailable'}`;
  } else $('ranges-reported').textContent = 'Waiting for range telemetry (updated firmware required)';
  const rates = latest?.rates, acquisition = state?.acquisition;
  $('acquisition-status').textContent = rates ?
    `ADC: ${rates.adc.toLocaleString()} scans/s per channel · received: ${(acquisition?.received_hz || 0).toLocaleString()} scans/s · BMI323: ${rates.bmi.toLocaleString()} reads/s · BMM350: ${rates.mag.toLocaleString()} read attempts/s · missed ticks: ${rates.missed} · buffer drops: ${rates.drops} · invalid scans: ${rates.invalid} · max scan: ${rates.maxscan} µs · received gaps: ${acquisition?.sequence_gaps || 0} · corrupt packets: ${acquisition?.corrupt_packets || 0}` :
    state?.mode === 'demo' ? 'Demo data · hardware sampling rates unavailable' : 'Waiting for acquisition statistics';
  for (const axis of ['PAN', 'TILT', 'S3']) {
    $(`servo-${axis}-command`).textContent = state?.servo_commands?.[axis]?.message || '';
    if (axis === lastServoAxis && state?.servo_commands?.[axis]) $('servo-message').textContent = `${axis}: ${state.servo_commands[axis].message}`;
    const form = $(`servo-${axis}`), config = latest?.servos?.[axis];
    const available = !busy && !servoBusy && !stale && safetyFresh && safety.armed && !safety.estop && !state?.servo_inhibit && config?.ready === 1;
    for (const control of form.querySelectorAll('button, input')) control.disabled = control.closest('details') ? !config : control.hasAttribute('data-off') ? !connected : !available;
    if (config) {
      const signature = JSON.stringify([session, config.pmin, config.pcenter, config.pmax, config.fmin, config.fcenter, config.fmax, config.umin, config.ucenter, config.umax]);
      for (const [key, prefix] of [['pulse', 'p'], ['frequency', 'f']]) {
        const input = $(`servo-${axis}-${key}`);
        input.min = config[`${prefix}min`]; input.max = config[`${prefix}max`];
        if (form.dataset.config !== signature) input.value = prefix === 'p' ? presetsFor(axis, config).center : config.fcenter;
      }
      form.dataset.config = signature;
      const settings = form.querySelector('details'), presets = presetsFor(axis, config);
      const presetSignature = JSON.stringify([session, config.pmin, config.pmax, presets]);
      if (settings.dataset.config !== presetSignature) {
        for (const input of settings.querySelectorAll('[data-setting]')) {
          input.min = config.pmin; input.max = config.pmax; input.value = presets[input.dataset.setting];
        }
        settings.dataset.config = presetSignature;
      }
      for (const button of form.querySelectorAll('[data-preset]')) button.title = `${presets[button.dataset.preset]} µs`;
      $(`servo-${axis}-reported`).textContent = config.ready !== 1 ? 'PWM output unavailable' :
        `${stale ? 'Last reported: ' : 'Reported: '}${config.enable ? `${config.pulse} µs at ${config.freq} Hz` : 'OFF'}`;
    } else $(`servo-${axis}-reported`).textContent = 'Waiting for servo telemetry (updated firmware required)';
  }
  if (state && relayUp) {
    let label = state.status === 'connected' ? (age > 3 ? 'Waiting for data' : 'Live') : state.status;
    if (state.mode === 'demo') label = `DEMO · ${label}`;
    $('status').textContent = label.charAt(0).toUpperCase() + label.slice(1);
    $('status').className = `badge ${state.status === 'error' || (state.status === 'connected' && age > 3) ? 'warn' : stale ? '' : 'live'}`;
    $('connection-message').textContent = state.message;
  }
  $('freshness').textContent = latest ? `Last sample ${age.toFixed(1)}s ago${stale ? ' · retained value' : ''}` : 'No samples received';
  $('sample-count').textContent = `${samples.length.toLocaleString()} buffered samples`;
  $('uptime').textContent = latest ? `Device time ${(latest.device_ms / 1000).toFixed(1)} s` : 'Device time —';
  for (const pin of [46, 4, 13, 14]) {
    const value = latest?.gpio?.[pin], card = $(`gpio-${pin}`);
    card.querySelector('strong').textContent = value === 1 ? 'HIGH (1)' : value === 0 ? 'LOW (0)' : '—';
    card.classList.toggle('high', value === 1);
  }
  for (let i = 0; i < 16; i++) {
    const card = $(`ch${i}`), value = latest?.adc[i];
    const inactive = latest?.adc_mode?.channel >= 0 && latest.adc_mode.channel !== i;
    card.classList.toggle('selected', selectedTraces.has(i));
    card.classList.toggle('invalid', !!latest && value == null);
    card.setAttribute('aria-pressed', String(selectedTraces.has(i)));
    const legend = $(`trace-ch${i}`);
    legend.setAttribute('aria-pressed', String(selectedTraces.has(i)));
    const shown = rawMode ? value : scaledAdc(value, i);
    legend.lastElementChild.textContent = `CH${i}${CHANNEL_LABELS[i] ? ' · ' + CHANNEL_LABELS[i] : ''} · ${fmt(shown)} ${rawMode ? 'counts' : channelScaling[i].unit || 'scaled'}`;
    card.querySelector('.adc-top span:last-child').textContent = rawMode ? 'RAW' : channelScaling[i].unit;
    card.querySelector('.adc-number').textContent = inactive ? 'OFF' : value == null ? (latest ? 'ERR' : '—') : rawMode ? value : scaledAdc(value, i).toFixed(3);
    card.querySelector('progress').value = value ?? 0;
  }
  for (const key of ['accel', 'gyro', 'mag']) {
    [...$(`${key}-values`).querySelectorAll('strong')].forEach((el, i) => {el.textContent = fmt(latest?.[key]?.[i]);});
  }
  const errors = latest ? [...latest.errors] : [];
  const adcMode = latest?.adc_mode;
  $('adc-diagnostic-apply').disabled = stale || busy || diagnosticBusy || !adcMode;
  $('adc-diagnostic-channel').disabled = stale || busy || diagnosticBusy || !adcMode;
  if (adcMode) {
    const channel = adcMode.channel, raw = channel >= 0 ? latest.adc[channel] : null;
    $('adc-diagnostic-reported').textContent = channel < 0 ? 'Reported: normal scan · all channels' :
      `Reported: CH${channel} only · ${raw ?? 'ERR'} counts · ${fmt(adcToVolts(raw))} V at ADC input · SPI ${(adcMode.spi / 1e6).toFixed(1)} MHz`;
    if (diagnosticRequested === channel) {
      $('adc-diagnostic-message').textContent = 'Board confirmed ADC selection.'; diagnosticRequested = null;
    }
  } else $('adc-diagnostic-reported').textContent = 'Waiting for ADC mode telemetry (updated firmware required)';
  if (latest) {
    for (const key of ['accel', 'gyro', 'mag']) if (!latest[key]) errors.push(`${key}: no valid reading in this sample`);
    if (latest.adc.some((v, i) => v == null && (adcMode?.channel == null || adcMode.channel < 0 || adcMode.channel === i))) errors.push('ADC: one or more channels missing or invalid');
  }
  $('sensor-errors').textContent = errors.join(' · ');
  $('adc-chart').setAttribute('aria-label', `ADC traces ${[...selectedTraces].map(i => 'CH' + i).join(', ') || 'none'} over time`);
  for (const key of ['feedback', 'accel', 'gyro', 'mag']) {
    [...$(`${key}-legend`).children].forEach((button, axis) => button.setAttribute('aria-pressed', String(!hiddenAxes[key].has(axis))));
  }
  $('feedback-units').textContent = rawMode ? 'Raw counts' : [5, 6, 7].map(channel => `CH${channel}: ${channelScaling[channel].unit || 'scaled'}`).join(' · ');
}

function renderCharts() {
  const rawMode = $('adc-units').value === 'raw';
  for (const key of ['accel', 'gyro', 'mag']) {
    const axes = [0, 1, 2].filter(axis => !hiddenAxes[key].has(axis));
    chart(`${key}-chart`, sample => axes.map(axis => sample[key]?.[axis] ?? null), axes.length, undefined, undefined, undefined, axes.map(axis => colors[axis]));
  }
  const value = (sample, channel) => sample.adc_mean?.[channel] ?? sample.adc[channel];
  const bounds = (sample, channel) => [sample.adc_min?.[channel] ?? sample.adc[channel], sample.adc_max?.[channel] ?? sample.adc[channel]]
    .map(value => rawMode ? value : scaledAdc(value, channel));
  const channels = [...selectedTraces].sort((a, b) => a - b);
  chart('adc-chart', sample => channels.map(channel => rawMode ? value(sample, channel) : scaledAdc(value(sample, channel), channel)), channels.length, undefined, undefined, sample => channels.map(channel => bounds(sample, channel)), channels.map(channel => channelColors[channel]));
  const feedback = [5, 6, 7].filter((channel, axis) => !hiddenAxes.feedback.has(axis));
  chart('feedback-chart', sample => feedback.map(channel => rawMode ? value(sample, channel) : scaledAdc(value(sample, channel), channel)), feedback.length, undefined, undefined, sample => feedback.map(channel => bounds(sample, channel)), feedback.map(channel => channelColors[channel]));
}

function chart(id, getValues, axes, fixedRange, decimals = fixedRange ? 0 : 1, getBounds, traceColors = colors) {
  const canvas = $(id), box = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const width = box.width, height = box.height;
  if (!width) return;
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const pad = {left: 48, right: 12, top: 14, bottom: 25};
  const w = width - pad.left - pad.right, h = height - pad.top - pad.bottom;
  const stamp = sample => sample.device_us != null && state?.acquisition?.clock_offset != null ?
    sample.device_us / 1e6 + state.acquisition.clock_offset : sample.plot_at ?? sample.received_at;
  const last = samples.length ? stamp(samples.at(-1)) : Date.now() / 1000;
  const end = Math.min(last, Date.now() / 1000 - .2), span = Number($('window').value);
  const visible = samples.filter(s => stamp(s) >= end - span && stamp(s) <= end);
  const values = visible.flatMap(sample => getBounds ? getBounds(sample).flat() : getValues(sample)).filter(Number.isFinite);
  let low = fixedRange?.[0] ?? 0, high = fixedRange?.[1] ?? 0;
  if (!fixedRange) for (const value of values) { low = Math.min(low, value); high = Math.max(high, value); }
  const autoAdc = ['adc-chart', 'feedback-chart'].includes(id) && !fixedRange;
  if (autoAdc && values.length) {
    low = high = values[0];
    for (const value of values) { low = Math.min(low, value); high = Math.max(high, value); }
  }
  if (low === high) {
    const padding = autoAdc ? Math.max(Math.abs(low) * .01, $('adc-units').value === 'raw' ? 1 : .001) : 1;
    low -= padding; high += padding;
  }
  if (!fixedRange) { const margin = (high - low) * .1; low -= margin; high += margin; }
  if (autoAdc) decimals = Math.min(6, Math.max(0, Math.ceil(-Math.log10((high - low) / 3)) + 1));
  ctx.font = '10px Segoe UI, sans-serif';
  for (let i = 0; i < 4; i++) {
    const y = pad.top + h * i / 3;
    ctx.strokeStyle = '#263448'; ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(width-pad.right, y); ctx.stroke();
    ctx.fillStyle = '#91a4bb'; ctx.textAlign = 'right';
    ctx.fillText((high - (high-low)*i/3).toFixed(decimals), pad.left-8, y+3);
  }
  ctx.fillStyle = '#91a4bb'; ctx.textAlign = 'left'; ctx.fillText(`−${span}s`, pad.left, height-4);
  ctx.textAlign = 'right'; ctx.fillText('latest', width-pad.right, height-4);
  for (let axis = 0; axis < axes; axis++) {
    ctx.beginPath(); ctx.strokeStyle = traceColors[axis]; ctx.lineWidth = 1.8;
    let drawing = false, previous = null;
    const buckets = [];
    for (const sample of visible) {
      const value = getValues(sample)[axis];
      const limits = getBounds ? getBounds(sample)[axis].filter(Number.isFinite) : [value].filter(Number.isFinite);
      const pixel = Math.round((stamp(sample) - (end-span)) / span * w);
      // Connect displayed samples even when raw scans were dropped in transit.
      // Break the trace for missing values, a long outage, or a device restart.
      const disconnected = !Number.isFinite(value) || !previous || stamp(sample)-stamp(previous) > 2 || sample.device_ms < previous.device_ms;
      if (!limits.length) { previous = null; continue; }
      const bucket = buckets.at(-1);
      if (bucket && bucket.pixel === pixel && !disconnected) {
        bucket.low = Math.min(bucket.low, ...limits); bucket.high = Math.max(bucket.high, ...limits);
        bucket.value = Number.isFinite(value) ? value : bucket.value;
      } else buckets.push({pixel, low: Math.min(...limits), high: Math.max(...limits), value: Number.isFinite(value) ? value : limits[0], disconnected});
      previous = sample;
    }
    // One min/max envelope per screen pixel preserves spikes from all scans.
    if (getBounds) {
      ctx.globalAlpha = .15;
      for (const bucket of buckets) {
        const x = pad.left + bucket.pixel;
        ctx.moveTo(x, pad.top + (high-bucket.low)/(high-low)*h);
        ctx.lineTo(x, pad.top + (high-bucket.high)/(high-low)*h);
      }
      ctx.stroke(); ctx.globalAlpha = 1; ctx.beginPath();
    }
    drawing = false;
    for (const bucket of buckets) {
      const value = bucket.value;
      const x = pad.left + bucket.pixel;
      const y = pad.top + (high-value) / (high-low) * h;
      if (bucket.disconnected) drawing = false;
      if (drawing) ctx.lineTo(x,y); else ctx.moveTo(x,y);
      drawing = true;
    }
    ctx.stroke();
  }
  if (!values.length) {ctx.fillStyle = '#91a4bb'; ctx.textAlign = 'center'; ctx.fillText(axes ? 'Waiting for sensor data' : 'Select a trace in the legend', pad.left+w/2, pad.top+h/2);}
}

$('export').addEventListener('click', () => {
  const header = ['source', 'received_utc', 'device_ms', ...Array.from({length:16}, (_,i) => `ch${i}_raw`), ...['accel_g', 'gyro_dps', 'mag_uT'].flatMap(k => ['x','y','z'].map(a=>`${k}_${a}`)), 'errors'];
  const quote = value => `"${String(value ?? '').replaceAll('"','""')}"`;
  const rows = samples.map(s => [state.mode, new Date(s.received_at*1000).toISOString(), s.device_ms, ...s.adc, ...(s.accel || [null,null,null]), ...(s.gyro || [null,null,null]), ...(s.mag || [null,null,null]), s.errors.join('; ')]);
  const csv = [header, ...rows].map(row => row.map(quote).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], {type:'text/csv;charset=utf-8'}));
  const link = document.createElement('a'); link.href = url; link.download = `antenna-${state.mode}-${new Date().toISOString().replaceAll(':','-')}.csv`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('resize', render);
updateButtons(); render(); poll();
let lastPaint = 0;
function animatePlots(now) {
  if (now - lastPaint >= 1000 / 30 && !document.hidden) { renderCharts(); lastPaint = now; }
  requestAnimationFrame(animatePlots);
}
requestAnimationFrame(animatePlots);
