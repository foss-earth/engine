import { createMapSourceHud } from "../shell/mapSourceHud";
import { attachRendererActivity } from "../shell/rendererActivity";
import { createBrowserInputSource } from "@felipegalind0/gamepad-tools/browser";
import { BindingRuntime, createProfileStore } from "@felipegalind0/gamepad-tools/core";
import { mountBindingEditor, type BindingEditorHandle } from "@felipegalind0/gamepad-tools/ui";
import "@felipegalind0/gamepad-tools/styles.css";
import { Matrix, Vector3 } from "@babylonjs/core";
import { createBabylonRuntime, type BabylonRuntime } from "../engine/babylon/createBabylonRuntime";
import { createGameLog, type GameLogTone } from "../log/createGameLog";
import { applyRendererChoice } from "../engine/babylon/rendererPreference";
import { RASTER_BASE_MAP_SOURCES, type RasterBaseMapSource } from "../engine/babylon/rasterBaseMaps";
import {
  resolveMapRuntimeConfig,
  setMapSourcePreference,
  setTerrainSourcePreference,
} from "../engine/babylon/resolveMapRuntimeConfig";
import { TERRAIN_SOURCES, type TerrainSource } from "../terrain/terrainTiles";
import { getAppSettings } from "../settings/appSettings";
import { INPUT_SENSITIVITY_IDS, PERFORMANCE_HUD_METRICS } from "../settings/catalogue";
import { createParameterControl, type ParameterControlHandle } from "../shell/settings/controls";
import { createParameterSection, type ParameterSectionHandle } from "../shell/settings/parameterSection";
import { createSavedSettingsSection } from "../shell/settings/savedSettings";
import type {
  GlobeHandle,
  GlobeLayerContext,
  GlobeViewState,
} from "../engine/types";
import { getTheme, setTheme, onThemeChange, toggleTheme } from "../theme/theme";
import { createPoiTracking } from "../layers/poiTracking";
import { createLayerRegistry } from "../layers/layerRegistry";
import { MAX_PITCH_DEG } from "../camera/cameraState";
import { createStatusHud, type StatusHudHandle } from "../hud/statusHud";
import { createNorthButton, type NorthButtonHandle } from "../hud/northButton";
import { createHelpModal, type HelpModalHandle } from "../hud/helpModal";
import { HUD_BUTTON_IDS, hudButtonParameterId, loadHudButtonVisibility, type HudButtonId } from "../hud/hudButtonVisibility";
import type { PanelSection } from "../shell/SectionsPanel";
import type { WindowOverlayHandle } from "../shell/WindowOverlay";
import { createMapSourcePanel } from "../shell/mapSourcePanel";
import { createMapDetailController, type MapDetailController } from "../shell/mapDetailController";
import { connectMapDetailRuntime } from "../shell/connectMapDetailRuntime";
import { createRendererPanel, getRendererLabel } from "../shell/rendererPanel";
import { createOrbitCompass, type OrbitCompassHandle } from "../visualization/orbitCompass";
import { createHemisphereCulling } from "../perf/culling";
import { createPerformanceMetrics, type PerformanceSnapshot } from "../perf/metrics";
import { createAnchorHeightResolver } from "../terrain/anchorHeight";
import { createPoiSpriteSizeTuner } from "../hud/poiSpriteSizeTuner";
import { createCompassScaleTuner } from "../hud/compassScaleTuner";
import { createInputModeHud, type InputModeHudHandle } from "../hud/inputModeHud";
import { loadInputSensitivityPreference } from "../input/inputSettings";
import {
  createGlobeGamepadAdapter,
  createStandardGlobeProfile,
  STANDARD_GLOBE_PROFILE_NAME,
} from "../input/globeNavigation";
import { createHudBar } from "../shell/hudBar";
import type { PoiSpriteSizeParams } from "../hud/poiSpriteSizeTuner";
import type { OrbitCompassScaleParams } from "../visualization/orbitCompass";

export interface GlobeAppHandle extends GlobeHandle {
  runtime: BabylonRuntime;
  inputModeHud: InputModeHudHandle | null;
  /** Shows the host's Controls tab, where the controller bindings live. */
  openControllerBindings(): void;
  /** The globe's input and controller settings, for the host's Controls tab. */
  controlsSections: readonly PanelSection[];
  /** The globe's settings, for the host's Settings tab. */
  settingsSections: readonly PanelSection[];
  /** The basemap and elevation choice, for the host's Map tab. */
  mapTab: HTMLElement;
  /** The GPU renderer choice, for the host's Renderer tab. */
  rendererTab: HTMLElement;
}

export interface GlobeAppOptions {
  googleApiKey?: string | null;
  baseMap?: string | RasterBaseMapSource | null;
  preferGoogleTiles?: boolean;
  getSurfaceHeightMeters?: (latDeg: number, lonDeg: number) => number | null;
  terrainSource?: string | TerrainSource | null;
  /** @deprecated Ignored: terrain detail is `map.detail.terrain.*`, adjusted by `map.auto.*`. */
  rasterQuality?: unknown;
  onPoiSpriteSizeChange?: (params: PoiSpriteSizeParams) => void;
  onCompassScaleChange?: (params: OrbitCompassScaleParams) => void;
  /** A detail controller the host configured; the app creates one otherwise. */
  mapDetail?: MapDetailController;
  /**
   * The host's tab overlay, filled once it mounts. The toolbar buttons toggle
   * its tabs: \u2699 Settings, input method Controls, the position Location,
   * and the renderer and map chips their own tabs.
   */
  overlayApiRef?: { current: WindowOverlayHandle | null };
}

