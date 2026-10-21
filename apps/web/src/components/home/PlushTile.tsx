'use client';

/**
 * Plush tile — adapted from "Plush Tile" by Originkit.
 *
 * The agenthub app icon (the lime A-check on an ink tile) rendered as a furry cushion: strands are
 * generated on the GPU with transform feedback, lit by a soft key light, and brushed by the
 * pointer. Adaptations for this site: the artwork is the agenthub logo drawn locally (no
 * remote image), fixed brand settings, decorative only, pauses off-screen and in hidden tabs,
 * holds still for reduced motion, and recovers from a lost WebGL context. Without WebGL2 the
 * flat logo underneath stays visible.
 */

import { useEffect, useRef, useState } from 'react';
import { prefersLightEffects } from '../../lib/device';
import { LOGO_CHECK_PATH, LOGO_LEGS_PATH } from '../ui/Logo';

type RGBA = [number, number, number, number];

const lin = (c: number) => c ** 2.2;
const D2R = Math.PI / 180;

function hex(h: string): RGBA {
  const n = Number.parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
}

/** Brand settings: ink fur with the lime A-check, an olive-tinted stage, warm-white key light. */
const SETTINGS = {
  background: hex('#1C2610'),
  fur: hex('#2A2F37'),
  light: hex('#FFF4E6'),
  mark: '#C5F04A',
  // A paler lime keeps the check readable once the fur blurs its edges.
  check: '#ECFBB8',
  // The mark spans about half of the 24px grid, so the grid is drawn larger than the tile.
  artSize: 118,
  scale: 100,
  radius: 48,
  puff: 5,
  breeze: 2,
  density: 5,
  length: 6,
  lift: 5,
  frizz: 6,
  reach: 5,
  strength: 6,
  parallax: 4,
  entranceDelay: 0.1,
  entranceDuration: 1.6,
  seed: 0,
  edgeFlow: 75,
  emboss: 50,
  rimShare: 26,
  clump: 28,
  hairWidth: 0.85,
  tipFade: 25,
  lens: 20,
  lightAngle: 100,
  lightHeight: 40,
  keyFalloff: 75,
  sheen: 25,
  crimp: 20,
  rootShade: 60,
  depthShade: 45,
  undercoat: 22,
  rimLight: 90,
  colorJitter: 22,
  bounce: 55,
  glow: 60,
  shadow: 50,
};

const TILE_HALF = 0.7;
const HORIZON = -0.74;
const STRANDS_PER_PX = 0.5;
const MAX_STRANDS = 260000;
const SEG = 4;
const HALF_SEG = SEG / 2;
const GRID = 48;
const ART = 512;
const FLOW = 64;
const PIXEL_BUDGET = 2_600_000;

const COMMON = `
uniform vec2 uHalf;
uniform float uCorner, uBevel, uDome;
uniform mat3 uRot;
uniform float uCam;
uniform vec2 uFrame, uRollCS, uOff;

float sdTile(vec2 p, out vec2 g) {
    vec2 sp = vec2(p.x < 0.0 ? -1.0 : 1.0, p.y < 0.0 ? -1.0 : 1.0);
    vec2 q = abs(p) - uHalf + uCorner;
    if (q.x > 0.0 && q.y > 0.0) { float l = length(q); g = q / l * sp; return l - uCorner; }
    g = q.x > q.y ? vec2(sp.x, 0.0) : vec2(0.0, sp.y);
    return max(q.x, q.y) - uCorner;
}
vec3 surf(vec2 p, out vec3 n) {
    vec2 g; float d = sdTile(p, g);
    float e = max(-d, 0.0);
    float q = clamp(e / uBevel, 0.02, 1.0);
    float r = 1.0 - q;
    float rr = sqrt(1.0 - r * r);
    float z = uBevel * rr;
    float dz = r / rr;
    float span = min(uHalf.x, uHalf.y);
    float c = clamp(e / span, 0.0, 1.0);
    z += uDome * (1.0 - (1.0 - c) * (1.0 - c));
    dz += uDome * 2.0 * (1.0 - c) / span;
    n = normalize(vec3(g * dz, 1.0));
    return vec3(p, z);
}
vec2 toNdc(vec3 local) {
    vec3 w = uRot * local;
    vec2 xy = w.xy * (uCam / (uCam - w.z));
    xy = vec2(uRollCS.x * xy.x + uRollCS.y * xy.y, -uRollCS.y * xy.x + uRollCS.x * xy.y);
    return xy / uFrame + uOff;
}
vec3 toSrgb(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
`;

const BG_VERT = `#version 300 es
void main() {
    vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
    gl_Position = vec4(p, 0.0, 1.0);
}`;

