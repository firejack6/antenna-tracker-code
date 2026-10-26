"""UI test with mocked servo APIs: never sends a hardware command."""
import copy
import json
import time
from playwright.sync_api import sync_playwright, expect

with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    page = browser.new_page()
    snapshot = page.request.get('http://127.0.0.1:8765/api/state?since=2147483647').json()
    snapshot['status'] = 'connected'
    snapshot['latest'].pop('tilt_imu',None)
    for axis in ('PAN','TILT'):
        snapshot['latest']['servos'][axis].update(neutral=1500,pmin=500,pmax=2500,mode=1,ready=1)
    snapshot['latest']['servo_motion'] = {axis: dict(limit=30, angle=30) for axis in ('PAN','TILT')}
    snapshot['samples'] = []; snapshot['logs'] = []; snapshot['servo_inhibit'] = False
    snapshot['safety_command'] = None
    snapshot['servo_safety'] = dict(armed=1, estop=0, received_at=time.time())
    snapshot['latest']['servo_position'] = {axis: dict(target=30, active=0, kp=.2, ki=0, kd=.02, ilimit=20, cap=60, tolerance=1, dbplus=42, dbminus=60, ramp=1, ramprate=30) for axis in ('PAN','TILT')}
    calls = []; errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    def state(route):
        result = copy.deepcopy(snapshot)
        result['latest']['received_at'] = result['latest']['sensor_received_at'] = time.time()
        result['servo_safety']['received_at'] = time.time()
        route.fulfill(json=result)
    def command(route):
        data = route.request.post_data_json
        calls.append((route.request.url.split('/')[-1], data))
        if route.request.url.endswith('/servo') and not data.get('off'):
            snapshot['latest']['servos'][data['axis']].update(enable=1,pulse=data['pulse'])
            snapshot['latest']['servo_motion'][data['axis']].update(target=data['pulse'],limit=30)
        if route.request.url.endswith('tilt-imu'):
            snapshot['latest']['tilt_imu'].update({key:value for key,value in data.items() if key != 'action'}, ready=1)
        if route.request.url.endswith('servo-ramp'):
            snapshot['latest']['servo_position'][data['axis']].update(ramp=int(data['enabled']), ramprate=data['rate'])
        if route.request.url.endswith(('servo-pid', 'servo-deadband')):
            snapshot['latest']['servo_position'][data['axis']].update({key:value for key,value in data.items() if key != 'axis'})
        route.fulfill(json={'ok':True})
    page.route('**/api/state?*', state)
    page.route('**/api/servo*', command)
    page.route('**/api/tilt-imu', command)
    page.goto('http://127.0.0.1:8765')
    panel = page.locator('#servo-TILT [data-position-controls]')
    expect(panel.locator('[data-position-go]')).to_be_enabled()
    panel.locator('[data-position-no-ramp]').check()
    assert calls[-1] == ('servo-ramp', {'axis':'TILT','enabled':False,'rate':30})
    expect(panel.locator('[data-position-reported]')).to_contain_text('Target ramp disabled')
    panel.locator('[data-position-ramp-rate]').fill('12.5')
    panel.locator('[data-position-ramp-save]').click()
    assert calls[-1] == ('servo-ramp', {'axis':'TILT','enabled':False,'rate':12.5})
    expect(panel.locator('[data-position-reported]')).to_contain_text('Ramp rate: 12.5 deg/s')
    panel.locator('[data-position-angle]').fill('-45')
    panel.locator('[data-position-go]').click()
    assert calls[-1] == ('servo-position', {'axis':'TILT','angle':45})
    panel.locator('summary').first.click()
    panel.locator('[data-position-gain="kp"]').fill('.4')
    panel.locator('[data-position-save]').click()
    assert calls[-1][0] == 'servo-pid' and calls[-1][1]['kp'] == .4
    expect(panel.locator('[data-position-gains]')).to_contain_text('P 0.4')
    expect(panel.locator('[data-position-gain="kp"]')).to_have_value('0.4')
    panel.locator('[data-position-db="dbplus"]').fill('0')
    panel.locator('[data-position-db="dbminus"]').fill('65')
    panel.locator('[data-position-db-save]').click()
    assert calls[-1] == ('servo-deadband', {'axis':'TILT','dbplus':0,'dbminus':65})
    expect(panel.locator('[data-position-db-reported]')).to_contain_text('below neutral 65 us')
    panel.locator('[data-position-stop]').click()
    assert calls[-1] == ('servo', {'axis':'TILT','off':True})
    raw = page.locator('#servo-TILT [data-raw-controls]')
    raw.locator('summary').first.click()
    page.locator('#servo-TILT-pulse').fill('1560')
    raw.locator('[data-raw-command]').click()
    assert calls[-1][0] == 'servo' and calls[-1][1]['pulse'] == 1560 and calls[-1][1]['manual'] is True and 'speed_limit' not in calls[-1][1]
    expect(page.locator('#servo-TILT-reported')).to_contain_text('1560')
    raw.locator('[data-step-size]').fill('25')
    expect(raw.locator('[data-step="25"]')).to_have_text('+25 ?s')
    raw.locator('[data-step="25"]').click()
    assert calls[-1][1]['pulse'] == 1585 and calls[-1][1]['manual'] is True
    snapshot['latest']['servos']['TILT']['mode'] = 0
    snapshot['latest']['servos']['TILT']['raw'] = 0
    snapshot['latest']['servo_position']['TILT']['active'] = 1
    expect(panel.locator('details').first).to_be_hidden()
    expect(panel.locator('[data-position-reported]')).to_contain_text('Servo internal position control')
    snapshot['latest']['tilt_imu'] = dict(active=1,ready=0,angle=-125,speed=0,raw=-125,axis=1,zero=0,amin=0,amax=110)
    expect(panel.locator('[data-position-go]')).to_be_disabled()
    imu = panel.locator('[data-imu-controls]')
    expect(imu).to_be_visible()
    imu.locator('summary').click()
    imu.locator('[data-imu-field="amin"]').fill('-140')
    imu.locator('[data-imu-field="amax"]').fill('-30')
    imu.locator('[data-imu-save]').click()
    assert calls[-1] == ('tilt-imu',dict(action='configure',axis=1,zero=0,amin=-140,amax=-30,pmin=500,pmax=2500))
    expect(imu.locator('[data-imu-reported]')).to_contain_text('Mapping calibrated')
    snapshot['latest']['servo_motion']['TILT'].update(minangle=-120.85,maxangle=43.2)
    angle = panel.locator('[data-position-angle]')
    expect(angle).to_have_attribute('min','-43.2')
    expect(angle).to_have_attribute('max','120.85')
    for value in ('0','20','49.123'):
        angle.fill(value)
        assert angle.evaluate('(input) => input.checkValidity()'), value
    angle.fill('121')
    assert not angle.evaluate('(input) => input.checkValidity()')
    angle.fill('0')
    page.locator('#servo-TILT-pulse').evaluate('(input) => input.value = "1500.25"')
    page.locator('#servo-TILT').evaluate('(form) => form.requestSubmit()')
    page.wait_for_timeout(200)
    assert calls[-1] == ('servo-position',dict(axis='TILT',angle=0))
    angle.fill('20')
    panel.locator('[data-position-go]').click()
    page.wait_for_timeout(200)
    assert calls[-1] == ('servo-position',dict(axis='TILT',angle=-20))
    expect(page.locator('#servo-TILT').locator('..').locator('canvas')).to_have_count(2)
    expect(page.locator('#servo-PAN').locator('..').locator('canvas')).to_have_count(2)
    page.set_viewport_size(dict(width=1400,height=1000))
    page.locator('.servo-form details').evaluate_all('(items) => items.forEach(item => item.open = false)')
    page.evaluate('''frame => {
      samples = Array.from({length:120},(_,i) => {
        const row=structuredClone(frame), t=Date.now()/1000-(119-i)*.1;
        row.received_at=row.sensor_received_at=t; row.sensor_device_ms=null;
        row.servo_motion.TILT.angle=-30+Math.sin(i/12)*2;
        row.servos.TILT.enable=1; row.servos.TILT.pulse=1400+Math.sin(i/12)*12;
        return row;
      });
      renderCharts();
    }''',snapshot['latest'])
    page.locator('#servo-TILT').locator('..').locator('..').screenshot(path='dashboard/servo-layout-desktop.png')
    page.set_viewport_size(dict(width=390,height=844))
    page.wait_for_timeout(250)
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Mobile horizontal overflow'
    page.screenshot(path='dashboard/servo-layout-mobile.png')
    assert not errors, errors
    browser.close()
print('Position UI target, PID editing/readback and Stop passed; hardware APIs mocked.')
