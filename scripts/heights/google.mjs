/**
 * Build-time heights from Google Photorealistic 3D Tiles, the finest geometry Google serves at a point.
 * Node only. The key travels in a request header, never in a URL, a log line or an output file,
 * and nothing Google sends is written to disk: only the derived height leaves this module.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ecefToGeodetic, geodeticToEcef } from './geodesy.mjs';

export const GOOGLE_3D_TILES_ROOT = 'https://tile.googleapis.com/v1/3dtiles/root.json';
/** Coarser than this, a Google sample is "coarse" and the caller falls back. Leaves over cities are ~1 m or finer. */
export const DEFAULT_MAX_GEOMETRIC_ERROR_METERS = 4;
const SEGMENT_BOTTOM_METERS = -500;
const SEGMENT_TOP_METERS = 9000;
const BOX_TOLERANCE_METERS = 1;
const MAX_DEPTH = 64;
const MAX_REQUESTS_PER_POINT = 400;

/** A failure that says Google can't serve this point; the caller records it and may fall back. */
export class GoogleUnavailableError extends Error {
  constructor(kind, message) { super(message); this.name = 'GoogleUnavailableError'; this.kind = kind; }
}

/** A Google URL safe for messages: no query (key, session), and the long file id shortened. */
export function redactGoogleUrl(href) {
  try {
    const { pathname } = new URL(href);
    const parts = pathname.split('/');
    const last = parts.pop() ?? '';
    return `${parts.slice(0, 4).join('/')}/…/${last.length > 16 ? `…${last.slice(-16)}` : last}`;
  } catch { return '(unparseable Google URL)'; }
}