const BG_FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform vec3 uBg, uWash;
uniform vec4 uTileBox;
uniform vec4 uShadowP;
uniform float uGlow, uShadowK, uHorizon, uFade;
out vec4 o;
vec3 toSrgb(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }
void main() {
    vec2 px = gl_FragCoord.xy;
    float m = 0.5 * min(uRes.x, uRes.y);
    vec2 c = (px - 0.5 * uRes) / m;

    vec3 col = uBg * 0.14;
    col += uWash * exp(-(c.x * c.x * 1.4 + (c.y - 1.05) * (c.y - 1.05) * 1.1));
    vec2 tq = (px - uTileBox.xy) / uTileBox.zw;
    float tr = max(max(abs(tq.x), abs(tq.y)) - 0.9, 0.0);
    col += uBg * uGlow * 0.6 * exp(-tr * tr * 9.0) * uFade;

    float fy = (uHorizon - px.y) / m;
    vec3 floorC = uBg * (1.45 + 0.5 * exp(-fy * fy * 600.0));
    col = mix(col, floorC, smoothstep(-0.03, 0.06, fy));

    vec2 sq = (px - uShadowP.xy) / uShadowP.zw;
    col *= 1.0 - uShadowK * 0.6 * exp(-dot(sq, sq) * 1.4) * uFade;
    vec2 bq = (px - uShadowP.xy - vec2(0.0, uShadowP.w * 0.9)) / (uShadowP.zw * vec2(0.5, 0.6));
    col += uBg * uGlow * 2.2 * exp(-dot(bq, bq)) * uFade;
    col *= 1.0 - 0.8 * smoothstep(0.6, 1.6, length(c * vec2(0.9, 1.0)));

    uvec2 ip = uvec2(px);
    uint hsh = ip.x * 1597334677u ^ ip.y * 3812015801u;
    hsh = (hsh ^ (hsh >> 16)) * 0x7feb352du;
    float n = float(hsh >> 8) / 16777216.0;
    o = vec4(toSrgb(col) + (n - 0.5) / 255.0, 1.0);
}`;

const SHADE = `
uniform sampler2D uArt;
uniform vec3 uLight, uBounceC, uKeyC;
uniform vec2 uDown;
uniform float uKeyLow, uKey, uFade;
float keyGrad(vec3 P0) {
    vec2 ld = uLight.xy;
    float l = length(ld);
    float k = l > 1e-3 ? dot((uRot * P0).xy, ld / l) / max(uHalf.x, uHalf.y) : 0.0;
    return mix(uKeyLow, 1.0, smoothstep(-1.15, 0.7, k)) * mix(0.5, 1.0, smoothstep(-1.1, -0.7, k));
}
vec2 artUv(vec2 p) { return vec2(p.x / uHalf.x, -p.y / uHalf.y) * 0.5 + 0.5; }
`;

const UNDER_VERT = `#version 300 es
precision highp float;
${COMMON}
${SHADE}
uniform float uUnder;
out vec2 vP;
out vec3 vCol;
const int G = ${GRID};
void main() {
    int cell = gl_VertexID / 6;
    int k = gl_VertexID % 6;
    ivec2 off = k == 0 ? ivec2(0, 0) : k == 1 || k == 4 ? ivec2(1, 0) : k == 2 || k == 3 ? ivec2(0, 1) : ivec2(1, 1);
    vec2 g = vec2(ivec2(cell % G, cell / G) + off) / float(G);
    vec2 p = (g * 2.0 - 1.0) * uHalf;
    vec3 N;
    vec3 P = surf(p, N);
    vec3 Nw = normalize(uRot * N);
    vec3 alb = texture(uArt, artUv(p)).rgb;
    float lam = max(dot(Nw, uLight), 0.0) * 0.75 + 0.25;
    vCol = alb * uUnder * vec3(1.0, 0.85, 0.7) * (uKeyC * lam * keyGrad(P) * uKey + uBounceC * max(dot(Nw.xy, uDown), 0.0) * 0.5);
    vP = p;
    gl_Position = vec4(toNdc(P), 0.0, 1.0);
}`;

const UNDER_FRAG = `#version 300 es
precision highp float;
${COMMON}
uniform float uPx;
uniform float uFade;
in vec2 vP;
in vec3 vCol;
out vec4 o;
void main() {
    vec2 g;
    float d = sdTile(vP, g) + 0.012 * min(uHalf.x, uHalf.y);
    float a = (1.0 - smoothstep(-uPx, uPx, d)) * uFade;
    o = vec4(toSrgb(vCol) * a, a);
}`;

const HASH = `
uint hashu(uint x) { x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16; return x; }
float h01(uint x) { return float(hashu(x) >> 8) * (1.0 / 16777216.0); }
`;

const PREP_VERT = `#version 300 es
precision highp float;
precision highp int;
${COMMON}
${HASH}
uniform sampler2D uFlow;
uniform float uLift, uSpread, uClump, uCs, uRimFrac, uEmboss;
uniform uint uSeed;
out vec4 oA;
out vec4 oB;
out vec4 oC;
out vec4 oD;
void main() {
    uint id = uint(gl_VertexID);
    uint hb = hashu(id + uSeed * 7919u) * 16u;
    float h0 = h01(hb), h1 = h01(hb + 1u), h2 = h01(hb + 2u), h3 = h01(hb + 3u);
    float h4 = h01(hb + 4u), h5 = h01(hb + 5u), h7 = h01(hb + 7u);
    vec2 g;
    vec2 p;
    float alive = 1.0;
    bool rim = h0 < uRimFrac;
    if (rim) {
        float an = h1 * 6.2831853;
        vec2 dir = vec2(cos(an), sin(an));
        float t = 0.0;
        for (int i = 0; i < 6; i++) t -= sdTile(dir * t, g);
        p = dir * t;
        sdTile(p, g);
        p -= g * (h2 * h2 * 0.45 * uBevel);
    } else {
        uint k = id + uSeed * 100003u;
        vec2 r2 = vec2(float(k * 3242174889u + 2147483648u), float(k * 2447445414u + 2147483648u)) * (1.0 / 4294967296.0);
        p = (r2 * 2.0 - 1.0) * uHalf;
        if (sdTile(p, g) > 0.0) alive = 0.0;
    }
    vec3 N;
    vec3 P0 = surf(p, N);
    vec2 uv = vec2(p.x / uHalf.x, -p.y / uHalf.y) * 0.5 + 0.5;

    const float TX = 1.0 / float(${FLOW});
    float hC = texture(uFlow, uv).b;
    float hx = (texture(uFlow, uv + vec2(TX, 0.0)).b - texture(uFlow, uv - vec2(TX, 0.0)).b) / (4.0 * TX * uHalf.x);
    float hy = -(texture(uFlow, uv + vec2(0.0, TX)).b - texture(uFlow, uv - vec2(0.0, TX)).b) / (4.0 * TX * uHalf.y);
    float inside = smoothstep(0.0, uBevel, -sdTile(p, g));
    P0.z += uEmboss * hC * inside;
    N = normalize(N - vec3(hx, hy, 0.0) * uEmboss * inside);

    vec2 fl = texture(uFlow, uv).rg * 2.0 - 1.0;
    vec3 t3 = vec3(fl.x, -fl.y, 0.0);
    vec3 T = t3 - N * dot(t3, N);
    float tl = length(T);
    T = tl > 0.05 ? T / tl : normalize(cross(N, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
    float fan = (h3 - 0.5) * uSpread;
    T = T * cos(fan) + cross(N, T) * sin(fan);

    vec2 ci = floor(p / uCs);
    vec2 best = p;
    float bd = 1e9;
    uint cid = 0u;
    for (int j = -1; j <= 1; j++)
        for (int i = -1; i <= 1; i++) {
            ivec2 cc = ivec2(ci) + ivec2(i, j);
            uint hh = hashu(uint(cc.x + 8192) * 73856093u ^ uint(cc.y + 8192) * 19349663u ^ (uSeed * 83492791u));
            vec2 pt = (vec2(cc) + vec2(h01(hh), h01(hh ^ 0x9e3779b9u))) * uCs;
            float d2 = dot(pt - p, pt - p);
            if (d2 < bd) { bd = d2; best = pt; cid = hh; }
        }
    vec3 pull = vec3(best - p, 0.0);
    pull = (pull - N * dot(pull, N)) * (rim ? 0.3 * uClump : uClump);
    float tuft = 1.0 + (h01(cid ^ 0x5bd1e995u) - 0.5) * 0.3;

    float crown = mix(3.0, 1.0, texture(uFlow, uv).a);
    float lift = (rim ? max(uLift, 1.4) : uLift * crown) * (0.6 + 0.8 * h4);
    oA = vec4(P0, h7 * 6.2831853);
    oB = vec4(N, lift);
    oC = vec4(T, tuft);
    oD = vec4(pull, alive * (0.55 + 0.9 * h5));
    gl_Position = vec4(0.0);
}`;

const PREP_FRAG = `#version 300 es
precision highp float;
out vec4 o;
void main() { o = vec4(0.0); }`;

const STRAND_VERT = `#version 300 es
precision highp float;
precision highp int;
${COMMON}
${SHADE}
${HASH}
layout(location = 0) in vec4 aA;
layout(location = 1) in vec4 aB;
layout(location = 2) in vec4 aC;
layout(location = 3) in vec4 aD;
uniform vec2 uRes;
uniform vec3 uGrav;
uniform vec4 uBrush;
uniform float uLen, uFrizz, uGrow, uTime, uBreeze, uWidth;
uniform float uJitter, uTipFade, uRootShade, uSheen, uRim, uCount, uDepth;
uniform uint uSeed;
uniform int uSegBase;
out vec4 vCol;
out float vDist;
out float vHalf;
out vec2 vCrimp;
const int SEG = ${SEG};

void main() {
    if (aD.w <= 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); vCol = vec4(0.0); vDist = 0.0; vHalf = 0.0; vCrimp = vec2(0.0); return; }
    int seg = (gl_VertexID >> 1) + uSegBase;
    float side = (gl_VertexID & 1) == 0 ? -1.0 : 1.0;
    float s = float(seg) / float(SEG);
    uint id = uint(gl_InstanceID);
    uint hb = hashu(id ^ (uSeed * 0x2545F491u) ^ 0xA511E9B3u);
    float hj = float(hb & 1023u) / 1023.0;
    float hw = float((hb >> 10) & 1023u) / 1023.0;
    float hc = float((hb >> 20) & 1023u) / 1023.0;

    float a = uHalf.x;
    vec3 P0 = aA.xyz * a;
    vec3 N = aB.xyz;
    vec3 T = aC.xyz;
    vec3 B = cross(N, T);
    float lift = aB.w;
    float ph0 = aA.w;
    float curlF = 2.0 + 4.0 * hc;
    vec3 pull = aD.xyz * a;

    bool rimHair = lift > 1.2;
    float L = uLen * aD.w * uGrow * (rimHair ? 0.75 : 1.0);

    vec2 dv = P0.xy - uBrush.xy;
    float dd = dot(dv, dv);
    float fb = uBrush.w * exp(-dd / (uBrush.z * uBrush.z));
    vec3 bp = vec3(dv * inversesqrt(dd + 1e-6), 0.0);
    bp -= N * dot(bp, N);
    vec3 D0 = normalize(N * lift * (1.0 - 0.7 * min(fb, 1.0)) + T + bp * fb * 1.5);
    vec3 bend = T * 0.6 + uGrav * (rimHair ? 0.2 : 0.35) - N * lift * 0.3 + bp * fb * 1.5;
    vec2 wv = vec2(sin(uTime * 1.7 + P0.x * 6.0 + P0.y * 2.5 + hc * 1.5), cos(uTime * 1.3 + P0.y * 5.0 - P0.x * 3.0 + hj * 2.0));
    bend += vec3(wv, 0.0) * uBreeze;

    float ph = ph0 + s * curlF;
    float k1 = uFrizz * 0.18, k2 = uFrizz * 0.08;
    vec3 cw = B * sin(ph) + N * 0.4 * cos(ph);
    float cr = ph0 * 3.0 + s * 9.0;
    vec3 curl = cw * (k1 * s) + B * (sin(cr) * k2);
    vec3 dcurl = (B * cos(ph) - N * 0.4 * sin(ph)) * (curlF * k1 * s) + cw * k1 + B * (cos(cr) * 9.0 * k2);
    float rs = sqrt(s);
    vec3 P = P0 + L * (D0 * s + bend * (0.5 * s * s) + curl) + pull * (s * rs);
    vec3 dP = L * (D0 + bend * s + dcurl) + pull * (1.5 * rs);

    vec2 ndc = toNdc(P);
    vec2 dpx = (toNdc(P + dP * 0.02) - ndc) * uRes;
    vec2 perp = normalize(vec2(-dpx.y, dpx.x) + 1e-6);
    float w = uWidth * (1.0 - 0.5 * s) * (0.8 + 0.4 * hw) * (rimHair ? 0.75 : 1.0);
    float cov = min(w, 1.0);
    w = max(w, 1.0);

    float hwid = 0.5 * w + 0.6;
    vDist = side * hwid;
    vHalf = 0.5 * w;
    vCrimp = vec2(s, hc * 6.2831853);
    gl_Position = vec4(ndc + perp * (side * hwid * 2.0) / uRes, 0.0, 1.0);

    vec3 Nw = normalize(uRot * N);
    vec3 Tw = normalize(uRot * dP);
    float layer = mix(1.0 - uDepth, 1.0, sqrt(float(id) / uCount));
    vec3 alb = texture(uArt, artUv(P0.xy)).rgb * (1.0 + (hj - 0.5) * 2.0 * uJitter) * aC.w * layer;
    float kg = keyGrad(P0);
    float tl2 = dot(Tw, uLight);
    float kk = sqrt(max(1.0 - tl2 * tl2, 0.0));
    float lam = max(dot(Nw, uLight), 0.0) * 0.9 + 0.1;

    float pale = min(min(alb.r, alb.g), alb.b) / max(max(alb.r, alb.g), max(alb.b, 1e-4));
    float ao1 = mix(1.0 - uRootShade * (1.0 - 0.35 * pale), 1.0, smoothstep(0.0, 1.0, s));
    vec3 ao = ao1 * mix(vec3(1.0), vec3(1.12, 0.94, 0.78), (1.0 - ao1) * pale);
    vec3 H = normalize(uLight + vec3(0.0, 0.0, 1.0));
    float th = dot(Tw, H);
    float sh = max(1.0 - th * th, 0.0);
    float spec = pow(sh, 24.0) * uSheen * kg * smoothstep(0.15, 0.9, s);
    float rimL = pow(1.0 - abs(Nw.z), 2.0) * s * uRim * kg * kg;
    vec3 sheenC = mix(alb * 1.6, vec3(1.0), 0.15 + 0.85 * pale * pale);

    vec3 warm = mix(vec3(1.0, 0.8, 0.62), vec3(1.0), mix(1.0, smoothstep(0.08, 0.6, lam * kg), pale));
    vec3 col = alb * (uKeyC * warm * lam * (0.55 + 0.45 * kk) * kg * ao * uKey + uBounceC * max(dot(Nw.xy, uDown), 0.0) * ao + uKeyC * rimL)
             + uKeyC * (sheenC * spec + alb * pow(sh, 8.0) * uSheen * 0.35 * kg);
    float al = cov * uFade * (1.0 - uTipFade * smoothstep(0.55, 1.0, s));
    vCol = vec4(toSrgb(col) * al, al);
}`;

const STRAND_FRAG = `#version 300 es
precision highp float;
uniform float uCrimpK;
in vec4 vCol;
in float vDist;
in float vHalf;
in vec2 vCrimp;
out vec4 o;
void main() {
    float cov = clamp(vHalf + 0.5 - abs(vDist), 0.0, 1.0);
    float g = sin(vCrimp.x * 22.0 + vCrimp.y);
    float glint = 1.0 + uCrimpK * (g * g - 0.5);
    o = vec4(vCol.rgb * glint, vCol.a) * cov;
}`;

/** Paints the fur albedo: ink base with the agenthub A-check centred on it. */
function paintArt(ctx: CanvasRenderingContext2D) {
  const S = ART;
  const fur = SETTINGS.fur;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = `rgb(${Math.round(fur[0] * 255)},${Math.round(fur[1] * 255)},${Math.round(fur[2] * 255)})`;
  ctx.fillRect(0, 0, S, S);
  const box = (S * SETTINGS.artSize) / 100;
  const k = box / 24;
  ctx.setTransform(k, 0, 0, k, (S - box) / 2, (S - box) / 2);
  ctx.strokeStyle = SETTINGS.mark;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Slightly bolder than the flat logo so the shape survives the fur.
  ctx.lineWidth = 3.2;
  ctx.stroke(new Path2D(LOGO_LEGS_PATH));
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = SETTINGS.check;
  ctx.stroke(new Path2D(LOGO_CHECK_PATH));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** Fur direction field from the artwork's structure tensor, plus an emboss mask. */
function buildFlow(
  small: CanvasRenderingContext2D,
  art: HTMLCanvasElement,
  edge: number,
  fur: RGBA,
  out: Uint8Array,
) {
  const n = FLOW;
  small.clearRect(0, 0, n, n);
  small.drawImage(art, 0, 0, n, n);
  const data = small.getImageData(0, 0, n, n).data;
  const at = (i: number) => (data[i] ?? 0) / 255;

  const mask = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const dr = at(i * 4) - fur[0];
    const dg = at(i * 4 + 1) - fur[1];
    const db = at(i * 4 + 2) - fur[2];
    mask[i] = Math.min(1, Math.sqrt(dr * dr + dg * dg + db * db) * 2.5);
  }
  const boxBlur = (a: Float32Array, r: number, passes: number) => {
    const tmp = new Float32Array(n * n);
    const get = (arr: Float32Array, i: number) => arr[i] ?? 0;
    for (let pass = 0; pass < passes; pass++) {
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          let s = 0;
          for (let k = -r; k <= r; k++) s += get(a, y * n + Math.min(n - 1, Math.max(0, x + k)));
          tmp[y * n + x] = s / (2 * r + 1);
        }
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          let s = 0;
          for (let k = -r; k <= r; k++) s += get(tmp, Math.min(n - 1, Math.max(0, y + k)) * n + x);
          a[y * n + x] = s / (2 * r + 1);
        }
    }
  };
  boxBlur(mask, 2, 3);

  const E = new Float32Array(n * n);
  const F = new Float32Array(n * n);
  const G = new Float32Array(n * n);
  const useEdges = edge > 0;
  if (useEdges) {
    const px = (x: number, y: number, c: number) =>
      at(((Math.min(n - 1, Math.max(0, y)) * n + Math.min(n - 1, Math.max(0, x))) << 2) + c);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        let e = 0;
        let f = 0;
        let g = 0;
        for (let c = 0; c < 3; c++) {
          const gx =
            px(x + 1, y - 1, c) +
            2 * px(x + 1, y, c) +
            px(x + 1, y + 1, c) -
            px(x - 1, y - 1, c) -
            2 * px(x - 1, y, c) -
            px(x - 1, y + 1, c);
          const gy =
            px(x - 1, y + 1, c) +
            2 * px(x, y + 1, c) +
            px(x + 1, y + 1, c) -
            px(x - 1, y - 1, c) -
            2 * px(x, y - 1, c) -
            px(x + 1, y - 1, c);
          e += gx * gx;
          f += gx * gy;
          g += gy * gy;
        }
        const i = y * n + x;
        E[i] = e;
        F[i] = f;
        G[i] = g;
      }
    boxBlur(E, 3, 2);
    boxBlur(F, 3, 2);
    boxBlur(G, 3, 2);
  }
  const v = (arr: Float32Array, i: number) => arr[i] ?? 0;
  let maxMag = 0;
  for (let i = 0; i < n * n; i++) {
    const e = v(E, i);
    const g = v(G, i);
    const l1 = (e + g) / 2 + Math.sqrt(((e - g) / 2) ** 2 + v(F, i) ** 2);
    maxMag = Math.max(maxMag, Math.sqrt(l1));
  }
  const ref = Math.max(0.4 * maxMag, 0.05);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const cx = (x + 0.5) / n - 0.5;
      const cy = (y + 0.5) / n - 0.5;
      const rl = Math.hypot(cx, cy) + 1e-6;
      const kr = Math.min(1, rl * 5) / rl;
      let bx = cx * kr;
      let by = cy * kr + 0.1 + 0.9 * Math.max(0, 1 - rl * 4);
      const bl = Math.hypot(bx, by) + 1e-6;
      bx /= bl;
      by /= bl;
      let src = Math.min(1, bl / 0.6);
      let dx = bx;
      let dy = by;
      if (useEdges) {
        const e = v(E, i);
        const f = v(F, i);
        const g = v(G, i);
        const half = Math.sqrt(((e - g) / 2) ** 2 + f * f);
        const l1 = (e + g) / 2 + half;
        const l2 = (e + g) / 2 - half;
        let vx = e >= g ? l1 - g : f;
        let vy = e >= g ? f : l1 - e;
        const vl = Math.hypot(vx, vy);
        if (vl > 1e-9) {
          vx /= vl;
          vy /= vl;
          const coh = (l1 - l2) / (l1 + l2 + 1e-9);
          const w = Math.min(1, (Math.sqrt(l1) / ref) ** 2) * coh * edge;
          src = Math.max(src, w);
          const across = (bx * vx + by * vy) * Math.min(w, 0.92);
          dx = bx - vx * across;
          dy = by - vy * across;
          const dl = Math.hypot(dx, dy) + 1e-9;
          dx /= dl;
          dy /= dl;
        }
      }
      out[i * 4] = Math.round((dx * 0.5 + 0.5) * 255);
      out[i * 4 + 1] = Math.round((dy * 0.5 + 0.5) * 255);
      out[i * 4 + 2] = Math.round(v(mask, i) * 255);
      out[i * 4 + 3] = Math.round(src * 255);
    }
}

/** WebGL's program switch (not a React hook, despite the name). */
function activate(gl: WebGL2RenderingContext, prog: WebGLProgram) {
  // biome-ignore lint/correctness/useHookAtTopLevel: WebGL2RenderingContext.useProgram, not a hook.
  gl.useProgram(prog);
}

type Uniforms = ReturnType<typeof makeUniforms>;

/** Cached uniform setters: skip the GL call when the value has not changed. */
function makeUniforms(gl: WebGL2RenderingContext, prog: WebGLProgram) {
  type Slot = { loc: WebGLUniformLocation | null; v: number[] };
  const slots = new Map<string, Slot>();
  const slot = (name: string) => {
    let s = slots.get(name);
    if (!s) {
      s = {
        loc: gl.getUniformLocation(prog, name),
        v: [Number.NaN, Number.NaN, Number.NaN, Number.NaN],
      };
      slots.set(name, s);
    }
    return s;
  };
  const changed = (s: Slot, a: number, b: number, c: number, d: number) => {
    if (s.v[0] === a && s.v[1] === b && s.v[2] === c && s.v[3] === d) return false;
    s.v[0] = a;
    s.v[1] = b;
    s.v[2] = c;
    s.v[3] = d;
    return true;
  };
  return {
    f1(name: string, a: number) {
      const s = slot(name);
      if (changed(s, a, 0, 0, 0)) gl.uniform1f(s.loc, a);
    },
    u1(name: string, a: number) {
      const s = slot(name);
      if (changed(s, a, 0, 0, 0)) gl.uniform1ui(s.loc, a);
    },
    i1(name: string, a: number) {
      const s = slot(name);
      if (changed(s, a, 0, 0, 0)) gl.uniform1i(s.loc, a);
    },
    f2(name: string, a: number, b: number) {
      const s = slot(name);
      if (changed(s, a, b, 0, 0)) gl.uniform2f(s.loc, a, b);
    },
    f3(name: string, a: number, b: number, c: number) {
      const s = slot(name);
      if (changed(s, a, b, c, 0)) gl.uniform3f(s.loc, a, b, c);
    },
    f4(name: string, a: number, b: number, c: number, d: number) {
      const s = slot(name);
      if (changed(s, a, b, c, d)) gl.uniform4f(s.loc, a, b, c, d);
    },
    m3(name: string, m: Float32Array) {
      gl.uniformMatrix3fv(slot(name).loc, false, m);
    },
  };
}

/** Starts the tile on a canvas. Returns the cleanup, or nothing when WebGL2 is unavailable. */
function startPlush(
  root: HTMLDivElement,
  canvas: HTMLCanvasElement,
  onRestore: () => void,
): (() => void) | undefined {
  // Tens of thousands of strands are too much for low-end GPUs: show the flat logo there.
  if (prefersLightEffects()) {
    canvas.style.display = 'none';
    return;
  }
  const maybe = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    powerPreference: 'low-power',
    preserveDrawingBuffer: false,
  });
  if (!maybe) return;
  const gl: WebGL2RenderingContext = maybe;

  const shaders: WebGLShader[] = [];
  const programs: WebGLProgram[] = [];
  const build = (vs: string, fs: string, varyings?: string[]) => {
    const compile = (type: number, s: string) => {
      const sh = gl.createShader(type);
      if (!sh) throw new Error('shader');
      gl.shaderSource(sh, s);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(sh) || 'shader');
      shaders.push(sh);
      return sh;
    };
    const p = gl.createProgram();
    if (!p) throw new Error('program');
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    if (varyings) gl.transformFeedbackVaryings(p, varyings, gl.INTERLEAVED_ATTRIBS);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(p) || 'link');
    programs.push(p);
    return p;
  };
  let bgProg: WebGLProgram;
  let underProg: WebGLProgram;
  let prepProg: WebGLProgram;
  let strandProg: WebGLProgram;
  try {
    bgProg = build(BG_VERT, BG_FRAG);
    underProg = build(UNDER_VERT, UNDER_FRAG);
    prepProg = build(PREP_VERT, PREP_FRAG, ['oA', 'oB', 'oC', 'oD']);
    strandProg = build(STRAND_VERT, STRAND_FRAG);
  } catch {
    // Decorative only: hide the canvas so the flat logo underneath shows instead.
    canvas.style.display = 'none';
    return;
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const STRIDE = 64;
  const strandBuf = gl.createBuffer();
  const strandVao = gl.createVertexArray();
  const tf = gl.createTransformFeedback();
  gl.bindVertexArray(strandVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, strandBuf);
  for (let i = 0; i < 4; i++) {
    gl.enableVertexAttribArray(i);
    gl.vertexAttribPointer(i, 4, gl.FLOAT, false, STRIDE, i * 16);
    gl.vertexAttribDivisor(i, 1);
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.bindVertexArray(vao);
  let capacity = 0;
  const prepKey = new Float64Array(12).fill(Number.NaN);

  const U_BG = makeUniforms(gl, bgProg);
  const U_UN = makeUniforms(gl, underProg);
  const U_ST = makeUniforms(gl, strandProg);
  const U_PR = makeUniforms(gl, prepProg);

  const artTex = gl.createTexture();
  const flowTex = gl.createTexture();
  const setupTex = (t: WebGLTexture | null, unit: number) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  };
  setupTex(artTex, 0);
  setupTex(flowTex, 1);
  activate(gl, underProg);
  U_UN.i1('uArt', 0);
  activate(gl, strandProg);
  U_ST.i1('uArt', 0);
  activate(gl, prepProg);
  U_PR.i1('uFlow', 1);

  // The artwork never changes, so paint it and its fur flow once.
  const artCanvas = document.createElement('canvas');
  artCanvas.width = ART;
  artCanvas.height = ART;
  const artCtx = artCanvas.getContext('2d');
  const smallCanvas = document.createElement('canvas');
  smallCanvas.width = FLOW;
  smallCanvas.height = FLOW;
  const smallCtx = smallCanvas.getContext('2d', { willReadFrequently: true });
  if (!artCtx || !smallCtx) {
    canvas.style.display = 'none';
    return;
  }
  paintArt(artCtx);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, artTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, artCanvas);
  const flowData = new Uint8Array(FLOW * FLOW * 4);
  buildFlow(smallCtx, artCanvas, SETTINGS.edgeFlow / 100, SETTINGS.fur, flowData);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, flowTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, FLOW, FLOW, 0, gl.RGBA, gl.UNSIGNED_BYTE, flowData);

  let cssW = Math.max(1, root.offsetWidth);
  let cssH = Math.max(1, root.offsetHeight);
  let quality = 1;
  const applySize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const budget = Math.min(1, Math.sqrt(PIXEL_BUDGET / Math.max(1, cssW * cssH * dpr * dpr)));
    const k = dpr * budget * quality;
    const w = Math.max(1, Math.round(cssW * k));
    const h = Math.max(1, Math.round(cssH * k));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
  };
  applySize();

  let disposed = false;
  let raf = 0;
  let scheduled = false;
  const wake = () => {
    if (disposed || scheduled) return;
    scheduled = true;
    raf = requestAnimationFrame(loop);
  };

  const ro = new ResizeObserver((entries) => {
    const r = entries[0]?.contentRect;
    if (!r) return;
    cssW = Math.max(1, r.width);
    cssH = Math.max(1, r.height);
    applySize();
    wake();
  });
  ro.observe(root);

  const ptr = { cx: 0, cy: 0, u: 0.5, v: 0.5, over: false, moved: false };
  const onMove = (e: PointerEvent) => {
    if (ptr.over && e.clientX === ptr.cx && e.clientY === ptr.cy) return;
    ptr.cx = e.clientX;
    ptr.cy = e.clientY;
    ptr.over = true;
    ptr.moved = true;
    wake();
  };
  const onLeave = () => {
    ptr.over = false;
    wake();
  };
  const onUp = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') onLeave();
  };
  const onScroll = () => {
    if (ptr.over) ptr.moved = true;
  };
  root.addEventListener('pointerenter', onMove);
  root.addEventListener('pointermove', onMove);
  root.addEventListener('pointerdown', onMove);
  root.addEventListener('pointerleave', onLeave);
  root.addEventListener('pointerup', onUp);
  root.addEventListener('pointercancel', onLeave);
  window.addEventListener('scroll', onScroll, { passive: true, capture: true });

  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = mq.matches;
  const onMq = () => {
    reduced = mq.matches;
    wake();
  };
  mq.addEventListener('change', onMq);

  let visible = true;
  const io = new IntersectionObserver((es) => {
    visible = es[es.length - 1]?.isIntersecting ?? true;
    wake();
  });
  io.observe(root);
  const onVis = () => wake();
  document.addEventListener('visibilitychange', onVis);

  const onLost = (e: Event) => {
    e.preventDefault();
    disposed = true;
    cancelAnimationFrame(raf);
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestore);

  const rot = new Float32Array(9);
  const tc = [0, 0];
  const tb = [0, 0];
  const view = { cam: 1, fx: 1, fy: 1, rcs: 1, rsn: 0, offX: 0, offY: 0 };
  const sh = {
    a: 1,
    rc: 0,
    bevel: 0,
    dome: 0,
    lx: 0,
    ly: 0,
    lz: 1,
    dnx: 0,
    dny: -1,
    b0: 0,
    b1: 0,
    b2: 0,
    keyLow: 0,
    k0: 1,
    k1: 1,
    k2: 1,
    fade: 1,
  };

  const project = (x: number, y: number, z: number, out: number[]) => {
    const r = (i: number) => rot[i] ?? 0;
    const wx = r(0) * x + r(3) * y + r(6) * z;
    const wy = r(1) * x + r(4) * y + r(7) * z;
    const wz = r(2) * x + r(5) * y + r(8) * z;
    const s = view.cam / (view.cam - wz);
    const X = wx * s;
    const Y = wy * s;
    const nx = (view.rcs * X + view.rsn * Y) / view.fx + view.offX;
    const ny = (-view.rsn * X + view.rcs * Y) / view.fy + view.offY;
    out[0] = (nx * 0.5 + 0.5) * canvas.width;
    out[1] = (ny * 0.5 + 0.5) * canvas.height;
  };
  const setShared = (U: Uniforms) => {
    U.f2('uHalf', sh.a, sh.a);
    U.f1('uCorner', Math.min(sh.rc, sh.a * 0.999));
    U.f1('uBevel', Math.max(sh.bevel, 1e-3));
    U.f1('uDome', sh.dome);
    U.m3('uRot', rot);
    U.f1('uCam', view.cam);
    U.f2('uFrame', view.fx, view.fy);
    U.f2('uRollCS', view.rcs, view.rsn);
    U.f2('uOff', view.offX, view.offY);
    U.f3('uLight', sh.lx, sh.ly, sh.lz);
    U.f3('uBounceC', sh.b0, sh.b1, sh.b2);
    U.f2('uDown', sh.dnx, sh.dny);
    U.f1('uKeyLow', sh.keyLow);
    U.f1('uKey', 1.9);
    U.f3('uKeyC', sh.k0, sh.k1, sh.k2);
    U.f1('uFade', sh.fade);
  };
  const sm = { bx: 0, by: 0, bw: 0, yaw: 0, pitch: 0 };
  let entT = 0;
  let clock = 0;
  let lastDraw = -1;
  let frameEma = 16.7;
  let slowFrames = 0;
  let fastFrames = 0;
  const C = SETTINGS;

  function loop(now: number) {
    scheduled = false;
    if (disposed || !visible || document.hidden) {
      lastDraw = -1;
      return;
    }
    const dur = C.entranceDuration;
    const delay = C.entranceDelay;
    const playEntrance = !reduced;
    const entDone = !playEntrance || entT >= delay + dur;
    const breezeK = reduced ? 0 : C.breeze / 10;
    const par = C.parallax / 10;
    const tYaw = ptr.over ? (ptr.u - 0.5) * 2 * par * 16 * D2R : 0;
    const tPitch = ptr.over ? (0.5 - ptr.v) * 2 * par * 16 * D2R : 0;
    const tBw = ptr.over ? C.strength / 5 : 0;
    const active =
      ptr.moved ||
      !entDone ||
      Math.abs(tBw - sm.bw) > 4e-3 ||
      Math.abs(tYaw - sm.yaw) + Math.abs(tPitch - sm.pitch) > 1e-4;

    // Idle breeze at ~20 fps; full rate only while the pointer is brushing the fur.
    const gap = active ? 15 : 48;
    if (lastDraw >= 0 && now - lastDraw < gap) {
      wake();
      return;
    }
    const dt = lastDraw < 0 ? 0 : Math.min((now - lastDraw) / 1000, 1 / 20);
    if (lastDraw >= 0) {
      frameEma += (now - lastDraw - frameEma) * 0.1;
      const target = gap + 2;
      if (frameEma > target * 1.45) slowFrames++;
      else slowFrames = 0;
      if (frameEma < target * 1.1) fastFrames++;
      else fastFrames = 0;
      if (slowFrames > 20 && quality > 0.6) {
        quality = Math.max(0.6, quality * 0.88);
        slowFrames = 0;
        applySize();
      } else if (fastFrames > 180 && quality < 1) {
        quality = Math.min(1, quality * 1.08);
        fastFrames = 0;
        applySize();
      }
    }
    lastDraw = now;
    entT += dt;
    clock = (clock + dt) % 3600;

    let movedNow = false;
    if (ptr.moved) {
      ptr.moved = false;
      movedNow = true;
      const r = root.getBoundingClientRect();
      ptr.u = (ptr.cx - r.left) / Math.max(1, r.width);
      ptr.v = (ptr.cy - r.top) / Math.max(1, r.height);
    }

    const ge = playEntrance ? Math.min(1, Math.max(0, (entT - delay) / dur)) : 1;
    const grow = 1 - (1 - ge) ** 3;
    const fade = Math.min(1, ge / 0.35);

    const aFull = TILE_HALF * (C.scale / 100);
    const a = aFull * (0.94 + 0.06 * grow);
    const rc = a * (C.radius / 100);
    const pf = C.puff;
    const bevel = a * (0.06 + 0.032 * pf);
    const dome = a * 0.012 * pf;
    const fov = C.lens * D2R;
    const cam = 1 / Math.tan(fov / 2);
    const minCss = Math.min(cssW, cssH);
    const fx = cssW / minCss;
    const fy = cssH / minCss;
    const rcs = 1;
    const rsn = 0;
    const offX = 0;
    const offY = 0;

    const kv = 1 - Math.exp(-dt * 6);
    sm.yaw += (tYaw - sm.yaw) * kv;
    sm.pitch += (tPitch - sm.pitch) * kv;
    if (Math.abs(tYaw - sm.yaw) + Math.abs(tPitch - sm.pitch) < 1e-4) {
      sm.yaw = tYaw;
      sm.pitch = tPitch;
    }
    const pitch = sm.pitch;
    const yaw = sm.yaw;
    const cp = Math.cos(-pitch);
    const sp = Math.sin(-pitch);
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    rot[0] = cy;
    rot[1] = sp * sy;
    rot[2] = -cp * sy;
    rot[3] = 0;
    rot[4] = cp;
    rot[5] = sp;
    rot[6] = sy;
    rot[7] = -sp * cy;
    rot[8] = cp * cy;

    view.cam = cam;
    view.fx = fx;
    view.fy = fy;
    view.rcs = rcs;
    view.rsn = rsn;
    view.offX = offX;
    view.offY = offY;

    if (ptr.over) {
      // Ray from the pointer onto the cushion's top plane: where the brush parts the fur.
      const nx = ptr.u * 2 - 1 - offX;
      const ny = 1 - ptr.v * 2 - offY;
      const X = nx * fx;
      const Y = ny * fy;
      const zTop = bevel + dome * 0.5;
      const n0 = sy;
      const n1 = -sp * cy;
      const n2 = cp * cy;
      const denom = X * n0 + Y * n1 - cam * n2;
      if (Math.abs(denom) > 1e-6) {
        const t = (zTop - cam * n2) / denom;
        const hx = X * t;
        const hy = Y * t;
        const hz = cam + -cam * t;
        const lx = cy * hx + sp * sy * hy + -cp * sy * hz;
        const ly = cp * hy + sp * hz;
        if (sm.bw < 0.02) {
          sm.bx = lx;
          sm.by = ly;
        }
        const kf = movedNow || dt > 0 ? 1 - Math.exp(-dt * 18) : 0;
        sm.bx += (lx - sm.bx) * kf;
        sm.by += (ly - sm.by) * kf;
      }
    }
    sm.bw += (tBw - sm.bw) * (1 - Math.exp(-dt * 8));
    if (Math.abs(tBw - sm.bw) < 4e-3) sm.bw = tBw;

    const la = C.lightAngle * D2R;
    const le = C.lightHeight * D2R;
    const lx = Math.cos(la) * Math.cos(le);
    const ly = Math.sin(la) * Math.cos(le);
    const lz = Math.sin(le);
    const dnx = rsn;
    const dny = -rcs;
    const gx = cy * dnx + sp * sy * dny;
    const gy = cp * dny;
    const gz = sy * dnx + -sp * cy * dny;

    const bg = C.background;
    const fc = C.fur;
    const bgl0 = lin(bg[0]);
    const bgl1 = lin(bg[1]);
    const bgl2 = lin(bg[2]);
    const bounce = C.bounce / 100;
    const frizz = C.frizz / 10;
    const kPx = canvas.width / cssW;
    const tileCss = aFull * minCss;
    const thin = Math.min(1, quality / 0.75);
    const count = Math.min(
      MAX_STRANDS,
      Math.round((C.density / 5) * tileCss * tileCss * STRANDS_PER_PX * thin),
    );

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.disable(gl.BLEND);

    project(0, 0, 0, tc);
    project(0, -a, 0, tb);
    const halfPx = a * 0.5 * Math.min(canvas.width, canvas.height);
    activate(gl, bgProg);
    U_BG.f2('uRes', canvas.width, canvas.height);
    U_BG.f3('uBg', bgl0, bgl1, bgl2);
    const wash = 0.006;
    U_BG.f3('uWash', lin(fc[0]) * wash, lin(fc[1]) * wash, lin(fc[2]) * wash);
    U_BG.f4('uTileBox', tc[0] ?? 0, tc[1] ?? 0, halfPx, halfPx);
    U_BG.f4('uShadowP', tb[0] ?? 0, (tb[1] ?? 0) - halfPx * 0.08, halfPx, halfPx * 0.16);
    U_BG.f1('uGlow', C.glow / 100);
    U_BG.f1('uShadowK', C.shadow / 100);
    U_BG.f1(
      'uHorizon',
      (0.5 + (HORIZON * Math.min(canvas.width, canvas.height)) / (2 * canvas.height)) *
        canvas.height,
    );
    U_BG.f1('uFade', fade);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const kc = C.light;
    sh.a = a;
    sh.rc = rc;
    sh.bevel = bevel;
    sh.dome = dome;
    sh.lx = lx;
    sh.ly = ly;
    sh.lz = lz;
    sh.dnx = dnx;
    sh.dny = dny;
    sh.b0 = bgl0 * bounce * 14;
    sh.b1 = bgl1 * bounce * 14;
    sh.b2 = bgl2 * bounce * 14;
    sh.keyLow = 1 - C.keyFalloff / 100;
    sh.k0 = lin(kc[0]);
    sh.k1 = lin(kc[1]);
    sh.k2 = lin(kc[2]);
    sh.fade = fade;

    activate(gl, underProg);
    setShared(U_UN);
    U_UN.f1('uUnder', C.undercoat / 100);
    U_UN.f1('uPx', 2 / (minCss * kPx));
    gl.drawArrays(gl.TRIANGLES, 0, GRID * GRID * 6);

    const lenK = 0.025 + 0.01 * C.length;
    const liftV = 0.1 + 0.15 * C.lift;
    const seed = C.seed;
    const clump = C.clump / 100;
    const rimFrac = C.rimShare / 100;
    const cornerU = Math.min(rc / a, 0.999);
    const bevelU = Math.max(bevel / a, 1e-3);
    const domeU = dome / a;
    const embossU = (C.emboss / 100) * 0.1;
    const next = [
      count,
      seed,
      rimFrac,
      cornerU,
      bevelU,
      domeU,
      liftV,
      frizz,
      clump,
      lenK,
      1,
      embossU,
    ];
    if (next.some((x, i) => prepKey[i] !== x)) {
      prepKey.set(next);
      if (count > capacity) {
        capacity = Math.min(MAX_STRANDS, Math.ceil(count * 1.25));
        gl.bindBuffer(gl.ARRAY_BUFFER, strandBuf);
        gl.bufferData(gl.ARRAY_BUFFER, capacity * STRIDE, gl.DYNAMIC_COPY);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
      }
      activate(gl, prepProg);
      U_PR.f2('uHalf', 1, 1);
      U_PR.f1('uCorner', cornerU);
      U_PR.f1('uBevel', bevelU);
      U_PR.f1('uDome', domeU);
      U_PR.f1('uLift', liftV);
      U_PR.f1('uSpread', 0.5 + frizz * 0.6);
      U_PR.f1('uClump', clump);
      U_PR.f1('uCs', lenK * 0.75);
      U_PR.f1('uRimFrac', rimFrac);
      U_PR.f1('uEmboss', embossU);
      U_PR.u1('uSeed', seed);
      gl.enable(gl.RASTERIZER_DISCARD);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, tf);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, strandBuf);
      gl.beginTransformFeedback(gl.POINTS);
      gl.drawArrays(gl.POINTS, 0, count);
      gl.endTransformFeedback();
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, null);
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
      gl.disable(gl.RASTERIZER_DISCARD);
    }

    activate(gl, strandProg);
    setShared(U_ST);
    U_ST.f2('uRes', canvas.width, canvas.height);
    U_ST.f3('uGrav', gx, gy, gz);
    U_ST.f4('uBrush', sm.bx, sm.by, a * (0.08 + 0.035 * C.reach), sm.bw);
    U_ST.f1('uLen', a * lenK);
    U_ST.f1('uFrizz', frizz);
    U_ST.f1('uGrow', 0.15 + 0.85 * grow);
    U_ST.f1('uTime', clock);
    U_ST.f1('uBreeze', breezeK * 0.35);
    U_ST.f1('uWidth', (C.hairWidth * kPx) / Math.sqrt(thin));
    U_ST.f1('uJitter', C.colorJitter / 100);
    U_ST.f1('uTipFade', C.tipFade / 100);
    U_ST.f1('uRootShade', C.rootShade / 100);
    U_ST.f1('uSheen', C.sheen / 100);
    U_ST.f1('uRim', C.rimLight / 100);
    U_ST.f1('uCount', Math.max(1, count));
    U_ST.f1('uDepth', C.depthShade / 100);
    U_ST.u1('uSeed', seed);
    U_ST.f1('uCrimpK', C.crimp / 100);
    gl.bindVertexArray(strandVao);
    U_ST.i1('uSegBase', 0);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, (HALF_SEG + 1) * 2, count);
    U_ST.i1('uSegBase', HALF_SEG);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, (HALF_SEG + 1) * 2, count);
    gl.bindVertexArray(vao);

    if (active || breezeK > 0) wake();
  }
  wake();

  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    ro.disconnect();
    io.disconnect();
    root.removeEventListener('pointerenter', onMove);
    root.removeEventListener('pointermove', onMove);
    root.removeEventListener('pointerdown', onMove);
    root.removeEventListener('pointerleave', onLeave);
    root.removeEventListener('pointerup', onUp);
    root.removeEventListener('pointercancel', onLeave);
    window.removeEventListener('scroll', onScroll, { capture: true });
    document.removeEventListener('visibilitychange', onVis);
    mq.removeEventListener('change', onMq);
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestore);
    if (gl.isContextLost()) return;
    gl.deleteTexture(artTex);
    gl.deleteTexture(flowTex);
    gl.deleteVertexArray(vao);
    gl.deleteVertexArray(strandVao);
    gl.deleteBuffer(strandBuf);
    gl.deleteTransformFeedback(tf);
    for (const s of shaders) gl.deleteShader(s);
    for (const p of programs) gl.deleteProgram(p);
  };
}

export interface PlushTileProps {
  className?: string;
  /** Shown when WebGL2 is unavailable: usually the flat logo. */
  fallback?: React.ReactNode;
}

/** The agenthub app icon as an interactive plush cushion. Size and position it with className. */
export function PlushTile({ className, fallback }: PlushTileProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [generation, setGeneration] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: generation restarts after a lost context.
  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    return startPlush(root, canvas, () => setGeneration((g) => g + 1));
  }, [generation]);

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      className={className}
      style={{ overflow: 'hidden', touchAction: 'pan-y' }}
    >
      {fallback ? (
        <div className="absolute inset-0 flex items-center justify-center">{fallback}</div>
      ) : null}
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />
    </div>
  );
}
