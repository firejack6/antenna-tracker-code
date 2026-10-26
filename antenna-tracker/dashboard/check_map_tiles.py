"""Check real browser tile requests on an isolated, disconnected dashboard."""
import json
import threading
from playwright.sync_api import sync_playwright
from relay import DashboardServer,Handler,Relay
server=DashboardServer(('127.0.0.1',0),Handler);server.relay=Relay()
threading.Thread(target=server.serve_forever,daemon=True).start()
try:
    with sync_playwright() as p:
        browser=p.chromium.launch()
        page=browser.new_page()
        responses=[]; failures=[]
        page.on('response',lambda r: responses.append([r.url,r.status]) if 'tile.openstreetmap.org' in r.url else None)
        page.on('requestfailed',lambda r:failures.append([r.url,r.failure]) if 'tile.openstreetmap.org' in r.url else None)
        page.goto(f'http://127.0.0.1:{server.server_port}')
        page.locator('[data-view="map"]').click()
        page.locator('#device-latitude').fill('41.88');page.locator('#device-longitude').fill('-87.63')
        page.locator('#device-location-form button').click()
        page.wait_for_timeout(5000)
        print(json.dumps(dict(responses=responses,failures=failures,status=page.locator('#map-tile-status').text_content())))
        assert any(status==200 for _,status in responses), 'No map tile loaded successfully'
        assert not any(reason=='csp' for _,reason in failures), 'Tile request blocked by CSP'
        browser.close()
finally:server.shutdown();server.server_close()
