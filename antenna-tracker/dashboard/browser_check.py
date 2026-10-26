"""Optional UI smoke test: pip install playwright; playwright install chromium."""
import sys
import re
from pathlib import Path
import tempfile
from playwright.sync_api import sync_playwright, expect

url = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8765'
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width': 1440, 'height': 1100})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto(url)
    expect(page.locator('#mode')).to_have_value('tcp')
    expect(page.locator('#port')).to_have_value('192.168.20.1:9000')
    expect(page.locator('#agent-field')).to_be_hidden()
    expect(page.locator('#baud-field')).to_be_hidden()
    expect(page.locator('#find')).to_be_hidden()
    expect(page.locator('#port-label')).to_contain_text('ESP address')
    expect(page.locator('#link-state')).to_have_text('No recent ADC')
    expect(page.locator('#orientation-state')).to_have_text('Waiting for acceleration')
    page.locator('#dropout-view').click()
    expect(page.locator('#dropout-viewer')).to_be_visible()
    expect(page.locator('#dropout-viewer-status')).to_have_text('No dropouts logged in this session.')
    page.locator('#dropout-view').click()
    expect(page.locator('#dropout-viewer')).to_be_hidden()
    orientation = page.evaluate('''() => ({
      level: sensorOrientation([0,0,1], [1,0,0]),
      east: sensorOrientation([0,0,1], [0,-1,0]),
      roll: sensorOrientation([0,0.5,Math.sqrt(3)/2], [1,0,0]),
      pitch: sensorOrientation([-0.5,0,Math.sqrt(3)/2], [Math.sqrt(3)/2,0,0.5]),
      invalid: sensorOrientation([0,0,0], [1,0,0]),
      noHeading: sensorOrientation([0,0,1], null)
    })''')
    assert orientation['level'] == dict(roll=0, pitch=0, heading=0)
    assert orientation['east']['heading'] == 90
    assert abs(orientation['roll']['roll'] - 30) < 1e-6
    assert abs(orientation['pitch']['pitch'] - 30) < 1e-6
    assert abs(orientation['pitch']['heading']) < 1e-6
    assert orientation['invalid'] is None and orientation['noHeading']['heading'] is None
    graph = page.evaluate('''() => {
      const saved = samples, ctx = document.getElementById('adc-chart').getContext('2d');
      const move = ctx.moveTo, line = ctx.lineTo;
      let previousX = null, connections = 0;
      ctx.moveTo = function(x,y) { previousX=x; return move.call(this,x,y); };
      ctx.lineTo = function(x,y) {
        if (this.strokeStyle !== '#263448' && previousX !== null && previousX !== x) connections++;
        previousX=x; return line.call(this,x,y);
      };
      try {
        samples = [
          {plot_at:1000,device_ms:100,adc_sequence:1,scan_count:64,adc:[100]},
          {plot_at:1001,device_ms:1100,adc_sequence:1000,scan_count:64,adc:[200]}
        ];
        chart('adc-chart', s=>[s.adc[0]], 1, undefined, undefined, s=>[[s.adc[0]-10,s.adc[0]+10]]);
        return {connections, heights:Object.fromEntries(['adc-chart','feedback-chart','accel-chart','gyro-chart','mag-chart'].map(id=>[id,document.getElementById(id).getBoundingClientRect().height]))};
      } finally { samples=saved; ctx.moveTo=move; ctx.lineTo=line; }
    }''')
    assert graph['connections'] >= 1, graph
    held_range = page.evaluate('''() => {
      const saved = samples, oldScale = chartScales.get('adc-chart'), now = Date.now()/1000;
      const make = value => ({received_at:now-.5,device_ms:100,adc:[value]});
      try {
        chartScales.delete('adc-chart'); samples=[make(1), {...make(2),device_ms:101}];
        chart('adc-chart', s=>[s.adc[0]], 1);
        const first = {...chartScales.get('adc-chart')};
        samples=[make(1.4), {...make(1.5),device_ms:101}];
        chart('adc-chart', s=>[s.adc[0]], 1);
        const second = chartScales.get('adc-chart');
        return first.low === second.low && first.high === second.high;
      } finally {
        samples=saved; if(oldScale) chartScales.set('adc-chart', oldScale); else chartScales.delete('adc-chart');
      }
    }''')
    assert held_range, 'Y-axis must not contract on each incoming batch'
    assert graph['heights']['adc-chart'] == 360, graph
    assert all(height == 300 for name, height in graph['heights'].items() if name != 'adc-chart'), graph
    print('PASS: connected graph across raw scan gaps; ADC 360px, feedback and IMU 300px')
    page.locator('#mode').select_option('demo')
    page.locator('#connect').click()
    expect(page.locator('#status')).to_contain_text('connected')
    expect(page.locator('#pid-state')).to_contain_text('TILT')
    assert page.locator('#pid-speed-legend button').count() == 4
    assert page.locator('#pid-position-legend button').count() == 3
    assert page.locator('#pid-output-legend button').count() == 7
    trace = page.locator('#pid-output-legend button').filter(has_text='Feedforward')
    trace.click(); expect(trace).to_have_attribute('aria-pressed', 'false')
    trace.click(); expect(trace).to_have_attribute('aria-pressed', 'true')
    page.locator('#pid-axis').select_option('PAN')
    expect(page.locator('#pid-state')).to_contain_text('PAN')
    page.locator('#pid-axis').select_option('TILT')
    assert all(box['height'] == 300 for box in [page.locator('#pid-' + key + '-chart').bounding_box() for key in ('speed', 'position', 'output')])
    overspeed = page.locator('#servo-TILT [data-overspeed]')
    expect(overspeed).to_have_text('Disable overspeed fault (currently ON)')
    overspeed.click()
    expect(overspeed).to_have_text('Enable overspeed fault (currently OFF)')
    overspeed.click()
    expect(overspeed).to_have_text('Disable overspeed fault (currently ON)')
    page.locator('#raw-pause').click()
    expect(page.locator('#raw-pause')).to_have_text('Resume monitor')
    frozen_log = page.locator('#log').text_content()
    page.wait_for_timeout(1200)
    assert page.locator('#log').text_content() == frozen_log
    page.locator('#raw-pause').click()
    expect(page.locator('#raw-pause')).to_have_text('Pause monitor')
    try:
        expect(page.locator('#status')).to_contain_text('Live')
        expect(page.locator('#orientation-state')).to_have_text('Sensor-frame estimate')
        expect(page.locator('#orientation-values')).to_contain_text('Heading')
        assert page.locator('#adc-legend button').count() == 16
        page.locator('#adc-channel').select_option('5')
        page.locator('#trace-ch6').click()
        page.locator('#trace-ch7').click()
        for channel in [5, 6, 7]:
            expect(page.locator(f'#trace-ch{channel}')).to_have_attribute('aria-pressed', 'true')
        plotted = page.evaluate('''() => {
          const ctx = document.getElementById('adc-chart').getContext('2d'), original = ctx.stroke;
          const strokes = new Set();
          ctx.stroke = function() { if (this.strokeStyle !== '#263448') strokes.add(this.strokeStyle); return original.call(this); };
          try { renderCharts(); return [...strokes]; } finally { ctx.stroke = original; }
        }''')
        assert len(plotted) == 3 and len(set(plotted)) == 3, plotted
        page.locator('#trace-ch6').click()
        expect(page.locator('#trace-ch6')).to_have_attribute('aria-pressed', 'false')
        page.reload()
        expect(page.locator('#trace-ch5')).to_have_attribute('aria-pressed', 'true')
        expect(page.locator('#trace-ch6')).to_have_attribute('aria-pressed', 'false')
        expect(page.locator('#trace-ch7')).to_have_attribute('aria-pressed', 'true')
        page.locator('#gyro-legend button').first.click()
        expect(page.locator('#gyro-legend button').first).to_have_attribute('aria-pressed', 'false')
        page.locator('#gyro-legend button').first.click()
        page.locator('#adc-channel').select_option('0')
        print('PASS: multiple colored traces, clickable legends, per-axis visibility and persistent selection')
        page.locator('#adc-diagnostic-channel').select_option('3')
        page.locator('#adc-diagnostic-apply').click()
        expect(page.locator('#adc-diagnostic-reported')).to_contain_text('CH3 only')
        expect(page.locator('#adc-diagnostic-reported')).to_contain_text('16.0 MHz')
        expect(page.locator('#ch2 .adc-number')).to_have_text('OFF')
        expect(page.locator('#ch3 .adc-number')).not_to_have_text('OFF')
        page.locator('#adc-diagnostic-channel').select_option('-1')
        page.locator('#adc-diagnostic-apply').click()
        expect(page.locator('#adc-diagnostic-reported')).to_contain_text('normal scan')
        expect(page.locator('#ch2 .adc-number')).not_to_have_text('OFF')
        print('PASS: single-channel ADC selection, inactive inputs, raw/voltage readout and normal scan restore')
        page.locator('#record-start').click()
        expect(page.locator('#record-status')).to_contain_text('Recording')
        page.wait_for_timeout(500)
        page.locator('#record-stop').click()
        expect(page.locator('#record-status')).to_contain_text('Saved')
        expect(page.locator('#record-download')).to_be_visible()
        csv = page.request.get(url + page.locator('#record-download').get_attribute('href')).text()
        assert len(csv.splitlines()) >= 3, csv
        assert 'device_us' in csv and 'received_utc' in csv and 'ch15_scaled' in csv
        expect(page.locator('#status')).to_contain_text('Live')
        print('PASS: start/stop CSV recording, timestamped download, live viewing continues')
        expect(page.locator('#ranges-reported')).to_contain_text('±8 g')
        page.locator('#accel-range').select_option('16')
        page.locator('#gyro-range').select_option('500')
        page.locator('#apply-ranges').click()
        expect(page.locator('#ranges-reported')).to_contain_text('±16 g')
        expect(page.locator('#ranges-reported')).to_contain_text('±500 °/s')
        expect(page.locator('#servo-PAN-reported')).to_have_text('Reported: OFF')
        expect(page.locator('#servo-safety-state')).to_contain_text('Disabled')
        assert page.locator('#servo-TILT [data-raw-command]').is_disabled()
        for step in [-100, 100]: assert page.locator(f'#servo-TILT [data-step="{step}"]').is_disabled()
        speed = page.locator('#servo-TILT [data-speed]')
        expect(speed).to_be_enabled()
        speed.fill('12.5')
        page.locator('#servo-TILT [data-speed-apply]').click()
        expect(page.locator('#servo-TILT [data-motion]')).to_contain_text('Limit: 12.5 deg/s')
        expect(page.locator('#servo-TILT [data-speed-status]')).to_contain_text('Board confirmed 12.5 deg/s')
        speed.fill('0')
        page.locator('#servo-TILT [data-speed-apply]').click()
        expect(page.locator('#servo-TILT [data-motion]')).to_contain_text('RAW PWM')
        expect(page.locator('#servo-TILT [data-speed-status]')).to_contain_text('limit disabled')
        speed.fill('12.5')
        page.locator('#servo-TILT [data-speed-apply]').click()
        expect(page.locator('#servo-TILT [data-motion]')).to_contain_text('Limit: 12.5 deg/s')
        expect(page.locator('#servo-TILT-reported')).to_contain_text('OFF')
        page.locator('#servo-enable').click()
        expect(page.locator('#servo-safety-state')).to_contain_text('Enabled')
        speed.fill('6.5')
        page.locator('#servo-TILT [data-raw-controls] > summary').click()
        page.locator('#servo-TILT [data-raw-command]').click()
        expect(page.locator('#servo-TILT [data-motion]')).to_contain_text('Limit: 6.5 deg/s')
        expect(page.locator('#servo-TILT [data-speed-status]')).to_contain_text('Board confirmed 6.5 deg/s')
        expect(page.locator('#servo-TILT-pulse')).to_have_value('1500')
        speed.fill('7.5')
        page.locator('#servo-TILT [data-step="-100"]').click()
        expect(page.locator('#servo-TILT [data-motion]')).to_contain_text('Limit: 7.5 deg/s')
        expect(page.locator('#servo-TILT-reported')).to_have_text('Reported: 1400 µs at 50 Hz')
        expect(page.locator('#servo-TILT-command')).to_contain_text('Board confirmed')
        page.locator('#servo-TILT [data-step="100"]').click()
        expect(page.locator('#servo-TILT-reported')).to_have_text('Reported: 1500 µs at 50 Hz')
        expect(page.locator('#servo-TILT-command')).to_contain_text('Board confirmed')
        page.locator('#servo-TILT [data-step="100"]').click()
        expect(page.locator('#servo-TILT-reported')).to_have_text('Reported: 1600 µs at 50 Hz')
        page.locator('#servo-TILT-pulse').fill('2400')
        page.locator('#servo-TILT [data-step="100"]').click()
        expect(page.locator('#servo-TILT-reported')).to_have_text('Reported: 2500 µs at 50 Hz')
        expect(page.locator('#servo-TILT-command')).to_contain_text('Board confirmed')
        expect(page.locator('#servo-TILT [data-step="100"]')).to_be_disabled()
        page.locator('#servo-TILT [data-neutral]').click()
        expect(page.locator('#servo-TILT-reported')).to_have_text('Reported: 1500 µs at 50 Hz')
        expect(page.locator('#servo-TILT-pulse')).to_have_value('1500')
        page.locator('#servo-TILT-pulse').fill('500')
        expect(page.locator('#servo-TILT [data-step="-100"]')).to_be_disabled()
        page.locator('#servo-TILT [data-off]').click()
        expect(page.locator('#servo-TILT-reported')).to_have_text('Reported: OFF')
        page.locator('#servo-TILT [data-preset="center"]').click()
        page.locator('#servo-TILT [data-raw-controls] details summary').click()
        page.locator('#servo-TILT [data-setting="min"]').fill('2100')
        page.locator('#servo-TILT [data-setting="center"]').fill('2400')
        page.locator('#servo-TILT [data-setting="max"]').fill('2450')
        page.locator('#servo-TILT [data-save-presets]').click()
        expect(page.locator('#servo-TILT [data-preset-status]')).to_contain_text('saved')
        page.locator('#servo-TILT [data-preset="min"]').click()
        expect(page.locator('#servo-TILT-pulse')).to_have_value('2100')
        expect(page.locator('#servo-TILT-reported')).to_have_text('Reported: OFF')
        assert page.locator('#servo-TILT-pulse').get_attribute('min') == '500'
        assert page.locator('#servo-TILT-pulse').get_attribute('max') == '2500'
        page.locator('#servo-TILT [data-setting="max"]').fill('2600')
        page.locator('#servo-TILT [data-save-presets]').click()
        expect(page.locator('#servo-TILT [data-preset-status]')).to_contain_text('2500')
        page.reload()
        expect(page.locator('#servo-TILT [data-setting="min"]')).to_have_value('2100')
        page.locator('#servo-TILT [data-preset="center"]').click()
        expect(page.locator('#servo-TILT-pulse')).to_have_value('2400')
        expect(page.locator('#servo-TILT-reported')).to_have_text('Reported: OFF')
        page.locator('#servo-TILT [data-raw-controls] details summary').click()
        page.locator('#servo-TILT [data-reset-presets]').click()
        expect(page.locator('#servo-TILT [data-setting="min"]')).to_have_value('1400')
        print('PASS: independent servo presets persist, stay inside absolute limits, and do not command movement')
        for axis, pulse in [('PAN', 1700), ('TILT', 1400), ('S3', 1600)]:
            page.locator(f'#servo-{axis}-pulse').fill(str(pulse))
            page.locator(f'#servo-{axis} button[type=submit]').click()
            expect(page.locator(f'#servo-{axis}-reported')).to_have_text(f'Reported: {pulse} µs at 50 Hz')
            expect(page.locator(f'#servo-{axis}-command')).to_contain_text('Board confirmed')
            page.locator(f'#servo-{axis} [data-off]').click()
            expect(page.locator(f'#servo-{axis}-reported')).to_have_text('Reported: OFF')
        expect(page.locator('#feedback-chart')).to_be_visible()
        page.locator('#servo-TILT [data-raw-controls] > summary').click()
        page.locator('#servo-TILT [data-raw-command]').click()
        expect(page.locator('#servo-TILT-reported')).not_to_have_text('Reported: OFF')
        page.locator('#servo-estop').click()
        expect(page.locator('#servo-safety-state')).to_contain_text('E-STOP LATCHED')
        for axis in ['PAN', 'TILT', 'S3']:
            expect(page.locator(f'#servo-{axis}-reported')).to_have_text('Reported: OFF')
            assert page.locator(f'#servo-{axis} button[type=submit]').is_disabled()
            for step in [-100, 100]: assert page.locator(f'#servo-{axis} [data-step="{step}"]').is_disabled()
        assert page.locator('#servo-enable').is_disabled()
        page.locator('#servo-clear').click()
        expect(page.locator('#servo-safety-state')).to_contain_text('Disabled')
        assert page.locator('#servo-TILT [data-raw-command]').is_disabled()
        page.locator('#servo-enable').click()
        expect(page.locator('#servo-safety-state')).to_contain_text('Enabled')
        page.locator('#servo-disable').click()
        expect(page.locator('#servo-safety-state')).to_contain_text('Disabled')
        print('PASS: enable/disable, E-stop stops PWM and blocks commands; clearing does not re-enable')
        tilt = page.locator('#servo-TILT [data-tilt-config]')
        tilt.locator('summary').click()
        expect(tilt.locator('[data-tilt-action="sweep_start"]')).to_be_disabled()
        expect(tilt.locator('[data-tilt-action="sweep_apply"]')).to_be_disabled()
        for key, value in dict(vmin='.01', vmax='3.2', zero='180', amin='-45', amax='45').items():
            tilt.locator(f'[data-tilt-field="{key}"]').fill(value)
        tilt.locator('[data-tilt-action="configure"]').click()
        expect(tilt.locator('[data-tilt-reported]')).to_contain_text('limits -45° to 45°')
        tilt.locator('[data-tilt-action="zero"]').click()
        expect(tilt.locator('[data-tilt-field="zero"]')).to_have_value(re.compile(r'185\.\d+'))
        expect(page.locator('#servo-TILT-reported')).to_contain_text('OFF')
        page.locator('#servo-enable').click()
        expect(page.locator('#servo-safety-state')).to_contain_text('Enabled')
        tilt.locator('[data-sweep-cap]').fill('60')
        tilt.locator('[data-tilt-action="sweep_start"]').click()
        expect(tilt.locator('[data-sweep-reported]')).to_contain_text('running')
        expect(tilt.locator('[data-sweep-reported]')).to_contain_text('PWM offset cap 60 µs')
        expect(page.locator('#servo-TILT [data-raw-command]')).to_be_disabled()
        tilt.locator('[data-tilt-action="sweep_stop"]').click()
        expect(tilt.locator('[data-sweep-reported]')).to_contain_text('cancelled')
        tilt.locator('[data-tilt-action="sweep_start"]').click()
        expect(tilt.locator('[data-sweep-reported]')).to_contain_text('complete')
        tilt.locator('[data-tilt-action="sweep_apply"]').click()
        expect(tilt.locator('[data-tilt-field="vmin"]')).to_have_value('0.004')
        expect(tilt.locator('[data-tilt-field="vmax"]')).to_have_value('3.3')
        page.locator('#servo-disable').click()
        expect(page.locator('#servo-safety-state')).to_contain_text('Disabled')
        print('PASS: TILT mapping, current-position zero, limits, simulated sweep start/stop/complete/apply')
        expect(page.locator('#gpio-46 strong')).to_have_text('HIGH (1)')
        for pin in (4, 13, 14):
            expect(page.locator(f'#gpio-{pin} strong')).to_have_text(re.compile(r'(HIGH \(1\)|LOW \(0\))'))
        expect(page.locator('#sample-count')).to_have_text(re.compile(r'([3-9]|\d{2,}) buffered samples'))
        assert page.locator('#adc-units').input_value() == 'volts'
        for channel, label in {5: 'S3 FB', 6: 'PAN FB', 7: 'TILT FB', 8: 'Disconnected', 9: 'Disconnected', 10: 'Disconnected', 11: '3.3 V output voltage', 12: '3.3 V output current', 13: 'Servo current', 14: '5 V output current', 15: 'Total current'}.items():
            expect(page.locator(f'#ch{channel} .adc-label')).to_have_text(label)
            expect(page.locator(f'#ch{channel} .adc-top span:first-child')).to_have_text(f'CH {channel:02d}')
        expect(page.locator('#ch0 .adc-number')).to_have_text(re.compile(r'\d+\.\d{3}'))
        page.locator('#adc-units').select_option('raw')
        assert page.locator('#ch0 .adc-number').inner_text().isdigit()
        expect(page.locator('#adc-range')).to_contain_text('4095 counts')
        page.locator('#adc-units').select_option('volts')
        expect(page.locator('#adc-range')).to_contain_text('0–5 V')
        page.locator('.scaling-settings summary').click()
        page.locator('#scaling-0-m').fill('-2')
        page.locator('#scaling-0-b').fill('10')
        page.locator('#scaling-0-unit').fill('deg')
        page.locator('#scaling-form button[type=submit]').click()
        assert page.evaluate('scaledAdc(2048, 0)') == 5
        assert page.evaluate('scaledAdc(null, 0)') is None
        assert page.evaluate('scaledAdc(2048, 1)') == 2.5
        expect(page.locator('#ch0 .adc-top span:last-child')).to_have_text('deg')
        assert page.evaluate("Number(document.querySelector('#ch0 .adc-number').textContent) === Number(scaledAdc(samples.at(-1).adc[0], 0).toFixed(3))")
        page.reload()
        expect(page.locator('#ch0 .adc-top span:last-child')).to_have_text('deg')
        assert page.evaluate('scaledAdc(2048, 0)') == 5
        page.locator('.scaling-settings summary').click()
        page.locator('#scaling-reset').click()
        assert page.evaluate('scaledAdc(2048, 0)') == 2.5
        expect(page.locator('#ch0 .adc-top span:last-child')).to_have_text('V')
        page.locator('#ch7').click()
        assert page.locator('#adc-channel').input_value() == '7'
        page.screenshot(path=str(Path(__file__).with_name('preview.png')), full_page=True)
        with page.expect_download() as dl:
            page.locator('#export').click()
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / 'samples.csv'
            dl.value.save_as(target)
            text = target.read_text()
            assert 'ch15_raw' in text and 'mag_uT_z' in text and 'demo' in text
            assert len(text.splitlines()) >= 4
        page.set_viewport_size({'width': 390, 'height': 844})
        assert not page.evaluate('document.documentElement.scrollWidth > window.innerWidth')
        page.locator('#disconnect').click()
        expect(page.locator('#status')).to_contain_text('disconnected')
        assert page.locator('body').evaluate("el => el.classList.contains('stale')")
        page.locator('#show-debug-sources').check()
        page.locator('#mode').select_option('direct')
        assert not page.locator('#agent-field').is_visible()
        assert page.locator('#port-field').is_visible()
        page.locator('#mode').select_option('remote')
        assert page.locator('#agent').input_value() == 'desktop-o1gdd79'
        assert not errors, errors
        print('PASS: scaling conversion, persistence, reset, raw mode, demo streaming, channel selection, CSV export, disconnect, mode controls, mobile layout, no JS errors')
    finally:
        page.request.post(url + '/api/disconnect', data={}, headers={'Content-Type': 'application/json'})
        browser.close()
