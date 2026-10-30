// The neon drafting table on starhermit:scene, as the browser build's
// js/render.js drew it with three.js r170: the table slab with its ruled
// grid (the detailed surface with speckle, glowing major lines and a satin
// roughness map on Balanced and up), the neon edge strips, the board of
// extruded pixel cells (one instanced box; empty cells slate tinted by
// their target, filled ones raised in their palette color, wrong ones half
// raised and dimmed with a red X), the bevel highlight and side gradient
// and the per-cell fill glow (the old onBeforeCompile patch, as material
// hooks reading the glow from the instances' custom slot), the pulsing
// markers on cells that want the selected color, the hover box and ring,
// the keyboard cursor, the ghost (region / hint preview), the digit labels
// (a ShaderMaterial over a digit atlas, at close zoom or always), the board
// frame, the drop-in reveal, the spring-animated heights and the completion
// wave, the fill sparks, the dust, the corner pylons, the holo ring and the
// floating pixels, the camera spring with pan and zoom and the low shake.
// It consumes session states and events and never touches the rules state.
//
// From three.js r170 (physically based lights): colors as written, the
// punctual lights' intensities ÷ π (the engine takes three's legacy units).
// The old composer (RenderPass → GTAO → UnrealBloom 0.6 / 0.5 / 0.9 →
// OutputPass with ACES 1.12 → the display-space grade and vignette → SMAA /
// FXAA) is the runtime's renderer.ao / bloom / grade / antialias in the same
// order. The canvas filled the window behind the DOM shell; so does the
// camera.
import {
  ACESFilmicToneMapping, OrthographicCamera, AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color, CylinderGeometry,
  DirectionalLight, DoubleSide, Euler, Fog, Group, HemisphereLight, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial,
  MeshPhysicalMaterial, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, Plane, PMREMGenerator, PointLight, Points, PointsMaterial,
  Quaternion, Raycaster, RepeatWrapping, RingGeometry, RoomEnvironment, ShaderMaterial, SRGBColorSpace, TextureLoader, TorusGeometry,
  Vector2, Vector3, Vector4, mergeGeometries, pointerToNdc, renderer, scene, type Material, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas, type OffscreenCanvasRenderingContext2D } from "starhermit:canvas";
import { RNG, type Content, type GameEvent, type Rng, type State, type Theme } from "./game.ts";
import { DUST_MAX, SPARK_MAX, sparkCap, type Look } from "./quality.ts";

const CELL = 1;
const H_EMPTY = 0.12, H_FILLED = 0.62, H_WRONG = 0.34;
const FOV = 32;
const EXPOSURE = 1.12;
const color = (hex: string): Color => new Color(hex);

// ---------------------------------------------------------------- the cell material (render.js patchCellMaterial)
/** Per-instance glow (fill pulse) added as emissive; at detailed quality a bevel highlight on each block's top edge
 * and a base-to-top gradient on its sides. three's box uv.y runs up the sides; Vertex.uv's v runs down. */
const cellUniforms = { uDetail: { value: 0 }, uGlowGain: { value: 1 } };
const CELL_HOOKS = {
  uniforms: cellUniforms,
  vertex: `fn vertex(v: Vertex) -> Vertex {
    var o = v;
    o.v0 = vec4f(v.uv.x, 1.0 - v.uv.y, v.normal.y, v.instance.x);
    return o;
  }`,
  surface: `fn surface(s: Surface) -> Surface {
    var o = s;
    let uv = s.v0.xy;
    let top = step(0.5, s.v0.z);
    let e = min(uv, vec2f(1.0) - uv);
    let edge = 1.0 - smoothstep(0.0, 0.1, min(e.x, e.y));
    if (uniforms.uDetail > 0.5) {
      o.base_color = vec4f(o.base_color.rgb * mix(mix(0.55, 1.0, uv.y), 1.0 + 0.4 * edge, top), o.base_color.a);
    }
    o.emissive = o.emissive + s.color.rgb * s.v0.w * uniforms.uGlowGain * mix(0.6, 1.0, top);
    return o;
  }`,
};

// ---------------------------------------------------------------- the digit labels (render.js _buildLabels)
const LABEL_VERTEX = `fn vertex(v: Vertex) -> Vertex {
  var o = v;
  o.v0 = vec4f(v.instance.x, 0.0, 0.0, 0.0);
  return o;
}`;
const LABEL_FRAGMENT = `fn fragment(f: Fragment) -> vec4f {
  let uv = vec2f((f.uv.x + f.v0.x) / 9.0, f.uv.y);
  let tex = textureSample(map, map_sampler, uv);
  return vec4f(srgb_to_linear(tex.rgb), tex.a * 0.9);
}`;

