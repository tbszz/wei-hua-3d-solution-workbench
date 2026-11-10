export function trapezoidProfile(distanceMm, maxSpeedMmS, accelerationMmS2, t) {
  const d = Math.abs(distanceMm), sign = Math.sign(distanceMm) || 1;
  const ta = maxSpeedMmS / accelerationMmS2;
  const da = 0.5 * accelerationMmS2 * ta * ta;
  const triangular = d <= 2 * da;
  const accelTime = triangular ? Math.sqrt(d / accelerationMmS2) : ta;
  const cruiseTime = triangular ? 0 : (d - 2 * da) / maxSpeedMmS;
  const total = triangular ? 2 * accelTime : 2 * accelTime + cruiseTime;
  const time = Math.max(0, Math.min(Number(t), total));
  let position;
  if (time <= accelTime) position = 0.5 * accelerationMmS2 * time * time;
  else if (time <= total - accelTime && !triangular) position = da + maxSpeedMmS * (time - accelTime);
  else { const td = total - time; position = d - 0.5 * accelerationMmS2 * td * td; }
  return { position: sign * position, total, atEnd: time >= total };
}
export function craneAxesToPose(axes, t) {
  return { trolleyMm: trapezoidProfile(axes.trolleyMm, axes.speedMmS, axes.accelerationMmS2, t), hoistMm: trapezoidProfile(axes.hoistMm, axes.hoistSpeedMmS, axes.hoistAccelerationMmS2, t) };
}
