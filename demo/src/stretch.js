// Piecewise-linear axis map used for parametric stretching.
// Geometry outside a band only moves; inside a band it stretches.
// The band ranges were checked against the model: body surfaces there are pure extrusions.

export function bandFor(band, nominalMm, valueMm) {
  const change = (valueMm - nominalMm) / 1000;
  const width = band.outer - band.inner;
  const growth = band.mirrored ? change / 2 : change;
  return { inner: band.inner, outer: band.outer, width, growth, scale: 1 + growth / width, mirrored: band.mirrored };
}

export function mapAxis(b, value) {
  const sign = b.mirrored ? Math.sign(value) || 1 : 1;
  const v = b.mirrored ? Math.abs(value) : value;
  if (v <= b.inner) return value;
  if (v >= b.outer) return sign * (v + b.growth);
  return sign * (b.inner + (v - b.inner) * b.scale);
}

export function minimumValue(band, nominalMm) {
  const shrink = (band.outer - band.inner) * (band.mirrored ? 2 : 1) * 1000;
  return nominalMm - shrink;
}

export function clampParam(param, value) {
  if (!Number.isFinite(value)) return param.nominal;
  const snapped = Math.round(value / param.step) * param.step;
  return Math.min(param.max, Math.max(param.min, snapped));
}

export const STRETCH_VERTEX_PARS = /* glsl */ `
  #ifndef STRETCH_BODY
  attribute vec3 aAnchor;
  #endif
  uniform vec4 uBandX;
  uniform vec4 uBandY;
  uniform vec4 uBandZ;

  // band = (inner, outer, growth, mirrored)
  float stretchAxis(vec4 band, float value) {
    float mirrored = band.w;
    float sign_ = mirrored > 0.5 ? (value < 0.0 ? -1.0 : 1.0) : 1.0;
    float v = mirrored > 0.5 ? abs(value) : value;
    float scale_ = 1.0 + band.z / (band.y - band.x);
    float mapped = v;
    if (v >= band.y) mapped = v + band.z;
    else if (v > band.x) mapped = band.x + (v - band.x) * scale_;
    return sign_ * mapped;
  }

  vec3 stretchOffset(vec3 p) {
    #ifdef STRETCH_BODY
    vec3 ref = p;
    #else
    vec3 ref = aAnchor;
    #endif
    return vec3(
      stretchAxis(uBandX, ref.x) - ref.x,
      stretchAxis(uBandY, ref.y) - ref.y,
      stretchAxis(uBandZ, ref.z) - ref.z
    );
  }
`;

export const STRETCH_VERTEX_MAIN = /* glsl */ `
  transformed += stretchOffset(transformed);
`;
