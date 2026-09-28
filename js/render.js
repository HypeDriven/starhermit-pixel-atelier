// render.js — Three.js presentation: a neon drafting table of extruded
// pixels. The renderer consumes immutable snapshots + event lists; it never
// mutates rules state. Deterministic visual seed drives decoration only.

import * as THREE from '../vendor/three.module.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RNG } from './rng.js';
import { resolve, describe, SHADOW_MAP, PARTICLE_CAP } from './gfx.js';

const CELL = 1;                 // world units per cell
const H_EMPTY = 0.12;           // extrusion heights
const H_FILLED = 0.62;
const H_WRONG = 0.34;
const FOV = 32;                 // low-distortion perspective
const LAYER_ENV = 0, LAYER_GAME = 1, LAYER_SELECT = 2, LAYER_FX = 3;

function hexToThree(hex) { return new THREE.Color(hex); }

// Colour grade + vignette (display-space in, display-space out): gentle
// S-curve, a touch more saturation, cool shadows / warm highlights. Blacks are
// lifted slightly so empty cells never sink into the table.
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.26 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.12);
      s *= mix(vec3(0.95, 0.98, 1.06), vec3(1.04, 1.0, 0.97), smoothstep(0.2, 0.8, l));
      s = s * 0.975 + 0.018;
      c = mix(c, s, uAmount);
      float d = length((vUv - 0.5) * vec2(1.1, 1.0));
      c *= 1.0 - uVignette * smoothstep(0.38, 0.9, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

// Cell material patch: per-instance glow (fill pulse / filled sheen) added as
// emissive, and — at detailed quality — a bevel highlight on each block's top
// edge plus a base-to-top gradient on its sides (cheap fake contact shading).
function patchCellMaterial(mat, uniforms) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uDetail = uniforms.uDetail;
    sh.uniforms.uGlowGain = uniforms.uGlowGain;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aGlow;\nvarying float vGlow;\nvarying vec2 vCellUv;\nvarying vec3 vObjN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGlow = aGlow; vCellUv = uv; vObjN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uDetail;\nuniform float uGlowGain;\nvarying float vGlow;\nvarying vec2 vCellUv;\nvarying vec3 vObjN;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float cellTop = step(0.5, vObjN.y);
        vec2 cellE = min(vCellUv, 1.0 - vCellUv);
        float cellEdge = 1.0 - smoothstep(0.0, 0.1, min(cellE.x, cellE.y));
        if (uDetail > 0.5) diffuseColor.rgb *= mix(mix(0.55, 1.0, vCellUv.y), 1.0 + 0.4 * cellEdge, cellTop);`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += vColor * vGlow * uGlowGain * mix(0.6, 1.0, cellTop);`);
  };
  mat.customProgramCacheKey = () => 'pa-cell-v1';
}

// Critically damped spring (authored, interruptible — target may change freely).
function springStep(current, target, velocity, smoothTime, dt) {
  const omega = 2 / Math.max(0.0001, smoothTime);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = current - target;
  const temp = (velocity + omega * change) * dt;
  let newVel = (velocity - omega * temp) * exp;
  let out = target + (change + temp) * exp;
  if (change > 0 === out > target) { out = target; newVel = 0; } // clamp overshoot
  return [out, newVel];
}

export function createRenderer3D(canvas, opts = {}) {
  return new DraftingTableRenderer(canvas, opts);
}

class DraftingTableRenderer {
  constructor(canvas, opts) {
    this.kind = '3d';
    this.canvas = canvas;
    this.opts = opts;
    this.onCameraChange = null;
    this.onFirstRender = null;
    this.theme = null;
    this.reducedMotion = false;
    this.cellLabels = false;
    this.tier = 'balanced';
    this.content = null;
    this.palette = [];
    this.cells = [];          // per-cell visual state
    this.ghostCells = new Set();
    this.hoverCell = -1;
    this.keyboardCell = -1;
    this.selectedColor = -1;
    this.time = 0;
    this.hidden = false;
    this.disposed = false;
    this._contextLost = false;
    // Title framing (no board yet): look across the table toward the holo ring and floating pixels.
    this.cameraMode = { tx: 0, tz: -6, dist: 36, vx: 0, vz: 0, vd: 0, x: 0, z: -6, d: 36 };
    this._tmpM = new THREE.Matrix4();
    this._tmpC = new THREE.Color();
    this._tmpV = new THREE.Vector3();
    this._revealT = Infinity;
    this._shakeAmp = 0;
    // Graphics quality (gfx.js): resolved tiers, adaptive resolution, post chain.
    this.gpu = opts.gpu || '';
    this.detected = opts.detected || 'balanced';
    this.saved = {};
    this.q = resolve({}, this.detected);
    this.adaptiveScale = 1;
    this._frames = [];
    this.fps = 0;
    this.pixelRatio = 1;
    this.size = [0, 0];
    this.postKey = null;
    this.composer = null;
    this.postFailed = false;
    this.cellUniforms = { uDetail: { value: 0 }, uGlowGain: { value: 1 } };
    this._initGL();
  }

  // ------------------------------------------------------------------ GL ---
  _initGL() {
    // Native MSAA is a context attribute: it follows the anti-aliasing setting
    // chosen at load (msaa, or off); runtime changes use the post chain.
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: this.opts.antialias !== false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.shadowMap.enabled = false;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = renderer;
    this.envRT = null;
    this.postKey = null;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 300);
    this.camera.layers.enable(LAYER_ENV);
    this.camera.layers.enable(LAYER_GAME);
    this.camera.layers.enable(LAYER_SELECT);
    this.camera.layers.enable(LAYER_FX);

    this.raycaster = new THREE.Raycaster();
    this.raycaster.layers.set(LAYER_GAME);
    this._ndc = new THREE.Vector2();

    this.canvas.addEventListener('webglcontextlost', this._onLost = (e) => {
      e.preventDefault();
      this._contextLost = true;
    });
    this.canvas.addEventListener('webglcontextrestored', this._onRestored = () => {
      this._contextLost = false;
      // Rebuild GPU resources from retained CPU descriptors.
      const { content, palette, theme } = this;
      this._disposeScene();
      this._initGL();
      if (theme) this.setTheme(theme);
      if (content) this.setBoard(content, palette);
      if (this._lastState) this.syncState(this._lastState);
    });

