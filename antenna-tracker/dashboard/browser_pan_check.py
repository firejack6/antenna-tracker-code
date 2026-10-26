"""Isolated dashboard check; all control requests are mocked, no ESP connection."""
import threading
import time
from playwright.sync_api import sync_playwright, expect
from relay import DashboardServer, Handler, Relay

server=DashboardServer(('127.0.0.1',0),Handler)
server.relay=Relay()
threading.Thread(target=server.serve_forever,daemon=True).start()
try:
    with sync_playwright() as p:
        browser=p.chromium.launch()
        page=browser.new_page()
        calls=[]; errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        def state(route):
            s=server.relay.snapshot(2147483647)
            s['status']='connected'
            s['latest']=dict(received_at=time.time(),adc=[None]*16,errors=[],gpio={},
                servos=dict(PAN=dict(ready=1,mode=1,neutral=1500,pmin=500,pmax=2500,
                    fmin=50,fcenter=50,fmax=50,pulse=1500,enable=0)),
                pan_config=dict(neutral=1500,polarity=1,vmin=.004,vmax=3.3,span=360,zero=0,amin=0,amax=360))
            route.fulfill(json=s)
        def command(route):
            calls.append(route.request.post_data_json)
            route.fulfill(json={'ok':True})
        page.route('**/api/state?*',state)
        page.route('**/api/pan',command)
        page.goto(f'http://127.0.0.1:{server.server_port}')
        panel=page.locator('[data-pan-controls]')
        panel.locator('summary').click()
        expect(panel.locator('[data-pan-field="neutral"]')).to_have_value('1500')
        panel.locator('[data-pan-field="neutral"]').fill('1515')
        panel.locator('[data-pan-action="configure"]').click()
        expect(panel.locator('[data-pan-status]')).to_contain_text('Queued')
        assert calls[-1]['neutral']==1515
        assert calls[-1]['action']=='configure'
        panel.locator('[data-pan-action="save"]').click()
        assert calls[-1]=={'action':'save'}
        panel.locator('[data-pan-action="zero"]').click()
        assert calls[-1]=={'action':'zero'}
        assert not errors,errors
        browser.close()
        print('PAN calibration UI passed; no hardware commands sent')
finally:
    server.shutdown(); server.server_close()
