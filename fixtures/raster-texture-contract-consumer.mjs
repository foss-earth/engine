/** Installed public acquisition/admission contracts. NullEngine and CPU pixels
 * exercise ownership; actual browser/GPU acceptance is recorded separately. */
import assert from 'node:assert/strict';
import { NullEngine, Scene, Texture } from '@babylonjs/core';
import { createSettingsRegistry } from '@foss-earth/ui/settings';
import { RENDERER_PARAMETERS } from '@foss-earth/renderer/settings';
import { createTextureDevicePorts, createTextureTransferTracker } from '@foss-earth/renderer/babylon';
import { createImageSessionBroker } from '@foss-earth/images';
import { createImageFileService } from '@foss-earth/images/browser';
import { createRasterTilesRuntime, createBoundedMapTextureLoader } from '@foss-earth/engine/babylon';
import { RASTER_BASE_MAP_SOURCES } from '@foss-earth/engine/core';
import { CONTROLS_PARAMETERS, MAP_SOURCE_PARAMETERS, MAP_DETAIL_PARAMETERS, MAP_LOADING_PARAMETERS,
  MAP_SELECTION_PARAMETERS, MAP_TERRAIN_SELECTION_PARAMETERS, MAP_AUTO_PARAMETERS } from '@foss-earth/engine/settings';

