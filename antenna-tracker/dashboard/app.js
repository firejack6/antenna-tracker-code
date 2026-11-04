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
let rawPaused = false, rawDirty = true;
function updateRawMonitor() {
  if (rawPaused || !rawDirty) return;
  $('log').textContent = logs.length ? logs.join('\n') : 'Waiting for connection output…';
  if ($('follow').checked) $('log').scrollTop = $('log').scrollHeight;
  rawDirty = false;
}
$('raw-pause').addEventListener('click', () => {
  rawPaused = !rawPaused;
  $('raw-pause').textContent = rawPaused ? 'Resume monitor' : 'Pause monitor';
  updateRawMonitor();
});
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
  for (const mode of ['tcp', 'remote', 'direct']) {
    const port = localStorage.getItem(`adc-last-port-${mode}`);
    if (port && port.length <= 250) rememberedPorts[mode] = mode === 'tcp' && port === '192.168.4.1:9000' ? '192.168.20.1:9000' : port;
  }
} catch { /* Port memory remains available for this page. */ }
const fmt = value => Number.isFinite(value) ? value.toFixed(3) : '—';
const gpioLabels = {46: 'Servo power good', 4: 'Hall C', 13: 'Hall B', 14: 'Hall A'};
const servoPresets = {};
try { Object.assign(servoPresets, JSON.parse(localStorage.getItem('servo-ui-presets') || '{}')); } catch {}
function presetsFor(axis, config) {
  const defaults = {min: config.umin ?? config.pmin, center: config.ucenter ?? (axis === 'TILT' && config.pmin <= 2400 && config.pmax >= 2400 ? 2400 : config.pcenter), max: config.umax ?? config.pmax};
  const saved = servoPresets[config.mode === 1 ? `${axis}:continuous` : axis];
  return validPresets(saved, config) ? saved : defaults;
}
// TILT's user-facing angle direction is opposite the IMU's native convention.
function displayAngle(axis, angle) { return axis === 'TILT' ? -angle : angle; }
function angleInput(value) {
  if (!Number.isFinite(value)) return '';
  return (Math.round(value * 100) / 100).toFixed(2);
}
function validPresets(values, config) {
  return values && ['min', 'center', 'max'].every(key => Number.isInteger(values[key])) &&
    config.pmin <= values.min && values.min <= values.center && values.center <= values.max && values.max <= config.pmax;
}
for (const [axis, pin] of [['PAN', 1], ['TILT', 2], ['S3', 3]]) {
  const form = document.createElement('form'); form.id = `servo-${axis}`; form.className = 'servo-form';
  // Position commands validate their own target, not unrelated hidden settings.
  form.noValidate = axis !== 'S3';
  form.innerHTML = `<strong>${axis} · GPIO ${pin} · A${pin - 1}/D${pin + 16}</strong><div class="servo-fields"><label>Pulse width (µs)<input id="servo-${axis}-pulse" type="number" step="1" required disabled></label><label>Frequency (Hz)<input id="servo-${axis}-frequency" type="number" step="1" required disabled></label></div><div class="buttons"><button type="submit" disabled>Command</button><button type="button" data-off class="secondary" disabled>Off</button>${['min','center','max'].map(key => `<button type="button" data-preset="${key}" class="secondary" disabled>${key.charAt(0).toUpperCase() + key.slice(1)}</button>`).join('')}</div><p id="servo-${axis}-reported">Waiting for servo telemetry</p><p id="servo-${axis}-command" role="status"></p>`;
  $('servo-controls').append(form);
  if (axis === 'PAN') {
    const calibration = document.createElement('details'); calibration.dataset.panControls = '';
    calibration.innerHTML = `<summary>PAN calibration and saved settings</summary><p>Changing calibration or CR tune stops PAN. Signed angle span sets pot direction; PWM polarity sets which pulse direction increases the calibrated angle. A five-turn pot with 5:1 gearing spans 360 device degrees. Save stores calibration, CR tune, PID, deadband, breakaway/schedule, ramp, speed and overspeed on the ESP (no DFU needed while iterating).</p><div class="servo-fields">${[['neutral','Neutral pulse (us)',500,2500,1],['polarity','PWM polarity (+1 or -1)',-1,1,1],['vmin','Pot minimum voltage',0,3.5,'any'],['vmax','Pot maximum voltage',0,3.5,'any'],['span','Signed device angle span (degrees)',-360,360,0.01],['zero','Zero offset (degrees)',-360,360,0.01],['amin','Minimum device angle',-360,360,0.01],['amax','Maximum device angle',-360,360,0.01]].map(([key,label,min,max,step])=>`<label>${label}<input data-pan-field="${key}" type="number" min="${min}" max="${max}" step="${step}"></label>`).join('')}</div><div class="buttons"><button type="button" data-pan-action="configure">Apply calibration</button><button type="button" data-pan-action="zero">Set current position as zero</button></div><p><strong>Continuous speed tune</strong> (Wi‑Fi / NVS)</p><div class="servo-fields">${[['ff','Feedforward (µs per °/s)',0,50,'any'],['rise','PWM rise (µs/s)',1,500,1],['fall','PWM fall (µs/s)',1,1000,1],['search','Startup search (µs/s)',0,100,'any'],['search_max','Startup search max (µs)',0,200,'any'],['brake','Overspeed brake confirm (s)',0,2,'any']].map(([key,label,min,max,step])=>`<label>${label}<input data-pan-cr="${key}" type="number" min="${min}" max="${max}" step="${step}"></label>`).join('')}</div><div class="buttons"><button type="button" data-pan-action="cr_configure">Apply CR tune</button><button type="button" data-pan-action="save">Save PAN settings</button></div><p data-pan-status role="status"></p>`;
    form.append(calibration);
    for (const button of calibration.querySelectorAll('[data-pan-action]')) button.addEventListener('click', async () => {
      const action = button.dataset.panAction, data = {action};
      if (action === 'configure') for (const input of calibration.querySelectorAll('[data-pan-field]')) {
        if (!input.reportValidity() || !Number.isFinite(input.valueAsNumber)) return;
        data[input.dataset.panField] = input.valueAsNumber;
      }
      if (action === 'cr_configure') for (const input of calibration.querySelectorAll('[data-pan-cr]')) {
        if (!input.reportValidity() || !Number.isFinite(input.valueAsNumber)) return;
        data[input.dataset.panCr] = input.valueAsNumber;
      }
      try { await api('/api/pan',data); calibration.querySelector('[data-pan-status]').textContent = 'Queued; watch reported values or raw log. PAN will stop.'; }
      catch (error) { calibration.querySelector('[data-pan-status]').textContent = error.message; }
    });
  }
  const neutralButton = document.createElement('button');
  neutralButton.type = 'button'; neutralButton.dataset.neutral = ''; neutralButton.textContent = 'Neutral / Stop'; neutralButton.hidden = true;
  form.querySelector('.buttons').append(neutralButton);
  neutralButton.addEventListener('click', () => {
    const config = state?.latest?.servos?.[axis];
    if (!config || config.mode !== 1) return;
    $(`servo-${axis}-pulse`).value = config.neutral;
    sendServo({axis, pulse: config.neutral, frequency: config.fcenter});
  });
  if (axis !== 'S3') {
    const motion = document.createElement('details');
    motion.innerHTML = `<label>Speed regulation / overspeed limit (deg/s; 0 disables)<input data-speed type="number" min="0" max="360" step="any" disabled></label><button type="button" data-speed-apply disabled>Apply speed</button><p data-motion></p><p data-speed-status role="status"></p>`;
    const motionSummary = document.createElement('summary'); motionSummary.textContent = 'Speed and protection settings'; motion.prepend(motionSummary);
    motion.querySelector('[data-speed-apply]').type = 'button';
    form.append(motion);
    const overspeed = document.createElement('button');
    overspeed.type = 'button'; overspeed.dataset.overspeed = ''; overspeed.disabled = true;
    overspeed.textContent = 'Overspeed fault: waiting for board'; motion.append(overspeed);
    overspeed.addEventListener('click', async () => {
      const reported = state?.latest?.servo_motion?.[axis]?.osfault;
      if (reported == null) return;
      try {
        await api('/api/servo-overspeed', {axis, enabled: reported !== 1});
        motion.querySelector('[data-speed-status]').textContent = 'Overspeed setting queued; watch button for board confirmation';
      } catch (error) { motion.querySelector('[data-speed-status]').textContent = error.message; }
    });
    motion.querySelector('[data-speed-apply]').addEventListener('click', async () => {
      const input = motion.querySelector('[data-speed]');
      if (!input.reportValidity()) return;
      try {
        await api('/api/servo-speed', {axis, speed: input.valueAsNumber});
        input.dataset.requestedSpeed = String(input.valueAsNumber);
        motion.querySelector('[data-speed-status]').textContent = 'Queued; watch reported limit for confirmation';
      } catch (error) { motion.querySelector('[data-speed-status]').textContent = error.message; }
    });
  }
  const stepLabel = document.createElement('label');
  stepLabel.innerHTML = 'Button step (?s)<input data-step-size type="number" min="1" max="2000" step="1" value="100">';
  const stepSize = stepLabel.querySelector('input');
  try {
    const saved = Number(localStorage.getItem(`servo-step-${axis}`));
    if (Number.isInteger(saved) && saved >= 1 && saved <= 2000) stepSize.value = saved;
  } catch {}
  form.querySelector('.servo-fields').append(stepLabel);
  const updateSteps = () => {
    if (!stepSize.checkValidity()) return;
    for (const button of form.querySelectorAll('[data-step]')) {
      const step = Math.sign(Number(button.dataset.step)) * stepSize.valueAsNumber;
      button.dataset.step = String(step);
      button.textContent = `${step > 0 ? '+' : '?'}${Math.abs(step)} ?s`;
    }
    try { localStorage.setItem(`servo-step-${axis}`, stepSize.value); } catch {}
  };
  stepSize.addEventListener('input', updateSteps);
  for (const step of [-100, 100]) {
    const stepButton = document.createElement('button');
    stepButton.type = 'button'; stepButton.dataset.step = String(step); stepButton.className = 'secondary';
    stepButton.textContent = `${step > 0 ? '+' : '−'}100 µs`; stepButton.disabled = true;
    form.querySelector('.buttons').append(stepButton);
    stepButton.addEventListener('click', () => {
      const pulseInput = $(`servo-${axis}-pulse`), frequencyInput = $(`servo-${axis}-frequency`);
      const config = (samples.at(-1) || state?.latest)?.servos?.[axis];
      if (!stepSize.reportValidity()) return;
      const pulse = Math.round(pulseInput.valueAsNumber + Number(stepButton.dataset.step));
      if (stepButton.disabled || !config || !Number.isInteger(pulse) || pulse < config.pmin || pulse > config.pmax || !frequencyInput.checkValidity()) return;
      pulseInput.value = pulse;
      // Same path as Manual PWM Command: direct SERVO RAW, not regulated CR.
      sendServo({axis, pulse, frequency: frequencyInput.valueAsNumber, manual: true});
    });
  }
  updateSteps();
  for (const input of form.querySelectorAll('input')) input.addEventListener('input', render);
  const settings = document.createElement('details');
  settings.dataset.presetControls = '';
  settings.innerHTML = `<summary>Button presets (µs)</summary><div class="servo-fields">${['min','center','max'].map(key => `<label>${key}<input data-setting="${key}" type="number" step="1"></label>`).join('')}</div><div class="buttons"><button type="button" data-save-presets>Save presets</button><button type="button" data-reset-presets>Reset presets</button></div><p data-preset-status role="status">Presets fill fields; click Command to move. Absolute limits still apply.</p>`;
  form.append(settings);
  if (axis === 'TILT') {
    const calibration = document.createElement('details'); calibration.dataset.tiltConfig = ''; calibration.hidden = true;
    calibration.innerHTML = `<summary>Continuous pot mapping (legacy)</summary><p>For continuous-rotation TILT only. Saving mapping or setting zero stops the axis.</p><div class="servo-fields">${[['vmin','Pot min (V)',0,5,.001],['vmax','Pot max (V)',0,5,.001],['zero','Zero offset (°)',0,360,.01],['amin','Min angle (°)',-360,360,.01],['amax','Max angle (°)',-360,360,.01]].map(([key,label,min,max,step]) => `<label>${label}<input data-tilt-field="${key}" type="number" min="${min}" max="${max}" step="${step}"></label>`).join('')}</div><div class="buttons"><button type="button" data-tilt-action="configure">Save mapping</button><button type="button" data-tilt-action="zero">Set zero here</button></div><p data-tilt-reported></p><div data-pot-sweep><p>Pot voltage sweep (continuous mode). Ensure travel is clear.</p><div class="servo-fields"><label>Speed (deg/s)<input data-sweep-speed type="number" min="1" max="100" step="any" value="5"></label><label>Direction<select data-sweep-direction><option value="1">Increasing V</option><option value="-1">Decreasing V</option></select></label><label>PWM offset cap (µs)<input data-sweep-cap type="number" min="1" max="1000" step="1" value="300"></label><label>PWM polarity<select data-sweep-polarity><option value="1">Above neutral ↑ V</option><option value="-1">Above neutral ↓ V</option></select></label><label>Start offset (µs)<input data-sweep-minimum type="number" min="0" max="1000" step="any" value="42"></label><label>Rotations<input data-sweep-rotations type="number" min="1" max="20" step="1" value="1"></label></div><div class="buttons"><button type="button" data-tilt-action="sweep_start">Start pot sweep</button><button type="button" data-tilt-action="sweep_stop" class="secondary">Stop</button><button type="button" data-tilt-action="sweep_apply">Apply measured range</button></div><p data-sweep-reported></p></div><p data-tilt-status role="status"></p>`;
    form.append(calibration);
    calibration.addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
    for (const button of calibration.querySelectorAll('[data-tilt-action]')) button.addEventListener('click', async () => {
      const action = button.dataset.tiltAction; let command = {action};
      if (action === 'configure') {
        for (const input of calibration.querySelectorAll('[data-tilt-field]')) {
          if (!input.reportValidity() || !Number.isFinite(input.valueAsNumber)) return;
          command[input.dataset.tiltField] = input.valueAsNumber;
        }
      }
      if (action === 'sweep_start') {
        const input = calibration.querySelector('[data-sweep-speed]');
        if (!input.reportValidity()) return;
        const cap = calibration.querySelector('[data-sweep-cap]');
        if (!cap.reportValidity()) return;
        command.speed = input.valueAsNumber; command.direction = Number(calibration.querySelector('[data-sweep-direction]').value); command.cap = cap.valueAsNumber;
        command.polarity = Number(calibration.querySelector('[data-sweep-polarity]').value);
        const minimum = calibration.querySelector('[data-sweep-minimum]');
        const rotations = calibration.querySelector('[data-sweep-rotations]');
        minimum.max = cap.value;
        if (!minimum.reportValidity() || !rotations.reportValidity()) return;
        command.minimum = minimum.valueAsNumber; command.rotations = rotations.valueAsNumber;
      }
      try { await api('/api/tilt', command); calibration.querySelector('[data-tilt-status]').textContent = 'Request queued; watch reported calibration/sweep state'; }
      catch (error) { calibration.querySelector('[data-tilt-status]').textContent = error.message; }
    });
  }
  settings.querySelector('[data-save-presets]').addEventListener('click', () => {
    const config = state?.latest?.servos?.[axis];
    if (!config) return;
    const values = Object.fromEntries([...settings.querySelectorAll('[data-setting]')].map(input => [input.dataset.setting, input.valueAsNumber]));
    if (!validPresets(values, config)) {
      settings.querySelector('[data-preset-status]').textContent = `Use ${config.pmin} ≤ Min ≤ Center ≤ Max ≤ ${config.pmax} µs.`;
      return;
    }
    servoPresets[config.mode === 1 ? `${axis}:continuous` : axis] = values;
    try { localStorage.setItem('servo-ui-presets', JSON.stringify(servoPresets)); } catch {}
    settings.querySelector('[data-preset-status]').textContent = 'Presets saved in this browser. No movement commanded.';
    render();
  });
  settings.querySelector('[data-reset-presets]').addEventListener('click', () => {
    delete servoPresets[state?.latest?.servos?.[axis]?.mode === 1 ? `${axis}:continuous` : axis];
    try { localStorage.setItem('servo-ui-presets', JSON.stringify(servoPresets)); } catch {}
    delete settings.dataset.config;
    settings.querySelector('[data-preset-status]').textContent = 'Defaults restored. No movement commanded.';
    render();
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (axis !== 'S3') { form.querySelector('[data-position-go]').click(); return; }
    sendServo({axis, pulse: $(`servo-${axis}-pulse`).valueAsNumber, frequency: $(`servo-${axis}-frequency`).valueAsNumber});
  });
  form.querySelector('[data-off]').addEventListener('click', () => sendServo({axis, off: true}));
  for (const button of form.querySelectorAll('[data-preset]')) button.addEventListener('click', () => {
    const config = (samples.at(-1) || state?.latest)?.servos?.[axis];
    if (!config) return;
    $(`servo-${axis}-pulse`).value = presetsFor(axis, config)[button.dataset.preset];
    $(`servo-${axis}-frequency`).value = config[`f${button.dataset.preset}`];
    render();
  });
  if (axis !== 'S3') {
    const raw = document.createElement('details'); raw.dataset.rawControls = '';
    raw.innerHTML = '<summary>Manual PWM controls</summary><p>Direct hardware PWM toward the pulse. On-ESP trapezoid slew softens steps (rate 0 = instant). No angle-limit correction.</p>';
    const rawFields = form.querySelector('.servo-fields'), rawButtons = form.querySelector('.buttons');
    const rawCommand = rawButtons.querySelector('[type="submit"]'); rawCommand.type = 'button'; rawCommand.dataset.rawCommand = '';
    rawCommand.addEventListener('click', () => sendServo({axis, pulse: $(`servo-${axis}-pulse`).valueAsNumber, frequency: $(`servo-${axis}-frequency`).valueAsNumber, manual: true}));
    const slew = document.createElement('div'); slew.dataset.pwmSlew = '';
    slew.innerHTML = `<div class="servo-fields"><label>PWM slew max rate (µs/s; 0=instant)<input data-pwm-slew-rate type="number" min="0" max="500" step="1" value="40"></label><label>PWM slew accel (µs/s²)<input data-pwm-slew-accel type="number" min="0" max="5000" step="1" value="80"></label></div><div class="buttons"><button type="button" data-pwm-slew-apply>Apply PWM slew</button></div><p data-pwm-slew-status role="status"></p>`;
    slew.querySelector('[data-pwm-slew-apply]').addEventListener('click', async () => {
      const rate = slew.querySelector('[data-pwm-slew-rate]');
      const accel = slew.querySelector('[data-pwm-slew-accel]');
      if (![rate, accel].every(input => input.reportValidity())) return;
      try {
        await api('/api/servo-pwm-slew', {axis, rate: rate.valueAsNumber, accel: accel.valueAsNumber});
        slew.querySelector('[data-pwm-slew-status]').textContent = `Slew queued ${rate.valueAsNumber} µs/s, ${accel.valueAsNumber} µs/s²`;
      } catch (error) { slew.querySelector('[data-pwm-slew-status]').textContent = error.message; }
    });
    raw.append(rawFields, rawButtons, settings, slew); form.append(raw);
    const pwmSweep = document.createElement('div'); pwmSweep.dataset.pwmSweep = '';
    pwmSweep.innerHTML = `<strong>PWM calibration sweep</strong><p>Open-loop RAW ramp; bypasses angle limits; holds at end. Enable servos first.</p><div class="servo-fields"><label>Start (µs)<input data-pwm-start type="number" min="500" max="2500" step="1" value="500"></label><label>End (µs)<input data-pwm-end type="number" min="500" max="2500" step="1" value="2500"></label><label>Rate (µs/s)<input data-pwm-rate type="number" min="5" max="200" step="1" value="40"></label></div><div class="buttons"><button type="button" data-pwm-go>Start sweep</button><button type="button" data-pwm-halt class="secondary" data-off>Stop sweep</button></div><p data-pwm-sweep-status role="status"></p>`;
    form.append(pwmSweep);
    pwmSweep.querySelector('[data-pwm-go]').addEventListener('click', async () => {
      const start = pwmSweep.querySelector('[data-pwm-start]');
      const end = pwmSweep.querySelector('[data-pwm-end]');
      const rate = pwmSweep.querySelector('[data-pwm-rate]');
      if (![start, end, rate].every(input => input.reportValidity())) return;
      try {
        await api('/api/servo-pwm-sweep', {axis, action: 'start', start: start.valueAsNumber, end: end.valueAsNumber, rate: rate.valueAsNumber});
        pwmSweep.dataset.pwmSweepEnd = String(end.valueAsNumber);
        pwmSweep.dataset.pwmSweepActive = '1';
        pwmSweep.querySelector('[data-pwm-sweep-status]').textContent = `Sweep queued ${start.valueAsNumber} → ${end.valueAsNumber} µs at ${rate.valueAsNumber} µs/s`;
      } catch (error) { pwmSweep.querySelector('[data-pwm-sweep-status]').textContent = error.message; }
    });
    pwmSweep.querySelector('[data-pwm-halt]').addEventListener('click', async () => {
      try {
        await api('/api/servo-pwm-sweep', {axis, action: 'stop'});
        delete pwmSweep.dataset.pwmSweepActive;
        pwmSweep.querySelector('[data-pwm-sweep-status]').textContent = 'Stop queued';
      } catch (error) { pwmSweep.querySelector('[data-pwm-sweep-status]').textContent = error.message; }
    });
    const position = document.createElement('div'); position.dataset.positionControls = '';
    position.innerHTML = `<div class="servo-fields"><label>Target angle (degrees)<input data-position-angle type="number" min="-360" max="360" step="0.01" value="0.00"></label></div><div class="buttons"><button type="button" data-position-go>Go to position</button><button type="button" data-position-stop class="secondary">Stop</button></div><p data-position-reported></p><label><input data-position-no-ramp type="checkbox"> Disable position target interpolation / ramps</label><p>Checked: the target is applied immediately. Changing this stops the axis. Feedback filtering and safety limits remain active.</p><label>Position target ramp rate (deg/s)<input data-position-ramp-rate type="number" min="0.1" max="360" step="any"></label><button type="button" data-position-ramp-save>Apply ramp rate</button><details><summary>Position PID gains</summary><p>Changing gains stops this servo. Values apply until the ESP restarts; source defaults are in servo_motion_config.h.</p><div class="servo-fields">${[['kp','P (us/degree)',0,100],['ki','I (us/(degree s))',0,100],['kd','D (us/(degree/s))',0,100],['ilimit','Integral limit (us)',0,1000],['cap','PWM correction/output limit (us)',1,1000],['tolerance','Position tolerance (degrees)',.1,30]].map(([key,label,min,max])=>`<label>${label}<input data-position-gain="${key}" type="number" min="${min}" max="${max}" step="any"></label>`).join('')}</div><button type="button" data-position-save>Apply PID gains</button><p data-position-gains></p><div data-deadband-controls><p>Deadband compensation: minimum drive offset for each physical PWM direction. Zero disables compensation. The PID output limit still caps the total offset.</p><div class="servo-fields"><label>Above-neutral deadband (us)<input data-position-db="dbplus" type="number" min="0" max="1000" step="any"></label><label>Below-neutral deadband (us)<input data-position-db="dbminus" type="number" min="0" max="1000" step="any"></label></div><button type="button" data-position-db-save>Apply deadband</button><p data-position-db-reported></p></div><div data-breakaway-controls hidden><p>Breakaway spike + error schedule. SERVO PID kp/cap are the large-error gains; near gains blend in below schedule_deg. Save PAN settings to keep across reboot.</p><div class="servo-fields"><label>Spike offset (us)<input data-breakaway-field="offset_us" type="number" min="0" max="250" step="1"></label><label>Spike duration (ms)<input data-breakaway-field="duration_ms" type="number" min="0" max="2000" step="1"></label><label>Near Kp<input data-schedule-field="kp_near" type="number" min="0" max="100" step="any"></label><label>Near cap (us)<input data-schedule-field="cap_near" type="number" min="1" max="1000" step="any"></label><label>Schedule span (°)<input data-schedule-field="schedule_deg" type="number" min="1" max="180" step="any"></label><label>Breakaway min scale<input data-schedule-field="brk_min_scale" type="number" min="0" max="1" step="any"></label><label>Settle deadband band (°)<input data-schedule-field="settle_deg" type="number" min="1" max="90" step="any"></label></div><div class="buttons"><button type="button" data-breakaway-save>Apply breakaway</button><button type="button" data-schedule-save>Apply schedule</button></div><p data-breakaway-reported></p></div></details><p data-position-status role="status"></p>`;
    if (axis === 'TILT') {
      const imuPanel = document.createElement('details'); imuPanel.dataset.imuControls = '';
      imuPanel.innerHTML = '<summary>IMU tilt feedback and PWM mapping</summary><p data-imu-reported></p><p>Map IMU angles at two PWM endpoints before angle control. Changing mapping/zero stops TILT until reboot.</p><label>Axis<select data-imu-field="axis"><option value="0">X roll</option><option value="1">Y tilt</option></select></label><div class="servo-fields"><label>Mounting zero (°)<input data-imu-field="zero" type="number" min="-720" max="720" step="0.01"></label><label>PWM at min angle (µs)<input data-imu-field="pmin" type="number" min="500" max="2500" step="1"></label><label>PWM at max angle (µs)<input data-imu-field="pmax" type="number" min="500" max="2500" step="1"></label><label>IMU at min PWM (°)<input data-imu-field="amin" type="number" min="-720" max="720" step="0.01"></label><label>IMU at max PWM (°)<input data-imu-field="amax" type="number" min="-720" max="720" step="0.01"></label></div><div class="buttons"><button type="button" data-imu-save>Apply IMU mapping</button><button type="button" data-imu-zero>Set zero here</button></div>';
      form.append(imuPanel);
      imuPanel.querySelector('[data-imu-save]').addEventListener('click', async () => {
        const fields = [...imuPanel.querySelectorAll('[data-imu-field]')];
        if (!fields.every(input=>input.reportValidity())) return;
        for (const input of fields) {
          if (input.dataset.imuField !== 'axis' && input.dataset.imuField !== 'pmin' && input.dataset.imuField !== 'pmax') {
            input.value = angleInput(input.valueAsNumber);
          }
        }
        try { await api('/api/tilt-imu', {action:'configure',...Object.fromEntries(fields.map(input=>[input.dataset.imuField,Number(input.value)]))}); position.querySelector('[data-position-status]').textContent = 'IMU mapping queued; output will stop'; }
        catch(error) { position.querySelector('[data-position-status]').textContent = error.message; }
      });
      imuPanel.querySelector('[data-imu-zero]').addEventListener('click', async () => {
        try { await api('/api/tilt-imu', {action:'zero'}); position.querySelector('[data-position-status]').textContent = 'IMU zero queued; output will stop'; }
        catch(error) { position.querySelector('[data-position-status]').textContent = error.message; }
      });
    }
    if (axis === 'PAN') {
      position.querySelector('details p').textContent = 'Changing gains stops PAN. Apply changes here, then use Save PAN settings in the calibration section to retain them across reboot.';
      position.querySelector('[data-breakaway-controls]').hidden = false;
      position.querySelector('[data-breakaway-save]').addEventListener('click', async () => {
        const fields = [...position.querySelectorAll('[data-breakaway-field]')];
        if (!fields.every(input => input.reportValidity())) return;
        try {
          await api('/api/servo-breakaway', {axis, ...Object.fromEntries(fields.map(input => [input.dataset.breakawayField, input.valueAsNumber]))});
          position.querySelector('[data-position-status]').textContent = 'Breakaway queued; output will stop. Watch reported values, then Save PAN settings to persist.';
        } catch (error) { position.querySelector('[data-position-status]').textContent = error.message; }
      });
      position.querySelector('[data-schedule-save]').addEventListener('click', async () => {
        const fields = [...position.querySelectorAll('[data-schedule-field]')];
        if (!fields.every(input => input.reportValidity())) return;
        try {
          await api('/api/servo-schedule', {axis, ...Object.fromEntries(fields.map(input => [input.dataset.scheduleField, input.valueAsNumber]))});
          position.querySelector('[data-position-status]').textContent = 'Schedule queued; output will stop. Watch reported values, then Save PAN settings to persist.';
        } catch (error) { position.querySelector('[data-position-status]').textContent = error.message; }
      });
    }
    position.querySelector('[data-position-no-ramp]').addEventListener('change', async event => {
      try {
        await api('/api/servo-ramp', {axis, enabled:!event.target.checked, rate:position.querySelector('[data-position-ramp-rate]').valueAsNumber});
        position.querySelector('[data-position-status]').textContent = 'Ramp change queued; axis will stop. Watch reported state for confirmation';
      } catch(error) { position.querySelector('[data-position-status]').textContent = error.message; }
    });
    position.querySelector('[data-position-ramp-save]').addEventListener('click', async () => {
      const input = position.querySelector('[data-position-ramp-rate]');
      if (!input.reportValidity()) return;
      try {
        await api('/api/servo-ramp', {axis, enabled:!position.querySelector('[data-position-no-ramp]').checked, rate:input.valueAsNumber});
        position.querySelector('[data-position-status]').textContent = 'Ramp rate queued; axis will stop. Watch reported rate for confirmation';
      } catch(error) { position.querySelector('[data-position-status]').textContent = error.message; }
    });
    position.querySelector('[data-position-db-save]').addEventListener('click', async () => {
      try {
        await api('/api/servo-deadband', {axis, ...Object.fromEntries([...position.querySelectorAll('[data-position-db]')].map(input=>[input.dataset.positionDb,input.valueAsNumber]))});
        position.querySelector('[data-position-status]').textContent = 'Deadband queued; output will stop. Watch reported values for confirmation';
      } catch(error) { position.querySelector('[data-position-status]').textContent = error.message; }
    });
    form.querySelector('strong').after(position);
    position.after(pwmSweep);
    pwmSweep.after(raw);
    const imuPanel = form.querySelector('[data-imu-controls]');
    if (imuPanel) raw.after(imuPanel);
    const tiltLegacy = form.querySelector('[data-tilt-config]');
    if (tiltLegacy) (imuPanel || raw).after(tiltLegacy);
    const angleField = position.querySelector('[data-position-angle]');
    angleField.addEventListener('change', () => { if (Number.isFinite(angleField.valueAsNumber)) angleField.value = angleInput(angleField.valueAsNumber); });
    position.querySelector('[data-position-go]').addEventListener('click', async () => {
      if (!angleField.reportValidity()) return;
      angleField.value = angleInput(angleField.valueAsNumber);
      try { await api('/api/servo-position', {axis, angle: displayAngle(axis,angleField.valueAsNumber)}); position.querySelector('[data-position-status]').textContent = 'Position queued; watch reported target and active state'; }
      catch(error) { position.querySelector('[data-position-status]').textContent = error.message; }
    });
    position.querySelector('[data-position-stop]').addEventListener('click', () => sendServo({axis, off:true}));
    position.querySelector('[data-position-save]').addEventListener('click', async () => {
      const inputs = [...position.querySelectorAll('[data-position-gain]')];
      if (!inputs.every(input=>input.reportValidity())) return;
      try { await api('/api/servo-pid', {axis, ...Object.fromEntries(inputs.map(input=>[input.dataset.positionGain,input.valueAsNumber]))}); position.querySelector('[data-position-status]').textContent = 'PID gains queued; output will stop. Watch reported gains for confirmation'; }
      catch(error) { position.querySelector('[data-position-status]').textContent = error.message; }
    });
  }
}
// Keep each axis's controls, readback and plots together.
const servoPanel = document.querySelector('.servo-panel');
document.querySelector('.connection').after(servoPanel);
for (const axis of ['PAN','TILT','S3']) {
  const form = $(`servo-${axis}`);
  const card = document.createElement('article'); card.className = 'servo-axis-card';
  const heading = document.createElement('div'); heading.className = 'servo-axis-heading';
  heading.innerHTML = `<h3>${axis}</h3><span>${axis === 'TILT' ? 'IMU position control' : axis === 'PAN' ? 'Continuous rotation · pot feedback' : 'Auxiliary PWM'}</span><div data-axis-readout>Waiting for telemetry</div>`;
  const layout = document.createElement('div'); layout.className = 'servo-axis-layout';
  form.before(card); card.append(heading,layout); layout.append(form);
  const plots = document.createElement('div'); plots.className = 'servo-axis-plots';
  plots.innerHTML = `${axis !== 'S3' ? `<div><h4>Position <small>degrees</small></h4><div class="mini-legend"><span class="legend-actual">Actual</span><span class="legend-target">Target</span><span class="legend-ramped">Ramped target</span></div><canvas id="servo-${axis}-position-chart" aria-label="${axis} actual and target position" role="img"></canvas></div>` : ''}<div><h4>PWM output <small>µs</small></h4><canvas id="servo-${axis}-pwm-chart" aria-label="${axis} PWM pulse width" role="img"></canvas></div>`;
  layout.append(plots);
}
// Secondary telemetry remains available without crowding the control view.
for (const panel of document.querySelectorAll('main section.panel:not(.connection):not(.servo-panel):not(.recording-panel):not(.map-panel):not(.tune-panel)')) {
  const title = panel.querySelector('h2')?.textContent;
  if (!title) continue;
  const disclosure = document.createElement('details'); disclosure.className = 'telemetry-disclosure';
  const summary = document.createElement('summary'); summary.textContent = title;
  const content = document.createElement('div'); content.className = 'disclosure-content';
  while (panel.firstChild) content.append(panel.firstChild);
  disclosure.append(summary,content); panel.append(disclosure);
  disclosure.addEventListener('toggle', () => { if (disclosure.open) renderCharts(); });
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
  if (!command.off) {
    const continuous = state?.latest?.servos?.[command.axis]?.mode === 1;
    command.continuous = continuous;
    // Manual PWM panel sets manual:true; all other UI paths use regulated CR when continuous.
    if (command.manual !== true) delete command.manual;
    if (continuous && command.manual !== true && command.speed_limit == null) {
      const speedInput = document.querySelector(`#servo-${command.axis} [data-speed]`);
      if (speedInput && Number.isFinite(speedInput.valueAsNumber)) command.speed_limit = speedInput.valueAsNumber;
    }
  }
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

const pidPlotTraces = {
  speed: [['Requested', '#f5bd4f', s => s.pid?.mode === 1 ? null : s.motion?.commandspeed], ['Measured', '#4bd3b5', s => s.motion?.speed], ['Ramped setpoint', '#a88bfa', s => s.pid?.mode === 1 ? null : s.pid?.setpoint], ['Error', '#ff788a', s => s.pid?.mode === 1 ? null : s.pid?.error]],
  position: [['Position', '#4bd3b5', s => s.motion?.angle], ['Minimum', '#f5bd4f', s => s.min], ['Maximum', '#ff788a', s => s.max], ['Target', '#a88bfa', s => s.position?.active ? s.position.target : null], ['Ramped target', '#65b5ff', s => s.pid?.mode === 1 ? s.pid.setpoint : null]],
  output: [['PWM output', '#4bd3b5', s => s.pid?.output], ['Requested offset', '#f5bd4f', s => s.pid?.request], ['P', '#ff788a', s => s.pid?.p], ['I', '#a88bfa', s => s.pid?.i], ['D', '#8da6bb', s => s.pid?.d], ['Feedforward + deadband', '#65b5ff', s => s.pid?.ff], ['Startup', '#ff9d5b', s => s.pid?.startup]]
};
const hiddenPidTraces = {speed: new Set(), position: new Set(), output: new Set()};
for (const [key, traces] of Object.entries(pidPlotTraces)) {
  traces.forEach(([label, color], index) => {
    const button = traceButton($(`pid-${key}-legend`), label, color, true, () => {
      const hidden = hiddenPidTraces[key];
      hidden.has(index) ? hidden.delete(index) : hidden.add(index);
      button.setAttribute('aria-pressed', String(!hidden.has(index))); renderCharts();
    });
  });
}
$('pid-axis').addEventListener('change', () => { render(); renderCharts(); });
function pidPlotSample(sample, axis) {
  const motion=sample.servo_motion?.[axis], pid=sample.servo_pid?.[axis], position=sample.servo_position?.[axis];
  const low=axis === 'TILT' && !sample.tilt_imu?.active ? sample.tilt_config?.amin : motion?.minangle;
  const high=axis === 'TILT' && !sample.tilt_imu?.active ? sample.tilt_config?.amax : motion?.maxangle;
  return {motion: motion && {...motion,angle:displayAngle(axis,motion.angle)},
    pid:pid && {...pid,setpoint:pid.mode === 1 ? displayAngle(axis,pid.setpoint) : pid.setpoint},
    position:position && {...position,target:displayAngle(axis,position.target)},
    min:displayAngle(axis,axis === 'TILT' ? high : low),max:displayAngle(axis,axis === 'TILT' ? low : high)};
}

function sourceChanged() {
  const mode = $('mode').value;
  $('agent-field').hidden = mode !== 'remote'; $('agent').required = mode === 'remote';
  for (const id of ['port-field', 'baud-field', 'find']) $(id).hidden = mode === 'demo';
  for (const id of ['baud-field', 'find']) $(id).hidden = mode === 'demo' || mode === 'tcp';
  $('baud').required = mode !== 'tcp' && mode !== 'demo';
  $('port-label').textContent = mode === 'tcp' ? 'ESP address (host:port)' : 'Serial port';
  $('port').placeholder = mode === 'tcp' ? '192.168.20.1:9000' : 'Find ports or enter COM port';
  $('port').required = mode !== 'demo';
  $('source-hint').textContent = {
    tcp: 'Join the ESP Wi-Fi network or use the same router, then enter its IP address and TCP port. No PlatformIO agent required.',
    remote: 'Connect through your running PlatformIO agent. Close any other monitor using the same port.',
    direct: 'Connect the Nano by USB to this computer. Close PlatformIO Serial Monitor before connecting.',
    demo: 'Simulated data for exploring the dashboard. No hardware or remote agent is used.'
  }[mode];
  $('port').value = rememberedPorts[mode] || (mode === 'tcp' ? '192.168.20.1:9000' : ''); $('ports').replaceChildren(); $('notice').textContent = '';
}
function syncDebugSources() {
  const show = $('show-debug-sources').checked;
  $('debug-sources').hidden = !show;
  try { localStorage.setItem('adc-show-debug-sources', show ? '1' : '0'); } catch {}
  if (!show && ['remote', 'direct'].includes($('mode').value)) {
    $('mode').value = 'tcp';
    sourceChanged();
  }
}
try { $('show-debug-sources').checked = localStorage.getItem('adc-show-debug-sources') === '1'; } catch {}
$('show-debug-sources').addEventListener('change', syncDebugSources);
$('mode').addEventListener('change', sourceChanged);
$('adc-channel').addEventListener('change', () => {
  selectedChannel = Number($('adc-channel').value); selectedTraces.clear(); selectedTraces.add(selectedChannel); saveTraces(); render();
});
$('adc-units').addEventListener('change', render);
$('window').addEventListener('change', render);
syncDebugSources();
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
$('telemetry-lean').addEventListener('change', () => action(async () => {
  const lean = $('telemetry-lean').checked;
  await api('/api/adc-stream', {enabled: !lean});
  $('notice').textContent = lean
    ? 'Lean telemetry queued — ADC batches off; status + servo feedback stay on-device.'
    : 'Full ADC stream queued.';
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
    // Cold start: skip historical backlog so Firefox never parses megabytes of buffered samples.
    const cold = cursor === 0 && session < 0;
    const response = await fetch(`/api/state?since=${cold ? 2147483647 : cursor}`, {cache: 'no-store'});
    if (!response.ok) throw new Error('Relay unavailable');
    const next = await response.json();
    if (!cold && next.cursor < cursor) {
      samples = []; logs = []; rawDirty = true; cursor = 0; session = -1;
      state = next; relayUp = true;
      if (next.latest) samples = [next.latest];
      cursor = next.cursor;
      render();
      return;
    }
    if (cold || next.session !== session) {
      samples = next.latest ? [next.latest] : [];
      logs = [];
      rawDirty = true;
      session = next.session;
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
    if (!cold) {
      if (next.samples?.length) {
        samples.push(...next.samples); samples = samples.slice(-10000);
      }
      if (next.logs?.length) {
        logs.push(...next.logs.map(line => line.text)); logs = logs.slice(-400);
        rawDirty = true;
      }
    }
    cursor = next.cursor;
    updateRawMonitor();
    render();
  } catch (error) {
    relayUp = false; $('status').textContent = 'Relay offline'; $('status').className = 'badge warn';
    $('connection-message').textContent = 'Cannot reach the local relay. Restart start-dashboard.ps1; this page will reconnect.';
    document.body.classList.add('stale');
  } finally {
    updateButtons();
    setTimeout(poll, document.body.classList.contains('map-view') ? 150 : 40);
  }
}

function renderMapOnly() {
  const latest = samples.at(-1) || state?.latest;
  const age = latest ? Math.max(0, Date.now() / 1000 - latest.received_at) : Infinity;
  const stale = !relayUp || state?.status !== 'connected' || age > 3;
  const attitude = sensorOrientation(latest?.accel, latest?.mag);
  const sensorAge = latest ? Date.now() / 1000 - (latest.sensor_received_at ?? latest.received_at) : Infinity;
  const orientationStale = stale || sensorAge > 3;
  if (typeof deviceMap !== 'undefined') {
    deviceMap.update(attitude?.heading, orientationStale,
      Number.isFinite(latest?.tilt_imu?.angle) ? displayAngle('TILT', latest.tilt_imu.angle) : null,
      latest?.servo_position?.TILT?.active ? displayAngle('TILT', latest.servo_position.TILT.target) : null,
      Number.isFinite(latest?.servo_motion?.PAN?.angle) ? latest.servo_motion.PAN.angle : null,
      latest?.servo_position?.PAN?.active ? latest.servo_position.PAN.target : null,
      stale,
      latest?.effective_config?.pan_fb);
    if (state?.track_sim) deviceMap.applyRelaySim(state.track_sim);
  }
  if (state && relayUp) {
    let label = state.status === 'connected' ? (age > 3 ? 'Waiting for data' : 'Live') : state.status;
    if (state.mode === 'demo') label = `DEMO · ${label}`;
    $('status').textContent = label.charAt(0).toUpperCase() + label.slice(1);
    $('status').className = `badge ${state.status === 'error' || (state.status === 'connected' && age > 3) ? 'warn' : stale ? '' : 'live'}`;
    $('connection-message').textContent = state.message;
  }
  $('freshness').textContent = latest ? `Last sample ${age.toFixed(1)}s ago${stale ? ' · retained value' : ''}` : 'No samples received';
  document.body.classList.toggle('stale', stale);
}

function render() {
  // Map tab: do not thrash the hidden Controls DOM/charts — that freezes Firefox after Leaflet opens.
  if (document.body.classList.contains('map-view')) {
    renderMapOnly();
    return;
  }
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
  const attitude = sensorOrientation(latest?.accel, latest?.mag);
  const sensorAge = latest ? Date.now() / 1000 - (latest.sensor_received_at ?? latest.received_at) : Infinity;
  const orientationStale = stale || sensorAge > 3;
  if (typeof deviceMap !== 'undefined') deviceMap.update(attitude?.heading, orientationStale,
    Number.isFinite(latest?.tilt_imu?.angle) ? displayAngle('TILT',latest.tilt_imu.angle) : null,
    latest?.servo_position?.TILT?.active ? displayAngle('TILT',latest.servo_position.TILT.target) : null,
    Number.isFinite(latest?.servo_motion?.PAN?.angle) ? latest.servo_motion.PAN.angle : null,
    latest?.servo_position?.PAN?.active ? latest.servo_position.PAN.target : null,
    stale,
    latest?.effective_config?.pan_fb);
  if (typeof panTune !== 'undefined') panTune.update(attitude?.heading, latest);
  $('orientation-state').textContent = !attitude ? 'Waiting for acceleration' : orientationStale ? 'Stale estimate' : 'Sensor-frame estimate';
  $('orientation-state').className = `badge ${attitude && !orientationStale ? 'live' : 'warn'}`;
  $('orientation-values').textContent = attitude ? `Roll ${attitude.roll.toFixed(1)}° · Pitch ${attitude.pitch.toFixed(1)}° · Heading ${attitude.heading == null ? 'unavailable' : attitude.heading.toFixed(1) + '°'}` : 'No valid orientation estimate';
  drawOrientation($('orientation-indicator'), attitude, orientationStale || !attitude);
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
  const link = latest?.link_health, ageMs = acquisition?.data_age_ms;
  const lean = latest?.effective_config?.adc_stream === 0;
  const statusAgeMs = latest?.received_at != null ? Math.max(0, Date.now() - latest.received_at * 1000) : null;
  const receiving = relayUp && state?.status === 'connected' && (lean
    ? statusAgeMs != null && statusAgeMs < 1500
    : ageMs != null && ageMs < 1000);
  $('link-state').textContent = state?.mode === 'demo' ? 'Demo' : lean
    ? (receiving ? 'Lean · status only' : 'Lean · no status')
    : receiving ? 'Receiving ADC' : 'No recent ADC';
  $('link-state').className = `badge ${receiving ? 'live' : 'warn'}`;
  $('link-age').textContent = lean
    ? (statusAgeMs == null ? 'No status yet' : `${Math.round(statusAgeMs).toLocaleString()} ms ago (status)`)
    : ageMs == null ? 'No ADC received' : `${Math.round(ageMs).toLocaleString()} ms ago`;
  const leanBox = $('telemetry-lean');
  if (leanBox) {
    leanBox.disabled = !connected;
    if (document.activeElement !== leanBox && latest?.effective_config?.adc_stream != null) {
      leanBox.checked = latest.effective_config.adc_stream === 0;
    }
  }
  $('link-throughput').textContent = acquisition ? `${acquisition.received_hz_10s?.toLocaleString() ?? '—'} scans/s · ${acquisition.adc_kbytes_s_10s ?? '—'} KB/s` : '—';
  $('link-gaps').textContent = acquisition ? `${(acquisition.recent_gaps || 0).toLocaleString()} · ${acquisition.recent_gap_percent ?? 0}%` : '—';
  $('link-buffer').textContent = link ? `${link.queued.toLocaleString()} / ${link.capacity.toLocaleString()} · ${rates?.adc > 0 ? Math.round(link.queued * 1000 / rates.adc) + ' ms' : 'delay unknown'}${receiving ? '' : ' (last reported)'}` : 'Requires updated ESP firmware';
  const closeReasons = {0:'none', 1:'peer disconnected', 2:'socket error', 3:'no send progress for 5 s', 4:'send queue overflow', 5:'Wi-Fi unavailable'};
  $('link-stalls').textContent = link ? `${link.stalls.toLocaleString()} / ${link.failed.toLocaleString()} · longest write ${link.maxwrite} ms · pending ${link.pending ?? '—'} bytes${link.close == null ? '' : ' · last close: ' + (closeReasons[link.close] || link.close)}${link.cmdmax == null ? '' : ` · ${link.commands} commands · max command ${link.cmdmax} µs · max control update ${link.ctrlmax} µs`}` : 'Requires updated ESP firmware';
  $('link-reconnects').textContent = (acquisition?.reconnects || 0).toLocaleString();
  if (acquisition?.tcp_max_decode_ms != null) $('link-stalls').textContent += ` · max TCP receive gap ${acquisition.tcp_max_receive_gap_ms} ms · max decode ${acquisition.tcp_max_decode_ms} ms`;
  const dropouts = state?.dropouts;
  $('link-dropouts').textContent = `${(dropouts?.count || 0).toLocaleString()}${dropouts?.active ? ' · ongoing' : ''}`;
  $('link-longest-gap').textContent = dropouts ? `${dropouts.longest_gap_ms.toLocaleString()} ms` : '—';
  $('link-last-gap').textContent = dropouts ? `${dropouts.active ? dropouts.current_gap_ms.toLocaleString() + ' ms ongoing' : '—'} / ${dropouts.last_gap_ms.toLocaleString()} ms` : '—';
  $('dropout-log-status').textContent = dropouts?.error ? `Dropout log error: ${dropouts.error}` :
    dropouts?.path ? `${dropouts.running ? 'Logging automatically' : 'Log retained'}: ${dropouts.path}` : 'Dropout logging starts when connected to hardware.';
  $('dropout-download').hidden = !dropouts?.filename;
  const temperature = state?.temperature, temperatureLog = state?.temperature_log;
  const temperatureStale = !relayUp || state?.status !== 'connected' || !temperature || Date.now()/1000 - temperature.received_at > 1;
  $('chip-temperature').textContent = temperature ? `${temperature.celsius == null ? 'Sensor unavailable' : temperature.celsius.toFixed(1) + ' °C'}${temperatureStale ? ' · stale' : ''}` : 'Waiting for temperature';
  $('temperature-download').hidden = !temperatureLog?.filename;
  $('temperature-log-status').textContent = temperatureLog?.error ? `Temperature log error: ${temperatureLog.error}` :
    temperatureLog?.path ? `Temperature CSV: ${temperatureLog.rows.toLocaleString()} samples · ${temperatureLog.path}` : '';
  $('acquisition-status').textContent = rates ?
    `ADC: ${rates.adc.toLocaleString()} scans/s per channel · received: ${acquisition?.received_hz > 0 ? acquisition.received_hz.toLocaleString() + ' scans/s' : 'no raw ADC batch in the last second'} · BMI323: ${rates.bmi.toLocaleString()} reads/s · BMM350: ${rates.mag.toLocaleString()} read attempts/s · missed ticks: ${rates.missed} · buffer drops: ${rates.drops} · invalid scans: ${rates.invalid} · max burst: ${rates.maxscan} µs · received gaps (missed sampling + dropped data): ${acquisition?.sequence_gaps || 0} · corrupt packets: ${acquisition?.corrupt_packets || 0}` :
    state?.mode === 'demo' ? 'Demo data · hardware sampling rates unavailable' : 'Waiting for acquisition statistics';
  for (const axis of ['PAN', 'TILT', 'S3']) {
    $(`servo-${axis}-command`).textContent = state?.servo_commands?.[axis]?.message || '';
    if (axis === lastServoAxis && state?.servo_commands?.[axis]) $('servo-message').textContent = `${axis}: ${state.servo_commands[axis].message}`;
    const form = $(`servo-${axis}`), config = latest?.servos?.[axis];
    const panPanel = form.querySelector('[data-pan-controls]');
    if (panPanel) {
      const calibration = latest?.pan_config, signature = JSON.stringify(calibration);
      if (calibration && panPanel.dataset.reported !== signature) {
        for (const input of panPanel.querySelectorAll('[data-pan-field]')) {
          const key = input.dataset.panField;
          input.value = ['span', 'zero', 'amin', 'amax'].includes(key) ? angleInput(calibration[key]) : calibration[key];
        }
        panPanel.dataset.reported = signature;
        panPanel.querySelector('[data-pan-status]').textContent = `Reported neutral: ${calibration.neutral} us; polarity: ${calibration.polarity}; range: ${calibration.amin} to ${calibration.amax} degrees`;
      }
      const cfg = latest?.effective_config, crSignature = JSON.stringify([session, cfg?.pan_ff, cfg?.pan_rise, cfg?.pan_fall, cfg?.pan_search, cfg?.pan_search_max, cfg?.pan_brake]);
      if (cfg && Number.isFinite(cfg.pan_ff) && panPanel.dataset.cr !== crSignature) {
        for (const input of panPanel.querySelectorAll('[data-pan-cr]')) {
          const key = input.dataset.panCr;
          const map = {ff: cfg.pan_ff, rise: cfg.pan_rise, fall: cfg.pan_fall, search: cfg.pan_search, search_max: cfg.pan_search_max, brake: cfg.pan_brake};
          if (Number.isFinite(map[key])) input.value = map[key];
        }
        panPanel.dataset.cr = crSignature;
      }
    }
    const available = !busy && !servoBusy && !stale && safetyFresh && safety.armed && !safety.estop && !state?.servo_inhibit && config?.ready === 1;
    for (const control of form.querySelectorAll('button, input')) control.disabled = control.closest('details') ? !config : control.hasAttribute('data-off') ? !connected : !available;
    const motion = latest?.servo_motion?.[axis];
    const readout = form.closest('.servo-axis-card').querySelector('[data-axis-readout]');
    const actualAngle = axis === 'TILT' && latest?.tilt_imu?.active ? latest.tilt_imu.angle : motion?.angle;
    readout.textContent = `${axis}${axis !== 'S3' ? ` angle: ${Number.isFinite(actualAngle) ? displayAngle(axis,actualAngle).toFixed(2)+'°' : 'unavailable'}` : ''} · PWM: ${config?.enable ? config.pulse+' µs' : 'OFF'}${stale ? ' · stale' : ''}`;
    if (axis !== 'S3') {
      const position = latest?.servo_position?.[axis], panel = form.querySelector('[data-position-controls]');
      panel.querySelector('[data-position-go]').disabled = !available || !position;
      panel.querySelector('[data-position-stop]').disabled = !connected;
      const imu = axis === 'TILT' ? latest?.tilt_imu : null;
      panel.querySelector('details').hidden = config?.mode !== 1 && !imu?.active;
      panel.querySelector('[data-deadband-controls]').hidden = !!imu?.active;
      if (imu?.active && !imu.ready) panel.querySelector('[data-position-go]').disabled = true;
      const imuPanel = form.querySelector('[data-imu-controls]');
      if (imuPanel) {
        imuPanel.hidden = !imu?.active;
        const fields = [...imuPanel.querySelectorAll('[data-imu-field]')];
        for (const control of [...fields,...imuPanel.querySelectorAll('button')]) control.disabled = !connected || stale || !imu;
        const signature = JSON.stringify([session,imu?.axis,imu?.zero,imu?.amin,imu?.amax,imu?.pmin,imu?.pmax]);
        if (imu && imuPanel.dataset.config !== signature) {
          for (const input of fields) {
            const key = input.dataset.imuField;
            if (key === 'pmin' || key === 'pmax' || key === 'axis') input.value = imu[key] ?? (key === 'pmin' ? 500 : key === 'pmax' ? 2500 : '');
            else input.value = angleInput(imu[key]);
          }
          imuPanel.dataset.config = signature;
        }
        imuPanel.querySelector('[data-imu-reported]').textContent = imu ? `IMU tilt ${imu.angle?.toFixed(2) ?? 'unavailable'}° · ${imu.speed?.toFixed(2) ?? 'unavailable'} °/s · ${imu.ready ? 'Mapping ready' : 'Mapping required'}` : 'Waiting for IMU firmware';
      }
      const sweepPanel = form.querySelector('[data-pwm-sweep]');
      if (sweepPanel) {
        for (const control of sweepPanel.querySelectorAll('button, input')) {
          control.disabled = control.hasAttribute('data-off') ? !connected : !available;
        }
        if (sweepPanel.dataset.pwmSweepActive === '1' && config?.enable && Number.isFinite(config.pulse)) {
          const end = Number(sweepPanel.dataset.pwmSweepEnd);
          const status = sweepPanel.querySelector('[data-pwm-sweep-status]');
          if (status) {
            if (Number.isFinite(end) && Math.abs(config.pulse - end) <= 1) {
              delete sweepPanel.dataset.pwmSweepActive;
              status.textContent = `Sweep complete · holding ${config.pulse} µs`;
            } else status.textContent = `Sweeping… ${config.pulse} → ${Number.isFinite(end) ? end : '—'} µs`;
          }
        }
      }
      const slewPanel = form.querySelector('[data-pwm-slew]');
      if (slewPanel) {
        for (const control of slewPanel.querySelectorAll('button, input')) control.disabled = !available;
        const slewSignature = JSON.stringify([session, motion?.slew_rate, motion?.slew_accel]);
        if (slewPanel.dataset.slew !== slewSignature && Number.isFinite(motion?.slew_rate) && Number.isFinite(motion?.slew_accel)) {
          slewPanel.querySelector('[data-pwm-slew-rate]').value = motion.slew_rate;
          slewPanel.querySelector('[data-pwm-slew-accel]').value = motion.slew_accel;
          slewPanel.dataset.slew = slewSignature;
        }
      }
      const gainInputs = [...panel.querySelectorAll('[data-position-gain]')];
      for (const control of [...gainInputs, panel.querySelector('[data-position-save]')]) control.disabled = !connected || stale || !position;
      panel.querySelector('[data-position-reported]').textContent = position ? `Reported target: ${displayAngle(axis,position.target).toFixed(2)} deg · ${config?.raw ? 'Manual direct PWM active' : position.active ? (config?.mode === 0 ? (imu?.active ? 'IMU angle controller' : 'Servo internal position control') : 'Position controller active') : 'Stopped'} · Ramp rate: ${position.ramprate ?? 'unavailable'} deg/s` : 'Waiting for position-controller firmware';
      const rampRate = panel.querySelector('[data-position-ramp-rate]');
      for (const control of [rampRate,panel.querySelector('[data-position-ramp-save]')]) control.disabled = !connected || stale || !Number.isFinite(position?.ramprate);
      const rateSignature = JSON.stringify([session,position?.ramprate]);
      if (panel.dataset.rampRate !== rateSignature) { rampRate.value = position?.ramprate ?? ''; panel.dataset.rampRate = rateSignature; }
      const noRamp = panel.querySelector('[data-position-no-ramp]');
      noRamp.disabled = !connected || stale || !Number.isFinite(position?.ramp);
      const rampSignature = JSON.stringify([session,position?.ramp]);
      if (panel.dataset.ramp !== rampSignature) { noRamp.checked = position?.ramp === 0; panel.dataset.ramp = rampSignature; }
      if (Number.isFinite(position?.ramp)) panel.querySelector('[data-position-reported]').textContent += position.ramp ? ' ? Target ramp enabled' : ' ? Target ramp disabled';
      const dbInputs = [...panel.querySelectorAll('[data-position-db]')];
      const hasDeadband = Number.isFinite(position?.dbplus) && Number.isFinite(position?.dbminus);
      for (const control of [...dbInputs, panel.querySelector('[data-position-db-save]')]) control.disabled = !connected || stale || !hasDeadband;
      if (hasDeadband) {
        const signature = JSON.stringify([session,position.dbplus,position.dbminus]);
        if (panel.dataset.deadband !== signature) { for (const input of dbInputs) input.value = position[input.dataset.positionDb]; panel.dataset.deadband = signature; }
      }
      panel.querySelector('[data-position-db-reported]').textContent = hasDeadband ? `Reported: above neutral ${position.dbplus} us; below neutral ${position.dbminus} us` : 'Waiting for deadband-capable firmware';
      const breakawayPanel = panel.querySelector('[data-breakaway-controls]');
      if (breakawayPanel && !breakawayPanel.hidden) {
        const cfg = latest?.effective_config;
        const hasBreakaway = Number.isFinite(cfg?.pan_breakaway_us) && Number.isFinite(cfg?.pan_breakaway_ms);
        const hasSchedule = Number.isFinite(cfg?.pan_kp_near) && Number.isFinite(cfg?.pan_schedule_deg);
        const breakawayInputs = [...breakawayPanel.querySelectorAll('[data-breakaway-field]')];
        const scheduleInputs = [...breakawayPanel.querySelectorAll('[data-schedule-field]')];
        for (const control of [...breakawayInputs, breakawayPanel.querySelector('[data-breakaway-save]')]) control.disabled = !connected || stale || !hasBreakaway;
        for (const control of [...scheduleInputs, breakawayPanel.querySelector('[data-schedule-save]')]) control.disabled = !connected || stale || !hasSchedule;
        if (hasBreakaway) {
          const signature = JSON.stringify([session, cfg.pan_breakaway_us, cfg.pan_breakaway_ms]);
          if (breakawayPanel.dataset.breakaway !== signature) {
            breakawayPanel.querySelector('[data-breakaway-field="offset_us"]').value = cfg.pan_breakaway_us;
            breakawayPanel.querySelector('[data-breakaway-field="duration_ms"]').value = cfg.pan_breakaway_ms;
            breakawayPanel.dataset.breakaway = signature;
          }
        }
        if (hasSchedule) {
          const map = {kp_near: 'pan_kp_near', cap_near: 'pan_cap_near', schedule_deg: 'pan_schedule_deg', brk_min_scale: 'pan_brk_min_scale', settle_deg: 'pan_settle_deg'};
          const signature = JSON.stringify([session, ...Object.values(map).map(key => cfg[key])]);
          if (breakawayPanel.dataset.schedule !== signature) {
            for (const input of scheduleInputs) input.value = cfg[map[input.dataset.scheduleField]];
            breakawayPanel.dataset.schedule = signature;
          }
        }
        const parts = [];
        if (hasBreakaway) parts.push(`spike ${cfg.pan_breakaway_us} us / ${cfg.pan_breakaway_ms} ms`);
        if (hasSchedule) parts.push(`near Kp ${cfg.pan_kp_near} cap ${cfg.pan_cap_near} · schedule ${cfg.pan_schedule_deg}° · brk≥${cfg.pan_brk_min_scale} · settle ${cfg.pan_settle_deg}°`);
        breakawayPanel.querySelector('[data-breakaway-reported]').textContent = parts.length
          ? `Reported: ${parts.join(' · ')}`
          : 'Waiting for breakaway/schedule-capable firmware';
      }
      if (position) {
        const signature = JSON.stringify([session, ...gainInputs.map(input=>position[input.dataset.positionGain])]);
        if (panel.dataset.gains !== signature) { for(const input of gainInputs) input.value = position[input.dataset.positionGain]; panel.dataset.gains = signature; }
        panel.querySelector('[data-position-gains]').textContent = `Reported: P ${position.kp}, I ${position.ki}, D ${position.kd} · integral ±${position.ilimit} us · output ±${position.cap} us · tolerance ${position.tolerance} deg`;
        const angle = panel.querySelector('[data-position-angle]');
        // Device-frame travel (firmware already sorts IMU map endpoints). Convert to
        // display space, then Math.min/max so descending maps never set min > max.
        // Use IMU mapping endpoints when active — not the live unwrapped IMU angle.
        let deviceLow = imu?.active
          ? (Number.isFinite(imu.amin) && Number.isFinite(imu.amax) ? Math.min(imu.amin, imu.amax) : motion?.minangle)
          : Math.max(motion?.minangle ?? 0, axis === 'TILT' ? latest.tilt_config?.amin ?? -360 : -360);
        let deviceHigh = imu?.active
          ? (Number.isFinite(imu.amin) && Number.isFinite(imu.amax) ? Math.max(imu.amin, imu.amax) : motion?.maxangle)
          : Math.min(motion?.maxangle ?? 360, axis === 'TILT' ? latest.tilt_config?.amax ?? 360 : 360);
        if (!Number.isFinite(deviceLow)) deviceLow = -360;
        if (!Number.isFinite(deviceHigh)) deviceHigh = 360;
        const displayLimits = [displayAngle(axis, deviceLow), displayAngle(axis, deviceHigh)];
        const displayMin = Math.round(Math.min(...displayLimits) * 100) / 100;
        const displayMax = Math.round(Math.max(...displayLimits) * 100) / 100;
        angle.min = displayMin; angle.max = displayMax; angle.step = '0.01';
        const preferred = displayAngle(axis, Number.isFinite(motion?.angle) ? motion.angle : position.target);
        const clamped = angleInput(Number.isFinite(preferred) ? Math.min(displayMax, Math.max(displayMin, preferred)) : displayMin);
        // Seed on new session; also pull the field back into range when not editing so
        // unwrapped IMU angles (~330°) cannot leave the input invalid for Go.
        if (document.activeElement !== angle) {
          const current = angle.valueAsNumber;
          const outOfRange = !Number.isFinite(current) || current < displayMin || current > displayMax;
          if (angle.dataset.session !== String(session) || outOfRange) {
            angle.value = clamped;
            angle.dataset.session = String(session);
          }
        }
      }
      for (const control of form.querySelectorAll('[data-raw-controls] button, [data-raw-controls] input')) control.disabled = control.hasAttribute('data-off') ? !connected : !available;
      const input = form.querySelector('[data-speed]');
      input.disabled = form.querySelector('[data-speed-apply]').disabled = !connected || stale || !motion;
      const overspeed = form.querySelector('[data-overspeed]');
      overspeed.disabled = !connected || stale || motion?.osfault == null;
      overspeed.textContent = motion?.osfault == null ? 'Overspeed fault: waiting for board' : motion.osfault === 1 ? 'Disable overspeed fault (currently ON)' : 'Enable overspeed fault (currently OFF)';
      overspeed.setAttribute('aria-pressed', String(motion?.osfault === 1));
      if (motion) {
        if (input.dataset.requestedSpeed != null && Number(input.dataset.requestedSpeed) === motion.limit) {
          form.querySelector('[data-speed-status]').textContent = motion.limit === 0 ? 'Board confirmed raw PWM mode; degrees/s limit disabled' : `Board confirmed ${motion.limit} deg/s limit`;
          delete input.dataset.requestedSpeed;
        }
        if (input.dataset.session !== String(session)) { input.value = motion.limit; input.dataset.session = String(session); }
        const number = value => value == null ? 'unavailable' : value.toFixed(2);
        form.querySelector('[data-motion]').textContent = `Device angle: ${number(displayAngle(axis,motion.angle))}° · Speed: ${number(motion.speed)} deg/s · ${motion.limit === 0 ? 'RAW PWM — speed regulation disabled' : `Limit: ${motion.limit} deg/s`} · ${config?.mode === 1 ? `Demand: ${motion.target} µs · Requested speed: ${motion.limit === 0 ? 'unregulated' : number(motion.commandspeed) + ' deg/s'} · Neutral: ${config.neutral} µs` : `Target: ${motion.target} µs · PWM angle calibration: ${motion.minangle}–${motion.maxangle}°`}${motion.moving ? ' · moving' : ''}`;
      } else form.querySelector('[data-motion]').textContent = 'Waiting for motion telemetry';
    }
    if (config) {
      form.querySelector('[data-neutral]').hidden = config.mode !== 1;
      $(`servo-${axis}-pulse`).parentElement.firstChild.textContent = config.mode === 1 ? 'Speed/direction demand (µs)' : 'Pulse width (µs)';
      const signature = JSON.stringify([session, config.mode, config.pmin, config.pcenter, config.pmax, config.fmin, config.fcenter, config.fmax, config.umin, config.ucenter, config.umax]);
      for (const [key, prefix] of [['pulse', 'p'], ['frequency', 'f']]) {
        const input = $(`servo-${axis}-${key}`);
        input.min = config[`${prefix}min`]; input.max = config[`${prefix}max`];
        if (form.dataset.config !== signature) input.value = prefix === 'p' ? (config.mode === 1 ? config.neutral : presetsFor(axis, config).center) : config.fcenter;
      }
      form.dataset.config = signature;
      const pending = state?.servo_commands?.[axis]?.state;
      for (const stepButton of form.querySelectorAll('[data-step]')) {
        const step = Number(stepButton.dataset.step), nextPulse = $(`servo-${axis}-pulse`).valueAsNumber + step;
        stepButton.disabled = !available || !Number.isInteger(nextPulse) || nextPulse < config.pmin || nextPulse > config.pmax ||
          !$(`servo-${axis}-frequency`).checkValidity() || ['queued', 'sent'].includes(pending);
        stepButton.title = `Immediately command the pulse field ${step > 0 ? '+' : ''}${step} µs, within ${config.pmin}–${config.pmax} µs. Wait for acknowledgement between steps.`;
      }
      const settings = form.querySelector('[data-preset-controls]'), presets = presetsFor(axis, config);
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
    if (axis === 'TILT') {
      const settings = form.querySelector('[data-tilt-config]'), tilt = latest?.tilt_config;
      const continuous = config?.mode === 1;
      settings.hidden = !continuous;
      if (continuous) {
        const usable = connected && !stale && !!tilt;
        const running = tilt?.sweep === 1;
        for (const input of settings.querySelectorAll('input, select')) input.disabled = !usable || running;
        for (const button of settings.querySelectorAll('[data-tilt-action]')) {
          const action = button.dataset.tiltAction;
          button.disabled = action === 'sweep_stop' ? !connected : !usable || running ||
            (action === 'sweep_start' && (!available || tilt.sweep === 1)) || (action === 'sweep_apply' && tilt.sweep !== 2);
        }
        if (tilt) {
          const signature = JSON.stringify([session, tilt.vmin, tilt.vmax, tilt.zero, tilt.amin, tilt.amax]);
          if (settings.dataset.config !== signature) {
            for (const input of settings.querySelectorAll('[data-tilt-field]')) {
              const key = input.dataset.tiltField;
              input.value = key === 'vmin' || key === 'vmax' ? tilt[key] : angleInput(tilt[key]);
            }
            settings.dataset.config = signature;
          }
          settings.querySelector('[data-tilt-reported]').textContent = `Reported: ${tilt.volts?.toFixed(4) ?? 'unavailable'} V · zero ${tilt.zero}° · limits ${tilt.amin}°–${tilt.amax}° · ${tilt.vmin}–${tilt.vmax} V`;
          const reasons = ['No fault', 'No pot movement detected; check neutral, drive cap and feedback', 'Pot feedback stale', 'Invalid pot voltage', 'Sweep timed out before a full turn', 'Rotation opposed the selected pot direction', 'Measured speed exceeded the sweep threshold', 'PWM update failed'];
          settings.querySelector('[data-sweep-reported]').textContent = `Pot sweep: ${['idle','running','complete','cancelled','fault'][tilt.sweep] ?? '?'} · ${tilt.progress?.toFixed(1) ?? '—'}° · ${tilt.smin?.toFixed(3) ?? '—'}–${tilt.smax?.toFixed(3) ?? '—'} V`;
          if (tilt.sweep === 4) settings.querySelector('[data-tilt-status]').textContent = reasons[tilt.reason] || 'Sweep fault';
          else if (tilt.sweep === 1) settings.querySelector('[data-tilt-status]').textContent = 'Pot sweep running';
          else if (tilt.sweep === 2) settings.querySelector('[data-tilt-status]').textContent = 'Pot sweep complete';
          else if (tilt.sweep === 3) settings.querySelector('[data-tilt-status]').textContent = 'Pot sweep cancelled';
        } else settings.querySelector('[data-tilt-reported]').textContent = 'Waiting for TILT calibration telemetry';
        if (running) for (const control of form.querySelectorAll('button, input')) {
          if (!control.closest('[data-tilt-config]') && !control.hasAttribute('data-off')) control.disabled = true;
        }
      }
    }
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

window.dashboard = {
  samples: () => samples,
  latest: () => samples.at(-1) || state?.latest || null,
  state: () => state,
  recentLogs: () => logs.slice(-40),
  api,
};

function renderCharts() {
  if (typeof panTune !== 'undefined') panTune.paint();
  for (const servoAxis of ['PAN','TILT','S3']) {
    if (servoAxis !== 'S3') chart(`servo-${servoAxis}-position-chart`, sample => {
      const s = pidPlotSample(sample,servoAxis);
      return [s.motion?.angle ?? null,s.position?.active ? s.position.target : null,s.pid?.mode === 1 ? s.pid.setpoint : null];
    },3,undefined,2,undefined,['#4bd3b5','#a88bfa','#65b5ff'],{sensorTime:true,key:servoAxis,wrapBreak:180,labels:['Actual','Target','Ramped target']});
    chart(`servo-${servoAxis}-pwm-chart`, sample => [sample.servos?.[servoAxis]?.enable ? sample.servos[servoAxis].pulse : null],1,undefined,1,undefined,['#f5bd4f'],{sensorTime:true,key:servoAxis,labels:['PWM']});
  }
  const axis = $('pid-axis').value, latest = samples.at(-1) || state?.latest;
  const current = pidPlotSample(latest || {}, axis);
  const phase = axis === 'TILT' && current.pid?.mode !== 1 && current.pid?.phase != null ? ` · ${['Stopped', 'Starting', 'Running', 'Recovering'][current.pid.phase] || 'Unknown phase'}` : '';
  $('pid-state').textContent = current.pid ? `${axis} · ${current.pid.active ? 'Controller active' : 'Controller idle'} · Position ${fmt(current.motion?.angle)}° · Speed ${fmt(current.motion?.speed)} deg/s · PWM ${latest?.servos?.[axis]?.enable ? latest.servos[axis].pulse + ' µs' : 'OFF'}` : 'Waiting for controller telemetry';
  $('pid-state').textContent += phase;
  for (const [key, definitions] of Object.entries(pidPlotTraces)) {
    const traces = definitions.filter((trace, index) => !hiddenPidTraces[key].has(index));
    chart(`pid-${key}-chart`, sample => traces.map(([, , get]) => get(pidPlotSample(sample, axis)) ?? null),
      traces.length, undefined, 2, undefined, traces.map(([, color]) => color), {
        sensorTime: true, key: axis, wrapBreak: key === 'position' ? 180 : undefined,
        labels: traces.map(([label]) => label),
      });
  }
  const rawMode = $('adc-units').value === 'raw';
  for (const key of ['accel', 'gyro', 'mag']) {
    const axes = [0, 1, 2].filter(axis => !hiddenAxes[key].has(axis));
    chart(`${key}-chart`, sample => axes.map(axis => sample[key]?.[axis] ?? null), axes.length, undefined, undefined, undefined, axes.map(axis => colors[axis]), {
      labels: axes.map(axis => ['X', 'Y', 'Z'][axis]),
    });
  }
  const value = (sample, channel) => sample.adc_mean?.[channel] ?? sample.adc[channel];
  const bounds = (sample, channel) => [sample.adc_min?.[channel] ?? sample.adc[channel], sample.adc_max?.[channel] ?? sample.adc[channel]]
    .map(value => rawMode ? value : scaledAdc(value, channel));
  const channels = [...selectedTraces].sort((a, b) => a - b);
  chart('adc-chart', sample => channels.map(channel => rawMode ? value(sample, channel) : scaledAdc(value(sample, channel), channel)), channels.length, undefined, undefined, sample => channels.map(channel => bounds(sample, channel)), channels.map(channel => channelColors[channel]), {
    labels: channels.map(channel => `CH${channel}`),
  });
  const feedback = [5, 6, 7].filter((channel, axis) => !hiddenAxes.feedback.has(axis));
  chart('feedback-chart', sample => feedback.map(channel => rawMode ? value(sample, channel) : scaledAdc(value(sample, channel), channel)), feedback.length, undefined, undefined, sample => feedback.map(channel => bounds(sample, channel)), feedback.map(channel => channelColors[channel]), {
    labels: feedback.map(channel => `CH${channel}`),
  });
}

const chartScales = new Map();
function chart(id, getValues, axes, fixedRange, decimals = fixedRange ? 0 : 1, getBounds, traceColors = colors, options = {}) {
  const canvas = $(id), box = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  const width = box.width, height = box.height;
  if (!width) return;
  const pixelWidth = Math.round(width * dpr), pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth; canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
  const pad = {left: 48, right: 12, top: 14, bottom: 25};
  const w = width - pad.left - pad.right, h = height - pad.top - pad.bottom;
  const stamp = sample => options.sensorTime && sample.sensor_device_ms != null && state?.acquisition?.clock_offset != null ? sample.sensor_device_ms / 1000 + state.acquisition.clock_offset : options.sensorTime && sample.sensor_received_at != null ? sample.sensor_received_at : sample.device_us != null && state?.acquisition?.clock_offset != null ?
    sample.device_us / 1e6 + state.acquisition.clock_offset : sample.plot_at ?? sample.received_at;
  const last = samples.length ? stamp(samples.at(-1)) : Date.now() / 1000;
  const end = Math.min(last, Date.now() / 1000 - .2), span = Number($('window').value);
  let visible = samples.filter(s => stamp(s) >= end - span && stamp(s) <= end);
  if (options.sensorTime) visible = [...new Map(visible.map(sample => [stamp(sample), sample])).values()];
  const hoverSeries = Array.from({ length: axes }, (_, axis) => ({
    label: options.labels?.[axis] ?? `Trace ${axis + 1}`,
    color: traceColors[axis],
    points: [],
  }));
  for (const sample of visible) {
    const t = stamp(sample);
    const vals = getValues(sample);
    for (let axis = 0; axis < axes; axis++) hoverSeries[axis].points.push({ t, v: vals[axis] });
  }
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
  if (!fixedRange && values.length) {
    const now = performance.now(), signature = JSON.stringify([session, traceColors, $('adc-units').value, span, channelScaling, options.key]);
    let scale = chartScales.get(id);
    if (!scale || scale.signature !== signature) {
      scale = {low, high, signature, expandedAt: now, paintedAt: now};
    } else if (low < scale.low || high > scale.high) {
      // Expand promptly for real excursions; hold the range through noisy updates.
      scale.low = Math.min(scale.low, low); scale.high = Math.max(scale.high, high); scale.expandedAt = now;
    } else if (now - scale.expandedAt > 5000 && high - low < (scale.high - scale.low) * .75) {
      const alpha = 1 - Math.exp(-Math.min(250, now - scale.paintedAt) / 2000);
      scale.low += (low - scale.low) * alpha; scale.high += (high - scale.high) * alpha;
    }
    scale.paintedAt = now; chartScales.set(id, scale); low = scale.low; high = scale.high;
  }
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
      const disconnected = !Number.isFinite(value) || !previous || stamp(sample)-stamp(previous) > 2 || sample.device_ms < previous.device_ms || (options.wrapBreak && Math.abs(value - getValues(previous)[axis]) > options.wrapBreak);
      if (!limits.length) { previous = null; continue; }
      const bucket = buckets.at(-1);
      if (bucket && bucket.pixel === pixel && !disconnected) {
        bucket.low = Math.min(bucket.low, ...limits); bucket.high = Math.max(bucket.high, ...limits);
        const weight = sample.scan_count || 1;
        if (Number.isFinite(value)) {
          bucket.value = (bucket.value * bucket.weight + value * weight) / (bucket.weight + weight);
          bucket.weight += weight;
        }
      } else buckets.push({pixel, low: Math.min(...limits), high: Math.max(...limits), value: Number.isFinite(value) ? value : limits[0], weight: sample.scan_count || 1, disconnected});
      previous = sample;
    }
    // A continuous translucent min/max band preserves spikes without flashing
    // a changing set of vertical strokes whenever samples shift pixel buckets.
    if (getBounds) {
      ctx.globalAlpha = .12; ctx.fillStyle = traceColors[axis];
      let segment = [];
      const fillBand = () => {
        if (!segment.length) return;
        ctx.beginPath();
        segment.forEach((bucket, index) => {
          const x = pad.left + bucket.pixel, y = pad.top + (high - bucket.high) / (high - low) * h;
          if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        });
        for (let index = segment.length - 1; index >= 0; index--) {
          const bucket = segment[index];
          ctx.lineTo(pad.left + bucket.pixel, pad.top + (high - bucket.low) / (high - low) * h);
        }
        ctx.closePath(); ctx.fill(); segment = [];
      };
      for (const bucket of buckets) {
        if (bucket.disconnected) fillBand();
        segment.push(bucket);
      }
      fillBand(); ctx.globalAlpha = 1; ctx.beginPath();
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
  if (typeof ChartHover !== 'undefined') {
    ChartHover.finish(ctx, canvas, {
      pad, width, height, low, high, decimals,
      t0: end - span, t1: end, series: hoverSeries,
    });
  }
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
let dropoutViewerTimer = null;
async function refreshDropoutViewer() {
  if ($('dropout-viewer').hidden) return;
  try {
    const response = await fetch('/api/dropouts/events', {cache:'no-store'});
    if (!response.ok) throw new Error('Could not read dropout events');
    const result = await response.json();
    if ($('dropout-viewer').hidden) return;
    const fragment = document.createDocumentFragment();
    for (const event of [...result.events].reverse()) {
      const row = document.createElement('tr');
      for (const value of [event.gap_number, event.event, event.utc, event.last_batch_utc, `${event.gap_ms.toLocaleString()} ms`]) {
        const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
      }
      fragment.append(row);
    }
    $('dropout-events').replaceChildren(fragment);
    $('dropout-viewer-status').textContent = result.events.length ? `Latest ${result.events.length} event rows · ${result.count} dropouts · refreshing every second` : 'No dropouts logged in this session.';
  } catch (error) { $('dropout-viewer-status').textContent = error.message; }
  finally { if (!$('dropout-viewer').hidden) dropoutViewerTimer = setTimeout(refreshDropoutViewer, 1000); }
}
$('dropout-view').addEventListener('click', () => {
  $('dropout-viewer').hidden = !$('dropout-viewer').hidden;
  $('dropout-view').textContent = $('dropout-viewer').hidden ? 'View dropout log' : 'Hide dropout log';
  clearTimeout(dropoutViewerTimer);
  if (!$('dropout-viewer').hidden) refreshDropoutViewer();
});
window.addEventListener('resize', render);
updateButtons(); render(); poll();
let lastPaint = 0;
function animatePlots(now) {
  if (document.body.classList.contains('map-view') || document.hidden) {
    requestAnimationFrame(animatePlots);
    return;
  }
  if (now - lastPaint >= 1000 / 30) { renderCharts(); lastPaint = now; }
  requestAnimationFrame(animatePlots);
}
requestAnimationFrame(animatePlots);
