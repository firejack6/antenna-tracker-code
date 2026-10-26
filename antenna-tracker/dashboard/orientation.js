// Sensor axes: +X forward, +Y right, +Z up at rest. Magnetic heading, no declination.
function sensorOrientation(accel, mag) {
  const vector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
  if (!vector(accel) || Math.hypot(...accel) < .1) return null;
  const [ax, ay, az] = accel;
  const roll = Math.atan2(ay, az), pitch = Math.atan2(-ax, Math.hypot(ay, az));
  let heading = null;
  if (vector(mag)) {
    const [mx, my, mz] = mag;
    const horizontalX = mx * Math.cos(pitch) + mz * Math.sin(pitch);
    const horizontalY = mx * Math.sin(roll) * Math.sin(pitch) + my * Math.cos(roll) - mz * Math.sin(roll) * Math.cos(pitch);
    if (Math.hypot(horizontalX, horizontalY) > 1e-6) heading = (Math.atan2(-horizontalY, horizontalX) * 180 / Math.PI + 360) % 360;
  }
  return {roll: roll * 180 / Math.PI, pitch: pitch * 180 / Math.PI, heading};
}

function drawOrientation(canvas, attitude, stale) {
  const box = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  if (!box.width) return;
  canvas.width = Math.round(box.width * dpr); canvas.height = Math.round(box.height * dpr);
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const width = box.width, height = box.height, radius = Math.min(height * .38, width * .22);
  ctx.globalAlpha = stale ? .45 : 1;
  const x = width * .28, y = height * .48;
  ctx.save(); ctx.beginPath(); ctx.arc(x, y, radius, 0, 2 * Math.PI); ctx.clip();
  ctx.translate(x, y); ctx.rotate(-(attitude?.roll || 0) * Math.PI / 180);
  ctx.translate(0, Math.max(-80, Math.min(80, attitude?.pitch || 0)) * radius / 45);
  ctx.fillStyle = '#255f8d'; ctx.fillRect(-width, -height * 3, width * 2, height * 3);
  ctx.fillStyle = '#805838'; ctx.fillRect(-width, 0, width * 2, height * 3);
  ctx.strokeStyle = '#e6edf5'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-width, 0); ctx.lineTo(width, 0); ctx.stroke();
  ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = '#e6edf5';
  for (let degrees = -80; degrees <= 80; degrees += 10) {
    if (!degrees) continue;
    const markY = -degrees * radius / 45, half = degrees % 20 === 0 ? 22 : 12;
    ctx.beginPath(); ctx.moveTo(-half, markY); ctx.lineTo(half, markY); ctx.stroke();
    if (degrees % 20 === 0) ctx.fillText(String(degrees), half + 17, markY + 4);
  }
  ctx.restore();
  ctx.strokeStyle = '#8b9bb1'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, radius, 0, 2 * Math.PI); ctx.stroke();
  ctx.strokeStyle = '#f4c76b'; ctx.lineWidth = 3; ctx.beginPath();
  ctx.moveTo(x - radius * .6, y); ctx.lineTo(x - 12, y); ctx.lineTo(x, y + 7); ctx.lineTo(x + 12, y); ctx.lineTo(x + radius * .6, y); ctx.stroke();
  const compassX = width * .75, compassRadius = radius * .78;
  ctx.save(); ctx.translate(compassX, y); ctx.rotate(-(attitude?.heading || 0) * Math.PI / 180);
  ctx.strokeStyle = '#8b9bb1'; ctx.beginPath(); ctx.arc(0, 0, compassRadius, 0, 2 * Math.PI); ctx.stroke();
  ctx.font = 'bold 14px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const [label, angle] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
    ctx.save(); ctx.rotate(angle * Math.PI / 180); ctx.translate(0, -compassRadius * .8);
    ctx.rotate((attitude?.heading || 0) * Math.PI / 180 - angle * Math.PI / 180);
    ctx.fillStyle = label === 'N' ? '#ff9095' : '#e6edf5'; ctx.fillText(label, 0, 0); ctx.restore();
  }
  ctx.restore();
  ctx.fillStyle = '#f4c76b'; ctx.beginPath(); ctx.moveTo(compassX, y - compassRadius - 12); ctx.lineTo(compassX - 6, y - compassRadius - 22); ctx.lineTo(compassX + 6, y - compassRadius - 22); ctx.fill();
  ctx.fillStyle = '#e6edf5'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(attitude ? 'Roll / pitch' : 'Waiting for acceleration', x, height - 15);
  ctx.fillText(attitude?.heading != null ? 'Magnetic heading' : 'Heading unavailable', compassX, height - 15);
}
