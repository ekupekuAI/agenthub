'use client';

/**
 * Page-change transition — adapted from "Miura Image Fold" by Originkit.
 *
 * When a link to another page is clicked, a full-screen sheet titled with the current page
 * appears, folds along a Miura-ori crease pattern, flips over to a sheet titled with the
 * destination, unfolds flat and fades away over the new page. Adaptations for this site:
 * branded title sheets instead of images, triggered by internal navigation, never captures
 * the pointer, skipped for reduced motion, and the WebGL context is created once and only
 * animates while a transition runs. Without WebGL2 the overlay is simply not shown.
 */

import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { prefersLightEffects } from '../../lib/device';
import { THEME_COLORS } from './theme';

const MIURA_GAMMA = (65 * Math.PI) / 180;
const PLAY_S = 0.7;
const FADE_S = 0.2;
// The new page shows its loading state right away, so never hold the sheet long.
const ARRIVE_TIMEOUT_S = 0.6;
const THETA_MAX = (84 * Math.PI) / 180;
const FOV = (30 * Math.PI) / 180;
const FLOATS = 8;
const CELLS = 6;

const SEAL_PATH =
  'M12 2.8A2.6 2.6 0 0 1 16.6 4.03A2.6 2.6 0 0 1 19.97 7.4A2.6 2.6 0 0 1 21.2 12A2.6 2.6 0 0 1 19.97 16.6A2.6 2.6 0 0 1 16.6 19.97A2.6 2.6 0 0 1 12 21.2A2.6 2.6 0 0 1 7.4 19.97A2.6 2.6 0 0 1 4.03 16.6A2.6 2.6 0 0 1 2.8 12A2.6 2.6 0 0 1 4.03 7.4A2.6 2.6 0 0 1 7.4 4.03A2.6 2.6 0 0 1 12 2.8Z';
const CHECK_PATH = 'M8.3 12.2L10.8 14.7L15.7 9.6';

interface Sheet {
  fill: string;
  text: string;
  sub: string;
  accent: string;
  mark: string;
}

/** Sheet colors per theme: the leaving sheet is a plain surface, the arriving one is tinted. */
const SHEETS: Record<'dark' | 'light', { from: Sheet; to: Sheet }> = {
  dark: {
    from: { fill: '#111316', text: '#ECEEF0', sub: '#808995', accent: '#C5F04A', mark: '#ECEEF0' },
    to: { fill: '#121A08', text: '#C5F04A', sub: '#A3ABB5', accent: '#C5F04A', mark: '#ECEEF0' },
  },
  light: {
    from: { fill: '#F3F3EE', text: '#14161A', sub: '#5F6978', accent: '#3F6212', mark: '#14161A' },
    to: { fill: '#EEF5D9', text: '#3F6212', sub: '#4A515B', accent: '#3F6212', mark: '#14161A' },
  },
};

/** Human label for a path, used as the sheet title. */
export function routeLabel(pathname: string): string {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return 'Skills';
  const [first, second] = path.slice(1).split('/');
  if (first === 'skills' && second) return decodeURIComponent(second);
  const named: Record<string, string> = {
    guidelines: 'Guidelines',
    publish: 'Publish',
    dashboard: 'Dashboard',
    admin: 'Admin',
    signin: 'Sign in',
  };
  return named[first ?? ''] ?? decodeURIComponent(first ?? '');
}

function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function miuraCell(a: number, b: number, gamma: number, theta: number) {
  const st = Math.sin(theta);
  const ct = Math.cos(theta);
  const sg = Math.sin(gamma);
  const tg = Math.tan(gamma);
  const k = Math.sqrt(1 + ct * ct * tg * tg);
  return {
    H: a * st * sg,
    S: (b * ct * tg) / k,
    L: a * Math.sqrt(Math.max(0, 1 - st * st * sg * sg)),
    V: b / k,
  };
}

type Cell = ReturnType<typeof miuraCell>;

function miuraVertex(i: number, j: number, c: Cell): [number, number, number] {
  return [i * c.L + (j & 1 ? c.V : 0), j * c.S, i & 1 ? c.H : 0];
}

function miuraLayout(aspect: number, cells: number) {
  const nx = Math.max(2, Math.round(cells));
  const sg = Math.sin(MIURA_GAMMA);
  const ny = Math.max(2, Math.round(nx / (aspect * sg)));
  const b = 1 / (ny * sg);
  const a = (aspect + b * Math.cos(MIURA_GAMMA)) / nx;
  return { nx, ny, a, b, x0: b * Math.cos(MIURA_GAMMA) };
}