// Column-major 4x4 matrices, as glTF and 3D Tiles store them.
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** 3D Tiles 1.0: glTF content is y-up; (x, y, z) in glTF is (x, -z, y) in the tileset. */
const Y_UP_TO_Z_UP = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
function multiply(a, b) {
  const out = new Array(16);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[column * 4 + k];
    out[column * 4 + row] = sum;
  }
  return out;
}
function nodeMatrix(node) {
  if (node.matrix) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Whether the segment p0→p1 passes through a 3D Tiles bounding volume (box or sphere), within a metre. */
export function segmentIntersectsVolume(volume, p0, p1) {
  if (volume?.box) {
    const box = volume.box;
    const center = box.slice(0, 3);
    let t0 = 0, t1 = 1;
    for (let axis = 0; axis < 3; axis++) {
      const half = box.slice(3 + axis * 3, 6 + axis * 3);
      const length = Math.hypot(...half);
      const extent = length + BOX_TOLERANCE_METERS;
      const unit = length > 0 ? half.map(value => value / length) : null;
      if (!unit) continue; // A flat box: the other two axes and the tolerance decide.
      const start = dot(sub(p0, center), unit);
      const delta = dot(sub(p1, p0), unit);
      if (Math.abs(delta) < 1e-12) { if (Math.abs(start) > extent) return false; continue; }
      let a = (-extent - start) / delta, b = (extent - start) / delta;
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      if (t0 > t1) return false;
    }
    return true;
  }
  if (volume?.sphere) {
    const [cx, cy, cz, radius] = volume.sphere;
    const d = sub(p1, p0), m = sub(p0, [cx, cy, cz]);
    const t = Math.min(1, Math.max(0, -dot(m, d) / dot(d, d)));
    const closest = [m[0] + d[0] * t, m[1] + d[1] * t, m[2] + d[2] * t];
    return Math.hypot(...closest) <= radius + BOX_TOLERANCE_METERS;
  }
  throw new GoogleUnavailableError('format', `Unsupported 3D Tiles bounding volume ${Object.keys(volume ?? {}).join(', ') || '(none)'}.`);
}

/** Splits a binary glTF into its JSON and its binary chunk. */
export function parseGlb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2) throw new GoogleUnavailableError('format', 'Tile content is not binary glTF 2.0.');
  let offset = 12, json = null, bin = null;
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (type === 0x004e4942) bin = chunk;
    offset += 8 + length;
  }
  if (!json) throw new GoogleUnavailableError('format', 'Binary glTF has no JSON chunk.');
  return { json, bin };
}

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const TYPED = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NORMALIZE = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };
function readAccessor(gltf, bin, index) {
  const accessor = gltf.accessors[index];
  const view = gltf.bufferViews[accessor.bufferView];
  const Type = TYPED[accessor.componentType];
  const size = COMPONENTS[accessor.type];
  if (!Type || !size || !bin) throw new GoogleUnavailableError('format', 'Unsupported glTF accessor.');
  const stride = view.byteStride || size * Type.BYTES_PER_ELEMENT;
  const base = bin.byteOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const out = new Float64Array(accessor.count * size);
  const data = new DataView(bin.buffer);
  const getter = { 5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32' }[accessor.componentType];
  const scale = accessor.normalized ? NORMALIZE[accessor.componentType] : 1;
  for (let i = 0; i < accessor.count; i++) for (let c = 0; c < size; c++) {
    const value = data[getter](base + i * stride + c * Type.BYTES_PER_ELEMENT, true);
    out[i * size + c] = accessor.normalized ? Math.max(value / scale, -1) : value;
  }
  return out;
}

let dracoModule = null;
/** Babylon's own Draco decoder (a peer dependency of this package), loaded once for Node. */
export function loadDraco() {
  dracoModule ??= (async () => {
    const require = createRequire(import.meta.url);
    const directory = path.join(path.dirname(require.resolve('@babylonjs/core')), 'assets', 'Draco');
    const exported = require(path.join(directory, 'draco_decoder_gltf.js'));
    const factory = exported.DracoDecoderModule ?? exported;
    const module = await new Promise((resolve, reject) => {
      // The Emscripten module is thenable; unwrap it without awaiting it directly.
      factory({ wasmBinary: readFileSync(path.join(directory, 'draco_decoder_gltf.wasm')), onRuntimeInitialized() { resolve(this); }, onAbort: reject });
    });
    return module;
  })();
  return dracoModule;
}

function decodeDraco(draco, bytes, positionId) {
  const decoder = new draco.Decoder(), buffer = new draco.DecoderBuffer(), mesh = new draco.Mesh();
  try {
    buffer.Init(bytes, bytes.byteLength);
    const status = decoder.DecodeBufferToMesh(buffer, mesh);
    if (!status.ok() || !mesh.ptr) throw new GoogleUnavailableError('format', `Draco decode failed: ${status.error_msg()}`);
    const faces = mesh.num_faces();
    const indexBytes = faces * 3 * 4;
    const indexPtr = draco._malloc(indexBytes);
    let indices;
    try { decoder.GetTrianglesUInt32Array(mesh, indexBytes, indexPtr); indices = new Uint32Array(draco.HEAPU32.buffer, indexPtr, faces * 3).slice(); }
    finally { draco._free(indexPtr); }
    const attribute = decoder.GetAttributeByUniqueId(mesh, positionId);
    const points = mesh.num_points();
    const components = attribute.num_components();
    const valueBytes = points * components * 4;
    const valuePtr = draco._malloc(valueBytes);
    let values;
    try { decoder.GetAttributeDataArrayForAllPoints(mesh, attribute, draco.DT_FLOAT32, valueBytes, valuePtr); values = new Float64Array(new Float32Array(draco.HEAPF32.buffer, valuePtr, points * components)); }
    finally { draco._free(valuePtr); }
    if (components !== 3) throw new GoogleUnavailableError('format', 'Draco positions are not three-component.');
    return { positions: values, indices };
  } finally { draco.destroy(mesh); draco.destroy(buffer); draco.destroy(decoder); }
}

/** Every triangle of a tile's glTF, in earth-centred, earth-fixed metres. */
export async function trianglesOfGlb(bytes, tileTransform = IDENTITY) {
  const { json: gltf, bin } = parseGlb(bytes);
  const root = multiply(tileTransform, Y_UP_TO_Z_UP);
  const meshes = [];
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  const visit = (index, parent) => {
    const node = gltf.nodes[index];
    const matrix = multiply(parent, nodeMatrix(node));
    if (node.mesh !== undefined) meshes.push({ mesh: gltf.meshes[node.mesh], matrix });
    for (const child of node.children ?? []) visit(child, matrix);
  };
  for (const index of scene?.nodes ?? []) visit(index, root);
  const triangles = [];
  for (const { mesh, matrix } of meshes) for (const primitive of mesh.primitives) {
    if ((primitive.mode ?? 4) !== 4) continue;
    let positions, indices;
    const compressed = primitive.extensions?.KHR_draco_mesh_compression;
    if (compressed) {
      const view = gltf.bufferViews[compressed.bufferView];
      const draco = await loadDraco();
      ({ positions, indices } = decodeDraco(draco, bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength), compressed.attributes.POSITION));
      const accessor = gltf.accessors[primitive.attributes.POSITION];
      if (accessor?.normalized) { const scale = NORMALIZE[accessor.componentType]; positions = positions.map(value => Math.max(value / scale, -1)); }
    } else {
      positions = readAccessor(gltf, bin, primitive.attributes.POSITION);
      indices = primitive.indices === undefined ? Uint32Array.from({ length: positions.length / 3 }, (_, i) => i) : readAccessor(gltf, bin, primitive.indices);
    }
    const world = new Float64Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      const [x, y, z] = [positions[i], positions[i + 1], positions[i + 2]];
      world[i] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
      world[i + 1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
      world[i + 2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    }
    triangles.push({ positions: world, indices });
  }
  return { triangles, copyright: typeof gltf.asset?.copyright === 'string' ? gltf.asset.copyright : null };
}

/** The first triangle a ray from `origin` along unit `direction` meets within `maxDistance`, or null. */
export function firstHit(triangles, origin, direction, maxDistance) {
  let best = null;
  for (const { positions, indices } of triangles) {
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3;
      const e1 = [positions[b] - positions[a], positions[b + 1] - positions[a + 1], positions[b + 2] - positions[a + 2]];
      const e2 = [positions[c] - positions[a], positions[c + 1] - positions[a + 1], positions[c + 2] - positions[a + 2]];
      const p = [direction[1] * e2[2] - direction[2] * e2[1], direction[2] * e2[0] - direction[0] * e2[2], direction[0] * e2[1] - direction[1] * e2[0]];
      const det = dot(e1, p);
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      const s = [origin[0] - positions[a], origin[1] - positions[a + 1], origin[2] - positions[a + 2]];
      const u = dot(s, p) * inv;
      if (u < 0 || u > 1) continue;
      const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
      const v = dot(direction, q) * inv;
      if (v < 0 || u + v > 1) continue;
      const t = dot(e2, q) * inv;
      if (t >= 0 && t <= maxDistance && (!best || t < best)) best = t;
    }
  }
  return best;
}

