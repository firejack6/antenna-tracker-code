"""Map browser checks with synthetic telemetry; no hardware connection."""
import threading
import time
from playwright.sync_api import sync_playwright, expect
from relay import DashboardServer, Handler, Relay

server=DashboardServer(('127.0.0.1',0),Handler)
server.relay=Relay()
threading.Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_port}'
try:
    with sync_playwright() as p:
        browser=p.chromium.launch()
        page=browser.new_page(viewport=dict(width=1200,height=1000))
        errors=[]
        page.on('pageerror',lambda error:errors.append(str(error)))
        stale=[False]
        def state(route):
            s=server.relay.snapshot(2147483647)
            s['status']='connected'
            s['latest']=dict(received_at=time.time()-(10 if stale[0] else 0),
                sensor_received_at=time.time()-(10 if stale[0] else 0),adc=[None]*16,
                accel=[0,0,1],gyro=[0,0,0],mag=[0,-1,0],gpio={},servos={},errors=[],
                tilt_imu=dict(angle=-30),
                servo_motion=dict(PAN=dict(angle=80)),
                servo_position=dict(TILT=dict(active=1,target=-40),PAN=dict(active=1,target=95)))
            route.fulfill(json=s)
        page.route('**/api/state?*',state)
        page.route('https://tile.openstreetmap.org/**',lambda route:route.abort())
        page.goto(base)
        result=page.evaluate('''() => ({
          north:smoothMapAzimuth(359,1,.35),
          reverse:smoothMapAzimuth(1,359,.35),
          step:smoothMapAzimuth(0,90,.35),
          initial:smoothMapAzimuth(null,90,0),
          split:smoothMapAzimuth(smoothMapAzimuth(0,90,.175),90,.175)
        })''')
        assert 0<result['north']<1 and 359<result['reverse']<360,result
        assert 50<result['step']<60 and result['initial']==90,result
        assert abs(result['step']-result['split'])<1e-9,result
        page.locator('[data-view="map"]').click()
        page.locator('#device-latitude').fill('41.88')
        page.locator('#device-longitude').fill('-87.63')
        page.locator('#device-pan-align').fill('10')
        page.locator('#device-mag-declination').fill('0')
        page.locator('#device-location-form button[type="submit"]').click()
        expect(page.locator('#device-location-status')).to_contain_text('41.880000, -87.630000')
        # mag [0,-1,0] → heading 90; dish(red) = mag
        expect(page.locator('#device-aim-source')).to_contain_text('mag')
        expect(page.locator('#device-map-heading')).to_contain_text('Mag(red) 90.0°')
        expect(page.locator('#map-pointing-pan')).to_contain_text('POT 80.0°')
        expect(page.locator('#map-elevation-value')).to_have_text('Elevation 30.0°')
        expect(page.locator('#map-elevation-target')).to_have_text('Target 40.0°')
        expect(page.locator('#map-elevation-pointer')).to_have_attribute('transform','rotate(-30 90 82)')
        expect(page.locator('#device-map path[stroke="#ef3038"]')).to_have_count(1)
        expect(page.locator('#map-seed-mag')).to_be_visible()
        expect(page.locator('[data-track-mode="align"]')).to_be_visible()
        expect(page.locator('#track-status')).to_contain_text('Synthetic tracking off')
        lat,lon=page.evaluate('deviceMap.destination(0,0,90,1000)')
        assert abs(lat)<1e-6 and .0089<lon<.0091
        stale[0]=True
        expect(page.locator('#device-map-heading')).to_contain_text('STALE')
        expect(page.locator('#map-elevation-pointer')).to_have_attribute('visibility','hidden')
        expect(page.locator('#device-map path[stroke="#ef3038"]')).to_have_count(0)
        stale[0]=False
        page.reload()
        page.locator('[data-view="map"]').click()
        expect(page.locator('#device-latitude')).to_have_value('41.88')
        expect(page.locator('#device-map path[stroke="#ef3038"]')).to_have_count(1)
        expect(page.locator('[data-track-mode="goto"]')).to_be_visible()
        page.screenshot(path='dashboard/device-map-desktop.png')
        page.set_viewport_size(dict(width=390,height=844))
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        assert not errors,errors
        browser.close()
    print('Map coordinates, persistence, mag-aim HUD, stale hiding, offline tiles and mobile layout passed.')
finally:
    server.shutdown()
    server.server_close()