const VS = `#version 300 es
precision highp float;
in vec3 aPos;
in vec3 aNormal;
in vec2 aUV;
uniform mat4 uProj;
uniform float uCamZ;
out vec3 vN;
out vec2 vUV;
out vec3 vView;
void main() {
    vec3 p = vec3(aPos.xy, aPos.z - uCamZ);
    vN = aNormal;
    vUV = aUV;
    vView = -p;
    gl_Position = uProj * vec4(p, 1.0);
}
`;

const FS = `#version 300 es
precision highp float;
in vec3 vN;
in vec2 vUV;
in vec3 vView;
uniform sampler2D uTexA;
uniform sampler2D uTexB;
uniform int uMode;
uniform float uFold;
uniform float uShadow;
uniform float uAlpha;
out vec4 o;
void main() {
    if (uMode == 0) {
        float d = length(vUV * 2.0 - 1.0);
        o = vec4(0.0, 0.0, 0.0, uShadow * (1.0 - smoothstep(0.2, 1.0, d))) * uAlpha;
        return;
    }
    if (any(lessThan(vUV, vec2(0.0))) || any(greaterThan(vUV, vec2(1.0)))) discard;
    vec3 V = normalize(vView);
    vec3 N = normalize(vN);
    bool front = dot(N, V) >= 0.0;
    vec3 n = front ? N : -N;
    vec4 ca = texture(uTexA, vUV);
    vec4 cb = texture(uTexB, vec2(1.0 - vUV.x, vUV.y));
    vec4 base = front ? ca : cb;
    vec3 L = normalize(vec3(-0.45, 0.6, 0.66));
    float lam = max(dot(n, L), 0.0);
    float lit = 0.36 + 0.78 * lam;
    vec3 Hh = normalize(L + V);
    float spec = pow(max(dot(n, Hh), 0.0), 48.0) * 0.35;
    float rim = pow(1.0 - clamp(dot(n, V), 0.0, 1.0), 3.0) * 0.45;
    vec3 col = base.rgb * mix(1.0, lit, uFold) + vec3(spec + rim) * uFold * base.a;
    o = vec4(col, base.a) * uAlpha;
}
`;

const UNIFORMS = [
  'uProj',
  'uCamZ',
  'uTexA',
  'uTexB',
  'uMode',
  'uFold',
  'uShadow',
  'uAlpha',
] as const;
type Uni = (typeof UNIFORMS)[number];

/** WebGL's program switch (not a React hook, despite the name). */
function activate(gl: WebGL2RenderingContext, prog: WebGLProgram) {
  // biome-ignore lint/correctness/useHookAtTopLevel: WebGL2RenderingContext.useProgram, not a hook.
  gl.useProgram(prog);
}

function createProgram(gl: WebGL2RenderingContext) {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type);
    if (!s) throw new Error('shader');
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s) || 'shader compile failed';
      gl.deleteShader(s);
      throw new Error(log);
    }
    return s;
  };
  const program = gl.createProgram();
  if (!program) throw new Error('program');
  const vsh = sh(gl.VERTEX_SHADER, VS);
  const fsh = sh(gl.FRAGMENT_SHADER, FS);
  gl.attachShader(program, vsh);
  gl.attachShader(program, fsh);
  gl.linkProgram(program);
  gl.deleteShader(vsh);
  gl.deleteShader(fsh);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) || 'link failed';
    gl.deleteProgram(program);
    throw new Error(log);
  }
  const u = {} as Record<Uni, WebGLUniformLocation | null>;
  for (const name of UNIFORMS) u[name] = gl.getUniformLocation(program, name);
  return { program, u };
}

/** Font families resolved from the page (next/font gives them generated names). */
function pageFonts(): { display: string; mono: string } {
  const probe = (cls: string) => {
    const el = document.createElement('span');
    el.className = cls;
    el.style.display = 'none';
    document.body.appendChild(el);
    const family = getComputedStyle(el).fontFamily;
    el.remove();
    return family || 'serif';
  };
  return { display: probe('font-display'), mono: probe('font-mono') };
}