function host(gpuBytes = 512 * 2**20, maxTextureSize = 8192) {
  const engine = new NullEngine(), scene = new Scene(engine); engine.getCaps().maxTextureSize = 8192;
  const settings = createSettingsRegistry({ storage: null });
  settings.register([...CONTROLS_PARAMETERS, ...MAP_SOURCE_PARAMETERS, ...MAP_DETAIL_PARAMETERS, ...MAP_LOADING_PARAMETERS,
    ...MAP_SELECTION_PARAMETERS, ...MAP_TERRAIN_SELECTION_PARAMETERS, ...MAP_AUTO_PARAMETERS, ...RENDERER_PARAMETERS]);
  const broker = createImageSessionBroker({ requests: 1, decodes: 1, pools: {
    sourceGpu: gpuBytes, decoded: 32 * 2**20, encoded: 1024, uploadOutstanding: 8 * 2**20, overlap: gpuBytes,
  } });
  const grant = (pool, bytes, label, flags = {}) => {
    const result = broker.pools.reserve(pool, bytes, label, flags); return result.ok ? result.reservation : null;
  };
  const tracker = createTextureTransferTracker({ scene, admit: (bytes, label) => grant('uploadOutstanding', bytes, label), requestRender() {} });
  const device = createTextureDevicePorts({ scene, transfer: tracker.transfer, tryAdmit: tracker.tryAdmit });
  let terrainCreated = 0, terrainDisposed = 0, loaderReleased = 0;
  const imageryPorts = { device, capabilities: { backend: 'webgl2', maxTextureSize, explicitGradients: true },
    createAbortController: () => new AbortController(), releaseOwnedLoader() { loaderReleased++; },
    loader: { async load(_url, expected) { return { ...expected, compressedBytes: 1, pages: [[new Uint8Array(4)]] }; } },
    managedAtlas: { generation: () => broker.generation(), reserveGpu: (bytes, label, flags) => grant('sourceGpu', bytes, label, flags),
      reserveTable: (bytes, label) => grant('decoded', bytes, label),
      reserveCopy(bytes, label) { const ticket = grant('decoded', bytes, label); assert(ticket); return ticket; },
      canUpload: (bytes, extra = 0) => broker.pools.fits('uploadOutstanding', bytes) && broker.pools.fits('decoded', bytes + extra),
      subscribeAvailable: listener => broker.pools.subscribeAvailable(listener), capacityKey: () => JSON.stringify(broker.pools.stats()),
    },
  };
  const create = (extra = {}) => createRasterTilesRuntime({ scene, settings, source: RASTER_BASE_MAP_SOURCES[0], imagery: 'atlas',
    nowMs: () => 0, after: () => () => {}, requestRender() {}, meshRebuildCpuMs: () => 2,
    attachTerrainLighting: () => ({}), imageryPorts, log: { warn() {} },
    createTerrainLoader() { terrainCreated++; return { load: () => new Promise(() => {}), loadPatch: () => new Promise(() => {}),
      dispose() { terrainDisposed++; }, setPaused() {}, getMetrics: () => ({ active: 0, queued: 0, decodedBytes: 0 }) }; }, ...extra,
  });
  return { create, imageryPorts, broker, scene, counts: () => ({ terrainCreated, terrainDisposed, loaderReleased }),
    dispose() { tracker.dispose(); broker.dispose(); scene.dispose(); engine.dispose(); } };
}
for (const [gpu, side, support] of [[512 * 2**20, 8192, 'ready'], [0, 8192, 'unavailable'], [512 * 2**20, 128, 'unavailable']]) {
  const f = host(gpu, side); let runtime;
  try {
    runtime = f.create(); runtime.update();
    assert.equal(runtime.getImageryDiagnostics().mode, 'atlas'); assert.equal(runtime.getDetailFeedback().support, support);
    if (support === 'ready') assert(f.broker.pools.stats().sourceGpu.reserved > 0);
    runtime.dispose(); assert.deepEqual(f.broker.pools.live(), []); assert.equal(f.counts().loaderReleased, 1);
  } finally { runtime?.dispose(); f.dispose(); }
}
for (const imagery of [undefined, 'legacy']) {
  const f = host();
  try { assert.throws(() => f.create({ imagery }), /explicit legacy or async texture/); assert.equal(f.counts().terrainCreated, 0); }
  finally { f.dispose(); }
}
{
  const f = host(512 * 2**20, 128);
  try {
    assert.throws(() => f.create({ imageryPorts: { ...f.imageryPorts, managedAtlas: undefined } }), /atlas fallback needs/);
    assert.deepEqual(f.counts(), { terrainCreated: 1, terrainDisposed: 1, loaderReleased: 1 }); assert.deepEqual(f.broker.pools.live(), []);
  } finally { f.dispose(); }
}
{
  const f = host(), png = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,2,0,0,0,1,8,6,0,0,0,0,0,0,0]);
  const files = createImageFileService({ broker: f.broker, limits: () => ({ responseBytes: 1024, timeoutMs: 1000 }), priority: () => 1,
    fetch: async () => new Response(png, { headers: { 'content-type': 'image/png' } }),
    decode: async (_bytes, mime) => { assert.equal(mime, 'image/png'); return { width: 2, height: 1, close() {} }; },
  });
  let transfers = 0;
  const acquire = createBoundedMapTextureLoader({ broker: f.broker, files, maxTextureSide: () => 256, whenReady: async () => {},
    uploader: { async upload(request) {
      const ticket = request.reserveUpload(8, 'CPU fixture');
      try { transfers++; const texture = new Texture(null, f.scene); return { kind: '2d', texture, width: 2, height: 1, levels: 2, gpuBytes: 12, complete: true, dispose() { texture.dispose(); } }; }
      finally { ticket.release(); }
    } },
  });
  try {
    const signal = new AbortController().signal;
    const texture = await acquire({ file: { url: 'https://fixture.invalid/misleading.jpg', width: 2, height: 1 }, declaredBytes: 0, priority: 1, signal });
    texture.dispose(); assert.equal(transfers, 1); assert.deepEqual(f.broker.pools.live(), []);
    await assert.rejects(acquire({ file: { url: 'https://fixture.invalid/explicit', mimeType: 'image/jpeg', width: 2, height: 1 }, declaredBytes: 0, priority: 1, signal }));
    assert.equal(transfers, 1); assert.deepEqual(f.broker.pools.live(), []);
  } finally { f.dispose(); }
}
console.log('Installed raster mode admission, denial/cleanup, and bounded validated-header acquisition passed; CPU native doubles only.');