/** Pixel offset from the projected sphere centre to the top-right exit button. */
const POI_EXIT_BTN_OFFSET_PX = 22;
const BUILD_TIME = __BUILD_TIME__;
const SOURCE_VERSION = __SOURCE_VERSION__;
const REPOSITORY_SLUG = __REPOSITORY_SLUG__;

type PerformanceMetricId = "fps" | "frame" | "p95" | "activeMeshes" | "drawCalls" | "tiles" | "culling" | "memory";

/** How each toolbar reading is drawn; whether it is shown is `interface.performanceHud.<id>`. */
interface PerformanceMetricDefinition {
  id: PerformanceMetricId;
  settingsLabel: string;
  tooltip: string;
  format(snapshot: PerformanceSnapshot): string | null;
}

const PERFORMANCE_METRIC_DEFINITIONS: readonly PerformanceMetricDefinition[] = [
  {
    id: "fps",
    settingsLabel: "FPS",
    tooltip: "Frames per second rendered by the map.",
    format: (snapshot) => `${Math.round(snapshot.fps)}fps`,
  },
  {
    id: "frame",
    settingsLabel: "Frame time",
    tooltip: "Average time spent rendering each frame.",
    format: (snapshot) => `${snapshot.frameMs.toFixed(1)}ms`,
  },
  {
    id: "p95",
    settingsLabel: "P95 frame time",
    tooltip: "95th percentile frame time over the recent sample window.",
    format: (snapshot) => `p95 ${snapshot.p95FrameMs.toFixed(1)}ms`,
  },
  {
    id: "activeMeshes",
    settingsLabel: "Active meshes (#⬟)",
    tooltip: "Babylon meshes currently active in the scene.",
    format: (snapshot) => `${snapshot.activeMeshes}⬟`,
  },
  {
    id: "drawCalls",
    settingsLabel: "Draw calls",
    tooltip: "GPU draw calls submitted for the current frame when the renderer exposes them.",
    format: (snapshot) => snapshot.drawCalls === null ? null : `d${snapshot.drawCalls}`,
  },
  {
    id: "tiles",
    settingsLabel: "Map tiles (#/#t)",
    tooltip: "Visible map tiles over active map tiles managed by the tile runtime.",
    format: (snapshot) => snapshot.tiles ? `${snapshot.tiles.visibleTiles}/${snapshot.tiles.activeTiles}t` : null,
  },
  {
    id: "culling",
    settingsLabel: "Culling",
    tooltip: "Visible tracked objects over total tracked objects after hemisphere culling.",
    format: (snapshot) => snapshot.culling.total > 0 ? `c${snapshot.culling.visible}/${snapshot.culling.total}` : null,
  },
  {
    id: "memory",
    settingsLabel: "Memory",
    tooltip: "Approximate JavaScript heap memory currently used by the page.",
    format: (snapshot) => snapshot.memoryMb === null ? null : `${Math.round(snapshot.memoryMb)}MB`,
  },
];


function getLoadedBundleName(): string {
  const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>("script[src]"));
  const bundle = scripts
    .map((script) => script.src)
    .map((src) => new URL(src, window.location.href).pathname.split("/").pop() ?? "")
    .find((name) => /^index-[\w-]+\.js$/.test(name));

  return bundle ?? "dev";
}

