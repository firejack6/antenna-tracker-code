/* Manually configured device location; compass data comes from live telemetry. */
// Display-only azimuth filtering. Increase for a steadier, slower map arrow.
const mapAzimuthSmoothingSeconds = 0.35;
function smoothMapAzimuth(previous, value, seconds) {
  if (!Number.isFinite(previous)) return (value%360+360)%360;
  const delta=((value-previous+540)%360+360)%360-180;
  const alpha=1-Math.exp(-Math.max(0,seconds)/mapAzimuthSmoothingSeconds);
  return (previous+alpha*delta+360)%360;
}
const deviceMap = (() => {
  const main = document.querySelector('main');
  const tabs = document.createElement('nav'); tabs.className = 'workspace-tabs'; tabs.setAttribute('aria-label','Dashboard views');
  tabs.innerHTML = '<button type="button" data-view="controls" aria-pressed="true">Controls</button><button type="button" data-view="map" aria-pressed="false">Map</button>';
  main.prepend(tabs);
  const panel = document.createElement('section'); panel.className = 'panel map-panel'; panel.hidden = true;
  panel.innerHTML = `<div class="section-heading"><h2>Device map</h2><button type="button" id="map-center" class="secondary">Center on device</button></div>
    <form id="device-location-form"><div class="map-fields">
    <label>Latitude (°)<input id="device-latitude" type="number" min="-90" max="90" step="any" required placeholder="e.g. 41.88"></label>
    <label>Longitude (°)<input id="device-longitude" type="number" min="-180" max="180" step="any" required placeholder="e.g. -87.63"></label>
    <label>Heading correction (°)<input id="device-heading-offset" type="number" min="-360" max="360" step="any" value="0" required></label>
    <label>Red line length (m)<input id="device-ray-length" type="number" min="1" max="100000" step="any" value="1000" required></label></div>
    <button type="submit">Save device location</button><p id="device-location-status" role="status">Enter device coordinates. Saved in this browser; this is not a live GPS fix.</p></form>
    <p id="device-map-heading" role="status">Compass heading unavailable</p><p class="plot-note">Red line = compass heading + correction, clockwise from north. Use correction for sensor mounting and magnetic declination. Map imagery requires internet; the marker and heading line work without tiles.</p>
    <div class="map-viewport"><div id="device-map" aria-label="Device location and compass heading map"></div>
    <aside class="map-elevation" aria-label="Live device elevation">
      <strong id="map-elevation-value">Elevation unavailable</strong><span id="map-elevation-target"></span>
      <svg viewBox="0 0 180 112" role="img" aria-label="Elevation side view relative to TILT zero">
        <path d="M10 82 H170" stroke="#8797aa" stroke-dasharray="4 4" fill="none"/>
        <text x="142" y="98" fill="#b0bdcb" font-size="11">0°</text>
        <g id="map-elevation-pointer"><path d="M90 82 H155 M147 77 L155 82 L147 87" stroke="#ef3038" stroke-width="4" fill="none"/></g>
        <circle cx="90" cy="82" r="5" fill="#69adff"/>
      </svg><small>Side view · relative to TILT zero</small>
    </aside></div><p id="map-tile-status" role="status"></p>`;
  tabs.after(panel);
  const el = id => document.getElementById(id);
  let config=null, map=null, marker=null, ray=null, heading=null, elevation=null, target=null, stale=true;
  let headingUpdatedAt=null;
  function destination(latitude, longitude, bearing, metres) {
    const rad=Math.PI/180, p=latitude*rad, l=longitude*rad, b=bearing*rad, d=metres/6371000;
    const p2=Math.asin(Math.max(-1,Math.min(1,Math.sin(p)*Math.cos(d)+Math.cos(p)*Math.sin(d)*Math.cos(b))));
    const l2=l+Math.atan2(Math.sin(b)*Math.sin(d)*Math.cos(p),Math.cos(d)-Math.sin(p)*Math.sin(p2));
    // Keep longitude in the same world copy so a dateline crossing stays short.
    return [p2/rad,l2/rad];
  }
  function draw() {
    const elevationValid=Number.isFinite(elevation) && !stale;
    el('map-elevation-value').textContent = Number.isFinite(elevation) ? `Elevation ${elevation.toFixed(1)}°${stale ? ' · STALE' : ''}` : 'Elevation unavailable';
    el('map-elevation-target').textContent = Number.isFinite(target) ? `Target ${target.toFixed(1)}°` : '';
    el('map-elevation-pointer').setAttribute('visibility',elevationValid ? 'visible' : 'hidden');
    if(elevationValid) el('map-elevation-pointer').setAttribute('transform',`rotate(${-elevation} 90 82)`);
    const valid=Number.isFinite(heading), bearing=valid && config ? (heading+config.offset+360)%360 : null;
    el('device-map-heading').textContent = valid ? `Heading ${heading.toFixed(1)}° magnetic${config ? ` · pointing ${bearing.toFixed(1)}° with correction` : ''}${stale ? ' · STALE — line hidden' : ''}` : 'Compass heading unavailable — line hidden';
    if (!map || !config) return;
    const origin=[config.lat,config.lon]; marker.setLatLng(origin);
    if (valid && !stale) {
      ray.setLatLngs([origin,destination(config.lat,config.lon,bearing,config.length)]);
      if (!map.hasLayer(ray)) ray.addTo(map);
    } else if (map.hasLayer(ray)) map.removeLayer(ray);
  }
  function init() {
    if (map) return;
    if (!window.L) { el('map-tile-status').textContent='Map library unavailable. Restart the dashboard script and refresh.'; return; }
    map=L.map('device-map').setView(config ? [config.lat,config.lon] : [20,0],config ? 15 : 2);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>'})
      .on('tileerror',()=>el('map-tile-status').textContent='Map tiles unavailable. Coordinates and compass line remain usable.')
      .on('tileload',()=>el('map-tile-status').textContent='').addTo(map);
    marker=L.circleMarker([0,0],{radius:8,color:'#ffffff',weight:2,fillColor:'#1676d2',fillOpacity:1});
    ray=L.polyline([],{color:'#ef3038',weight:4,interactive:false});
    if (config) marker.addTo(map);
    draw();
  }
  tabs.addEventListener('click',event=>{
    const button=event.target.closest('[data-view]'); if (!button) return;
    const show=button.dataset.view==='map'; document.body.classList.toggle('map-view',show); panel.hidden=!show;
    tabs.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
    if(show){init();requestAnimationFrame(()=>map?.invalidateSize());}
  });
  function read() {
    const c={lat:el('device-latitude').valueAsNumber,lon:el('device-longitude').valueAsNumber,offset:el('device-heading-offset').valueAsNumber,length:el('device-ray-length').valueAsNumber};
    if (!Object.values(c).every(Number.isFinite) || Math.abs(c.lat)>90 || Math.abs(c.lon)>180 || Math.abs(c.offset)>360 || c.length<1 || c.length>100000) throw Error('Enter valid coordinates, correction and line length.');
    return c;
  }
  el('device-location-form').addEventListener('submit',event=>{
    event.preventDefault();
    try { config=read(); localStorage.setItem('tracker-device-location',JSON.stringify(config));
      el('device-location-status').textContent=`Device location: ${config.lat.toFixed(6)}, ${config.lon.toFixed(6)} · saved in this browser`;
      init(); if(map){marker.addTo(map);map.setView([config.lat,config.lon],15);} draw();
    } catch(error){el('device-location-status').textContent=error.message;}
  });
  el('map-center').addEventListener('click',()=>{if(config){init();map?.setView([config.lat,config.lon],map.getZoom());}});
  try {
    const saved=JSON.parse(localStorage.getItem('tracker-device-location'));
    if(saved){for(const [key,id] of Object.entries({lat:'device-latitude',lon:'device-longitude',offset:'device-heading-offset',length:'device-ray-length'}))el(id).value=saved[key];config=read();el('device-location-status').textContent=`Device location: ${config.lat.toFixed(6)}, ${config.lon.toFixed(6)} · saved in this browser`;}
  }catch{config=null;}
  return {update(value,isStale,tiltAngle=null,targetAngle=null){
    const now=performance.now()/1000;
    const reset=stale || isStale || headingUpdatedAt===null || now-headingUpdatedAt>1;
    heading=Number.isFinite(value) ? smoothMapAzimuth(reset ? null : heading,value,headingUpdatedAt===null ? 0 : now-headingUpdatedAt) : null;
    headingUpdatedAt=now;elevation=tiltAngle;target=targetAngle;stale=isStale;draw();
  },destination};
})();