    this._buildEnvironment();
    this.resize();
    this._applyGraphics();
  }

  _disposeScene() {
    this.composer?.dispose();
    this.composer = null;
    this.envRT?.dispose();
    this.envRT = null;
    this.scene?.traverse((obj) => {
      obj.geometry?.dispose?.();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if (!m) continue;
        for (const k of Object.keys(m)) m[k]?.isTexture && m[k].dispose();
        m.dispose?.();
      }
    });
    this.renderer?.dispose();
  }

  // ------------------------------------------------------------- env -------
  _buildEnvironment() {
    const t = this.theme || {};
    const s = this.scene;
    s.background = hexToThree(t.bg || '#05070f');
    s.fog = new THREE.Fog(hexToThree(t.fog || '#0a1024'), 30, 95);

    // Lights: one dominant key, soft hemisphere fill, accent rim.
    this.hemi = new THREE.HemisphereLight(hexToThree(t.key || '#9fd8ff'), hexToThree(t.bg || '#05070f'), 0.55);
    s.add(this.hemi);
    this.key = new THREE.DirectionalLight(hexToThree(t.key || '#9fd8ff'), 1.6);
    this.key.position.set(8, 16, 6);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.02;
    s.add(this.key, this.key.target);
    this._fitShadow();
    this.rim = new THREE.PointLight(hexToThree(t.rim || '#ff7ad9'), 60, 60, 2);
    this.rim.position.set(-10, 6, -8);
    s.add(this.rim);

    // Drafting table slab with procedural grid texture.
    const tableSize = 64;
    const tableMat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.15, envMapIntensity: 0.6 });
    this.table = new THREE.Mesh(new THREE.BoxGeometry(tableSize, 1.2, tableSize), tableMat);
    this.table.position.y = -0.62;
    this.table.layers.set(LAYER_ENV);
    s.add(this.table);
    this._applyTableSurface();

    // Neon edge strips around the table (merged into one mesh).
    this.edgeMat = new THREE.MeshBasicMaterial({ color: hexToThree(t.accentA || '#22d3ee') });
    const half = tableSize / 2;
    const edgeGeoms = [];
    for (const [x, z, w, d] of [[0, -half, tableSize, 0.14], [0, half, tableSize, 0.14], [-half, 0, 0.14, tableSize], [half, 0, 0.14, tableSize]]) {
      const g = new THREE.BoxGeometry(w, 0.06, d);
      g.translate(x, 0.03, z);
      edgeGeoms.push(g);
    }
    this.tableEdges = new THREE.Mesh(mergeGeoms(edgeGeoms), this.edgeMat);
    this.tableEdges.layers.set(LAYER_ENV);
    s.add(this.tableEdges);

    // Decorative props (quality-gated): corner pylons, holo ring, floating
    // pixels and dust.
    this.props = new THREE.Group();
    this.props.layers.set(LAYER_ENV);
    s.add(this.props);
    this._buildProps();
  }

  // Key-light shadow box fitted tightly to the board (or a default play area).
  _fitShadow() {
    if (!this.key) return;
    const ext = Math.max(this.w || 12, this.h || 12) * CELL * 0.5 + 1.5;
    const sc = this.key.shadow.camera;
    Object.assign(sc, { left: -ext * 1.25, right: ext * 1.25, top: ext * 1.25, bottom: -ext * 1.25, near: 1, far: 50 });
    sc.updateProjectionMatrix();
    this.key.position.set(8, 16, 6).normalize().multiplyScalar(24);
    this.key.target.position.set(0, 0, 0);
  }

  _applyTableSurface() {
    if (!this.table) return;
    const t = this.theme || {};
    const detailed = this.q.detail === 'detailed';
    const m = this.table.material;
    m.map?.dispose();
    m.roughnessMap?.dispose();
    m.map = detailed ? makeGridTextureDetailed(t.table || '#0d1426', t.grid || '#16233f') : makeGridTexture(t.table || '#0d1426', t.grid || '#16233f');
    m.map.wrapS = m.map.wrapT = THREE.RepeatWrapping;
    m.map.repeat.set(16, 16);
    m.roughnessMap = detailed ? makeNoiseTexture() : null;
    if (m.roughnessMap) {
      m.roughnessMap.wrapS = m.roughnessMap.wrapT = THREE.RepeatWrapping;
      m.roughnessMap.repeat.set(6, 6);
      m.roughness = 1;
      m.metalness = 0.25;
    } else {
      m.roughness = 0.85;
      m.metalness = 0.15;
    }
    m.needsUpdate = true;
  }

  _buildProps() {
    while (this.props.children.length) {
      const c = this.props.children.pop();
      c.geometry?.dispose?.();
      c.material?.dispose?.();
    }
    this.dust = null;
    this.holoRing = null;
    this.floaters = null;
    this.tips = null;
    const q = this.q;
    const t = this.theme || {};
    const rng = new RNG('decor:' + (this.content?.seed || 'default'));
    const glow = q.bloom === 'on' ? 2.2 : 1;
    const accent = hexToThree(t.accentB || '#f472b6');
    const accentA = hexToThree(t.accentA || '#22d3ee');

    // Dust motes (cheap points; cosmetic only, never raycastable).
    if (q.particles === 'high') {
      const count = 160;
      const pos = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        pos[i * 3] = rng.range(-22, 22);
        pos[i * 3 + 1] = rng.range(0.5, 10);
        pos[i * 3 + 2] = rng.range(-22, 22);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.dust = new THREE.Points(g, new THREE.PointsMaterial({
        color: accentA, size: 0.07, transparent: true, opacity: 0.55,
        sizeAttenuation: true, depthWrite: false,
      }));
      this.dust.layers.set(LAYER_ENV);
      this.dust.raycast = () => {};
      this.props.add(this.dust);
    }
    if (q.detail !== 'detailed') return;

    const pylonMat = new THREE.MeshStandardMaterial({ color: hexToThree(t.tableEdge || '#1c2b4d'), roughness: 0.45, metalness: 0.6 });
    const tipMat = new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(glow) });
    const geoms = [], tipGeoms = [];
    for (let i = 0; i < 4; i++) {
      const ang = (i / 4) * Math.PI * 2 + 0.4;
      const r = 24 + rng.range(-2, 2);
      const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
      const h = 4 + rng.range(0, 3);
      const g = new THREE.CylinderGeometry(0.5, 0.8, h, 6);
      g.translate(x, h / 2 - 1.2, z);
      geoms.push(g);
      const tip = new THREE.CylinderGeometry(0.52, 0.52, 0.18, 6);
      tip.translate(x, h - 1.2 + 0.09, z);
      tipGeoms.push(tip);
    }
    const pylons = new THREE.Mesh(mergeGeoms(geoms), pylonMat);
    pylons.castShadow = false;
    this.tips = new THREE.Mesh(mergeGeoms(tipGeoms), tipMat);
    this.tipBase = accent.clone().multiplyScalar(glow);
    this.props.add(pylons, this.tips);

    // Holo ring floating behind the board.
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(9, 0.05, 8, 96),
      new THREE.MeshBasicMaterial({ color: accentA.clone().multiplyScalar(glow), transparent: true, opacity: 0.4, depthWrite: false })
    );
    const ext = Math.max(this.w || 12, this.h || 12) * CELL * 0.5;
    ring.position.set(0, 6, -Math.max(16, ext + 10));
    ring.rotation.x = Math.PI / 2.4;
    this.props.add(ring);
    this.holoRing = ring;

    // Floating pixels: small neon cubes drifting around the table's rim —
    // the "extruded pixels" motif, kept well outside the playfield.
    const n = 44;
    const cols = [t.accentA || '#22d3ee', t.accentB || '#f472b6', '#ffd166', '#3fd68f'];
    const fm = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.34, 0.34, 0.34),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 1).multiplyScalar(glow > 1 ? 1.25 : 0.9) }),
      n
    );
    this.floatData = [];
    const c = new THREE.Color();
    for (let i = 0; i < n; i++) {
      // Back arc only (behind and beside the board), never between camera and table.
      const ang = rng.range(Math.PI * 1.05, Math.PI * 1.95);
      const r = rng.range(ext + 5, ext + 20);
      const d = { x: Math.cos(ang) * r * 1.3, z: Math.sin(ang) * r, y: rng.range(1, 5), ph: rng.range(0, 6.28), sp: rng.range(0.4, 1), s: rng.range(0.6, 1.4) };
      this.floatData.push(d);
      fm.setColorAt(i, c.set(cols[i % cols.length]));
    }
    fm.instanceColor.needsUpdate = true;
    fm.layers.set(LAYER_ENV);
    fm.raycast = () => {};
    this.floaters = fm;
    this._placeFloaters(0);
    this.props.add(fm);
  }

  _placeFloaters(time) {
    if (!this.floaters) return;
    const m = this._tmpM, q = new THREE.Quaternion(), e = new THREE.Euler(), v = this._tmpV, sc = new THREE.Vector3();
    for (let i = 0; i < this.floatData.length; i++) {
      const d = this.floatData[i];
      e.set(time * d.sp * 0.5 + d.ph, time * d.sp * 0.7 + d.ph, 0);
      q.setFromEuler(e);
      v.set(d.x, d.y + Math.sin(time * d.sp + d.ph) * 0.35, d.z);
      sc.setScalar(d.s);
      m.compose(v, q, sc);
      this.floaters.setMatrixAt(i, m);
    }
    this.floaters.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------ theme ------
  setTheme(theme) {
    this.theme = theme;
    if (!this.scene) return;
    this.scene.background = hexToThree(theme.bg);
    this.scene.fog.color = hexToThree(theme.fog);
    this.hemi.color = hexToThree(theme.key);
    this.hemi.groundColor = hexToThree(theme.bg);
    this.key.color = hexToThree(theme.key);
    this.rim.color = hexToThree(theme.rim);
    this._applyTableSurface();
    this._buildProps();
    this._recolorAll();
    this._applyGlow();
  }

  // Neon strips and the board frame read brighter than 1.0 when bloom is on,
  // so only they (and fill pulses) bloom; without bloom they stay flat.
  _applyGlow() {
    const glow = this.q.bloom === 'on' ? 2.2 : 1;
    const a = hexToThree(this.theme?.accentA || '#22d3ee');
    this.edgeMat?.color.copy(a).multiplyScalar(glow);
    this.frame?.material.color.copy(a).multiplyScalar(glow);
    this.cellUniforms.uGlowGain.value = this.q.bloom === 'on' ? 1.6 : 0.8;
  }

  _recolorAll() {
    // Theme change: empty-cell slate tint derives from the theme.
    if (!this.cellMesh || !this.content) return;
    const c = this._tmpC;
    for (let i = 0; i < this.cells.length; i++) {
      this.cellMesh.setColorAt(i, this._cellBaseColor(i, c));
    }
    this.cellMesh.instanceColor.needsUpdate = true;
    this._applyGlow();
  }

  // ------------------------------------------------------ graphics ------
  /** Apply saved graphics settings (gfx.js shape). Live: no reload needed. */
  setGraphics(saved) {
    this.saved = { ...(saved || {}) };
    this.q = resolve(this.saved, this.detected);
    this.adaptiveScale = 1;
    this._frames = [];
    this._applyGraphics();
    return this.q;
  }

  // Legacy tier API (low / medium / high) maps onto presets.
  setQuality(tier) {
    this.setGraphics({ ...this.saved, preset: tier === 'medium' ? 'balanced' : tier });
  }
  setRenderScale() { /* superseded by render_scale + adaptive resolution */ }

  _applyGraphics() {
    const g = this.q;
    if (!this.renderer || !this.scene) return;
    this.tier = g.preset;
    // Shadows: key light + board cells + table, map size from the tier.
    const size = SHADOW_MAP[g.shadows];
    this.renderer.shadowMap.enabled = size > 0;
    this.key.castShadow = size > 0;
    if (size > 0 && this.key.shadow.mapSize.x !== size) {
      this.key.shadow.mapSize.set(size, size);
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null;
    }
    this.table.receiveShadow = size > 0;
    if (this.cellMesh) this.cellMesh.castShadow = this.cellMesh.receiveShadow = size > 0;
    // Reflections: studio environment (PMREM) + clearcoat cells.
    if (g.reflections === 'on') {
      if (!this.envRT) {
        const pm = new THREE.PMREMGenerator(this.renderer);
        const room = new RoomEnvironment();
        this.envRT = pm.fromScene(room, 0.04);
        room.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
        pm.dispose();
      }
      this.scene.environment = this.envRT.texture;
      this.scene.environmentIntensity = 0.22;
    } else {
      this.scene.environment = null;
    }
    this.cellUniforms.uDetail.value = g.detail === 'detailed' ? 1 : 0;
    if (this.cellMesh) this.cellMesh.material = g.reflections === 'on' ? this.cellMatGloss : this.cellMat;
    this._applyTableSurface();
    this._buildProps();
    this._buildParticles();
    this._applyGlow();
    // Materials pick up shadow / environment changes on recompile.
    this.scene.traverse((o) => {
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) if (m) m.needsUpdate = true;
    });
    this.postKey = null; // rebuild the post chain on the next frame
    this._fpsVisible(g.showFps);
    document.body.dataset.gfxPreset = g.preset;
    this.canvas.dataset.gfxPreset = g.preset;
    this.resize();
  }

  /** What the settings panel shows: GPU, auto choice, resolved tiers, cost, fps. */
  graphicsInfo() {
    const px = [Math.round(this.size[0] * this.pixelRatio), Math.round(this.size[1] * this.pixelRatio)];
    return {
      gpu: this.gpu || 'unknown GPU',
      detected: this.detected,
      resolved: this.q,
      pixels: px,
      summary: describe(this.q, px),
      fps: Math.round(this.fps || 0),
      adaptiveScale: Math.round(this.adaptiveScale * 100) / 100,
      postFailed: !!this.postFailed,
    };
  }

  _fpsVisible(on) {
    let el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.className = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '— fps';
      document.body.append(el);
    }
    if (el) el.hidden = !on;
  }

  _postKey(w, h) {
    const g = this.q;
    return g.post && !this.postFailed ? [g.ao, g.bloom, g.grade, g.antialias, w, h, this.pixelRatio].join('|') : 'none';
  }

  _buildPost(w, h) {
    const g = this.q;
    this.composer?.dispose();
    this.composer = null;
    if (!g.post || this.postFailed) return;
    const pw = Math.max(1, Math.round(w * this.pixelRatio)), ph = Math.max(1, Math.round(h * this.pixelRatio));
    try {
      const target = new THREE.WebGLRenderTarget(pw, ph, {
        type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0,
      });
      const composer = new EffectComposer(this.renderer, target);
      composer.setPixelRatio(this.pixelRatio);
      composer.setSize(w, h);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (g.ao !== 'off') {
        // Contact darkening where raised pixels meet the table and each other.
        const ao = new GTAOPass(this.scene, this.camera, pw, ph);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = 0.75;
        ao.updateGtaoMaterial({ radius: 0.5, distanceExponent: 1.2, thickness: 1.0, scale: 1.0, samples: g.ao === 'high' ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === 'high' ? 6 : 4, rings: 2, samples: g.ao === 'high' ? 16 : 8 });
        composer.addPass(ao);
      }
      if (g.bloom === 'on') {
        // High threshold: only the neon strips, pylons and fill pulses bloom.
        composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.6, 0.5, 0.9));
      }
      composer.addPass(new OutputPass());
      if (g.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
      if (g.antialias === 'smaa') composer.addPass(new SMAAPass(pw, ph));
      if (g.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / pw, 1 / ph);
        composer.addPass(fxaa);
      }
      this.composer = composer;
    } catch {
      // Post-processing is an enhancement: render directly if it cannot be built.
      this.postFailed = true;
      this.composer = null;
    }
  }

  // Adaptive resolution: average ~90 frames; step the scale down when slow,
  // back up when fast. Also feeds the optional frame-rate readout.
  _adapt(dtMs) {
    const f = this._frames;
    f.push(dtMs);
    if (f.length < 90) return;
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    f.length = 0;
    this.fps = 1000 / avg;
    const el = document.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = `${Math.round(this.fps)} fps · ${Math.round(this.pixelRatio * 100) / 100}×`;
    if (!this.q.adaptive) { this.adaptiveScale = 1; return; }
    if (avg > 26) this.adaptiveScale = Math.max(0.6, this.adaptiveScale - 0.1);
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.05);
  }

  setReducedMotion(v) { this.reducedMotion = v; }
  setCellLabels(v) {
    this.cellLabels = v;
    if (this.labels) this.labels.visible = v || this._closeZoom();
  }

  // ------------------------------------------------------------ board ------
  setBoard(content, palette) {
    // Remove previous board objects.
    if (this.boardGroup) {
      this.scene.remove(this.boardGroup);
      this.boardGroup.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
      this.cellMat?.dispose();
      this.cellMatGloss?.dispose();
    }
    this.content = content;
    this.palette = palette;
    this._lastState = null;
    const w = content.width, h = content.height;
    this.w = w; this.h = h;
    this.cells = new Array(w * h);
    for (let i = 0; i < w * h; i++) {
      this.cells[i] = { h: 0, targetH: H_EMPTY, v: 0, flash: 0, filled: false, wrong: 0, delay: 0 };
    }
    this.ghostCells = new Set();
    this.hoverCell = -1;
    this.keyboardCell = -1;

    const group = new THREE.Group();
    this.boardGroup = group;
    this.scene.add(group);

    // Cells: one instanced extruded box, origin at base so scale-y rises up.
    const geo = new THREE.BoxGeometry(0.92, 1, 0.92);
    geo.translate(0, 0.5, 0);
    // Per-instance glow (fill pulse / filled sheen), read by the patched material.
    this.glow = new Float32Array(w * h);
    this.glowAttr = new THREE.InstancedBufferAttribute(this.glow, 1);
    this.glowAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aGlow', this.glowAttr);
    this.cellMat = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.2 });
    // Glossy lacquered pixels when reflections are on.
    this.cellMatGloss = new THREE.MeshPhysicalMaterial({
      roughness: 0.38, metalness: 0.08, clearcoat: 0.8, clearcoatRoughness: 0.22, envMapIntensity: 1.0,
    });
    patchCellMaterial(this.cellMat, this.cellUniforms);
    patchCellMaterial(this.cellMatGloss, this.cellUniforms);
    const shadows = SHADOW_MAP[this.q.shadows] > 0;
    this.cellMesh = new THREE.InstancedMesh(geo, this.q.reflections === 'on' ? this.cellMatGloss : this.cellMat, w * h);
    this.cellMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.cellMesh.castShadow = shadows;
    this.cellMesh.receiveShadow = shadows;
    this.cellMesh.layers.set(LAYER_GAME);
    group.add(this.cellMesh);
    const c = new THREE.Color();
    for (let i = 0; i < w * h; i++) {
      this._writeCellMatrix(i, H_EMPTY);
      this.cellMesh.setColorAt(i, this._cellBaseColor(i, c));
    }
    this.cellMesh.instanceColor.needsUpdate = true;

    // Interaction plane: the ONLY raycast target for picking.
    this.pickPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(w * CELL, h * CELL),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    this.pickPlane.rotation.x = -Math.PI / 2;
    this.pickPlane.position.y = 0.01;
    this.pickPlane.layers.set(LAYER_GAME);
    group.add(this.pickPlane);

    // Selection: lift box + grounded ring marker (not bloom alone).
    this.hoverBox = new THREE.Mesh(
      new THREE.BoxGeometry(1.02, 1.02, 1.02),
      new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.9 })
    );
    this.hoverBox.visible = false;
    this.hoverBox.layers.set(LAYER_SELECT);
    group.add(this.hoverBox);
    this.hoverRing = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.72, 32),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.65, side: THREE.DoubleSide })
    );
    this.hoverRing.rotation.x = -Math.PI / 2;
    this.hoverRing.position.y = 0.02;
    this.hoverRing.visible = false;
    this.hoverRing.layers.set(LAYER_SELECT);
    group.add(this.hoverRing);
    this.cursorBox = new THREE.Mesh(
      new THREE.BoxGeometry(1.02, 0.2, 1.02),
      new THREE.MeshBasicMaterial({ color: hexToThree(this.theme?.accentB || '#f472b6'), wireframe: true })
    );
    this.cursorBox.visible = false;
    this.cursorBox.layers.set(LAYER_SELECT);
    group.add(this.cursorBox);

    // Markers: diamonds on cells that want the selected color.
    this.markerMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.markerMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.3, 0.3), this.markerMat, w * h);
    this.markerMesh.count = 0;
    this.markerMesh.layers.set(LAYER_SELECT);
    group.add(this.markerMesh);

    // Wrong-cell X overlays.
    this.wrongMat = new THREE.MeshBasicMaterial({
      map: makeXTexture(), transparent: true, depthWrite: false, color: '#ff5d5d',
    });
    this.wrongMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.7, 0.7), this.wrongMat, w * h);
    this.wrongMesh.count = 0;
    this.wrongMesh.layers.set(LAYER_SELECT);
    group.add(this.wrongMesh);

    // Index label sprites (digit atlas), visible at close zoom or on demand.
    this._buildLabels();

    // Board frame: emissive surround anchoring the playfield.
    const frameMat = new THREE.MeshBasicMaterial({ color: hexToThree(this.theme?.accentA || '#22d3ee') });
    const fg = [];
    const fw = w * CELL / 2 + 0.35, fh = h * CELL / 2 + 0.35;
    for (const [x, z, gw, gd] of [[0, -fh, fw * 2, 0.1], [0, fh, fw * 2, 0.1], [-fw, 0, 0.1, fh * 2], [fw, 0, 0.1, fh * 2]]) {
      const g = new THREE.BoxGeometry(gw, 0.08, gd);
      g.translate(x, 0.04, z);
      fg.push(g);
    }
    this.frame = new THREE.Mesh(mergeGeoms(fg), frameMat);
    this.frame.layers.set(LAYER_GAME);
    group.add(this.frame);
    this._applyGlow();
    this._fitShadow();
    this._buildProps(); // decor keeps clear of this board's footprint

    this._buildParticles();
    this._revealT = this.reducedMotion ? Infinity : 0; // board drop-in reveal
    this.fitCamera(true);
    this.renderer.compile(this.scene, this.camera); // prewarm before play
  }

  _buildLabels() {
    if (this.labels) {
      this.boardGroup.remove(this.labels);
      this.labels.geometry.dispose();
      this.labels.material.dispose();
    }
    const w = this.w, h = this.h;
    const atlas = makeDigitAtlas();
    const geo = new THREE.PlaneGeometry(0.55, 0.55);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: { map: { value: atlas } },
      vertexShader: `
        attribute float digit;
        varying vec2 vUv;
        varying float vDigit;
        void main() {
          vUv = uv;
          vDigit = digit;
          gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform sampler2D map;
        varying vec2 vUv;
        varying float vDigit;
        void main() {
          vec2 uv = vec2((vUv.x + vDigit) / 9.0, vUv.y);
          vec4 tex = texture2D(map, uv);
          if (tex.a < 0.05) discard;
          gl_FragColor = vec4(tex.rgb, tex.a * 0.9);
        }`,
    });
    this.labels = new THREE.InstancedMesh(geo, mat, w * h);
    const digits = new Float32Array(w * h);
    const m = new THREE.Matrix4();
    for (let i = 0; i < w * h; i++) {
      const { x, z } = this._cellPos(i);
      m.makeTranslation(x, H_EMPTY + 0.02, z);
      this.labels.setMatrixAt(i, m);
      digits[i] = this.content.targets[i]; // 0..8 → atlas slots (0 = '•')
    }
    this.labels.geometry.setAttribute('digit', new THREE.InstancedBufferAttribute(digits, 1));
    this.labels.layers.set(LAYER_SELECT);
    this.labels.visible = this.cellLabels;
    this.labels.count = w * h;
    this.boardGroup.add(this.labels);
  }

  _buildParticles() {
    if (this.points) {
      this.scene.remove(this.points);
      this.points.geometry.dispose();
      this.points.material.dispose();
      this.points = null;
    }
    const cap = PARTICLE_CAP[this.q.particles] || 96;
    this.pCap = cap;
    this.pData = new Float32Array(cap * 8); // x,y,z, vx,vy,vz, life, maxLife
    this.pAlive = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cap * 3), 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({
      size: 0.14, vertexColors: true, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }));
    this.points.frustumCulled = false;
    this.points.layers.set(LAYER_FX);
    this.points.raycast = () => {}; // cosmetic particles never intercept raycasts
    this.scene.add(this.points);
    this.pRng = new RNG('fx:' + (this.content?.seed || 'fx'));
  }

  _spawnBurst(x, y, z, colorHex, n, spread = 2.2) {
    if (!this.points || this.reducedMotion) n = Math.min(n, 4);
    const col = hexToThree(colorHex);
    const posA = this.points.geometry.attributes.position;
    const colA = this.points.geometry.attributes.color;
    for (let k = 0; k < n && this.pAlive < this.pCap; k++) {
      const i = this.pAlive++;
      const d = this.pData;
      d[i * 8] = x; d[i * 8 + 1] = y; d[i * 8 + 2] = z;
      d[i * 8 + 3] = this.pRng.range(-spread, spread);
      d[i * 8 + 4] = this.pRng.range(1.5, 4);
      d[i * 8 + 5] = this.pRng.range(-spread, spread);
      d[i * 8 + 6] = 0;
      d[i * 8 + 7] = this.pRng.range(0.35, 0.8);
      colA.setXYZ(i, col.r, col.g, col.b);
    }
    colA.needsUpdate = true;
    posA.needsUpdate = true;
  }

  // --------------------------------------------------------- state sync ----
  _cellPos(i) {
    const x = (i % this.w) - (this.w - 1) / 2;
    const z = Math.floor(i / this.w) - (this.h - 1) / 2;
    return { x: x * CELL, z: z * CELL };
  }

  _cellBaseColor(i, out = this._tmpC) {
    const cell = this.cells[i];
    const target = this.content.targets[i];
    const pCol = hexToThree(this.palette[target] || '#ffffff');
    if (cell.filled) return out.copy(pCol);
    if (cell.wrong) {
      const wrongCol = hexToThree(this.palette[cell.wrong - 1] || '#ff0000');
      return out.copy(wrongCol).multiplyScalar(0.75);
    }
    // Empty: theme slate tinted faintly with the target color (readable hint).
    const base = hexToThree(this.theme?.cellEmpty || '#141d33');
    return out.copy(base).lerp(pCol, 0.22);
  }

  _writeCellMatrix(i, height) {
    const { x, z } = this._cellPos(i);
    this._tmpM.makeScale(1, Math.max(0.02, height), 1);
    this._tmpM.setPosition(x, 0, z);
    this.cellMesh.setMatrixAt(i, this._tmpM);
  }

  syncState(state) {
    this._lastState = state;
    if (!this.content) return;
    const c = this._tmpC;
    let markersDirty = true;
    for (let i = 0; i < state.targets.length; i++) {
      const cell = this.cells[i];
      cell.filled = state.filled[i] === 1;
      cell.wrong = state.wrong[i];
      cell.targetH = cell.filled ? H_FILLED : cell.wrong ? H_WRONG : H_EMPTY;
      cell.h = cell.targetH;
      cell.flash = 0;
      this._writeCellMatrix(i, cell.h);
      this.cellMesh.setColorAt(i, this._cellBaseColor(i, c));
    }
    this.cellMesh.instanceMatrix.needsUpdate = true;
    this.cellMesh.instanceColor.needsUpdate = true;
    this.selectedColor = state.selected;
    this._rebuildMarkers(state);
    this._rebuildWrong(state);
    this._refreshLabelVisibility();
  }

  applyEvents(events, state) {
    this._lastState = state;
    const c = this._tmpC;
    let colorDirty = false, markerDirty = false, wrongDirty = false;
    for (const ev of events) {
      switch (ev.type) {
        case 'fill': {
          for (const i of ev.cells) {
            const cell = this.cells[i];
            cell.filled = true; cell.wrong = 0;
            cell.targetH = H_FILLED;
            cell.flash = 1;
            if (this.reducedMotion) cell.h = H_FILLED;
            this.cellMesh.setColorAt(i, this._cellBaseColor(i, c));
            const { x, z } = this._cellPos(i);
            this._spawnBurst(x, H_FILLED + 0.1, z, this.palette[ev.color], ev.tool === 'region' ? 2 : 5);
          }
          colorDirty = markerDirty = true;
          break;
        }
        case 'error': {
          for (const i of ev.cells) {
            const cell = this.cells[i];
            cell.wrong = ev.color + 1;
            cell.targetH = H_WRONG;
            if (this.reducedMotion) cell.h = H_WRONG;
            this.cellMesh.setColorAt(i, this._cellBaseColor(i, c));
          }
          colorDirty = wrongDirty = true;
          this._shake(0.25);
          break;
        }
        case 'undo': {
          for (const i of ev.cells) {
            const cell = this.cells[i];
            cell.filled = false; cell.wrong = 0;
            cell.targetH = H_EMPTY;
            if (this.reducedMotion) cell.h = H_EMPTY;
            this.cellMesh.setColorAt(i, this._cellBaseColor(i, c));
          }
          colorDirty = markerDirty = wrongDirty = true;
          break;
        }
        case 'select':
          this.selectedColor = ev.color;
          markerDirty = true;
          break;
        case 'terminal':
          if (ev.status === 'complete') this._completionWave();
          break;
        default:
          break;
      }
    }
    if (colorDirty) this.cellMesh.instanceColor.needsUpdate = true;
    if (markerDirty) this._rebuildMarkers(state);
    if (wrongDirty) this._rebuildWrong(state);
  }

  _rebuildMarkers(state) {
    if (!this.markerMesh) return;
    let n = 0;
    const sel = this.selectedColor;
    if (sel >= 0 && state && (state.status === 'active' || state.status === 'paused')) {
      for (let i = 0; i < state.targets.length; i++) {
        if (state.targets[i] === sel && !state.filled[i]) {
          const { x, z } = this._cellPos(i);
          this._tmpM.makeRotationX(-Math.PI / 2);
          this._tmpM.setPosition(x, (this.cells[i].h || H_EMPTY) + 0.03, z);
          this.markerMesh.setMatrixAt(n++, this._tmpM);
        }
      }
    }
    this.markerMesh.count = n;
    this.markerMesh.instanceMatrix.needsUpdate = true;
    this.markerMesh.visible = n > 0;
  }

  _rebuildWrong(state) {
    if (!this.wrongMesh) return;
    let n = 0;
    for (let i = 0; i < state.wrong.length; i++) {
      if (state.wrong[i]) {
        const { x, z } = this._cellPos(i);
        this._tmpM.makeRotationX(-Math.PI / 2);
        this._tmpM.setPosition(x, (this.cells[i].h || H_WRONG) + 0.04, z);
        this.wrongMesh.setMatrixAt(n++, this._tmpM);
      }
    }
    this.wrongMesh.count = n;
    this.wrongMesh.instanceMatrix.needsUpdate = true;
  }

  _completionWave() {
    // Highest event tier: staggered celebratory bounce from the board center.
    if (this.reducedMotion) return;
    const cx = 0, cz = 0;
    for (let i = 0; i < this.cells.length; i++) {
      const { x, z } = this._cellPos(i);
      const dist = Math.hypot(x - cx, z - cz);
      this.cells[i].delay = dist * 0.045;
      this.cells[i].flash = 1.5;
    }
    for (let k = 0; k < 4; k++) {
      this._spawnBurst(this.pRng.range(-this.w / 2, this.w / 2), 1.2, this.pRng.range(-this.h / 2, this.h / 2),
        this.theme?.accentA || '#22d3ee', 30, 3.5);
    }
    this._shake(0.5);
  }

  _shake(amp) {
    if (this.reducedMotion) return;
    this._shakeAmp = Math.max(this._shakeAmp || 0, amp * 0.06); // low amplitude
  }

  // Settle every animated object into the exact deterministic end state.
  settle() {
    if (!this.content) return;
    for (let i = 0; i < this.cells.length; i++) {
      const cell = this.cells[i];
      cell.h = cell.targetH;
      cell.flash = 0;
      cell.delay = 0;
      this._writeCellMatrix(i, cell.h);
    }
    this.cellMesh.instanceMatrix.needsUpdate = true;
    this._revealT = Infinity;
    if (this.points) {
      this.pAlive = 0;
      this.points.geometry.attributes.position.needsUpdate = true;
    }
    this._shakeAmp = 0;
  }

  // ------------------------------------------------------------ input ------
  screenToCell(clientX, clientY) {
    if (!this.content || this._contextLost) return -1;
    const rect = this.canvas.getBoundingClientRect();
    this._ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this._ndc, this.camera);
    const hits = this.raycaster.intersectObject(this.pickPlane, false);
    if (!hits.length) return -1;
    // Work in the board group's space (x across, z down the rows): the plane's
    // own local Y is the reversed board Z after its -90° X rotation.
    const p = this.pickPlane.parent.worldToLocal(hits[0].point.clone());
    const x = Math.floor(p.x / CELL + this.w / 2);
    const y = Math.floor(p.z / CELL + this.h / 2);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return -1;
    return y * this.w + x;
  }

  cellToScreen(i) {
    const { x, z } = this._cellPos(i);
    this._tmpV.set(x, H_FILLED, z).project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: rect.left + (this._tmpV.x + 1) / 2 * rect.width,
      y: rect.top + (-this._tmpV.y + 1) / 2 * rect.height,
    };
  }

  setHover(cell) {
    this.hoverCell = cell;
    if (cell >= 0) {
      const { x, z } = this._cellPos(cell);
      this.hoverBox.position.set(x, 0.5, z);
      this.hoverRing.position.set(x, 0.02, z);
      const col = this.palette[this.content.targets[cell]] || '#ffffff';
      this.hoverBox.material.color = hexToThree(col);
      this.hoverRing.material.color = hexToThree(col);
      this.hoverBox.visible = this.hoverRing.visible = true;
    } else {
      this.hoverBox.visible = this.hoverRing.visible = false;
    }
  }

  setKeyboardCursor(cell) {
    this.keyboardCell = cell;
    if (cell >= 0) {
      const { x, z } = this._cellPos(cell);
      this.cursorBox.position.set(x, 0.6, z);
      this.cursorBox.visible = true;
    } else {
      this.cursorBox.visible = false;
    }
  }

  setGhost(cells) {
    // Restore previous ghost cells, brighten new ones (legal-target preview).
    const c = this._tmpC;
    for (const i of this.ghostCells) this.cellMesh?.setColorAt(i, this._cellBaseColor(i, c));
    this.ghostCells = new Set(cells || []);
    for (const i of this.ghostCells) {
      this._cellBaseColor(i, c);
      c.multiplyScalar(1.6);
      this.cellMesh?.setColorAt(i, c);
    }
    if (this.cellMesh) this.cellMesh.instanceColor.needsUpdate = true;
  }

  // ------------------------------------------------------------ camera -----
  fitCamera(immediate = false) {
    if (!this.content) return;
    const ext = Math.max(this.w, this.h) * CELL;
    const margin = 1.62; // leaves breathing room for the HUD tray and top bar
    const aspect = this.camera.aspect || 1;
    const fitV = (ext * margin) / (2 * Math.tan((FOV * Math.PI / 180) / 2));
    // Portrait: horizontal extent is the constraint — fit width with margin.
    const dist = Math.max(fitV, aspect < 1 ? fitV / Math.max(aspect, 0.4) * 1.05 : fitV);
    this.cameraMode.tx = 0; this.cameraMode.tz = 0;
    this.cameraMode.dist = Math.min(60, Math.max(6, dist));
    if (immediate || this.reducedMotion) {
      this.cameraMode.x = 0; this.cameraMode.z = 0; this.cameraMode.d = this.cameraMode.dist;
      this.cameraMode.vx = this.cameraMode.vz = this.cameraMode.vd = 0;
    }
    this.onCameraChange?.();
  }

  panBy(dxPx, dyPx) {
    const scale = this.cameraMode.d / Math.max(1, this.canvas.clientHeight) * 1.6;
    this.cameraMode.tx -= dxPx * scale;
    this.cameraMode.tz -= dyPx * scale;
    const lim = Math.max(this.w, this.h) * CELL * 0.75 + 4;
    this.cameraMode.tx = Math.max(-lim, Math.min(lim, this.cameraMode.tx));
    this.cameraMode.tz = Math.max(-lim, Math.min(lim, this.cameraMode.tz));
    this.onCameraChange?.();
  }

  zoomBy(factor) {
    this.cameraMode.dist = Math.max(3.5, Math.min(70, this.cameraMode.dist * factor));
    this.onCameraChange?.();
  }

  resetCamera() { this.fitCamera(); }

  _closeZoom() { return this.cameraMode.d < Math.max(this.w || 10, this.h || 10) * 0.9; }

  _refreshLabelVisibility() {
    if (this.labels) this.labels.visible = this.cellLabels || this._closeZoom();
  }

  // ------------------------------------------------------------ loop -------
  resize() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    // Pixel ratio = min(dpr, preset cap) × render scale × adaptive scale.
    const ratio = Math.min(window.devicePixelRatio || 1, this.q.dpr) * this.q.scale * this.adaptiveScale;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.size = [w, h];
    this.pixelRatio = ratio;
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
  }

  setHidden(hidden) {
    this.hidden = hidden;
    if (hidden) this.settle(); // decorative motion pauses; state stays exact
  }

  update(dtMs) {
    if (this.disposed || this._contextLost || this.hidden) return;
    const dt = Math.min(0.05, dtMs / 1000);
    this.time += dt;

    // Board reveal: cells drop in, staggered from center.
    if (this.content && this._revealT !== Infinity) {
      this._revealT += dt;
      const t = this._revealT;
      let done = true;
      for (let i = 0; i < this.cells.length; i++) {
        const { x, z } = this._cellPos(i);
        const start = Math.hypot(x, z) * 0.03;
        const local = Math.max(0, Math.min(1, (t - start) / 0.4));
        const ease = 1 - (1 - local) ** 3;
        const height = H_EMPTY * ease;
        this._writeCellMatrix(i, height);
        if (local < 1) done = false;
      }
      this.cellMesh.instanceMatrix.needsUpdate = true;
      if (done || t > 4) this._revealT = Infinity;
    } else {
      // Spring cells toward targets; pulse flashes (fed to the glow attribute).
      let dirty = false, glowDirty = false;
      for (let i = 0; i < this.cells.length; i++) {
        const cell = this.cells[i];
        if (cell.delay > 0) { cell.delay -= dt; dirty = true; continue; }
        if (Math.abs(cell.h - cell.targetH) > 0.001 || Math.abs(cell.v) > 0.001) {
          [cell.h, cell.v] = springStep(cell.h, cell.targetH, cell.v, 0.22, dt);
          this._writeCellMatrix(i, cell.h);
          dirty = true;
        }
        if (cell.flash > 0) {
          cell.flash = Math.max(0, cell.flash - dt * 3);
          dirty = glowDirty = true;
        }
        const gl = cell.flash * 0.9;
        if (this.glow[i] !== gl) { this.glow[i] = gl; glowDirty = true; }
      }
      if (dirty) this.cellMesh.instanceMatrix.needsUpdate = true;
      if (glowDirty) this.glowAttr.needsUpdate = true;
    }

    // Marker pulse.
    if (this.markerMesh?.visible) {
      this.markerMat.opacity = 0.55 + 0.3 * Math.sin(this.time * 4);
    }
    if (this.hoverRing?.visible) {
      const s = 1 + 0.06 * Math.sin(this.time * 5);
      this.hoverRing.scale.set(s, s, 1);
    }

    // Particles.
    if (this.points && this.pAlive > 0) {
      const posA = this.points.geometry.attributes.position;
      const d = this.pData;
      let i = 0;
      while (i < this.pAlive) {
        d[i * 8 + 6] += dt;
        if (d[i * 8 + 6] >= d[i * 8 + 7]) {
          // swap-remove
          const last = --this.pAlive;
          for (let k = 0; k < 8; k++) d[i * 8 + k] = d[last * 8 + k];
          continue;
        }
        d[i * 8 + 4] -= 9 * dt;
        d[i * 8] += d[i * 8 + 3] * dt;
        d[i * 8 + 1] += d[i * 8 + 4] * dt;
        d[i * 8 + 2] += d[i * 8 + 5] * dt;
        posA.setXYZ(i, d[i * 8], d[i * 8 + 1], d[i * 8 + 2]);
        i++;
      }
      posA.needsUpdate = true;
      this.points.geometry.setDrawRange(0, this.pAlive);
    }

    // Ambient motion (background: animated; off under reduced motion).
    const ambient = this.q.background === 'animated' && !this.reducedMotion;
    if (ambient) {
      this._ambT = (this._ambT || 0) + dt;
      const at = this._ambT;
      if (this.dust) { this.dust.rotation.y += dt * 0.012; this.dust.position.y = Math.sin(at * 0.4) * 0.3; }
      if (this.holoRing) this.holoRing.rotation.z += dt * 0.05;
      this._placeFloaters(at);
      if (this.tips && this.tipBase) this.tips.material.color.copy(this.tipBase).multiplyScalar(0.8 + 0.2 * Math.sin(at * 1.7));
      this.rim.intensity = 60 * (0.9 + 0.1 * Math.sin(at * 0.9));
    }

    // Camera spring (critically damped, interruptible).
    const cm = this.cameraMode;
    if (this.reducedMotion) {
      cm.x = cm.tx; cm.z = cm.tz; cm.d = cm.dist;
    } else {
      [cm.x, cm.vx] = springStep(cm.x, cm.tx, cm.vx, 0.3, dt);
      [cm.z, cm.vz] = springStep(cm.z, cm.tz, cm.vz, 0.3, dt);
      [cm.d, cm.vd] = springStep(cm.d, cm.dist, cm.vd, 0.3, dt);
    }
    let sx = 0, sy = 0;
    if (this._shakeAmp > 0.0005) {
      sx = (this.pRng ? this.pRng.range(-1, 1) : 0) * this._shakeAmp;
      sy = (this.pRng ? this.pRng.range(-1, 1) : 0) * this._shakeAmp;
      this._shakeAmp *= Math.exp(-6 * dt);
    }
    // Authored framing: slightly elevated tabletop angle — low enough that
    // extruded (filled) cells read as raised blocks against empty ones.
    const elev = 0.76; // radians from horizontal-ish
    const cx = cm.x + sx;
    const cz = cm.z + cm.d * Math.cos(elev) * 0.55 + sy;
    const cy = cm.d * Math.sin(elev);
    this.camera.position.set(cx, cy, cz);
    this.camera.lookAt(cm.x, 0, cm.z);
    this._refreshLabelVisibility();

    this._adapt(dtMs);
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    const ratio = Math.min(window.devicePixelRatio || 1, this.q.dpr) * this.q.scale * this.adaptiveScale;
    if (w !== this.size[0] || h !== this.size[1] || ratio !== this.pixelRatio) this.resize();
    const key = this._postKey(w, h);
    if (key !== this.postKey) {
      this.postKey = key;
      this._buildPost(w, h);
    }
    this.renderer.info.autoReset = false; // count every pass of the frame
    this.renderer.info.reset();
    if (this.composer) {
      try { this.composer.render(dt); }
      catch { this.postFailed = true; this.composer?.dispose(); this.composer = null; this.postKey = null; this.renderer.render(this.scene, this.camera); }
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  getStats() {
    const info = this.renderer.info;
    return { drawCalls: info.render.calls, triangles: info.render.triangles };
  }

  dispose() {
    this.disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this._onLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
    this._disposeScene();
  }
}

// ---------------------------------------------------------------------------
// Procedural textures (authored, inspectable — no external assets)
// ---------------------------------------------------------------------------

function makeGridTexture(baseHex, lineHex) {
  const size = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = lineHex;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, size - 2, size - 2);
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  ctx.moveTo(size / 2, 0); ctx.lineTo(size / 2, size);
  ctx.moveTo(0, size / 2); ctx.lineTo(size, size / 2);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Detailed drafting surface: finer ruled grid, brighter major lines with a soft
// glow, and faint deterministic speckle so the table is never a flat plane.
function makeGridTextureDetailed(baseHex, lineHex) {
  const size = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = baseHex;
  ctx.fillRect(0, 0, size, size);
  const rng = new RNG('table-speckle');
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(255,255,255,${rng.range(0.01, 0.04).toFixed(3)})`;
    ctx.fillRect(rng.range(0, size), rng.range(0, size), 1, 1);
  }
  ctx.strokeStyle = lineHex;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let k = 1; k < 8; k++) {
    if (k === 4) continue;
    const p = (k * size) / 8 + 0.5;
    ctx.moveTo(p, 0); ctx.lineTo(p, size);
    ctx.moveTo(0, p); ctx.lineTo(size, p);
  }
  ctx.stroke();
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(size / 2, 0); ctx.lineTo(size / 2, size);
  ctx.moveTo(0, size / 2); ctx.lineTo(size, size / 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.shadowColor = lineHex;
  ctx.shadowBlur = 6;
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, size - 3, size - 3);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Roughness variation (linear data): soft value noise so reflections on the
// table break up into a satin sheen instead of a mirror.
function makeNoiseTexture() {
  const size = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const rng = new RNG('table-rough');
  const g = 16, grid = [];
  for (let i = 0; i < g * g; i++) grid.push(rng.range(0, 1));
  const at = (x, y) => grid[((y % g + g) % g) * g + ((x % g + g) % g)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * g, fy = (y / size) * g;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const v = (at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy;
      const r = Math.round(255 * (0.55 + 0.4 * v));
      const k = (y * size + x) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = r;
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(cv);
}

function makeXTexture() {
  const size = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(14, 14); ctx.lineTo(size - 14, size - 14);
  ctx.moveTo(size - 14, 14); ctx.lineTo(14, size - 14);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeDigitAtlas() {
  // 9 slots: 0 = '•' (background swatch), 1..8 = digits.
  const slot = 64;
  const cv = document.createElement('canvas');
  cv.width = slot * 9;
  cv.height = slot;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = 'rgba(0,0,0,0.65)';
  ctx.lineWidth = 5;
  ctx.font = `bold ${slot * 0.62}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < 9; i++) {
    const ch = i === 0 ? '•' : String(i);
    const x = i * slot + slot / 2;
    ctx.strokeText(ch, x, slot / 2);
    ctx.fillText(ch, x, slot / 2);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function mergeGeoms(geoms) {
  // Minimal merge for identical attribute layouts (position/normal/uv).
  let vCount = 0, iCount = 0;
  for (const g of geoms) {
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vCount * 3);
  const norm = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const idx = new Uint32Array(iCount);
  let vOff = 0, iOff = 0;
  for (const g of geoms) {
    pos.set(g.attributes.position.array, vOff * 3);
    norm.set(g.attributes.normal.array, vOff * 3);
    uv.set(g.attributes.uv.array, vOff * 2);
    const n = g.attributes.position.count;
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) idx[iOff + i] = g.index.array[i] + vOff;
      iOff += g.index.count;
    } else {
      for (let i = 0; i < n; i++) idx[iOff + i] = i + vOff;
      iOff += n;
    }
    vOff += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(norm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
