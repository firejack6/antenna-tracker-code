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
    assert graph['heights']['adc-chart'] == 360, graph
    assert all(height == 300 for name, height in graph['heights'].items() if name != 'adc-chart'), graph
    print('PASS: connected graph across raw scan gaps; ADC 360px, feedback and IMU 300px')
    page.locator('#mode').select_option('demo')
    page.locator('#connect').click()
    try:
        expect(page.locator('#status')).to_contain_text('Live')
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
        assert page.locator('#servo-TILT button[type=submit]').is_disabled()
        page.locator('#servo-enable').click()
        expect(page.locator('#servo-safety-state')).to_contain_text('Enabled')
        expect(page.locator('#servo-TILT-pulse')).to_have_value('2400')
        page.locator('#servo-TILT details summary').click()
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
        page.locator('#servo-TILT details summary').click()
        page.locator('#servo-TILT [data-reset-presets]').click()
        expect(page.locator('#servo-TILT [data-setting="min"]')).to_have_value('500')
        print('PASS: independent servo presets persist, stay inside absolute limits, and do not command movement')
        for axis, pulse in [('PAN', 1700), ('TILT', 1400), ('S3', 1600)]:
            page.locator(f'#servo-{axis}-pulse').fill(str(pulse))
            page.locator(f'#servo-{axis} button[type=submit]').click()
            expect(page.locator(f'#servo-{axis}-reported')).to_have_text(f'Reported: {pulse} µs at 50 Hz')
            expect(page.locator(f'#servo-{axis}-command')).to_contain_text('Board confirmed')
            page.locator(f'#servo-{axis} [data-off]').click()
            expect(page.locator(f'#servo-{axis}-reported')).to_have_text('Reported: OFF')
        expect(page.locator('#feedback-chart')).to_be_visible()
        page.locator('#servo-TILT button[type=submit]').click()
        expect(page.locator('#servo-TILT-reported')).not_to_have_text('Reported: OFF')
        page.locator('#servo-estop').click()
        expect(page.locator('#servo-safety-state')).to_contain_text('E-STOP LATCHED')
        for axis in ['PAN', 'TILT', 'S3']:
            expect(page.locator(f'#servo-{axis}-reported')).to_have_text('Reported: OFF')
            assert page.locator(f'#servo-{axis} button[type=submit]').is_disabled()
        assert page.locator('#servo-enable').is_disabled()
        page.locator('#servo-clear').click()
        expect(page.locator('#servo-safety-state')).to_contain_text('Disabled')
        assert page.locator('#servo-TILT button[type=submit]').is_disabled()
        page.locator('#servo-enable').click()
        expect(page.locator('#servo-safety-state')).to_contain_text('Enabled')
        page.locator('#servo-disable').click()
        expect(page.locator('#servo-safety-state')).to_contain_text('Disabled')
        print('PASS: enable/disable, E-stop stops PWM and blocks commands; clearing does not re-enable')
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