/** Draws one title sheet: wordmark top-left, a mono caption and the page name in serif. */
function drawSheet(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  dpr: number,
  sheet: Sheet,
  caption: string,
  title: string,
  fonts: { display: string; mono: string },
) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = sheet.fill;
  ctx.fillRect(0, 0, W, H);

  // Faint dot grid, as on the site's page headers.
  ctx.fillStyle = sheet.sub;
  ctx.globalAlpha = 0.12;
  for (let y = 12; y < H; y += 24) for (let x = 12; x < W; x += 24) ctx.fillRect(x, y, 1.5, 1.5);
  ctx.globalAlpha = 1;

  const pad = Math.max(24, Math.min(72, W * 0.06));
  const seal = 28;
  ctx.save();
  ctx.translate(pad, pad);
  ctx.scale(seal / 24, seal / 24);
  ctx.fillStyle = '#C5F04A';
  ctx.fill(new Path2D(SEAL_PATH));
  ctx.strokeStyle = '#0B0C0E';
  ctx.lineWidth = 1.9;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke(new Path2D(CHECK_PATH));
  ctx.restore();
  ctx.fillStyle = sheet.mark;
  ctx.font = `500 18px ${fonts.mono}`;
  ctx.textBaseline = 'middle';
  ctx.fillText('agenthub', pad + seal + 12, pad + seal / 2);

  const size = Math.max(52, Math.min(148, W * 0.1));
  ctx.textBaseline = 'alphabetic';
  ctx.font = `500 13px ${fonts.mono}`;
  ctx.fillStyle = sheet.sub;
  ctx.fillText(caption.toUpperCase().split('').join(' '), pad, H - pad - size * 1.05);
  ctx.font = `400 ${size}px ${fonts.display}`;
  ctx.fillStyle = sheet.text;
  let text = title;
  while (ctx.measureText(text).width > W - pad * 2 && text.length > 4)
    text = `${text.slice(0, -2)}…`;
  ctx.fillText(text, pad, H - pad);
  ctx.fillStyle = sheet.accent;
  ctx.fillRect(pad, H - pad + size * 0.18, Math.min(120, W * 0.18), 3);
}

interface Engine {
  start(from: string, to: string): void;
  arrived(pathname: string): void;
  dispose(): void;
}