function withSession(href, parent) {
  const url = new URL(href, parent);
  const session = new URL(parent).searchParams.get('session');
  if (session && !url.searchParams.has('session')) url.searchParams.set('session', session);
  return url.href;
}

/**
 * A Google 3D Tiles client for one preparation run: one key, one session, shared JSON and tile
 * caches in memory only, and a bound on concurrent requests.
 */
export function createGoogleTilesClient({ apiKey, fetcher = fetch, concurrency = 6, timeoutMs = 30000, retries = 3, rootUrl = GOOGLE_3D_TILES_ROOT } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new GoogleUnavailableError('no-key', 'No FOSS_EARTH_GOOGLE_KEY was found.');
  let active = 0;
  const waiting = [];
  const json = new Map(), tiles = new Map();
  const cacheKey = href => { const url = new URL(href); url.searchParams.delete('session'); url.searchParams.delete('key'); return url.href; };
  async function request(href, counter) {
    if (counter && ++counter.count > MAX_REQUESTS_PER_POINT) throw new GoogleUnavailableError('budget', `More than ${MAX_REQUESTS_PER_POINT} Google requests for one point.`);
    while (active >= concurrency) await new Promise(resolve => waiting.push(resolve));
    active++;
    try {
      let last;
      for (let attempt = 0; attempt < retries; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
        let response;
        try { response = await fetcher(href, { headers: { 'X-Goog-Api-Key': apiKey }, signal: AbortSignal.timeout(timeoutMs) }); }
        catch (error) { last = new GoogleUnavailableError('network', `Google request failed (${error?.name ?? 'error'}) for ${redactGoogleUrl(href)}.`); continue; }
        if (response.ok) return new Uint8Array(await response.arrayBuffer());
        last = new GoogleUnavailableError(response.status === 401 || response.status === 403 ? 'auth' : 'http', `Google returned HTTP ${response.status} for ${redactGoogleUrl(href)}.`);
        if (response.status !== 429 && response.status < 500) break;
      }
      throw last;
    } finally { active--; waiting.shift()?.(); }
  }
  const once = (cache, href, load) => {
    const key = cacheKey(href);
    if (!cache.has(key)) cache.set(key, load().catch(error => { cache.delete(key); throw error; }));
    return cache.get(key);
  };
  return {
    rootUrl,
    tileset: (href, counter) => once(json, href, async () => JSON.parse(new TextDecoder().decode(await request(href, counter)))),
    triangles: (href, transform, counter) => once(tiles, href, async () => trianglesOfGlb(await request(href, counter), transform)),
  };
}

