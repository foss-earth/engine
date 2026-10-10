/** Run only in a coordinator-granted slot. Archives must already be packed and exactly pinned. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
const owner = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(await realpath(owner),owner,'Owner checkout cannot redirect.');
const given = process.argv[2];
assert(given, 'Usage: node scripts/check-installed-consumer.mjs <archive-manifest.json>');
const manifestPath = resolve(given);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
assert.equal(manifest.schemaVersion, 1, 'Archive closure schemaVersion must be 1.');
assert(Array.isArray(manifest.archives), 'Manifest archives must be {name,version,path,sha256,bytes}[] including engine and exact optional peers/tooling.');
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const build = join(owner,'build'), parent = join(build,'consumer'), cache = join(build,'npm-cache');
for (const directory of [build,parent,cache]) { await mkdir(directory,{recursive:true});assert.equal(await realpath(directory),directory,'Owner output/cache must not redirect.'); }
const output = join(parent,stamp);await mkdir(output);
const workspace = join(output,'isolated'), temp = join(output,'tmp');
await mkdir(workspace);await mkdir(temp);
await writeFile(join(output,'input-closure.json'),JSON.stringify(manifest,null,2)+'\n');
const emptyNpmConfig = join(output,'empty-user.npmrc'),emptyGlobalConfig = join(output,'empty-global.npmrc');await writeFile(emptyNpmConfig,'');await writeFile(emptyGlobalConfig,'');
const dependencies = Object.create(null);
const pins = [];
for (const artifact of manifest.archives) {
  assert.match(artifact.name ?? '', /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/);
  assert.match(artifact.version ?? '', /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/);
  assert(Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0, 'Every archive requires exact positive byte size.');
  assert.equal(typeof artifact.path,'string');
  assert(/^[a-f0-9]{64}$/.test(artifact.sha256), 'Every archive requires an exact SHA256.');
  const declaredPath = isAbsolute(artifact.path) ? resolve(artifact.path) : resolve(dirname(manifestPath), artifact.path);
  const path = await realpath(declaredPath);assert.equal(path,declaredPath,'Declared archive location must be canonical, not a symlink.');
  assert(path.endsWith('.tgz'), 'Only packed archives are accepted, never source directories or linked checkouts.');
  assert((await stat(path)).isFile(),'Archive must be a regular file.');
  assert.equal((await stat(path)).size,artifact.bytes,'Archive byte size mismatch before reading.');
  const data = await readFile(path);assert.equal(data.length,artifact.bytes,'Archive byte size changed while reading.');
  const digest = createHash('sha256').update(data).digest('hex');
  const integrity = 'sha512-'+createHash('sha512').update(data).digest('base64');
  assert.equal(digest, artifact.sha256, `Archive digest mismatch for ${artifact.name}.`);
  assert(!dependencies[artifact.name], `Duplicate artifact ${artifact.name}.`);
  dependencies[artifact.name] = `file:${path}`;
  pins.push({ name: artifact.name, version: artifact.version, path, sha256: digest, bytes: data.length, integrity });
}
const sourcePackage=JSON.parse(await readFile(join(owner,'package.json'),'utf8'));
const requiredNames=['@foss-earth/engine', '@foss-earth/ui', '@foss-earth/renderer', '@babylonjs/core', '@felipegalind0/gamepad-tools', '3d-tiles-renderer', 'react', 'react-dom', 'typescript', '@types/node', '@types/react', '@types/react-dom', '@foss-earth/images', 'jsdom', '@foss-earth/sky'];
for (const name of requiredNames) {
  assert(dependencies[name], `Missing exact installed-consumer artifact: ${name}.`);
  const expected=name===sourcePackage.name?sourcePackage.version:sourcePackage.dependencies?.[name]??sourcePackage.peerDependencies?.[name]??sourcePackage.devDependencies?.[name];
  assert.match(expected??'',/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/,'Source prerequisite must have an exact version: '+name);
  assert.equal(pins.find(pin=>pin.name===name).version,expected,'Current source prerequisite version: '+name);
}
await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'engine-isolated-consumer', private: true, type: 'module', dependencies }, null, 2));
const commandRecords = [];
async function run(command, args, label, extraEnv = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^npm_config_/i.test(key) || /^npm_package_/i.test(key) || /^(NODE_PATH|NODE_OPTIONS|CONSUMER_FORBID_PEERS|ENGINE_CONSUMER_WORKSPACE|npm_execpath|npm_node_execpath|npm_lifecycle_event|npm_lifecycle_script|INIT_CWD)$/.test(key)) delete env[key];
  Object.assign(env,{TMPDIR:temp,TMP:temp,TEMP:temp},extraEnv);
  const child = spawn(command, args, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const exitCode = await new Promise((resolveExit, reject) => { child.on('error', reject); child.on('close', resolveExit); });
  const log = join(output, `${label}.log`);
  await writeFile(log, `${stdout}${stderr}`);
  commandRecords.push({ command, args, label, exitCode, log });
  if (exitCode !== 0) throw new Error(`${label} failed (${exitCode}); retained ${log}.`);
}
await run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', cache, '--userconfig', emptyNpmConfig, '--globalconfig', emptyGlobalConfig], 'install');
const workspaceReal = await realpath(workspace), installedNames = new Set(), supplied = new Map(pins.map(pin=>[pin.name,pin]));
const lock = JSON.parse(await readFile(join(workspace,'package-lock.json'),'utf8'));
assert(lock.packages && typeof lock.packages === 'object','Installed lock closure is required.');
assert.deepEqual(lock.packages['']?.dependencies,{...dependencies},'Installed root dependency locations must match the full supplied archive closure.');
for (const [location,record] of Object.entries(lock.packages)) {
  if (!location) continue;
  assert(location.startsWith('node_modules/')&&!location.slice(13).includes('/node_modules/'),'Nested lock locations are unqualified.');
  const name = location.slice('node_modules/'.length),pin = supplied.get(name);assert(pin,'Unpinned lock dependency: '+name);
  assert(!record.link,'Linked lock location is unqualified: '+name);assert.equal(record.version,pin.version);assert.equal(record.integrity,pin.integrity,'Actual archive integrity: '+name);
  assert.equal(typeof record.resolved,'string');assert(record.resolved.startsWith('file:'),'Registry/source resolution is unqualified: '+name);
  const resolvedPath=record.resolved.startsWith('file://')?fileURLToPath(record.resolved):resolve(workspace,record.resolved.slice(5));
  assert.equal(await realpath(resolvedPath),pin.path,'Actual archive location: '+name);
}
for(const pin of pins)assert(lock.packages['node_modules/'+pin.name],'Declared exact archive absent from actual lock: '+pin.name);
async function inventory(directory,scope='') {
  for (const item of await readdir(directory,{withFileTypes:true})) {
    if (item.name === '.bin' || item.name === '.package-lock.json') continue;
    assert(item.isDirectory(),'Installed package/scope location must be an actual directory, never a link.');
    const candidate = join(directory,item.name);assert((await realpath(candidate)).startsWith(workspaceReal+sep),'Installed path escaped workspace.');
    if (item.name.startsWith('@')&&!scope) { await inventory(candidate,item.name+'/');continue; }
    assert(!item.name.startsWith('.'),'Unexpected hidden installed location.');
    const name=scope+item.name,pin=supplied.get(name);assert(pin,'Unpinned installed transitive location: '+name);assert(!installedNames.has(name),'Duplicate installed package location: '+name);
    const pkg=JSON.parse(await readFile(join(candidate,'package.json'),'utf8'));assert.equal(pkg.name,name);assert.equal(pkg.version,pin.version);
    assert(![pkg.bundleDependencies,pkg.bundledDependencies].some(value=>value===true||Array.isArray(value)&&value.length),'Bundled closure is unqualified: '+name);
    try { await stat(join(candidate,'node_modules'));throw new Error('Nested package locations are unqualified: '+name); } catch(error) { if(error.code!=='ENOENT')throw error; }
    installedNames.add(name);
  }
}
await inventory(join(workspace,'node_modules'));
for(const pin of pins)assert(installedNames.has(pin.name),'Declared exact archive not installed: '+pin.name);
const guardSource = `import { realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
const base = await realpath(process.env.ENGINE_CONSUMER_WORKSPACE);
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url.startsWith('node:')) return result;
  if (!result.url.startsWith('file:')) throw new Error('Non-file consumer module: ' + result.url);
  const path = await realpath(fileURLToPath(result.url));
  if (path !== base && !path.startsWith(base + '/')) throw new Error('Consumer module escaped isolated workspace: ' + path);
  if(process.env.CONSUMER_FORBID_PEERS==='1'&&/[/]node_modules[/](?:@foss-earth[/](?:ui|renderer|sky)|@babylonjs[/]core|react(?:-dom)?)(?:[/]|$)/.test(path))throw new Error('PURE_IMPORTED_PEER');
  return result;
}`;
await writeFile(join(workspace, 'guard.mjs'), guardSource);
await writeFile(join(workspace, 'guard.cjs'), `const Module = require('node:module');
const fs = require('node:fs');
const base = fs.realpathSync(process.env.ENGINE_CONSUMER_WORKSPACE);
const original = Module._resolveFilename;
Module._resolveFilename = function (...args) {
  const resolved = original.apply(this, args);
  if (Module.isBuiltin(resolved)) return resolved;
  const path = fs.realpathSync(resolved);
  if (path !== base && !path.startsWith(base + '/')) throw new Error('Consumer CommonJS module escaped isolated workspace: ' + path);
  if(process.env.CONSUMER_FORBID_PEERS==='1'&&/[/]node_modules[/](?:@foss-earth[/](?:ui|renderer|sky)|@babylonjs[/]core|react(?:-dom)?)(?:[/]|$)/.test(path))throw new Error('PURE_IMPORTED_PEER');
  return resolved;
};`);
await writeFile(join(workspace, 'core.ts'), await readFile(join(owner, 'fixtures', 'consumer.ts')));
await writeFile(join(workspace, 'public-entries.ts'), await readFile(join(owner, 'fixtures', 'publicEntries.ts')));
await writeFile(join(workspace, 'surface-readiness.ts'), await readFile(join(owner, 'fixtures', 'surface-readiness', 'public-consumer.ts')));
await writeFile(join(workspace, 'surface-readiness.mjs'), await readFile(join(owner, 'fixtures', 'surface-readiness', 'public-consumer.mjs')));
await writeFile(join(workspace, 'visualization-consumer.mjs'), (await readFile(join(owner, 'fixtures', 'visualization-consumer.mjs'), 'utf8')).replace('__OUTSIDE_IMPORT__', pathToFileURL(join(owner,'package.json')).href));
await writeFile(join(workspace, 'globe-consumer.mjs'), await readFile(join(owner, 'fixtures', 'globe-consumer.mjs')));
await writeFile(join(workspace,'location-consumer.mjs'),await readFile(join(owner,'fixtures','location-consumer.mjs')));
await writeFile(join(workspace,'map-cache-consumer.mjs'),await readFile(join(owner,'fixtures','map-cache-consumer.mjs')));
await writeFile(join(workspace,'async-raster-consumer.mjs'),await readFile(join(owner,'fixtures','async-raster-consumer.mjs')));
await writeFile(join(workspace,'bounded-atlas-consumer.mjs'),await readFile(join(owner,'fixtures','bounded-atlas-consumer.mjs')));
await writeFile(join(workspace,'owned-atlas-consumer.mjs'),await readFile(join(owner,'fixtures','owned-atlas-consumer.mjs')));
await writeFile(join(workspace,'browser-worker-consumer.mjs'),await readFile(join(owner,'fixtures','browser-worker-consumer.mjs')));
await writeFile(join(workspace, 'consumer.mjs'), `import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import * as core from '@foss-earth/engine';
import * as browser from '@foss-earth/engine/browser';
import * as babylon from '@foss-earth/engine/babylon';
import * as settings from '@foss-earth/engine/settings';
import * as panels from '@foss-earth/engine/panels';
import * as gamepad from '@foss-earth/engine/gamepad';
import * as imagery from '@foss-earth/engine/imagery';
import { LocationPanel } from '@foss-earth/engine/react';
assert.equal(typeof globalThis.document, 'undefined');
assert.equal(typeof core.createNavigationOwner, 'function');
assert.equal(typeof browser.createInputController, 'function');
assert.equal(typeof babylon.createNavigationCameraAdapter, 'function');
assert.equal(typeof babylon.createRasterTilesRuntime, 'function');
assert.equal(typeof babylon.createGoogleTilesRuntime, 'function');
assert.equal(typeof panels.createMapSourcePanel, 'function');
assert.equal(typeof gamepad.createGlobeGamepadAdapter, 'function');
assert.equal(typeof imagery.createImageryResidency, 'function');
assert(settings.CONTROLS_PARAMETERS.some(spec => spec.id === 'camera.inertiaDecay'));
assert(settings.MAP_TERRAIN_SELECTION_PARAMETERS.some(spec => spec.id === 'map.terrain.meshRebuildTimePerFrame'));
const point = core.geodeticToEcef(0, 0, 250);
assert.equal(core.ecefToGeodetic(point.x, point.y, point.z).altMeters, 250);
const draft = core.createLocationDraftStore({ storage: null, key: core.LOCATION_PLACE_DRAFT_KEY });
const html = renderToString(createElement(LocationPanel, { initialLocation: { latDeg: 0, lonDeg: 0 }, onApply() {},
  observeLocation: () => () => {}, searchAttribution: 'Host', createAbortController: () => new AbortController(), draft }));
assert(html.includes('Latitude') || html.includes('Lat'));
for (const entry of ['@foss-earth/engine/input-mode.css', '@foss-earth/engine/map.css', '@foss-earth/engine/visualization-tuners.css']) assert((await readFile(new URL(import.meta.resolve(entry)), 'utf8')).length > 0);
console.log('Isolated public entries, core math, exact optional peers, React SSR and exported CSS passed; no device initialized.');`);
await writeFile(join(workspace, 'declarations.mjs'), `import ts from 'typescript';
import { realpathSync } from 'node:fs';
const base = realpathSync(process.env.ENGINE_CONSUMER_WORKSPACE);
for (const [filename, libs] of [['core.ts', ['lib.es2022.d.ts']], ['public-entries.ts', ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts']], ['surface-readiness.ts', ['lib.es2022.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts']]]) {
  const program = ts.createProgram([filename], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noEmit: true, skipLibCheck: false,
    jsx: ts.JsxEmit.ReactJSX, types: [], lib: libs });
  for (const source of program.getSourceFiles()) {
    const path = realpathSync(source.fileName);
    if (path !== base && !path.startsWith(base + '/')) throw new Error('Declaration resolution escaped isolated workspace: ' + path);
  }
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) { console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCurrentDirectory: () => base,
    getCanonicalFileName: name => name, getNewLine: () => '\\n' })); process.exitCode = 1; }
}
if (!process.exitCode) console.log('Isolated pure core and optional public declarations passed.');`);
const environment = { ENGINE_CONSUMER_WORKSPACE: workspace };
const guarded = ['--require', './guard.cjs', '--loader', './guard.mjs'];
await writeFile(join(workspace,'pure.mjs'),`import assert from 'node:assert/strict';for(const name of ['document','window','navigator','fetch','requestAnimationFrame'])Object.defineProperty(globalThis,name,{configurable:true,get(){throw new Error('PURE_HOST_GLOBAL:'+name);}});const core=await import('@foss-earth/engine');const lookup=await import('@foss-earth/engine/location-provider');assert.equal(typeof core.createNavigationOwner,'function');assert.equal(typeof lookup.createLocationSearch,'function');`);
await run(process.execPath,[...guarded,'./pure.mjs'],'pure',{...environment,CONSUMER_FORBID_PEERS:'1'});
await run(process.execPath,[...guarded,'./surface-readiness.mjs'],'surface-readiness',{...environment,CONSUMER_FORBID_PEERS:'1'});
await writeFile(join(workspace,'peer-negative.mjs'),`import assert from 'node:assert/strict';await assert.rejects(import('@foss-earth/ui/settings'),/PURE_IMPORTED_PEER/);`);
await run(process.execPath,[...guarded,'./peer-negative.mjs'],'pure-peer-negative',{...environment,CONSUMER_FORBID_PEERS:'1'});
await run(process.execPath, [...guarded, './consumer.mjs'], 'runtime', environment);
await run(process.execPath, [...guarded, './visualization-consumer.mjs'], 'visualization', environment);
await run(process.execPath, [...guarded, './globe-consumer.mjs'], 'globe', environment);
await run(process.execPath, [...guarded, './declarations.mjs'], 'declarations', environment);
await run(process.execPath,[...guarded,'./location-consumer.mjs'],'location',environment);
await run(process.execPath,[...guarded,'./map-cache-consumer.mjs'],'map-cache',environment);
await run(process.execPath,[...guarded,'./async-raster-consumer.mjs'],'async-raster',environment);
await run(process.execPath,[...guarded,'./bounded-atlas-consumer.mjs'],'bounded-atlas',environment);
await run(process.execPath,[...guarded,'./owned-atlas-consumer.mjs'],'owned-atlas',environment);
await run(process.execPath,[...guarded,'./browser-worker-consumer.mjs'],'browser-worker',environment);
await writeFile(join(output,'outside.mjs'),'export const outside=true;\n');
await writeFile(join(workspace,'negative.mjs'),`import assert from 'node:assert/strict';await assert.rejects(import(${JSON.stringify(pathToFileURL(join(output,'outside.mjs')).href)}),/escaped isolated workspace/);`);
await run(process.execPath,[...guarded,'./negative.mjs'],'runtime-negative',environment);
await writeFile(join(output,'outside.d.ts'),'export interface Outside { outside: true }\n');
await writeFile(join(workspace,'declaration-negative.ts'),`import type { Outside } from '../outside.js';export type Negative = Outside;\n`);
await writeFile(join(workspace,'declaration-negative.mjs'),`import assert from 'node:assert/strict';import ts from 'typescript';import {realpathSync} from 'node:fs';import path from 'node:path';const root=realpathSync(process.env.ENGINE_CONSUMER_WORKSPACE)+path.sep;const program=ts.createProgram(['declaration-negative.ts'],{noEmit:true,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext});assert.throws(()=>{for(const source of program.getSourceFiles())if(!realpathSync(source.fileName).startsWith(root))throw new Error('DECLARATION_OUTSIDE_WORKSPACE');},/DECLARATION_OUTSIDE_WORKSPACE/);`);
await run(process.execPath,[...guarded,'./declaration-negative.mjs'],'declaration-negative',environment);
const ownerPackage=JSON.parse(await readFile(join(workspace,'node_modules/@foss-earth/engine/package.json'),'utf8'));
async function exportTargets(value) {if(typeof value==='string'){assert(value.startsWith('./'));const filename=await realpath(join(workspace,'node_modules/@foss-earth/engine',value));assert(filename.startsWith(workspaceReal+sep));assert((await readFile(filename)).length);}else if(value&&typeof value==='object')for(const child of Object.values(value))await exportTargets(child);}
await exportTargets(ownerPackage.exports);
const receipt = { schemaVersion: 1, package: '@foss-earth/engine', workspace, pins, commands: commandRecords,
  closure: {schemaVersion:manifest.schemaVersion,requiredNames,installedNames:[...installedNames].sort(),flatOneVersionOnly:true,bundledDependenciesAllowed:false}, environment:{node:process.version,platform:process.platform,arch:process.arch}, exports:Object.keys(ownerPackage.exports),
  scope: 'Installed artifact public contracts and CPU-only module/React SSR, injected canvas/tuner/bounded-map and borrowed globe runtime lifecycle smoke; no GPU/native/benchmark/browser-device qualification.' };
await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ receipt: join(output, 'receipt.json'), workspace, pins: pins.map(pin => ({ name: pin.name, version: pin.version, sha256: pin.sha256 })) }));