function createEngine(wrapper: HTMLDivElement, canvas: HTMLCanvasElement): Engine | null {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: true,
    premultipliedAlpha: true,
  });
  if (!gl) return null;
  let prog: ReturnType<typeof createProgram>;
  try {
    prog = createProgram(gl);
  } catch {
    return null;
  }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  const attr = (name: string, size: number, offset: number) => {
    const loc = gl.getAttribLocation(prog.program, name);
    if (loc < 0) return;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, FLOATS * 4, offset * 4);
  };
  attr('aPos', 3, 0);
  attr('aNormal', 3, 3);
  attr('aUV', 2, 6);
  const texs = [0, 1].map(() => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  });
  const pages = [document.createElement('canvas'), document.createElement('canvas')];
  let verts = new Float32Array(0);
  const proj = new Float32Array(16);

  let W = 0;
  let H = 0;
  let dpr = 1;
  let raf = 0;
  let last = -1;
  let t = 0; // 0..1 through the fold
  let fadeT = 0; // 0..1 through the final fade
  let waitS = 0;
  let target = '';
  let landed = false;
  let running = false;
  let backdrop: [number, number, number] = [0, 0, 0];
  let safety = 0;
  let fonts: { display: string; mono: string } | undefined;

  const hide = () => {
    running = false;
    cancelAnimationFrame(raf);
    clearTimeout(safety);
    wrapper.style.visibility = 'hidden';
  };

  const frame = (now: number) => {
    if (!running) return;
    if (document.hidden) {
      hide();
      return;
    }
    raf = requestAnimationFrame(frame);
    if (!landed && window.location.pathname === target) landed = true;
    // Wall-clock timing (capped only for long stalls) so slow frames never stretch the overlay.
    const dt = last < 0 ? 0 : Math.min((now - last) / 1000, 0.25);
    last = now;

    if (t < 1) t = Math.min(1, t + dt / PLAY_S);
    else if (!landed && waitS < ARRIVE_TIMEOUT_S) waitS += dt;
    else fadeT = Math.min(1, fadeT + dt / FADE_S);
    if (fadeT >= 1) {
      hide();
      return;
    }

    // Miura motion from the original: fold in, flip at the middle, unfold flat.
    const turn = t;
    const fold = easeInOutCubic(clamp01(turn < 0.5 ? turn / 0.44 : (1 - turn) / 0.44));
    const flip = Math.PI * easeInOutCubic(clamp01((turn - 0.36) / 0.28));
    const alpha = clamp01(t / 0.08) * (1 - easeInOutCubic(fadeT));

    const aspect = W / H;
    const lay = miuraLayout(aspect, CELLS);
    const { nx, ny, a, b, x0 } = lay;
    const cell = miuraCell(a, b, MIURA_GAMMA, fold * THETA_MAX);
    const flat = miuraCell(a, b, MIURA_GAMMA, 0);
    const cols = nx + 1;
    const rows = ny + 1;
    const P = new Float32Array(cols * rows * 3);
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const v = miuraVertex(i, j, cell);
        const k = (j * cols + i) * 3;
        P[k] = v[0];
        P[k + 1] = v[1];
        P[k + 2] = v[2];
        minX = Math.min(minX, v[0]);
        maxX = Math.max(maxX, v[0]);
        minY = Math.min(minY, v[1]);
        maxY = Math.max(maxY, v[1]);
        minZ = Math.min(minZ, v[2]);
        maxZ = Math.max(maxZ, v[2]);
      }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const scale = 1 - 0.18 * fold;
    const tilt = -0.38 * fold;
    const yaw = flip + 0.22 * fold * Math.cos(flip);
    const ctl = Math.cos(tilt);
    const stl = Math.sin(tilt);
    const cyw = Math.cos(yaw);
    const syw = Math.sin(yaw);
    const at = (k: number) => P[k] ?? 0;
    for (let k = 0; k < P.length; k += 3) {
      const x = (at(k) - cx) * scale;
      const y = (at(k + 1) - cy) * scale;
      const z = (at(k + 2) - cz) * scale;
      const y1 = y * ctl - z * stl;
      const z1 = y * stl + z * ctl;
      P[k] = x * cyw + z1 * syw;
      P[k + 1] = y1;
      P[k + 2] = -x * syw + z1 * cyw;
    }

    const faceCount = nx * ny;
    const need = (faceCount + 1) * 6 * FLOATS;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    if (verts.length !== need) {
      verts = new Float32Array(need);
      gl.bufferData(gl.ARRAY_BUFFER, verts.byteLength, gl.DYNAMIC_DRAW);
    }

    // Soft contact shadow under the folding sheet.
    let sx0 = Number.POSITIVE_INFINITY;
    let sx1 = Number.NEGATIVE_INFINITY;
    let sy0 = Number.POSITIVE_INFINITY;
    let sy1 = Number.NEGATIVE_INFINITY;
    let sz0 = Number.POSITIVE_INFINITY;
    for (let k = 0; k < P.length; k += 3) {
      sx0 = Math.min(sx0, at(k));
      sx1 = Math.max(sx1, at(k));
      sy0 = Math.min(sy0, at(k + 1));
      sy1 = Math.max(sy1, at(k + 1));
      sz0 = Math.min(sz0, at(k + 2));
    }
    const shx = (sx0 + sx1) / 2 + 0.03 * fold;
    const shy = (sy0 + sy1) / 2 - 0.05 * fold;
    const hw = (sx1 - sx0) * 0.75 + 0.08;
    const hh = (sy1 - sy0) * 0.75 + 0.08;
    const sz = sz0 - 0.08;
    const corner: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
      [1, 1],
      [0, 1],
    ];
    let w = 0;
    for (const [u, v] of corner) {
      verts[w++] = shx + (u * 2 - 1) * hw;
      verts[w++] = shy + (v * 2 - 1) * hh;
      verts[w++] = sz;
      verts[w++] = 0;
      verts[w++] = 0;
      verts[w++] = 1;
      verts[w++] = u;
      verts[w++] = v;
    }
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const k00 = (j * cols + i) * 3;
        const k10 = (j * cols + i + 1) * 3;
        const k01 = ((j + 1) * cols + i) * 3;
        const ux = at(k10) - at(k00);
        const uy = at(k10 + 1) - at(k00 + 1);
        const uz = at(k10 + 2) - at(k00 + 2);
        const vx = at(k01) - at(k00);
        const vy = at(k01 + 1) - at(k00 + 1);
        const vz = at(k01 + 2) - at(k00 + 2);
        let nxv = uy * vz - uz * vy;
        let nyv = uz * vx - ux * vz;
        let nzv = ux * vy - uy * vx;
        const nl = Math.hypot(nxv, nyv, nzv) || 1;
        nxv /= nl;
        nyv /= nl;
        nzv /= nl;
        for (const [di, dj] of corner) {
          const kk = ((j + dj) * cols + i + di) * 3;
          const fv = miuraVertex(i + di, j + dj, flat);
          verts[w++] = at(kk);
          verts[w++] = at(kk + 1);
          verts[w++] = at(kk + 2);
          verts[w++] = nxv;
          verts[w++] = nyv;
          verts[w++] = nzv;
          verts[w++] = (fv[0] - x0) / aspect;
          verts[w++] = 1 - fv[1];
        }
      }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, verts);

    const camZ = 0.5 / Math.tan(FOV / 2);
    const f = 1 / Math.tan(FOV / 2);
    const near = 0.05;
    const far = camZ + 4;
    proj.fill(0);
    proj[0] = f / aspect;
    proj[5] = f;
    proj[10] = (far + near) / (near - far);
    proj[11] = -1;
    proj[14] = (2 * far * near) / (near - far);

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.depthMask(true);
    // Page-colored backdrop behind the sheet hides the page swap underneath (premultiplied).
    gl.clearColor(backdrop[0] * alpha, backdrop[1] * alpha, backdrop[2] * alpha, alpha);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    activate(gl, prog.program);
    for (let i = 0; i < 2; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, texs[i] ?? null);
    }
    gl.uniform1i(prog.u.uTexA, 0);
    gl.uniform1i(prog.u.uTexB, 1);
    gl.uniformMatrix4fv(prog.u.uProj, false, proj);
    gl.uniform1f(prog.u.uCamZ, camZ);
    gl.uniform1f(prog.u.uFold, fold);
    gl.uniform1f(prog.u.uShadow, 0.5 * fold);
    gl.uniform1f(prog.u.uAlpha, alpha);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    if (fold > 0.001) {
      gl.disable(gl.DEPTH_TEST);
      gl.depthMask(false);
      gl.uniform1i(prog.u.uMode, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.depthMask(true);
    }
    gl.enable(gl.DEPTH_TEST);
    gl.uniform1i(prog.u.uMode, 1);
    gl.drawArrays(gl.TRIANGLES, 6, faceCount * 6);
  };

  return {
    start(from, to) {
      const theme =
        document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      W = window.innerWidth;
      H = window.innerHeight;
      // The sheet is always moving: 1.5x is sharp enough and keeps texture uploads small.
      dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      const bg = THEME_COLORS[theme];
      const n = Number.parseInt(bg.slice(1), 16);
      backdrop = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
      if (!fonts) fonts = pageFonts();
      const sheetFonts = fonts;
      const sheets = SHEETS[theme];
      const specs: [Sheet, string, string][] = [
        [sheets.from, 'Leaving', routeLabel(from)],
        [sheets.to, 'Opening', routeLabel(to)],
      ];
      specs.forEach(([sheet, caption, title], i) => {
        const page = pages[i];
        const ctx = page?.getContext('2d');
        if (!page || !ctx) return;
        page.width = canvas.width;
        page.height = canvas.height;
        drawSheet(ctx, W, H, dpr, sheet, caption, title, sheetFonts);
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, texs[i] ?? null);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, page);
      });
      target = to;
      landed = false;
      t = 0;
      fadeT = 0;
      waitS = 0;
      last = -1;
      wrapper.style.visibility = 'visible';
      // Never leave the overlay up if the browser stops delivering frames.
      clearTimeout(safety);
      safety = window.setTimeout(hide, (PLAY_S + ARRIVE_TIMEOUT_S + FADE_S + 1) * 1000);
      if (!running) {
        running = true;
        raf = requestAnimationFrame(frame);
      }
    },
    arrived(pathname) {
      if (running && pathname === target) landed = true;
    },
    dispose() {
      hide();
      for (const tex of texs) gl.deleteTexture(tex);
      gl.deleteBuffer(vbo);
      gl.deleteVertexArray(vao);
      gl.deleteProgram(prog.program);
    },
  };
}