/** Every tile with glTF content whose volume the vertical line crosses, finest first. */
async function candidatesAt(client, p0, p1, counter) {
  const found = [];
  async function visit(tile, base, parentTransform, depth) {
    if (depth > MAX_DEPTH) throw new GoogleUnavailableError('format', 'Google tileset is deeper than expected.');
    if (!segmentIntersectsVolume(tile.boundingVolume, p0, p1)) return;
    const transform = tile.transform ? multiply(parentTransform, tile.transform) : parentTransform;
    const uri = tile.content?.uri ?? tile.content?.url;
    const href = uri ? withSession(uri, base) : null;
    if (href && new URL(href).pathname.endsWith('.json')) {
      const external = await client.tileset(href, counter);
      await visit(external.root, href, transform, depth + 1);
    } else if (href) {
      found.push({ href, transform, geometricErrorMeters: tile.geometricError, depth });
    }
    await Promise.all((tile.children ?? []).map(child => visit(child, base, transform, depth + 1)));
  }
  const root = await client.tileset(client.rootUrl, counter);
  await visit(root.root, client.rootUrl, IDENTITY, 0);
  return found.sort((a, b) => a.geometricErrorMeters - b.geometricErrorMeters || b.depth - a.depth);
}

/**
 * The top of Google's finest geometry on the vertical through one point: the highest surface in the
 * finest tiles that have any surface there. Throws GoogleUnavailableError when Google has no
 * geometry there, or only geometry coarser than `maxGeometricErrorMeters`.
 */
export async function sampleGoogleHeight(client, point, { maxGeometricErrorMeters = DEFAULT_MAX_GEOMETRIC_ERROR_METERS } = {}) {
  const p0 = geodeticToEcef(point.longitudeDeg, point.latitudeDeg, SEGMENT_BOTTOM_METERS);
  const p1 = geodeticToEcef(point.longitudeDeg, point.latitudeDeg, SEGMENT_TOP_METERS);
  const length = Math.hypot(...sub(p0, p1));
  const direction = sub(p0, p1).map(value => value / length);
  const counter = { count: 0 };
  const candidates = await candidatesAt(client, p0, p1, counter);
  const fine = candidates.filter(candidate => candidate.geometricErrorMeters <= maxGeometricErrorMeters);
  for (let i = 0; i < fine.length;) {
    const level = fine.filter(candidate => candidate.geometricErrorMeters === fine[i].geometricErrorMeters);
    i += level.length;
    let best = null;
    for (const candidate of level) {
      const { triangles, copyright } = await client.triangles(candidate.href, candidate.transform, counter);
      const distance = firstHit(triangles, p1, direction, length);
      if (distance !== null && (!best || distance < best.distance)) best = { distance, candidate, copyright };
    }
    if (!best) continue;
    const hit = p1.map((value, axis) => value + direction[axis] * best.distance);
    const geodetic = ecefToGeodetic(hit);
    return {
      heightMeters: geodetic.heightMeters,
      geometricErrorMeters: best.candidate.geometricErrorMeters,
      tileDepth: best.candidate.depth,
      copyright: best.copyright,
      requests: counter.count,
    };
  }
  const coarsest = candidates.length ? Math.min(...candidates.map(candidate => candidate.geometricErrorMeters)) : null;
  if (coarsest !== null && coarsest > maxGeometricErrorMeters) {
    throw new GoogleUnavailableError('coarse', `Google's finest geometry here has a ${round(coarsest)} m geometric error, coarser than the ${maxGeometricErrorMeters} m limit.`);
  }
  throw new GoogleUnavailableError('no-coverage', 'Google has no fine geometry on the vertical through this point.');
}
const round = value => Math.round(value * 1000) / 1000;
