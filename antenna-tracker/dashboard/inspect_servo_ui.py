"""Read visible servo state without clicking controls or sending commands."""
import json
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://127.0.0.1:8765')
    page.wait_for_timeout(1500)
    for axis in ('PAN', 'TILT'):
        form = page.locator('#servo-'+axis)
        print(json.dumps(dict(axis=axis,
            motion=form.locator('[data-motion]').text_content(),
            target=form.locator('[data-position-reported]').text_content(),
            go_disabled=form.locator('[data-position-go]').is_disabled())))
    print(json.dumps(dict(errors=errors)))
    browser.close()