/** Full-screen fold played between pages. Mount once, in the root layout. */
export function RouteFold() {
  const pathname = usePathname();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<Engine | null>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const canvas = canvasRef.current;
    if (!wrapper || !canvas) return;
    // Off for reduced motion and on low-end devices: navigation must feel instant there.
    if (prefersLightEffects()) return;
    let engine: Engine | null | undefined;
    // Prepare shaders while the browser is idle so the first click does not stall.
    const warm = () => {
      if (engine === undefined) engine = createEngine(wrapper, canvas);
    };
    const idle = window.requestIdleCallback
      ? window.requestIdleCallback(warm, { timeout: 3000 })
      : window.setTimeout(warm, 1500);

    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.('a[href]');
      if (!(link instanceof HTMLAnchorElement)) return;
      if (link.target && link.target !== '_self') return;
      if (link.hasAttribute('download') || link.dataset.noFold !== undefined) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname.startsWith('/api/')) return;
      if (url.pathname === window.location.pathname) return;
      warm();
      engine?.start(window.location.pathname, url.pathname);
    };
    document.addEventListener('click', onClick, true);
    engineRef.current = {
      start: () => {},
      arrived: (p) => engine?.arrived(p),
      dispose: () => {},
    };
    return () => {
      if (window.cancelIdleCallback) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
      document.removeEventListener('click', onClick, true);
      engine?.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.arrived(pathname);
  }, [pathname]);

  return (
    <div
      ref={wrapperRef}
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[100]"
      style={{ visibility: 'hidden' }}
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
