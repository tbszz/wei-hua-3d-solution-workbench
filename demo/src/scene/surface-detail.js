// Shared surface detail for every lit (MeshStandard / MeshPhysical) material in the app.
// Patched into three's built-in shader once, so procedural parts, the product GLBs and any model
// uploaded later all get the same factory wear without touching them one by one:
// world-space mottling and fine wear (one texture, dominant-axis projection, two lookups),
// roughness variation, faint vertical streaks and dirt where things meet the floor.
//
// Per-material switches (material.defines):
//   NO_DETAIL     leave this material alone (decals, glass, labels)
//   DETAIL_FLOOR  floor and floor paint: only the large-scale variation that breaks up tiling
import * as THREE from 'three';

const MARK = '// surface-detail';

export function surfaceDetailBrightness(mottle, streak = 0, floor = false) {
  const value = floor ? 1 + mottle * 0.12 : 1 + mottle * 0.13 + streak * 0.05 - 0.04;
  return Math.min(1, Math.max(floor ? 0.94 : 0.75, value));
}

const VERTEX_PARS = /* glsl */ `${MARK}
varying vec3 vDetailPos;
varying vec3 vDetailNormal;
`;

const VERTEX_MAIN = /* glsl */ `
{
  vec4 detailPos = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
  detailPos = batchingMatrix * detailPos;
  #endif
  #ifdef USE_INSTANCING
  detailPos = instanceMatrix * detailPos;
  #endif
  vDetailPos = ( modelMatrix * detailPos ).xyz;
  vDetailNormal = inverseTransformDirection( transformedNormal, viewMatrix );
}
`;

const FRAGMENT_PARS = /* glsl */ `${MARK}
uniform sampler2D detailMap;
varying vec3 vDetailPos;
varying vec3 vDetailNormal;
`;

const FRAGMENT_MAIN = /* glsl */ `
#ifndef NO_DETAIL
{
  vec3 an = abs( vDetailNormal );
  vec2 duv = an.y > max( an.x, an.z ) ? vDetailPos.xz : ( an.x > an.z ? vDetailPos.zy : vDetailPos.xy );
  vec4 big = texture2D( detailMap, duv * 0.043 );
  #ifdef DETAIL_FLOOR
  // Large-scale darkening only (at most 6 %), plus faint 6 m saw-cut joints.
  diffuseColor.rgb *= clamp( 1.0 + ( big.r - 0.5 ) * 0.12, 0.94, 1.0 );
  vec2 joint = abs( fract( vDetailPos.xz / 6.0 + 0.5 ) - 0.5 ) * 6.0;
  vec2 jw = fwidth( vDetailPos.xz ) * 1.5;
  float cut = max( 1.0 - smoothstep( 0.006, 0.006 + jw.x, joint.x ), 1.0 - smoothstep( 0.006, 0.006 + jw.y, joint.y ) );
  diffuseColor.rgb *= 1.0 - 0.08 * cut;
  roughnessFactor = clamp( roughnessFactor + ( big.r - 0.5 ) * 0.12, 0.04, 1.0 );
  #else
  // Wear only ever darkens, so the textures set the brightest a surface can look.
  vec4 fine = texture2D( detailMap, duv * 0.61 + 0.37 );
  float mottle = ( big.r - 0.5 ) * 0.5 + ( fine.r - 0.5 ) * 0.5;
  float streak = ( fine.b - 0.5 ) * ( 1.0 - an.y );
  diffuseColor.rgb *= clamp( 1.0 + mottle * 0.13 + streak * 0.05 - 0.04, 0.75, 1.0 );
  diffuseColor.rgb *= mix( 0.8, 1.0, smoothstep( 0.0, 0.55, vDetailPos.y ) );
  roughnessFactor = clamp( roughnessFactor + ( fine.g - 0.5 ) * 0.2 + mottle * 0.1, 0.04, 1.0 );
  #endif
}
#endif
`;

const uniform = { value: null };

function patch(source, pars, anchor, main) {
  if (source.includes(MARK)) return source;
  if (!source.includes(anchor)) throw new Error(`surface-detail: three.js shader has no ${anchor}`);
  return source.replace('void main() {', `${pars}\nvoid main() {`).replace(anchor, `${anchor}\n${main}`);
}

// Call once before the first render. Later calls only swap the texture.
export function installSurfaceDetail(map) {
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  uniform.value = map;
  for (const id of ['standard', 'physical']) {
    const lib = THREE.ShaderLib[id];
    lib.uniforms.detailMap = uniform;
    lib.vertexShader = patch(lib.vertexShader, VERTEX_PARS, '#include <worldpos_vertex>', VERTEX_MAIN);
    lib.fragmentShader = patch(lib.fragmentShader, FRAGMENT_PARS, '#include <metalnessmap_fragment>', FRAGMENT_MAIN);
  }
}