async function getCurrentDeploySha(): Promise<string | null> {
  if (!REPOSITORY_SLUG) {
    return null;
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${REPOSITORY_SLUG}/git/ref/heads/gh-pages`, {
      cache: "no-store",
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json() as { object?: { sha?: unknown } };
    return typeof payload.object?.sha === "string" ? payload.object.sha : null;
  } catch {
    return null;
  }
}

function hydrateDeployShaLine(line: HTMLElement | null): void {
  if (!line) {
    return;
  }

  void getCurrentDeploySha().then((sha) => {
    line.textContent = sha ? `Deploy: ${sha.slice(0, 12)}` : "Deploy: unavailable";
  });
}

function readVisiblePerformanceMetrics(): Set<PerformanceMetricId> {
  const settings = getAppSettings();
  return new Set(PERFORMANCE_METRIC_DEFINITIONS
    .filter((metric) => settings.get(`interface.performanceHud.${metric.id}`) === true)
    .map((metric) => metric.id));
}

function renderPerformanceChips(
  element: HTMLElement,
  snapshot: PerformanceSnapshot,
  visibleMetrics: ReadonlySet<PerformanceMetricId>,
): void {
  const existing = new Map(Array.from(element.children, (child) => [
    (child as HTMLElement).dataset.perfMetric, child as HTMLElement,
  ]));
  const chips = PERFORMANCE_METRIC_DEFINITIONS.flatMap((metric) => {
    if (!visibleMetrics.has(metric.id)) return [];
    const value = metric.format(snapshot);
    if (value === null) return [];

    const chip = existing.get(metric.id) ?? document.createElement("span");
    chip.className = "hud-chip perf-chip";
    chip.dataset.perfMetric = metric.id;
    chip.title = metric.tooltip;
    chip.setAttribute("aria-label", `${metric.settingsLabel}: ${value}`);
    if (chip.textContent !== value) chip.textContent = value;
    return chip;
  });

  // Keep retained chips mounted so CSS animations are not restarted each frame.
  const retained = new Set(chips);
  for (const child of existing.values()) {
    if (!retained.has(child)) child.remove();
  }
  let cursor = element.firstChild;
  for (const chip of chips) {
    if (chip === cursor) cursor = cursor.nextSibling;
    else element.insertBefore(chip, cursor);
  }
}

function getFallbackNoticeMessage(status: BabylonRuntime["status"]): string {
  if (!status.googleApiKeyProvided) {
    return "Fallback mode active because no Google Maps API key was provided. Append ?key=YOUR_GOOGLE_MAPS_API_KEY to the URL to enable Google Photorealistic 3D Tiles.";
  }

  if (status.lastError) {
    return `Fallback mode active because Google 3D tiles failed: ${status.lastError} Verify the key is valid, the Maps Tiles API is enabled, and localhost is allowed in key restrictions.`;
  }

  return "Fallback mode active.";
}

function getGoogleWarningMessage(status: BabylonRuntime["status"]): string {
  if (status.lastError) {
    return `Google tiles reported an error: ${status.lastError}`;
  }

  return "Google mode is active, but tiles may still be loading.";
}

function getRasterWarningMessage(status: BabylonRuntime["status"]): string {
  const source = status.rasterBaseMap;
  if (status.lastError) {
    return `${source?.label ?? "Raster basemap"} is active, but some tiles failed to load: ${status.lastError}`;
  }

  return `${source?.label ?? "Raster basemap"} is active. Attribution: ${source?.attribution ?? "see provider terms"}.`;
}

export async function createGlobeApp(
  rootElement: HTMLElement,
  options: GlobeAppOptions = {},
): Promise<GlobeAppHandle> {
  rootElement.innerHTML = `
    <div class="globe-shell">
      <canvas id="globeCanvas" class="globe-canvas" aria-label="3D globe canvas"></canvas>

      <div id="hudBarRoot"></div>

      <div id="helpModal" class="modal-overlay" hidden aria-modal="true" role="dialog"
        aria-labelledby="helpModalTitle">
        <div class="modal-card">
          <h2 id="helpModalTitle" class="modal-title">Controls</h2>
          <div class="help-axes">
            <div class="help-axis">
              <div class="help-axis-title">Pan</div>
              <div class="help-axis-triggers">
                <span class="help-trigger">Left drag</span>
                <span class="help-trigger">2-finger swipe</span>
                <span class="help-trigger">1-finger <small>(mobile)</small></span>
                <span class="help-trigger">Left stick <small>(controller)</small></span>
              </div>
              <div class="help-axis-note">Changes Lat\u202F/\u202FLon</div>
            </div>
            <div class="help-axis">
              <div class="help-axis-title">Orbit</div>
              <div class="help-axis-triggers">
                <span class="help-trigger">Right drag</span>
                <span class="help-trigger">\u21E7\u202F+\u202F2-finger swipe</span>
                <span class="help-trigger">2-finger <small>(mobile)</small></span>
                <span class="help-trigger">Right stick <small>(controller)</small></span>
              </div>
              <div class="help-axis-note">Changes Heading\u202F/\u202FPitch</div>
            </div>
          </div>
          <p class="help-zoom">Zoom \u2014 Scroll wheel\u00B7Pinch\u00B7Triggers <small>(controller)</small></p>
          <p class="help-zoom">Controller \u2014 top face button resets north-up\u00B7Change bindings in Controls \u2192 Controller</p>
          <button id="helpModalDismiss" class="modal-dismiss" type="button">Got it</button>
        </div>
      </div>

      <div id="settingsSectionsHolder" hidden>
        <div id="settingsCameraLines" class="settings-section-content">
          <p class="settings-line">Camera model: state-driven orbit geometry.</p>
          <p class="settings-line">Pitch: 0\u00B0\u202F=\u202Fhorizon, 90\u00B0\u202F=\u202Fstraight down.</p>
        </div>

        <div id="controlsInputMethodSection" class="settings-section-content"></div>
        <div id="controlsControllerSection" class="settings-section-content"></div>

        <div id="settingsAboutSection" class="settings-section-content">
          <p id="settingsBuildLine" class="settings-line">Build: ${BUILD_TIME}</p>
          <p id="settingsSourceLine" class="settings-line">Source: ${SOURCE_VERSION}</p>
          <p id="settingsBundleLine" class="settings-line">Bundle: ${getLoadedBundleName()}</p>
          <p id="settingsDeployLine" class="settings-line">Deploy: loading</p>
        </div>
      </div>

      <button id="poiExitBtn" class="poi-exit-btn" hidden
        type="button" aria-label="Exit point of interest view">&#x2715;</button>

      <div id="extraPanelsGrid" class="extra-panels-grid"></div>
    </div>
  `;

  const hudBarRoot = rootElement.querySelector<HTMLElement>("#hudBarRoot");
  if (!hudBarRoot) {
    throw new Error("Expected to find the HUD bar root.");
  }
  const hudBar = createHudBar(hudBarRoot, {
    ariaLabel: "Map indicators",
    items: [
      {
        kind: "button",
        id: "northButton",
        title: "Reset to north-up",
        ariaLabel: "Reset camera to north-up",
        className: "north-button",
        content: () => {
          const template = document.createElement("template");
          template.innerHTML = `<svg id="northButtonSvg" viewBox="0 0 36 36" width="28" height="28" aria-hidden="true"><polygon points="18,5 14,14 22,14" fill="#ef4444"></polygon><text x="18" y="27" text-anchor="middle" fill="rgba(255,255,255,0.82)" font-family="system-ui,-apple-system,sans-serif" font-weight="700" font-size="13">N</text></svg>`;
          return template.content.firstElementChild ?? document.createElement("span");
        },
      },
      { kind: "button", id: "helpButton", title: "Controls help", ariaLabel: "Controls help", text: "?" },
      { kind: "button", id: "settingsButton", title: "Settings", ariaLabel: "Settings", className: "settings-button", text: "⚙" },
      {
        kind: "button",
        id: "themeButton",
        title: "Toggle theme",
        ariaLabel: "Toggle theme",
        className: "theme-button",
        content: () => {
          const icon = document.createElement("span");
          icon.className = "theme-button-icon";
          icon.setAttribute("aria-hidden", "true");
          icon.textContent = "☾";
          return icon;
        },
      },
      { kind: "button", id: "rendererModePill", title: "GPU renderer API. Click to show or hide the Renderer tab.", ariaLabel: "GPU renderer API", appearance: "chip", className: "hud-chip-button hud-chip--gpu", text: "GPU" },
      { kind: "slot", id: "perfMetricsPill", className: "hud-chip-group perf-chip-group", ariaLabel: "Performance metrics" },
      { kind: "button", id: "hudStatus", appearance: "chip", className: "hud-chip-button hud-status-text", ariaLive: "polite", ariaLabel: "Camera position", title: "Latitude, longitude, heading, pitch and zoom distance. Click to show or hide the Location tab." },
      { kind: "slot", id: "mapSourceSlot", className: "map-source-hud-slot" },
    ],
  });

  const canvas = rootElement.querySelector<HTMLCanvasElement>("#globeCanvas");
  if (!canvas) {
    throw new Error('Expected to find a canvas element with id "globeCanvas".');
  }

  const rendererModePill = rootElement.querySelector<HTMLButtonElement>("#rendererModePill");
  const perfMetricsPill = rootElement.querySelector<HTMLElement>("#perfMetricsPill");
  const settingsDeployLine = rootElement.querySelector<HTMLElement>("#settingsDeployLine");
  hydrateDeployShaLine(settingsDeployLine);

  const gameLog = createGameLog();
  let lastLoggedStatus = "";
  const logStatus = (text: string, tone: GameLogTone): void => {
    if (text === lastLoggedStatus) return;
    lastLoggedStatus = text;
    gameLog.print({ text, tone });
  };

  // One registry for the page: the map source, renderer and every other
  // parameter below are read from it and follow it.
  const settings = getAppSettings();

  let onMapStatus: ((status: BabylonRuntime["status"]) => void) | null = null;
  const applyRuntimeStatus = (status: BabylonRuntime["status"]): void => {
    onMapStatus?.(status);
    if (status.mode === "fallback") {
      logStatus(getFallbackNoticeMessage(status), "warning");
      return;
    }
    if (status.mode === "raster-basemap" && status.lastError) {
      logStatus(getRasterWarningMessage(status), "warning");
      return;
    }
    if (status.lastError) {
      logStatus(getGoogleWarningMessage(status), "warning");
    }
  };

  const mapConfig = resolveMapRuntimeConfig({
    googleApiKey: options.googleApiKey,
    baseMap: options.baseMap,
    preferGoogleTiles: options.preferGoogleTiles,
    terrainSource: options.terrainSource,
    settings,
  });

  const runtime = await createBabylonRuntime(canvas, {
    googleApiKey: mapConfig.googleApiKey,
    preferGoogleTiles: mapConfig.preferGoogleTiles,
    rasterBaseMap: mapConfig.rasterBaseMap,
    terrainSource: mapConfig.terrainSource,
    rasterImagery: mapConfig.rasterImagery,
    getSurfaceHeightMeters: options.getSurfaceHeightMeters,
    onStatusChange: applyRuntimeStatus,
    settings,
  });
  const compassHeightOffset = (): number => {
    const value = settings.get("visualization.compass.heightOffset");
    return typeof value === "number" ? value : 0;
  };
  const layerContext: GlobeLayerContext = {
    scene: runtime.scene,
    engine: runtime.engine,
  };
  const poiTracking = createPoiTracking(runtime.scene, () => runtime.geospatialCamera);
  const culling = createHemisphereCulling(() => runtime.geospatialCamera?.globalPosition ?? null);
  const resolveSurfaceHeightMeters = (latDeg: number, lonDeg: number): number | null => (
    options.getSurfaceHeightMeters?.(latDeg, lonDeg) ?? runtime.surface?.sample(latDeg, lonDeg)?.heightMeters ?? null
  );
  const anchorHeights = createAnchorHeightResolver({
    provider: resolveSurfaceHeightMeters,
    cacheProviderSamples: false,
    heightOffsetMeters: compassHeightOffset(),
  });
  runtime.configureOrbitTargetHeight({
    resolveSurfaceHeightMeters: anchorHeights.resolveHeight,
    initialOffsetMeters: compassHeightOffset(),
  });
  const registry = createLayerRegistry(layerContext, poiTracking, culling, anchorHeights);
  // Layer add/remove mutates scene contents (meshes, sprites); wrap so the
  // change becomes visible on the next animation frame in render-on-demand mode.
  const addLayer: typeof registry.addLayer = (layer) => {
    registry.addLayer(layer);
    runtime.requestRender();
  };
  const removeLayer: typeof registry.removeLayer = (layerId) => {
    registry.removeLayer(layerId);
    runtime.requestRender();
  };
  const orbitCompass: OrbitCompassHandle = createOrbitCompass(runtime.scene);
  const performanceMetrics = createPerformanceMetrics({
    engine: runtime.engine,
    scene: runtime.scene,
    getTileMetrics: () => runtime.getTileMetrics(),
    getCullingStats: () => culling.getStats(),
  });

  if (rendererModePill) {
    const rendererLabel = getRendererLabel(runtime.renderer.mode);
    const forceFailed =
      runtime.renderer.requested !== "auto" && runtime.renderer.requested !== runtime.renderer.mode;
    rendererModePill.textContent = forceFailed ? `${rendererLabel}*` : rendererLabel;
    rendererModePill.classList.toggle("hud-chip--good", runtime.renderer.mode === "webgpu");
    rendererModePill.classList.toggle("hud-chip--bad", runtime.renderer.mode !== "webgpu");
  }
  const toggleTab = (tabId: Parameters<WindowOverlayHandle["toggleTab"]>[0]): void => {
    options.overlayApiRef?.current?.toggleTab(tabId);
  };
  const rendererPanel = createRendererPanel({ renderer: runtime.renderer, onChange: force => applyRendererChoice(force, settings), settings });
  // One detail controller: the HUD rail and the Map tab's Detail group both
  // observe it, and it is the only writer of the renderer's detail target.
  const mapDetail: MapDetailController = options.mapDetail ?? createMapDetailController();
  const disconnectMapDetail = connectMapDetailRuntime(mapDetail, runtime);
  const mapPanel = createMapSourcePanel({
    detail: mapDetail,
    rasterSources: RASTER_BASE_MAP_SOURCES,
    terrainSources: TERRAIN_SOURCES,
    settings,
    // The runtime follows map.source.*: saving the choice switches the map.
    onMapSourceChange: (selected) => setMapSourcePreference(selected, settings),
    onTerrainSourceChange: (selected) => setTerrainSourcePreference(selected, settings),
  });

  // The map source sits at the bar's right end: the basemap's name and credit
  // link, the download speed, and a detail rail for Google 3D Tiles.
  const mapSourceSlot = rootElement.querySelector<HTMLElement>("#mapSourceSlot");
  const mapSourceHud = mapSourceSlot
    ? createMapSourceHud(mapSourceSlot, {
        activity: runtime,
        onProviderClick: () => toggleTab("map"),
        detail: { controller: mapDetail },
      })
    : null;
  onMapStatus = (status) => {
    mapPanel.update(status);
    mapSourceHud?.update(status);
  };
  applyRuntimeStatus(runtime.status);

  // ── HUD setup ────────────────────────────────────────────────────
  const hudStatusEl = rootElement.querySelector<HTMLElement>("#hudStatus");
  const northBtnEl = rootElement.querySelector<HTMLButtonElement>("#northButton");
  const northBtnSvgEl = rootElement.querySelector<SVGElement>("#northButtonSvg");
  const helpBtnEl = rootElement.querySelector<HTMLButtonElement>("#helpButton");
  const helpModalEl = rootElement.querySelector<HTMLElement>("#helpModal");
  const settingsBtnEl = rootElement.querySelector<HTMLButtonElement>("#settingsButton");
  const themeBtnEl = rootElement.querySelector<HTMLButtonElement>("#themeButton");
  const themeBtnIconEl = themeBtnEl?.querySelector<HTMLElement>(".theme-button-icon") ?? null;
  const poiExitBtnEl = rootElement.querySelector<HTMLButtonElement>("#poiExitBtn");
  const extraPanelsGridEl = rootElement.querySelector<HTMLElement>("#extraPanelsGrid");

  const statusHud: StatusHudHandle | null = hudStatusEl ? createStatusHud(hudStatusEl) : null;
  const northButton: NorthButtonHandle | null = northBtnSvgEl ? createNorthButton(northBtnSvgEl) : null;
  const helpModal: HelpModalHandle | null = helpModalEl ? createHelpModal(helpModalEl) : null;

  let visiblePerformanceMetrics = readVisiblePerformanceMetrics();
  let lastPerfSnapshot: PerformanceSnapshot | null = null;

  // ── Debug panels ──────────────────────────────────────────────
  const spriteTuner = extraPanelsGridEl
    ? createPoiSpriteSizeTuner(extraPanelsGridEl, (params) => {
        options.onPoiSpriteSizeChange?.(params);
        runtime.requestRender();
      })
    : null;
  const compassScaleTuner = extraPanelsGridEl
    ? createCompassScaleTuner(extraPanelsGridEl, (params) => {
        orbitCompass.setScaleParams(params);
        options.onCompassScaleChange?.(params);
        runtime.requestRender();
      })
    : null;
  const showTuners = (): void => {
    if (settings.get("interface.poiSpriteTuner") === true) spriteTuner?.show(); else spriteTuner?.hide();
    if (settings.get("interface.compassScaleTuner") === true) compassScaleTuner?.show(); else compassScaleTuner?.hide();
  };
  showTuners();

  const inputModeHud: InputModeHudHandle | null = themeBtnEl
    ? createInputModeHud(rootElement, themeBtnEl, {
        onModeChange: (mode) => runtime.setInputMode?.(mode),
        onSensitivityChange: (sensitivity) => runtime.setInputSensitivity?.(sensitivity),
        onToggle: () => toggleTab("controls"),
      })
    : null;

  const onRendererPillClick = (): void => toggleTab("renderer");
  const onStatusClick = (): void => toggleTab("location");
  rendererModePill?.addEventListener("click", onRendererPillClick);
  hudStatusEl?.addEventListener("click", onStatusClick);

  // The app follows its parameters wherever they are changed: their sections,
  // Show all parameters, an import or another tab.
  const hudButtonElements: Record<HudButtonId, HTMLElement | null> = {
    help: helpBtnEl,
    settings: settingsBtnEl,
    theme: themeBtnEl,
    inputMode: rootElement.querySelector<HTMLElement>(".input-mode-control"),
  };
  // The toolbar buttons stay on by default: a first-time visitor may not know
  // that + opens the same things. Hiding one never hides its content, because
  // every one of them has a home in these sections or under +.
  const applyHudButtonVisibility = (): void => {
    const visibility = loadHudButtonVisibility();
    for (const id of HUD_BUTTON_IDS) {
      const element = hudButtonElements[id];
      if (element) element.hidden = !visibility[id];
    }
  };
  applyHudButtonVisibility();
  const applyCompassHeight = (): void => {
    const meters = compassHeightOffset();
    anchorHeights.setHeightOffset(meters);
    runtime.configureOrbitTargetHeight({
      resolveSurfaceHeightMeters: anchorHeights.resolveHeight,
      initialOffsetMeters: meters,
    });
  };
  const stopWatchingSettings = [
    ...HUD_BUTTON_IDS.map(id => settings.watch(hudButtonParameterId(id), applyHudButtonVisibility)),
    ...PERFORMANCE_HUD_METRICS.map(([metric]) => settings.watch(`interface.performanceHud.${metric}`, () => {
      visiblePerformanceMetrics = readVisiblePerformanceMetrics();
      if (lastPerfSnapshot && perfMetricsPill) renderPerformanceChips(perfMetricsPill, lastPerfSnapshot, visiblePerformanceMetrics);
    })),
    settings.watch("interface.poiSpriteTuner", showTuners),
    settings.watch("interface.compassScaleTuner", showTuners),
    settings.watch("visualization.compass.heightOffset", applyCompassHeight),
    settings.watch("input.globeAnchorRotation", value => runtime.setGlobeAnchorRotation?.(value === true)),
    ...INPUT_SENSITIVITY_IDS.map(id => settings.watch(id, () => runtime.setInputSensitivity?.(loadInputSensitivityPreference()))),
  ];

  const resetNorth = (): void => {
    poiTracking.exitTracking();
    runtime.setViewState({ headingDeg: 0, pitchDeg: MAX_PITCH_DEG });
  };
  northBtnEl?.addEventListener("click", resetNorth);

  const gamepadSource = createBrowserInputSource({ target: window });
  const gamepadAdapter = createGlobeGamepadAdapter(runtime, { onResetNorth: resetNorth });
  const selectedGamepadSlot = (): number => gamepadSource.getSelectedDevice()?.slot ?? 0;
  const gamepadRuntime = new BindingRuntime({
    adapter: gamepadAdapter,
    profile: createStandardGlobeProfile(selectedGamepadSlot()),
  });
  const gamepadStore = createProfileStore();
  const offGamepadFrame = gamepadSource.subscribe((frame) => gamepadRuntime.dispatch(frame));
  const stopGamepadSource = gamepadSource.start({ intervalMs: 33 });
  // Controller bindings live in the Controls tab, mounted once and kept, so a
  // rebinding in progress survives closing the tab.
  const controllerSectionEl = rootElement.querySelector<HTMLElement>("#controlsControllerSection");
  const gamepadEditor: BindingEditorHandle | null = controllerSectionEl
    ? mountBindingEditor({
        root: controllerSectionEl,
        runtime: gamepadRuntime,
        source: gamepadSource,
        store: gamepadStore,
        builtInProfiles: [
          {
            id: "standard",
            label: STANDARD_GLOBE_PROFILE_NAME,
            create: () => createStandardGlobeProfile(selectedGamepadSlot()),
          },
        ],
      })
    : null;
  const openControllerBindings = (): void => options.overlayApiRef?.current?.openOrSelectTab("controls");

  const inputMethodSectionEl = rootElement.querySelector<HTMLElement>("#controlsInputMethodSection");
  const unmountInlineInputMode = inputMethodSectionEl ? inputModeHud?.mountInline(inputMethodSectionEl) : undefined;

  // ── Settings and Controls tabs ───────────────────────────────
  // Each section draws its parameters' controls and, under Show all
  // parameters, every parameter homed in it.
  const parameterSections: ParameterSectionHandle[] = [];
  const parameterControls: ParameterControlHandle[] = [];
  const sectionOf = (tab: string, section: string, extra: Omit<Parameters<typeof createParameterSection>[1], "tab" | "section"> = {}): HTMLElement => {
    const handle = createParameterSection(settings, { tab, section, ...extra });
    parameterSections.push(handle);
    return handle.element;
  };
  const note = (text: string): HTMLElement => {
    const line = document.createElement("p");
    line.className = "settings-line";
    line.textContent = text;
    return line;
  };
  const group = (heading: string, ids: readonly string[]): HTMLElement => {
    const element = document.createElement("div");
    element.className = "settings-metric-menu";
    const title = document.createElement("div");
    title.className = "settings-section-title";
    title.textContent = heading;
    element.append(title);
    for (const id of ids) {
      const control = createParameterControl(settings, id);
      parameterControls.push(control);
      element.append(control.element);
    }
    return element;
  };
  const performanceIds = PERFORMANCE_HUD_METRICS.map(([metric]) => `interface.performanceHud.${metric}`);
  const performanceMain = document.createElement("div");
  performanceMain.className = "settings-section-content";
  performanceMain.append(
    group("Performance HUD", performanceIds),
    group("Extra panels", ["interface.poiSpriteTuner", "interface.compassScaleTuner"]),
  );
  const savedSettings = createSavedSettingsSection(settings);
  const inputMethodElement = inputMethodSectionEl
    ? sectionOf("controls", "input-method", { main: inputMethodSectionEl, covers: ["input.mode", ...INPUT_SENSITIVITY_IDS] })
    : null;
  const controllerSectionElement = rootElement.querySelector<HTMLElement>("#controlsControllerSection");
  const aboutElement = rootElement.querySelector<HTMLElement>("#settingsAboutSection");
  // The input-method button lands here, so its section starts open.
  const controlsSections: PanelSection[] = [
    ...(inputMethodElement ? [{ id: "input-method", title: "Input method", element: inputMethodElement, defaultOpen: true }] : []),
    { id: "orbit", title: settings.getSectionTitle("controls", "orbit"), element: sectionOf("controls", "orbit"), defaultOpen: false },
    ...(controllerSectionElement ? [{ id: "controller", title: "Controller", element: controllerSectionElement, defaultOpen: false }] : []),
  ];
  const settingsSections: PanelSection[] = [
    { id: "toolbar", title: "Toolbar", element: sectionOf("settings", "toolbar", { footer: note("Settings stays available from + in either panel.") }), defaultOpen: false },
    { id: "camera", title: "Camera", element: sectionOf("settings", "camera", { main: rootElement.querySelector<HTMLElement>("#settingsCameraLines") ?? undefined }), defaultOpen: false },
    { id: "performance", title: "Performance debug", element: sectionOf("settings", "performance", { main: performanceMain, covers: [...performanceIds, "interface.poiSpriteTuner", "interface.compassScaleTuner"] }), defaultOpen: false },
    { id: "saved-settings", title: "Saved settings", element: savedSettings.element, defaultOpen: false },
    ...(aboutElement ? [{ id: "about", title: "About", element: aboutElement, defaultOpen: false }] : []),
  ];
  void gamepadStore.listProfileIds("foss-earth").then(async (ids) => {
    const stored = ids.length > 0 ? await gamepadStore.loadProfile("foss-earth", ids[0]) : null;
    if (!stored || stored.hostNamespace !== "foss-earth") {
      return;
    }
    gamepadRuntime.setProfile(stored);
    if (stored.selectedDeviceSlot !== undefined || stored.selectedDeviceSessionId !== undefined) {
      gamepadSource.selectDevice({
        slot: stored.selectedDeviceSlot,
        sessionId: stored.selectedDeviceSessionId,
      });
    }
  });
  helpBtnEl?.addEventListener("click", () => helpModal?.show());
  const onSettingsButtonClick = (): void => toggleTab("settings");
  settingsBtnEl?.addEventListener("click", onSettingsButtonClick);

  // ── Theme button ────────────────────────────────────────────
  // Shows sun in dark mode (click to go light), moon in light mode (click to go dark).
  function syncThemeButton(theme: "light" | "dark"): void {
    if (themeBtnIconEl) themeBtnIconEl.textContent = theme === "dark" ? "\u263C" : "\u263E";
    if (themeBtnEl) {
      const nextLabel = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
      themeBtnEl.title = nextLabel;
      themeBtnEl.setAttribute("aria-label", nextLabel);
    }
  }
  syncThemeButton(getTheme());
  const onThemeButtonClick = (): void => { toggleTheme(); };
  themeBtnEl?.addEventListener("click", onThemeButtonClick);
  // Theme changes can update scene-side colors (fallback clear color, etc.);
  // pump a frame whenever the theme flips for either tab-local or cross-tab events.
  const offThemeChangeForButton = onThemeChange((next) => {
    syncThemeButton(next);
    runtime.requestRender();
  });
  poiExitBtnEl?.addEventListener("click", (e) => {
    e.stopPropagation();
    poiTracking.exitTracking();
    runtime.requestRender();
  });

  // Update HUD every frame while the scene is running
  let hudObserver: ReturnType<typeof runtime.scene.onBeforeRenderObservable.add> | null = null;
  // Track last known POI-tracking state so we only call setOrbitMode on
  // transitions, never every frame. Calling setOrbitMode every frame would
  // stomp over external orbit-mode requests (e.g. from PropertyEarthMap's own
  // trackedPoint state), since poiTracking.isTracking() returns false for
  // external trackers and would reset orbitModeActive to false immediately.
  let lastPoiTrackingActive = false;
  hudObserver = runtime.scene.onBeforeRenderObservable.add(() => {
    const state = runtime.getViewState();
    mapSourceHud?.update(runtime.status);
    if (state) {
      statusHud?.update(state);
      northButton?.update(state.headingDeg);
    }
    const camera = runtime.geospatialCamera;
    const compassAnchor = anchorHeights.resolve(poiTracking.getOrbitTarget() ?? camera?.center ?? null);
    orbitCompass.update(compassAnchor, state?.zoomMeters ?? camera?.radius ?? 0);
    culling.update();
    const poiTrackingActive = poiTracking.isTracking();
    if (poiTrackingActive !== lastPoiTrackingActive) {
      lastPoiTrackingActive = poiTrackingActive;
      runtime.setOrbitMode(poiTrackingActive);
    }

    // ── POI exit button: project orbit target to screen space ─────
    if (poiExitBtnEl) {
      const orbitTarget = poiTracking.getOrbitTarget();
      const poiCamera = runtime.geospatialCamera;
      const poiEngine = runtime.engine;
      const poiCanvas = poiEngine.getRenderingCanvas();
      if (orbitTarget && poiCamera && poiCanvas) {
        const txMatrix = runtime.scene.getTransformMatrix();
        const vp = poiCamera.viewport.toGlobal(
          poiEngine.getRenderWidth(),
          poiEngine.getRenderHeight(),
        );
        const sp = Vector3.Project(orbitTarget, Matrix.IdentityReadOnly, txMatrix, vp);
        if (sp.z > 0 && sp.z < 1) {
          const rect = poiCanvas.getBoundingClientRect();
          const scaleX = rect.width / poiEngine.getRenderWidth();
          const scaleY = rect.height / poiEngine.getRenderHeight();
          poiExitBtnEl.hidden = false;
          poiExitBtnEl.style.left = `${rect.left + sp.x * scaleX + POI_EXIT_BTN_OFFSET_PX}px`;
          poiExitBtnEl.style.top = `${rect.top + sp.y * scaleY - POI_EXIT_BTN_OFFSET_PX}px`;
        } else {
          poiExitBtnEl.hidden = true;
        }
      } else {
        poiExitBtnEl.hidden = true;
      }
    }
    const perfSnapshot = performanceMetrics.update();
    lastPerfSnapshot = perfSnapshot;
    if (perfMetricsPill) {
      renderPerformanceChips(perfMetricsPill, perfSnapshot, visiblePerformanceMetrics);
    }
  });

  console.info(
    `[app] runtime initialized renderer=${runtime.renderer.mode} mode=${runtime.status.mode} googleApiKeyProvided=${runtime.status.googleApiKeyProvided}`,
  );

  // Visual feedback for render-on-demand state (the map source HUD shows tile
  // streaming itself):
  // - .is-rendering on the renderer chip while the scheduler is pumping frames
  // - .is-active on the perf metrics group at the same time (drives the FPS
  //   chip's green tint)
  const offRendererActivity = rendererModePill ? attachRendererActivity(rendererModePill, runtime) : () => {};
  const offRenderActive = runtime.onActiveRenderChange((active) => {
    perfMetricsPill?.classList.toggle("is-active", active);
  });
  if (runtime.isRendering()) {
    perfMetricsPill?.classList.add("is-active");
  }

  return {
    runtime,
    inputModeHud,
    openControllerBindings,
    controlsSections,
    settingsSections,
    mapTab: mapPanel.element,
    rendererTab: rendererPanel.element,
    addLayer,
    removeLayer,
    getViewState(): GlobeViewState | null {
      return runtime.getViewState();
    },
    setViewState(partial: Partial<GlobeViewState>): void {
      runtime.setViewState(partial);
    },
    getTheme,
    setTheme,
    onThemeChange,
    requestRender(): void {
      runtime.requestRender();
    },
    destroy() {
      if (hudObserver) {
        runtime.scene.onBeforeRenderObservable.remove(hudObserver);
        hudObserver = null;
      }
      statusHud?.destroy();
      northButton?.destroy();
      helpModal?.destroy();
      settingsBtnEl?.removeEventListener("click", onSettingsButtonClick);
      for (const stop of stopWatchingSettings) stop();
      for (const section of parameterSections) section.destroy();
      for (const control of parameterControls) control.destroy();
      savedSettings.destroy();
      unmountInlineInputMode?.();
      spriteTuner?.destroy();
      compassScaleTuner?.destroy();
      inputModeHud?.destroy();
      northBtnEl?.removeEventListener("click", resetNorth);
      gamepadEditor?.destroy();
      offGamepadFrame();
      stopGamepadSource();
      gamepadRuntime.dispose();
      gamepadSource.dispose();
      rendererModePill?.removeEventListener("click", onRendererPillClick);
      hudStatusEl?.removeEventListener("click", onStatusClick);
      onMapStatus = null;
      mapSourceHud?.destroy();
      mapPanel.destroy();
      disconnectMapDetail();
      if (!options.mapDetail) mapDetail.dispose();
      rendererPanel.destroy();
      themeBtnEl?.removeEventListener("click", onThemeButtonClick);
      offThemeChangeForButton();
      offRendererActivity();
      offRenderActive();
      gameLog.destroy();
      hudBar.destroy();

      poiTracking.destroy();
      registry.destroy();
      culling.destroy();
      orbitCompass.destroy();

      runtime.destroy();
      rootElement.replaceChildren();
    },
  };
}