// ---------------------------------------------------------------- procedural textures (render.js, same drawing)
type Ctx = OffscreenCanvasRenderingContext2D;
function canvas(w: number, h: number): { c: OffscreenCanvas; g: Ctx } {
  const c = new OffscreenCanvas(w, h);
  return { c, g: c.getContext("2d")! as Ctx };
}
function srgbTexture(c: OffscreenCanvas): CanvasTexture {
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}
function makeGridTexture(baseHex: string, lineHex: string): CanvasTexture {
  const size = 128;
  const { c, g } = canvas(size, size);
  g.fillStyle = baseHex;
  g.fillRect(0, 0, size, size);
  g.strokeStyle = lineHex;
  g.lineWidth = 2;
  g.strokeRect(1, 1, size - 2, size - 2);
  g.globalAlpha = 0.5;
  g.beginPath();
  g.moveTo(size / 2, 0); g.lineTo(size / 2, size);
  g.moveTo(0, size / 2); g.lineTo(size, size / 2);
  g.stroke();
  return srgbTexture(c);
}
/** Detailed drafting surface: finer ruled grid, brighter major lines with a soft glow, faint speckle (authored at 256 px). */
function makeGridTextureDetailed(baseHex: string, lineHex: string, px: number): CanvasTexture {
  const size = 256;
  const { c, g } = canvas(px, px);
  g.scale(px / size, px / size);
  g.fillStyle = baseHex;
  g.fillRect(0, 0, size, size);
  const rng = new RNG("table-speckle");
  for (let i = 0; i < 900; i++) {
    g.fillStyle = `rgba(255,255,255,${rng.range(0.01, 0.04).toFixed(3)})`;
    g.fillRect(rng.range(0, size), rng.range(0, size), 1, 1);
  }
  g.strokeStyle = lineHex;
  g.globalAlpha = 0.35;
  g.lineWidth = 1;
  g.beginPath();
  for (let k = 1; k < 8; k++) {
    if (k === 4) continue;
    const p = (k * size) / 8 + 0.5;
    g.moveTo(p, 0); g.lineTo(p, size);
    g.moveTo(0, p); g.lineTo(size, p);
  }
  g.stroke();
  g.globalAlpha = 0.8;
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(size / 2, 0); g.lineTo(size / 2, size);
  g.moveTo(0, size / 2); g.lineTo(size, size / 2);
  g.stroke();
  g.globalAlpha = 1;
  g.shadowColor = lineHex;
  g.shadowBlur = 6;
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, size - 3, size - 3);
  const t = srgbTexture(c);
  t.anisotropy = 4;
  return t;
}
function makeXTexture(): CanvasTexture {
  const size = 64;
  const { c, g } = canvas(size, size);
  g.strokeStyle = "#ffffff";
  g.lineWidth = 10;
  g.lineCap = "round";
  g.beginPath();
  g.moveTo(14, 14); g.lineTo(size - 14, size - 14);
  g.moveTo(size - 14, 14); g.lineTo(14, size - 14);
  g.stroke();
  return srgbTexture(c);
}
/** 9 slots: 0 = '•' (background swatch), 1..8 = digits. */
function makeDigitAtlas(): CanvasTexture {
  const slot = 64;
  const { c, g } = canvas(slot * 9, slot);
  g.fillStyle = "#ffffff";
  g.strokeStyle = "rgba(0,0,0,0.65)";
  g.lineWidth = 5;
  g.font = `bold ${slot * 0.62}px sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  for (let i = 0; i < 9; i++) {
    const ch = i === 0 ? "•" : String(i);
    const x = i * slot + slot / 2;
    g.strokeText(ch, x, slot / 2);
    g.fillText(ch, x, slot / 2);
  }
  return new CanvasTexture(c);
}

// ---------------------------------------------------------------- the scene
const camera = new PerspectiveCamera(FOV, 16 / 9, 0.1, 300);
renderer.camera = camera;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = EXPOSURE;
scene.background = color("#05070f");
const fog = new Fog(color("#0a1024"), 30, 95);
scene.fog = fog;

const hemi = new HemisphereLight(color("#9fd8ff"), color("#05070f"), 0.55);
scene.add(hemi);
const key = new DirectionalLight(color("#9fd8ff"), 1.6);
key.position.set(8, 16, 6).normalize().multiplyScalar(24);
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
scene.add(key, key.target);
/** The page's key-light shadow box, fitted tightly to the board. */
function fitShadow(): void {
  const ext = Math.max(W || 12, H || 12) * CELL * 0.5 + 1.5;
  const sc = key.shadow.camera as OrthographicCamera;
  sc.left = -ext * 1.25; sc.right = ext * 1.25; sc.top = ext * 1.25; sc.bottom = -ext * 1.25; sc.near = 1; sc.far = 50;
  sc.updateProjectionMatrix();
}
const RIM = 60;
const rim = new PointLight(color("#ff7ad9"), RIM, 60, 2);
rim.position.set(-10, 6, -8);
scene.add(rim);

const TABLE = 64;
const tableMat = new MeshStandardMaterial({ roughness: 0.85, metalness: 0.15 });
const table = new Mesh(new BoxGeometry(TABLE, 1.2, TABLE), tableMat);
table.position.y = -0.62;
scene.add(table);
const edgeMat = new MeshBasicMaterial({ color: color("#22d3ee") });
const tableEdges = (() => {
  const half = TABLE / 2, gs: BufferGeometry[] = [];
  for (const [x, z, w, d] of [[0, -half, TABLE, 0.14], [0, half, TABLE, 0.14], [-half, 0, 0.14, TABLE], [half, 0, 0.14, TABLE]] as const) {
    const g = new BoxGeometry(w, 0.06, d);
    g.translate(x, 0.03, z);
    gs.push(g);
  }
  return new Mesh(mergeGeometries(gs)!, edgeMat);
})();
scene.add(tableEdges);
const props = new Group();
scene.add(props);

let roughTex: Texture | null = null;
new TextureLoader().load("assets/table-rough.png", (t) => {
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(6, 6);
  roughTex = t;
  applyTableSurface();
}, undefined, (e: unknown) => console.warn(`table roughness: ${e instanceof Error ? e.message : String(e)}`));
let envTex: Texture | null = null;

// ---------------------------------------------------------------- state
let look: Look | null = null;
let theme: Theme | null = null;
let reducedMotion = false;
let cellLabels = false;
let content: Content | null = null;
let palette: string[] = [];
let W = 12, H = 12;
fitShadow();
interface CellView { h: number; targetH: number; v: number; flash: number; filled: boolean; wrong: number; delay: number }
let cells: CellView[] = [];
let ghostCells = new Set<number>();
let selectedColor = -1;

let time = 0, ambT = 0;
let revealT = Infinity;
let shakeAmp = 0;
let hidden = false;
let active = true;
const cam = { tx: 0, tz: -6, dist: 36, vx: 0, vz: 0, vd: 0, x: 0, z: -6, d: 36 };
let win = { w: 1, h: 1 };
/** Fired when the player moves the camera (lessons count it). */
let onCameraChange: (() => void) | null = null;
export function setCameraListener(fn: () => void): void { onCameraChange = fn; }

const tmpM = new Matrix4(), tmpC = new Color(), tmpV = new Vector3(), tmpQ = new Quaternion(), tmpE = new Euler(), tmpS = new Vector3();
const tmp4 = new Vector4();

// board objects
let boardGroup: Group | null = null;
let cellMesh: InstancedMesh | null = null;
let cellMat: Material | null = null, cellMatGloss: Material | null = null, cellTier = "";
let hoverBox: Mesh | null = null, hoverRing: Mesh | null = null, cursorBox: Mesh | null = null;
let markerMesh: InstancedMesh | null = null;
const markerMat = new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, blending: AdditiveBlending, depthWrite: false });
let wrongMesh: InstancedMesh | null = null;
const wrongMat = new MeshBasicMaterial({ map: makeXTexture(), transparent: true, depthWrite: false, color: color("#ff5d5d") });
let labels: InstancedMesh | null = null;
const digitAtlas = makeDigitAtlas();
const labelMat = new ShaderMaterial({
  transparent: true, depthWrite: false, uniforms: { map: { value: digitAtlas } }, vertexShader: LABEL_VERTEX, fragmentShader: LABEL_FRAGMENT,
});
labelMat.alphaTest = 0.05;
let frameMesh: Mesh | null = null;
const frameMat = new MeshBasicMaterial({ color: color("#22d3ee") });

// props
let dust: Points | null = null;
let holoRing: Mesh | null = null;
let floaters: InstancedMesh | null = null;
let floatData: { x: number; y: number; z: number; ph: number; sp: number; s: number }[] = [];
let tips: Mesh | null = null;
let tipBase = new Color();

// particles
let points: Points | null = null;
let pCap = 0, pAlive = 0;
let pData = new Float32Array(0);
let pRng: Rng = new RNG("fx:fx");
let pPos = new Float32Array(0), pCol = new Float32Array(0);

const glowGain = (): number => (look?.bloom ? 2.2 : 1);

// ---------------------------------------------------------------- materials
function makeCellMats(): void {
  const tier = look?.budget.material ?? "standard";
  if (tier === cellTier && cellMat) return;
  const old = [cellMat, cellMatGloss];
  cellTier = tier;
  cellMat = tier === "lambert" ? new MeshLambertMaterial({ hooks: CELL_HOOKS }) : new MeshStandardMaterial({ roughness: 0.55, metalness: 0.2, hooks: CELL_HOOKS });
  cellMatGloss = tier === "physical"
    ? new MeshPhysicalMaterial({ roughness: 0.38, metalness: 0.08, clearcoat: 0.8, clearcoatRoughness: 0.22, hooks: CELL_HOOKS })
    : new MeshStandardMaterial({ roughness: 0.38, metalness: 0.08, hooks: CELL_HOOKS });
  if (cellMesh) cellMesh.material = look?.reflections ? cellMatGloss : cellMat;
  for (const m of old) m?.dispose();
}

function applyTableSurface(): void {
  const t = theme;
  const detailed = !!look?.detailed;
  tableMat.map?.dispose();
  const px = look?.budget.table ?? 256;
  const map = detailed ? makeGridTextureDetailed(t?.table ?? "#0d1426", t?.grid ?? "#16233f", px) : makeGridTexture(t?.table ?? "#0d1426", t?.grid ?? "#16233f");
  map.wrapS = map.wrapT = RepeatWrapping;
  map.repeat.set(16, 16);
  tableMat.map = map;
  if (detailed && roughTex) {
    tableMat.roughnessMap = roughTex;
    tableMat.roughness = 1;
    tableMat.metalness = 0.25;
  } else {
    tableMat.roughnessMap = null;
    tableMat.roughness = 0.85;
    tableMat.metalness = 0.15;
  }
}

/** Neon strips and the board frame read brighter than 1.0 with bloom, so only they (and fill pulses) bloom. */
function applyGlow(): void {
  const g = glowGain();
  const a = color(theme?.accentA ?? "#22d3ee");
  edgeMat.color.copy(a).multiplyScalar(g);
  frameMat.color.copy(a).multiplyScalar(g);
  cellUniforms.uGlowGain.value = look?.bloom ? 1.6 : 0.8;
}

function disposeChildren(group: Group): void {
  for (const c of [...group.children]) {
    group.remove(c);
    const m = c as Mesh;
    m.geometry?.dispose?.();
    (m.material as Material | undefined)?.dispose?.();
  }
}

function buildProps(): void {
  disposeChildren(props);
  dust = null; holoRing = null; floaters = null; tips = null;
  if (!look) return;
  const t = theme;
  const rng = new RNG("decor:" + (content?.seed ?? "default"));
  const glow = look.bloom ? 2.2 : 1;
  const accent = color(t?.accentB ?? "#f472b6");
  const accentA = color(t?.accentA ?? "#22d3ee");
  if (look.particles === "high") {
    const count = Math.min(DUST_MAX, look.budget.dust);
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = rng.range(-22, 22);
      pos[i * 3 + 1] = rng.range(0.5, 10);
      pos[i * 3 + 2] = rng.range(-22, 22);
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(pos, 3));
    dust = new Points(g, new PointsMaterial({ color: accentA, size: 0.07, transparent: true, opacity: 0.55, sizeAttenuation: true, depthWrite: false }));
    props.add(dust);
  }
  if (!look.detailed) return;
  const pylonMat = new MeshStandardMaterial({ color: color(t?.tableEdge ?? "#1c2b4d"), roughness: 0.45, metalness: 0.6 });
  const tipMat = new MeshBasicMaterial({ color: accent.clone().multiplyScalar(glow) });
  const geoms: BufferGeometry[] = [], tipGeoms: BufferGeometry[] = [];
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2 + 0.4;
    const r = 24 + rng.range(-2, 2);
    const x = Math.cos(ang) * r, z = Math.sin(ang) * r;
    const h = 4 + rng.range(0, 3);
    const g = new CylinderGeometry(0.5, 0.8, h, 6);
    g.translate(x, h / 2 - 1.2, z);
    geoms.push(g);
    const tip = new CylinderGeometry(0.52, 0.52, 0.18, 6);
    tip.translate(x, h - 1.2 + 0.09, z);
    tipGeoms.push(tip);
  }
  props.add(new Mesh(mergeGeometries(geoms)!, pylonMat));
  tips = new Mesh(mergeGeometries(tipGeoms)!, tipMat);
  tipBase = accent.clone().multiplyScalar(glow);
  props.add(tips);
  const ext = Math.max(W, H) * CELL * 0.5;
  holoRing = new Mesh(new TorusGeometry(9, 0.05, 8, 96),
    new MeshBasicMaterial({ color: accentA.clone().multiplyScalar(glow), transparent: true, opacity: 0.4, depthWrite: false }));
  holoRing.position.set(0, 6, -Math.max(16, ext + 10));
  holoRing.rotation.x = Math.PI / 2.4;
  props.add(holoRing);
  const n = look.budget.floaters;
  const cols = [t?.accentA ?? "#22d3ee", t?.accentB ?? "#f472b6", "#ffd166", "#3fd68f"];
  floaters = new InstancedMesh(new BoxGeometry(0.34, 0.34, 0.34),
    new MeshBasicMaterial({ color: new Color(1, 1, 1).multiplyScalar(glow > 1 ? 1.25 : 0.9) }), n);
  floatData = [];
  for (let i = 0; i < n; i++) {
    const ang = rng.range(Math.PI * 1.05, Math.PI * 1.95);
    const r = rng.range(ext + 5, ext + 20);
    floatData.push({ x: Math.cos(ang) * r * 1.3, z: Math.sin(ang) * r, y: rng.range(1, 5), ph: rng.range(0, 6.28), sp: rng.range(0.4, 1), s: rng.range(0.6, 1.4) });
    floaters.setColorAt(i, tmpC.set(cols[i % cols.length]!));
  }
  placeFloaters(0);
  props.add(floaters);
}
function placeFloaters(at: number): void {
  if (!floaters) return;
  for (let i = 0; i < floatData.length; i++) {
    const d = floatData[i]!;
    tmpE.set(at * d.sp * 0.5 + d.ph, at * d.sp * 0.7 + d.ph, 0);
    tmpQ.setFromEuler(tmpE);
    tmpV.set(d.x, d.y + Math.sin(at * d.sp + d.ph) * 0.35, d.z);
    tmpS.setScalar(d.s);
    tmpM.compose(tmpV, tmpQ, tmpS);
    floaters.setMatrixAt(i, tmpM);
  }
  floaters.instanceMatrix.needsUpdate = true;
}

function buildParticles(): void {
  if (points) {
    scene.remove(points);
    points.geometry.dispose();
    points.material.dispose();
    points = null;
  }
  if (!look) return;
  pCap = Math.min(SPARK_MAX, sparkCap(look));
  pData = new Float32Array(pCap * 8);
  pPos = new Float32Array(pCap * 3);
  pCol = new Float32Array(pCap * 3);
  pAlive = 0;
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pPos, 3));
  g.setAttribute("color", new BufferAttribute(pCol, 3));
  g.setDrawRange(0, 0);
  points = new Points(g, new PointsMaterial({
    size: 0.14, vertexColors: true, transparent: true, opacity: 0.95, blending: AdditiveBlending, depthWrite: false, sizeAttenuation: true,
  }));
  points.frustumCulled = false;
  scene.add(points);
  pRng = new RNG("fx:" + (content?.seed ?? "fx"));
}
function spawnBurst(x: number, y: number, z: number, hex: string, n: number, spread = 2.2): void {
  if (!points) return;
  if (reducedMotion) n = Math.min(n, 4);
  const col = color(hex);
  for (let k = 0; k < n && pAlive < pCap; k++) {
    const i = pAlive++;
    const d = pData;
    d[i * 8] = x; d[i * 8 + 1] = y; d[i * 8 + 2] = z;
    d[i * 8 + 3] = pRng.range(-spread, spread);
    d[i * 8 + 4] = pRng.range(1.5, 4);
    d[i * 8 + 5] = pRng.range(-spread, spread);
    d[i * 8 + 6] = 0;
    d[i * 8 + 7] = pRng.range(0.35, 0.8);
    pCol[i * 3] = col.r; pCol[i * 3 + 1] = col.g; pCol[i * 3 + 2] = col.b;
  }
  points.geometry.attributes.color!.needsUpdate = true;
}

// ---------------------------------------------------------------- quality and theme
/** The runtime's quality tier applied live (no reload): materials, shadows, environment, props, sparks and the post chain. */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  look = next;
  renderer.shadowMap.enabled = next.shadows > 0;
  key.castShadow = next.shadows > 0;
  if (next.shadows > 0) key.shadow.mapSize = next.shadows;
  table.receiveShadow = next.shadows > 0;
  if (cellMesh) cellMesh.castShadow = cellMesh.receiveShadow = next.shadows > 0;
  if (next.reflections) {
    if (!envTex) {
      try { const pageRoom = new RoomEnvironment(renderer); pageRoom.position.y = 0; /* the page's three r170 (pre-r183) builds the room at the origin */ envTex = new PMREMGenerator(renderer).fromScene(pageRoom, 0.04).texture; } catch (e) { console.warn(`environment: ${String(e)}`); }
    }
    scene.environment = envTex;
    scene.environmentIntensity = 0.22;
  } else scene.environment = null;
  cellUniforms.uDetail.value = next.detailed ? 1 : 0;
  makeCellMats();
  if (cellMesh) cellMesh.material = next.reflections ? cellMatGloss! : cellMat!;
  applyTableSurface();
  buildProps();
  buildParticles();
  applyGlow();
  // UnrealBloomPass(0.6, 0.5, 0.9): only the neon strips, pylons and fill pulses bloom.
  // three r170 page: bloom model "r176" with the page's strength 0.6 (engine.minor 30).
  renderer.bloom = next.bloom ? { model: "r176", strength: 0.6, radius: 0.5, threshold: 0.9, resolution: next.budget.bloomRes } : null;
  // GTAOPass: radius 0.5, distance exponent 1.2, thickness 1, 16 / 8 samples and the denoise per tier, blend 0.75.
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.75, radius: 0.5, distanceExponent: 1.2, thickness: 1, scale: 1, samples: next.ao === "high" ? 16 : 8, resolution: next.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // GradeShader after the OutputPass (display space): a 0.22 S-curve, saturation 1.12, cool shadows / warm highlights over
  // luma 0.2 → 0.8, blacks lifted (×0.975 + 0.018 as levels), a 0.26 vignette
  // from 0.38 to 0.9 with x scaled 1.1.
  renderer.grade = next.grade ? {
    space: "display", contrastCurve: "s", contrast: 0.22, saturation: 1.12, levels: [0.975, 0.018], split: [0.2, 0.8], shadows: [0.95, 0.98, 1.06], highlights: [1.04, 1.0, 0.97],
    vignette: { amount: 0.26, inner: 0.38, outer: 0.9, scale: [1.1, 1] },
  } : null;
  renderer.antialias = next.antialias;
}

/** render.js setTheme. */
export function setTheme(t: Theme): void {
  theme = t;
  scene.background = color(t.bg);
  fog.color = color(t.fog);
  hemi.color = color(t.key);
  hemi.groundColor = color(t.bg);
  key.color = color(t.key);
  rim.color = color(t.rim);
  applyTableSurface();
  buildProps();
  recolorAll();
  applyGlow();
}
export function setReducedMotion(v: boolean): void { reducedMotion = v; }
export function setCellLabels(v: boolean): void { cellLabels = v; refreshLabels(); }
/** Whether the 3D scene draws (the title and menus draw it behind their veil, as the canvas showed through). */
export function setActive(on: boolean): void { active = on; renderer.camera = on ? camera : null; }
export function setHidden(v: boolean): void { hidden = v; if (v) settle(); }

// ---------------------------------------------------------------- the board
function cellPos(i: number): { x: number; z: number } {
  return { x: ((i % W) - (W - 1) / 2) * CELL, z: (Math.floor(i / W) - (H - 1) / 2) * CELL };
}
function cellBaseColor(i: number, out = tmpC): Color {
  const c = cells[i]!;
  const target = content!.targets[i]!;
  const p = color(palette[target] ?? "#ffffff");
  if (c.filled) return out.copy(p);
  if (c.wrong) return out.copy(color(palette[c.wrong - 1] ?? "#ff0000")).multiplyScalar(0.75);
  return out.copy(color(theme?.cellEmpty ?? "#141d33")).lerp(p, 0.22);
}
function writeCell(i: number, height: number): void {
  const { x, z } = cellPos(i);
  tmpM.makeScale(1, Math.max(0.02, height), 1);
  tmpM.setPosition(x, 0, z);
  cellMesh!.setMatrixAt(i, tmpM);
}
function recolorAll(): void {
  if (!cellMesh || !content) return;
  for (let i = 0; i < cells.length; i++) cellMesh.setColorAt(i, ghostCells.has(i) ? cellBaseColor(i).multiplyScalar(1.6) : cellBaseColor(i));
  cellMesh.instanceColor!.needsUpdate = true;
}
function writeGlow(i: number, g: number): void {
  tmp4.set(g, 0, 0, 0);
  cellMesh!.setCustomAt(i, tmp4, 0);
}

/** render.js setBoard: a new board (the previous one disposed), revealed by the drop-in. */
export function setBoard(c: Content, pal: string[]): void {
  if (boardGroup) {
    scene.remove(boardGroup);
    disposeChildren(boardGroup);
  }
  content = c;
  palette = pal;

  W = c.width; H = c.height;
  fitShadow();
  cells = [];
  for (let i = 0; i < W * H; i++) cells.push({ h: 0, targetH: H_EMPTY, v: 0, flash: 0, filled: false, wrong: 0, delay: 0 });
  ghostCells = new Set();
  const group = new Group();
  boardGroup = group;
  scene.add(group);

  const geo = new BoxGeometry(0.92, 1, 0.92);
  geo.translate(0, 0.5, 0);
  cellTier = "";
  makeCellMats();
  const shadows = (look?.shadows ?? 0) > 0;
  cellMesh = new InstancedMesh(geo, look?.reflections ? cellMatGloss! : cellMat!, W * H);
  cellMesh.customSlots = 1;
  cellMesh.castShadow = cellMesh.receiveShadow = shadows;
  group.add(cellMesh);
  for (let i = 0; i < W * H; i++) {
    writeCell(i, H_EMPTY);
    cellMesh.setColorAt(i, cellBaseColor(i));
    writeGlow(i, 0);
  }

  hoverBox = new Mesh(new BoxGeometry(1.02, 1.02, 1.02), new MeshBasicMaterial({ color: 0xffffff, wireframe: true, transparent: true, opacity: 0.9 }));
  hoverBox.visible = false;
  group.add(hoverBox);
  hoverRing = new Mesh(new RingGeometry(0.55, 0.72, 32), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.65, side: DoubleSide }));
  hoverRing.rotation.x = -Math.PI / 2;
  hoverRing.position.y = 0.02;
  hoverRing.visible = false;
  group.add(hoverRing);
  cursorBox = new Mesh(new BoxGeometry(1.02, 0.2, 1.02), new MeshBasicMaterial({ color: color(theme?.accentB ?? "#f472b6"), wireframe: true }));
  cursorBox.visible = false;
  group.add(cursorBox);

  markerMesh = new InstancedMesh(new PlaneGeometry(0.3, 0.3), markerMat, W * H);
  markerMesh.count = 0;
  group.add(markerMesh);
  wrongMesh = new InstancedMesh(new PlaneGeometry(0.7, 0.7), wrongMat, W * H);
  wrongMesh.count = 0;
  group.add(wrongMesh);

  const lg = new PlaneGeometry(0.55, 0.55);
  lg.rotateX(-Math.PI / 2);
  labels = new InstancedMesh(lg, labelMat, W * H);
  labels.customSlots = 1;
  for (let i = 0; i < W * H; i++) {
    const { x, z } = cellPos(i);
    tmpM.makeTranslation(x, H_EMPTY + 0.02, z);
    labels.setMatrixAt(i, tmpM);
    tmp4.set(c.targets[i]!, 0, 0, 0);
    labels.setCustomAt(i, tmp4, 0);
  }
  labels.visible = cellLabels;
  group.add(labels);

  const fg: BufferGeometry[] = [];
  const fw = (W * CELL) / 2 + 0.35, fh = (H * CELL) / 2 + 0.35;
  for (const [x, z, gw, gd] of [[0, -fh, fw * 2, 0.1], [0, fh, fw * 2, 0.1], [-fw, 0, 0.1, fh * 2], [fw, 0, 0.1, fh * 2]] as const) {
    const g = new BoxGeometry(gw, 0.08, gd);
    g.translate(x, 0.04, z);
    fg.push(g);
  }
  frameMesh = new Mesh(mergeGeometries(fg)!, frameMat);
  group.add(frameMesh);
  applyGlow();
  buildProps();
  buildParticles();
  revealT = reducedMotion ? Infinity : 0;
  fitCamera(true);
}

/** render.js syncState: every cell from a state (restore, palette change), no animation. */
export function syncState(state: State): void {

  if (!content || !cellMesh) return;
  for (let i = 0; i < state.targets.length; i++) {
    const c = cells[i]!;
    c.filled = state.filled[i] === 1;
    c.wrong = state.wrong[i]!;
    c.targetH = c.filled ? H_FILLED : c.wrong ? H_WRONG : H_EMPTY;
    c.h = c.targetH;
    c.flash = 0;
    if (revealT === Infinity) writeCell(i, c.h);
    writeGlow(i, 0);
  }
  recolorAll();
  cellMesh.instanceMatrix.needsUpdate = true;
  selectedColor = state.selected;
  rebuildMarkers(state);
  rebuildWrong(state);
}

/** render.js applyEvents. */
export function applyEvents(events: GameEvent[], state: State): void {

  if (!content || !cellMesh) return;
  let colorDirty = false, markerDirty = false, wrongDirty = false;
  for (const ev of events) {
    switch (ev.type) {
      case "fill":
        for (const i of ev.cells ?? []) {
          const c = cells[i]!;
          c.filled = true; c.wrong = 0; c.targetH = H_FILLED; c.flash = 1;
          if (reducedMotion) c.h = H_FILLED;
          cellMesh.setColorAt(i, cellBaseColor(i));
          const { x, z } = cellPos(i);
          spawnBurst(x, H_FILLED + 0.1, z, palette[ev.color!] ?? "#ffffff", ev.tool === "region" ? 2 : 5);
        }
        colorDirty = markerDirty = true;
        break;
      case "error":
        for (const i of ev.cells ?? []) {
          const c = cells[i]!;
          c.wrong = ev.color! + 1; c.targetH = H_WRONG;
          if (reducedMotion) c.h = H_WRONG;
          cellMesh.setColorAt(i, cellBaseColor(i));
        }
        colorDirty = wrongDirty = true;
        shake(0.25);
        break;
      case "undo":
        for (const i of ev.cells ?? []) {
          const c = cells[i]!;
          c.filled = false; c.wrong = 0; c.targetH = H_EMPTY;
          if (reducedMotion) c.h = H_EMPTY;
          cellMesh.setColorAt(i, cellBaseColor(i));
        }
        colorDirty = markerDirty = wrongDirty = true;
        break;
      case "select":
        selectedColor = ev.color!;
        markerDirty = true;
        break;
      case "terminal":
        if (ev.status === "complete") completionWave();
        markerDirty = true;
        break;
      default: break;
    }
  }
  if (colorDirty) cellMesh.instanceColor!.needsUpdate = true;
  if (markerDirty) rebuildMarkers(state);
  if (wrongDirty) rebuildWrong(state);
}
function rebuildMarkers(state: State): void {
  if (!markerMesh) return;
  let n = 0;
  const sel = selectedColor;
  if (sel >= 0 && (state.status === "active" || state.status === "paused")) {
    for (let i = 0; i < state.targets.length; i++) {
      if (state.targets[i] === sel && !state.filled[i]) {
        const { x, z } = cellPos(i);
        tmpM.makeRotationX(-Math.PI / 2);
        tmpM.setPosition(x, (cells[i]!.h || H_EMPTY) + 0.03, z);
        markerMesh.setMatrixAt(n++, tmpM);
      }
    }
  }
  markerMesh.count = n;
  markerMesh.instanceMatrix.needsUpdate = true;
  markerMesh.visible = n > 0;
}
function rebuildWrong(state: State): void {
  if (!wrongMesh) return;
  let n = 0;
  for (let i = 0; i < state.wrong.length; i++) {
    if (state.wrong[i]) {
      const { x, z } = cellPos(i);
      tmpM.makeRotationX(-Math.PI / 2);
      tmpM.setPosition(x, (cells[i]!.h || H_WRONG) + 0.04, z);
      wrongMesh.setMatrixAt(n++, tmpM);
    }
  }
  wrongMesh.count = n;
  wrongMesh.instanceMatrix.needsUpdate = true;
}
function completionWave(): void {
  if (reducedMotion) return;
  for (let i = 0; i < cells.length; i++) {
    const { x, z } = cellPos(i);
    cells[i]!.delay = Math.hypot(x, z) * 0.045;
    cells[i]!.flash = 1.5;
  }
  for (let k = 0; k < 4; k++) spawnBurst(pRng.range(-W / 2, W / 2), 1.2, pRng.range(-H / 2, H / 2), theme?.accentA ?? "#22d3ee", 30, 3.5);
  shake(0.5);
}
function shake(amp: number): void {
  if (reducedMotion) return;
  shakeAmp = Math.max(shakeAmp, amp * 0.06);
}
/** render.js settle: every animated object at its exact end state (Skip animations). */
export function settle(): void {
  if (!content || !cellMesh) return;
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    c.h = c.targetH; c.flash = 0; c.delay = 0; c.v = 0;
    writeCell(i, c.h);
    writeGlow(i, 0);
  }
  cellMesh.instanceMatrix.needsUpdate = true;
  revealT = Infinity;
  pAlive = 0;
  points?.geometry.setDrawRange(0, 0);
  shakeAmp = 0;
}

// ---------------------------------------------------------------- picking and overlays
const raycaster = new Raycaster();
const ndc = new Vector2();
const boardPlane = new Plane(new Vector3(0, 1, 0), -0.01);
/** render.js screenToCell (window pixels): the ray against the board's plane, -1 off the board. */
export function screenToCell(x: number, y: number): number {
  if (!content) return -1;
  pointerToNdc(x, y, ndc);
  raycaster.setFromCamera(ndc, camera);
  const p = raycaster.ray.intersectPlane(boardPlane, tmpV);
  if (!p) return -1;
  const cx = Math.floor(p.x / CELL + W / 2), cy = Math.floor(p.z / CELL + H / 2);
  if (cx < 0 || cy < 0 || cx >= W || cy >= H) return -1;
  return cy * W + cx;
}
/** A cell's raised top in window pixels (render.js cellToScreen). */
export function cellToScreen(i: number): { x: number; y: number } {
  const { x, z } = cellPos(i);
  tmpV.set(x, H_FILLED, z).project(camera);
  return { x: (tmpV.x + 1) / 2 * win.w, y: (-tmpV.y + 1) / 2 * win.h };
}
export function setHover(cell: number): void {
  if (!hoverBox || !hoverRing || !content) return;
  if (cell >= 0) {
    const { x, z } = cellPos(cell);
    hoverBox.position.set(x, 0.5, z);
    hoverRing.position.set(x, 0.02, z);
    const col = color(palette[content.targets[cell]!] ?? "#ffffff");
    (hoverBox.material as MeshBasicMaterial).color.copy(col);
    (hoverRing.material as MeshBasicMaterial).color.copy(col);
    hoverBox.visible = hoverRing.visible = true;
  } else hoverBox.visible = hoverRing.visible = false;
}
export function setKeyboardCursor(cell: number): void {
  if (!cursorBox) return;
  if (cell >= 0) {
    const { x, z } = cellPos(cell);
    cursorBox.position.set(x, 0.6, z);
    cursorBox.visible = true;
  } else cursorBox.visible = false;
}
/** Brightens a set of cells (the region tool's preview, a hint), restoring the previous ones. */
export function setGhost(list: number[] | null): void {
  if (!cellMesh || !content) { ghostCells = new Set(); return; }
  const prev = ghostCells;
  ghostCells = new Set(list ?? []);
  for (const i of prev) cellMesh.setColorAt(i, cellBaseColor(i));
  for (const i of ghostCells) cellMesh.setColorAt(i, cellBaseColor(i).multiplyScalar(1.6));
  cellMesh.instanceColor!.needsUpdate = true;
}

// ---------------------------------------------------------------- the camera
/** Fits the board (margin for the HUD tray and top bar; portrait fits the width). */
export function fitCamera(immediate = false): void {
  if (!content) return;
  const ext = Math.max(W, H) * CELL;
  const margin = 1.62;
  const aspect = win.w / Math.max(1, win.h);
  const fitV = (ext * margin) / (2 * Math.tan((FOV * Math.PI / 180) / 2));
  const dist = Math.max(fitV, aspect < 1 ? fitV / Math.max(aspect, 0.4) * 1.05 : fitV);
  cam.tx = 0; cam.tz = 0;
  cam.dist = Math.min(60, Math.max(6, dist));
  if (immediate || reducedMotion) {
    cam.x = 0; cam.z = 0; cam.d = cam.dist;
    cam.vx = cam.vz = cam.vd = 0;
  }
}
export function resetCamera(): void { fitCamera(); onCameraChange?.(); }
export function panBy(dx: number, dy: number): void {
  const scale = cam.d / Math.max(1, win.h) * 1.6;
  cam.tx -= dx * scale;
  cam.tz -= dy * scale;
  const lim = Math.max(W, H) * CELL * 0.75 + 4;
  cam.tx = Math.max(-lim, Math.min(lim, cam.tx));
  cam.tz = Math.max(-lim, Math.min(lim, cam.tz));
  onCameraChange?.();
}
export function zoomBy(f: number): void {
  cam.dist = Math.max(3.5, Math.min(70, cam.dist * f));
  onCameraChange?.();
}
function closeZoom(): boolean { return cam.d < Math.max(W || 10, H || 10) * 0.9; }
function refreshLabels(): void { if (labels) labels.visible = cellLabels || closeZoom(); }

/** Critically damped spring (render.js springStep). */
function spring(cur: number, target: number, vel: number, smooth: number, dt: number): [number, number] {
  const omega = 2 / Math.max(0.0001, smooth);
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (vel + omega * change) * dt;
  let nv = (vel - omega * temp) * exp;
  let out = target + (change + temp) * exp;
  if (change > 0 === out > target) { out = target; nv = 0; }
  return [out, nv];
}

// ---------------------------------------------------------------- each frame
let lastSize = "";
export function update(dtSec: number, w: number, h: number): void {
  if (w > 0 && h > 0) {
    win = { w, h };
    const k = `${w}x${h}`;
    if (k !== lastSize) {
      const first = lastSize === "";
      lastSize = k;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (content) fitCamera(first);
    }
  }
  if (hidden || !active) return;
  const dt = Math.min(0.05, dtSec);
  time += dt;
  if (content && cellMesh) {
    if (revealT !== Infinity) {
      revealT += dt;
      const t = revealT;
      let done = true;
      for (let i = 0; i < cells.length; i++) {
        const { x, z } = cellPos(i);
        const start = Math.hypot(x, z) * 0.03;
        const local = Math.max(0, Math.min(1, (t - start) / 0.4));
        const ease = 1 - (1 - local) ** 3;
        // cells filled before the reveal ended (a restored round) rise to their height
        writeCell(i, Math.max(H_EMPTY, cells[i]!.targetH) * ease);
        if (local < 1) done = false;
      }
      cellMesh.instanceMatrix.needsUpdate = true;
      if (done || t > 4) {
        revealT = Infinity;
        for (let i = 0; i < cells.length; i++) { cells[i]!.h = cells[i]!.targetH; writeCell(i, cells[i]!.h); }
      }
    } else {
      let dirty = false, glowDirty = false;
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i]!;
        if (c.delay > 0) { c.delay -= dt; continue; }
        if (Math.abs(c.h - c.targetH) > 0.001 || Math.abs(c.v) > 0.001) {
          [c.h, c.v] = spring(c.h, c.targetH, c.v, 0.22, dt);
          writeCell(i, c.h);
          dirty = true;
        }
        if (c.flash > 0) {
          c.flash = Math.max(0, c.flash - dt * 3);
          writeGlow(i, c.flash * 0.9);
          glowDirty = true;
        }
      }
      if (dirty) cellMesh.instanceMatrix.needsUpdate = true;
      void glowDirty;
    }
  }
  if (markerMesh?.visible) markerMat.opacity = 0.55 + 0.3 * Math.sin(time * 4);
  if (hoverRing?.visible) {
    const s = 1 + 0.06 * Math.sin(time * 5);
    hoverRing.scale.set(s, s, 1);
  }
  // sparks
  if (points && pAlive > 0) {
    const d = pData;
    let i = 0;
    while (i < pAlive) {
      d[i * 8 + 6] = d[i * 8 + 6]! + dt;
      if (d[i * 8 + 6]! >= d[i * 8 + 7]!) {
        const last = --pAlive;
        for (let k = 0; k < 8; k++) d[i * 8 + k] = d[last * 8 + k]!;
        for (let k = 0; k < 3; k++) pCol[i * 3 + k] = pCol[last * 3 + k]!;
        continue;
      }
      d[i * 8 + 4] = d[i * 8 + 4]! - 9 * dt;
      d[i * 8] = d[i * 8]! + d[i * 8 + 3]! * dt;
      d[i * 8 + 1] = d[i * 8 + 1]! + d[i * 8 + 4]! * dt;
      d[i * 8 + 2] = d[i * 8 + 2]! + d[i * 8 + 5]! * dt;
      pPos[i * 3] = d[i * 8]!; pPos[i * 3 + 1] = d[i * 8 + 1]!; pPos[i * 3 + 2] = d[i * 8 + 2]!;
      i++;
    }
    points.geometry.attributes.position!.needsUpdate = true;
    points.geometry.attributes.color!.needsUpdate = true;
    points.geometry.setDrawRange(0, pAlive);
  }
  // ambient motion (Background animated; off with reduced motion)
  if (look?.animated && !reducedMotion) {
    ambT += dt;
    if (dust) { dust.rotation.y += dt * 0.012; dust.position.y = Math.sin(ambT * 0.4) * 0.3; }
    if (holoRing) holoRing.rotation.z += dt * 0.05;
    placeFloaters(ambT);
    if (tips) (tips.material as MeshBasicMaterial).color.copy(tipBase).multiplyScalar(0.8 + 0.2 * Math.sin(ambT * 1.7));
    rim.intensity = RIM * (0.9 + 0.1 * Math.sin(ambT * 0.9));
  }
  // the camera spring
  if (reducedMotion) { cam.x = cam.tx; cam.z = cam.tz; cam.d = cam.dist; }
  else {
    [cam.x, cam.vx] = spring(cam.x, cam.tx, cam.vx, 0.3, dt);
    [cam.z, cam.vz] = spring(cam.z, cam.tz, cam.vz, 0.3, dt);
    [cam.d, cam.vd] = spring(cam.d, cam.dist, cam.vd, 0.3, dt);
  }
  let sx = 0, sy = 0;
  if (shakeAmp > 0.0005) {
    sx = pRng.range(-1, 1) * shakeAmp;
    sy = pRng.range(-1, 1) * shakeAmp;
    shakeAmp *= Math.exp(-6 * dt);
  }
  const elev = 0.76;
  camera.position.set(cam.x + sx, cam.d * Math.sin(elev), cam.z + cam.d * Math.cos(elev) * 0.55 + sy);
  camera.lookAt(cam.x, 0, cam.z);
  refreshLabels();
}
