import { createMapSourceHud } from "../shell/mapSourceHud";
import { connectMapDetailLog } from "../shell/mapDetailLog";
import { attachRendererActivity } from "../shell/rendererActivity";
import { createBrowserInputSource } from "@felipegalind0/gamepad-tools/browser";
import { BindingRuntime, createProfileStore } from "@felipegalind0/gamepad-tools/core";
import { mountBindingEditor, type BindingEditorHandle } from "@felipegalind0/gamepad-tools/ui";
import "@felipegalind0/gamepad-tools/styles.css";
import { Matrix, Vector3 } from "@babylonjs/core";
import { createBabylonRuntime, type BabylonRuntime } from "../engine/babylon/createBabylonRuntime";
import { createGameLog, type GameLogLine, type GameLogTone } from "../log/createGameLog";
import { applyRendererChoice } from "../engine/babylon/rendererPreference";
import { RASTER_BASE_MAP_SOURCES, type RasterBaseMapSource } from "../engine/babylon/rasterBaseMaps";
import {
  resolveMapRuntimeConfig,
  setMapSourcePreference,
  setTerrainSourcePreference,
} from "../engine/babylon/resolveMapRuntimeConfig";
import { TERRAIN_SOURCES, type TerrainSource } from "../terrain/terrainTiles";
import { getAppSettings } from "../settings/appSettings";
import { INPUT_SENSITIVITY_IDS, PERFORMANCE_HUD_METRICS, TOOLBAR_EDIT_PRIORITIES_ID, TOOLBAR_PRIORITIES, toolbarPriorityParameterId } from "../settings/catalogue";
import { createParameterControl, type ParameterControlHandle } from "../shell/settings/controls";
import { createParameterSection, type ParameterSectionHandle } from "../shell/settings/parameterSection";
import { createThemeControl } from "../shell/settings/themeControl";
import { createPresetsSection } from "../shell/settings/presetsSection";
import { createSavedSettingsSection } from "../shell/settings/savedSettings";
import { createAppFilesSection, describeAppFiles } from "../shell/appFilesSection";
import { createDiagnosticsSection } from "../shell/diagnosticsSection";
import { createBugReportPanel } from "../shell/bugReportPanel";
import { stepKind } from "../diagnostics/sessionTrail";
import { reportSecrets, startAppDiagnostics, type AppDiagnostics } from "./appDiagnostics";
import { issueReporterFromBuild } from "./issueReporting";
import type { IssueReporterConfig } from "../diagnostics/issueReport";
import { keepAppFiles } from "./appFiles";
import { getAppIdentity } from "./appIdentity";
import { createAboutPanel } from "../shell/aboutPanel";
import { describePublishedVersion, watchPublishedVersion, type PublishedVersionWatch } from "./publishedVersion";
import type {
  GlobeHandle,
  GlobeLayerContext,
  GlobeViewState,
} from "../engine/types";
import { getTheme, setTheme, onThemeChange, toggleTheme } from "../theme/theme";
import { createPoiTracking } from "../layers/poiTracking";
import { createLayerRegistry } from "../layers/layerRegistry";
import { MAX_PITCH_DEG } from "../camera/cameraState";
import { ecefToGeodetic, RAD_TO_DEG } from "../camera/cameraMath";
import { createStatusHud, type CameraAltitude, type StatusHudHandle } from "../hud/statusHud";
import { surfaceHeightDatum } from "../terrain/geoid";
import { PERFORMANCE_METRIC_DEFINITIONS, renderPerformanceChips, type PerformanceMetricId } from "../hud/performanceChips";
import { createNorthButton, type NorthButtonHandle } from "../hud/northButton";
import { createHelpModal, type HelpModalHandle } from "../hud/helpModal";
import { HUD_BUTTON_IDS, hudButtonParameterId, type HudButtonId } from "../hud/hudButtonVisibility";
import type { PanelSection } from "../shell/SectionsPanel";
import type { WindowOverlayHandle } from "../shell/WindowOverlay";
import { createMapSourcePanel } from "../shell/mapSourcePanel";
import { createMapDetailController, type MapDetailController } from "../shell/mapDetailController";
import { connectMapDetailRuntime } from "../shell/connectMapDetailRuntime";
import { createRendererPanel, getRendererLabel } from "../shell/rendererPanel";
import { createSkyPanel } from "../shell/skyPanel";
import { createDateTimePanel } from "../shell/dateTimePanel";
import { createFrameBudgetPanel } from "../shell/frameBudgetPanel";
import { bindFrameProfileSettings } from "../perf/frameProfileSession";
import { FRAME_PROFILING_IDS, frameProfilingParameters } from "../settings/catalogue/profiling";
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
  withStickDeadzone,
} from "../input/globeNavigation";
import { createHudBar } from "../shell/hudBar";
import { fitHudBar, type HudBarFitItem } from "../shell/hudBarFit";
import { attachFullscreenButton } from "../shell/fullscreen";
import { createSceneHotspots, createSceneHud, createScenesPanel } from "../shell/scenesPanel";
import { createPanoramaTabs, type PanoramaTabs } from "../shell/panoramaTabs";
import { connectSceneLog } from "../shell/sceneLog";
import { createSceneController, type SceneController, type SceneExample } from "../scenes/sceneController";
import { SCENE_EXAMPLES } from "../scenes/examples";
import { sceneMediaStore, type MediaStore } from "../scenes/mediaStore";
import { effectiveOrbRadius, type PanoramaRenderer } from "../engine/babylon/panorama/panoramaRenderer";
import * as panoramaMath from "../scenes/panoramaMath";
import type { PoiSpriteSizeParams } from "../hud/poiSpriteSizeTuner";
import type { OrbitCompassScaleParams } from "../visualization/orbitCompass";

declare global {
  interface Window {
    /** Test only, with `?panoramaTest=1`: what scripts/validation/panorama-campus.mjs drives and reads. */
    __fossEarthPanoramaTest?: {
      runtime: BabylonRuntime;
      scenes: SceneController;
      readonly renderer: PanoramaRenderer | null;
      /** The app's settings: the check resets automatic map detail before it times frames. */
      settings: ReturnType<typeof getAppSettings>;
      /** The CPU reference the check holds the GPU's output against. */
      math: typeof panoramaMath & { effectiveOrbRadius: typeof effectiveOrbRadius };
      /** The images kept between visits: scripts/validation/scene-revisit.mjs reads and clears them. */
      media: MediaStore;
      /** The visit's trail and report: scripts/validation/diagnostics.mjs reads them. */
      diagnostics: AppDiagnostics;
      /** Whether this page is the published one: scripts/validation/published-version.mjs reads it. */
      publishedVersion: PublishedVersionWatch;
    };
  }
}

export interface GlobeAppHandle extends GlobeHandle {
  runtime: BabylonRuntime;
  inputModeHud: InputModeHudHandle | null;
  /** Shows the host's Controls tab, where the controller bindings live. */
  openControllerBindings(): void;
  /** The globe's input and controller settings, for the host's Controls tab. */
  controlsSections: readonly PanelSection[];
  /** The toolbar and theme, for the host's Interface tab. */
  interfaceSections: readonly PanelSection[];
  /** Presets, saved settings, the app's files and diagnostics, for the host's Settings tab. */
  settingsSections: readonly PanelSection[];
  /** Which version runs and what it is built from, for the host's About tab. */
  aboutTab: HTMLElement;
  /** The report form's one home, prepared when this tab is first shown. */
  bugReportTab: HTMLElement;
  onBugReportShow(): void;
  /** The basemap and elevation choice, for the host's Map tab. */
  mapTab: HTMLElement;
  /** The GPU renderer choice, for the host's Renderer tab. */
  rendererTab: HTMLElement;
  /** Where the Sun is, the atmosphere, the ground under it and exposure, for the host's Sky tab. */
  skyTab: HTMLElement;
  /** The dials that set the time the Sun is placed for, for the host's Date and time tab. */
  timeTab: HTMLElement;
  /** Scenes to load and their panoramas, for the host's Scenes tab. */
  scenesTab: HTMLElement;
  /** The panorama's own tab and 360 image settings, for the window overlay's `panoramaTabs`. */
  panoramaTabs: PanoramaTabs;
  /** The mounted scene, if any, and loading another. */
  scenes: SceneController;
}

export interface GlobeAppOptions {
  /** Download full diagnostics and open an issue draft in this GitHub repository. */
  issueReporter?: IssueReporterConfig;
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
   * The scenes this app offers: listed in Scenes → Content, and the only ones
   * `?scene=<id>` opens. Their URLs resolve against the app's base URL.
   * Default: FOSS Earth's example scenes.
   */
  scenes?: readonly SceneExample[];
  /** The id of one of `scenes` to open at start, when the address names none with `?scene=`. */
  initialScene?: string;
  /**
   * The host's tab overlay, filled once it mounts. The toolbar buttons toggle
   * its tabs: \u2699 Settings, input method Controls, the position Location,
   * and the renderer and map chips their own tabs.
   */
  overlayApiRef?: { current: WindowOverlayHandle | null };
}

/** Pixel offset from the projected sphere centre to the top-right exit button. */
const POI_EXIT_BTN_OFFSET_PX = 22;
/** The site's GitHub repository, whose latest deploy About names. */
const REPOSITORY_SLUG = __REPOSITORY_SLUG__;

export { getAppIdentity, getLoadedBundleName } from "./appIdentity";

function readVisiblePerformanceMetrics(): Set<PerformanceMetricId> {
  return new Set(PERFORMANCE_METRIC_DEFINITIONS
    .filter((metric) => readHudPreference(`interface.performanceHud.${metric.id}`).wanted)
    .map((metric) => metric.id));
}

function readHudPreference(id: string): { wanted: boolean; pinned: boolean } {
  const mode = getAppSettings().get(id);
  return { wanted: mode === "on" || mode === "auto", pinned: mode === "on" };
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
        <div id="controlsInputMethodSection" class="settings-section-content"></div>
        <div id="controlsControllerSection" class="settings-section-content"></div>
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
      { kind: "slot", id: "perfMetricsPill", className: "hud-chip-group perf-chip-group", ariaLabel: "Performance metrics" },
      { kind: "button", id: "rendererModePill", title: "GPU renderer API. Click to show or hide the Renderer tab.", ariaLabel: "GPU renderer API", appearance: "chip", className: "hud-chip-button hud-chip--gpu", text: "GPU" },
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
      { kind: "button", id: "settingsButton", title: "Settings", ariaLabel: "Settings", className: "settings-button", text: "⚙" },
      { kind: "button", id: "bugReportButton", title: "Show or close the Bug report tab", ariaLabel: "Bug report", text: "🐞" },
      { kind: "button", id: "fullscreenButton", title: "Enter fullscreen", ariaLabel: "Enter fullscreen", text: "⛶" },
      { kind: "button", id: "hudStatus", appearance: "chip", className: "hud-chip-button hud-status-text", ariaLive: "polite", ariaLabel: "Camera position", title: "Latitude and longitude of the point looked at, the camera's altitude, heading, pitch and zoom distance. Click to show or hide the Location tab." },
      { kind: "slot", id: "mapSourceSlot", className: "map-source-hud-slot" },
    ],
  });

  const canvas = rootElement.querySelector<HTMLCanvasElement>("#globeCanvas");
  if (!canvas) {
    throw new Error('Expected to find a canvas element with id "globeCanvas".');
  }

  const rendererModePill = rootElement.querySelector<HTMLButtonElement>("#rendererModePill");
  const perfMetricsPill = rootElement.querySelector<HTMLElement>("#perfMetricsPill");

  // One registry for the page: the map source, renderer and every other
  // parameter below are read from it and follow it.
  const settings = getAppSettings();

  // Every line of the log is a step of the visit's trail, which Settings → Diagnostics copies as a report.
  const diagnostics = startAppDiagnostics({
    log: createGameLog(),
    settings,
    identity: getAppIdentity(),
  });
  const gameLog = diagnostics.log;
  // Asked while the renderer starts: a browser may have opened its own copy of an older page, which then reloads before it has shown anything.
  const publishedVersion = watchPublishedVersion({ settings, log: gameLog });
  diagnostics.addState(() => `Published: ${describePublishedVersion(publishedVersion.state(), publishedVersion.now())}`);
  let lastLoggedStatus = "";
  const statusLines = new Map<string, GameLogLine>();
  const logStatus = (text: string, tone: GameLogTone): void => {
    if (text === lastLoggedStatus) return;
    lastLoggedStatus = text;
    // The same trouble with another tile's address is the same line with its latest wording, not a line for every tile.
    const kind = `${tone} ${stepKind(text)}`;
    const line = statusLines.get(kind);
    if (line) line.update({ text, tone });
    else statusLines.set(kind, gameLog.print({ text, tone }));
  };

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
  diagnostics.attachRuntime(runtime);
  const compassHeightOffset = (): number => {
    const value = settings.get("visualization.compass.heightOffset");
    return typeof value === "number" ? value : 0;
  };
  const layerContext: GlobeLayerContext = {
    scene: runtime.scene,
    engine: runtime.engine,
  };
  const poiTracking = createPoiTracking(runtime.scene, () => runtime.geospatialCamera, {
    dragThresholdPx: () => settings.get<number>("input.mouse.dragThreshold"),
  });
  const culling = createHemisphereCulling(() => runtime.geospatialCamera?.globalPosition ?? null);
  const resolveSurfaceHeightMeters = (latDeg: number, lonDeg: number): number | null => (
    options.getSurfaceHeightMeters?.(latDeg, lonDeg) ?? runtime.surface?.sample(latDeg, lonDeg)?.heightMeters ?? null
  );
  // The compass follows the ground as the orbit target does: `camera.surfaceFollowSpeed` and `camera.surfaceRetry`.
  const anchorTuning = () => ({
    maxVerticalSpeedMetersPerSecond: settings.get<number>("camera.surfaceFollowSpeed"),
    providerMissRetryMs: settings.get<number>("camera.surfaceRetry"),
  });
  const anchorHeights = createAnchorHeightResolver({
    provider: resolveSurfaceHeightMeters,
    cacheProviderSamples: false,
    heightOffsetMeters: compassHeightOffset(),
    ...anchorTuning(),
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
  const bugReportBtnEl = rootElement.querySelector<HTMLButtonElement>("#bugReportButton");
  const themeBtnEl = rootElement.querySelector<HTMLButtonElement>("#themeButton");
  const fullscreenBtnEl = rootElement.querySelector<HTMLButtonElement>("#fullscreenButton");
  const detachFullscreen = fullscreenBtnEl ? attachFullscreenButton(fullscreenBtnEl) : null;
  const themeBtnIconEl = themeBtnEl?.querySelector<HTMLElement>(".theme-button-icon") ?? null;
  const poiExitBtnEl = rootElement.querySelector<HTMLButtonElement>("#poiExitBtn");
  const extraPanelsGridEl = rootElement.querySelector<HTMLElement>("#extraPanelsGrid");

  const statusHud: StatusHudHandle | null = hudStatusEl ? createStatusHud(hudStatusEl, settings) : null;
  // The readout's altitude is the camera's own, not the height of what it looks at.
  const cameraAltitude = (): CameraAltitude | null => {
    const eye = runtime.geospatialCamera?.position;
    if (!eye || !statusHud) return null;
    const { latRad, lonRad, altMeters } = ecefToGeodetic(eye.x, eye.y, eye.z);
    return {
      altitudeMeters: altMeters,
      groundHeightMeters: statusHud.needsGroundHeight() ? resolveSurfaceHeightMeters(latRad * RAD_TO_DEG, lonRad * RAD_TO_DEG) : null,
      heightDatum: surfaceHeightDatum(runtime.status.mode),
    };
  };
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

  const inputModeHud: InputModeHudHandle | null = rendererModePill
    ? createInputModeHud(rootElement, rendererModePill, {
        onModeChange: (mode) => runtime.setInputMode?.(mode),
        onSensitivityChange: (sensitivity) => runtime.setInputSensitivity?.(sensitivity),
        onToggle: () => toggleTab("controls"),
      })
    : null;

  const onRendererPillClick = (): void => toggleTab("renderer");
  const onStatusClick = (): void => toggleTab("location");
  const onBugReportClick = (): void => toggleTab("bug-report");
  rendererModePill?.addEventListener("click", onRendererPillClick);
  hudStatusEl?.addEventListener("click", onStatusClick);
  bugReportBtnEl?.addEventListener("click", onBugReportClick);

  // The app follows its parameters wherever they are changed: their sections,
  // Show all parameters, an import or another tab.
  const hudButtonElements: Record<HudButtonId, HTMLElement | null> = {
    help: helpBtnEl,
    renderer: rendererModePill,
    settings: settingsBtnEl,
    bugReport: bugReportBtnEl,
    theme: themeBtnEl,
    inputMode: rootElement.querySelector<HTMLElement>(".input-mode-control"),
    position: hudStatusEl,
    fullscreen: fullscreenBtnEl,
  };
  // Setting visibility and scene visibility are independent of automatic fit.
  const applyHudButtonVisibility = (): void => {
    for (const id of HUD_BUTTON_IDS) {
      const element = hudButtonElements[id];
      if (element) element.toggleAttribute("data-hud-choice-hidden", !readHudPreference(hudButtonParameterId(id)).wanted);
    }
  };
  applyHudButtonVisibility();
  const fittingIds = new Set([
    TOOLBAR_EDIT_PRIORITIES_ID,
    ...HUD_BUTTON_IDS.map(hudButtonParameterId),
    ...PERFORMANCE_HUD_METRICS.map(([metric]) => `interface.performanceHud.${metric}`),
    ...TOOLBAR_PRIORITIES.map(([item]) => toolbarPriorityParameterId(item)),
  ]);
  const hudFit = mapSourceSlot ? fitHudBar(hudBar.element, mapSourceSlot, () => {
    const customPriorities = settings.get(TOOLBAR_EDIT_PRIORITIES_ID) === true;
    const items = TOOLBAR_PRIORITIES.flatMap(([item, , defaultPriority]): HudBarFitItem[] => {
      const priority = customPriorities ? settings.get<number>(toolbarPriorityParameterId(item)) : defaultPriority;
      if (item === "north") return northBtnEl ? [{ element: northBtnEl, priority, keepVisible: true, reserveSpace: true, essential: true }] : [];
      const button = HUD_BUTTON_IDS.find(id => id === item);
      const element = button ? hudButtonElements[button]
        : perfMetricsPill?.querySelector<HTMLElement>(`[data-perf-metric="${item}"]`);
      const id = button ? hudButtonParameterId(button) : `interface.performanceHud.${item}`;
      const { wanted, pinned } = readHudPreference(id);
      return element && wanted ? [{ element, priority, keepVisible: pinned }] : [];
    });
    // Reserve the first two available controls after North (Help and Input by
    // default). Pinning one keeps the same core; Custom priorities change it.
    const core = items.filter(item => !item.reserveSpace && !item.element.closest("[hidden]"))
      .sort((a, b) => a.priority - b.priority);
    for (const item of core.slice(0, 2)) item.reserveSpace = true;
    return items;
  }) : null;
  const applyCompassHeight = (): void => {
    const meters = compassHeightOffset();
    anchorHeights.setHeightOffset(meters);
    runtime.configureOrbitTargetHeight({
      resolveSurfaceHeightMeters: anchorHeights.resolveHeight,
      initialOffsetMeters: meters,
    });
  };
  const stopWatchingSettings = [
    // What automatic adjustment did, and why, goes in the log as it happens.
    connectMapDetailLog(runtime, gameLog),
    settings.subscribe(changed => {
      if (![...changed].some(id => fittingIds.has(id))) return;
      // On pins the chip, Auto fits it by priority, and Off removes it.
      applyHudButtonVisibility();
      visiblePerformanceMetrics = readVisiblePerformanceMetrics();
      if (lastPerfSnapshot && perfMetricsPill) renderPerformanceChips(perfMetricsPill, lastPerfSnapshot, visiblePerformanceMetrics);
      hudFit?.update();
    }),
    settings.watch("interface.poiSpriteTuner", showTuners),
    settings.watch("interface.compassScaleTuner", showTuners),
    settings.watch("visualization.compass.heightOffset", applyCompassHeight),
    ...["camera.surfaceFollowSpeed", "camera.surfaceRetry"].map(id => settings.watch(id, () => anchorHeights.setTuning(anchorTuning()))),
    settings.watch("input.globeAnchorRotation", value => runtime.setGlobeAnchorRotation?.(value === true)),
    ...INPUT_SENSITIVITY_IDS.map(id => settings.watch(id, () => runtime.setInputSensitivity?.(loadInputSensitivityPreference()))),
  ];

  const resetNorth = (): void => {
    poiTracking.exitTracking();
    runtime.setViewState({ headingDeg: 0, pitchDeg: MAX_PITCH_DEG });
  };
  northBtnEl?.addEventListener("click", resetNorth);

  const gamepadSource = createBrowserInputSource({ target: window });
  // A navigation lease, such as an entered panorama, selects its own controller context.
  const gamepadAdapter = createGlobeGamepadAdapter(runtime, {
    onResetNorth: resetNorth,
    getContext: () => runtime.getNavigationState()?.inputContext ?? "globe",
  });
  // The lease owns the camera: a tracked point must not move it meanwhile.
  const offNavigationChange = runtime.onNavigationChange(state => poiTracking.setSuspended(state !== null));
  const selectedGamepadSlot = (): number => gamepadSource.getSelectedDevice()?.slot ?? 0;
  const stickDeadzone = (): number => settings.get<number>("input.gamepad.deadzone");
  const gamepadRuntime = new BindingRuntime({
    adapter: gamepadAdapter,
    profile: createStandardGlobeProfile(selectedGamepadSlot(), stickDeadzone()),
  });
  // Every stick bound to a navigation rate, the standard one or the user's own, takes the deadzone.
  stopWatchingSettings.push(settings.watch("input.gamepad.deadzone", () => {
    gamepadRuntime.setProfile(withStickDeadzone(gamepadRuntime.getProfile(), stickDeadzone()));
  }));
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
            create: () => createStandardGlobeProfile(selectedGamepadSlot(), stickDeadzone()),
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
  const performanceMain = document.createElement("div");
  performanceMain.className = "settings-section-content";
  // The frame budget lives here, the one home of its profiling parameters.
  if (!settings.has(FRAME_PROFILING_IDS.enabled)) settings.register(frameProfilingParameters({ tab: "renderer", section: "performance" }));
  const unbindFrameProfile = bindFrameProfileSettings(settings, runtime.frameProfile);
  const frameBudget = createFrameBudgetPanel({
    session: runtime.frameProfile,
    settings,
    unmeasured: "work nobody has timed yet, the browser's own, and waiting for the display",
    readings: ["scene.panorama.sourceGpuMiB", "scene.panorama.decodedMiB", "scene.panorama.encodedMiB"],
    traceFileName: "foss-earth-frame-trace",
  });
  const frameBudgetGroup = document.createElement("div");
  frameBudgetGroup.className = "settings-metric-menu";
  const frameBudgetTitle = document.createElement("div");
  frameBudgetTitle.className = "settings-section-title";
  frameBudgetTitle.textContent = "Frame budget";
  frameBudgetGroup.append(frameBudgetTitle, frameBudget.element);
  performanceMain.append(
    group("Extra panels", ["interface.poiSpriteTuner", "interface.compassScaleTuner"]),
    frameBudgetGroup,
  );
  const presets = createPresetsSection(settings);
  const savedSettings = createSavedSettingsSection(settings);
  // The app's own files, kept by its service worker as Settings → App files asks.
  const appFiles = keepAppFiles(settings);
  const appFilesSection = createAppFilesSection(appFiles, publishedVersion);
  diagnostics.addState(async () => `App files: ${describeAppFiles(await appFiles.status())}`);
  const diagnosticsSource = {
    report: () => diagnostics.report({ allSettings: true }),
    previous: () => diagnostics.previous(),
    reportSecrets: () => reportSecrets(settings),
  };
  const diagnosticsSection = createDiagnosticsSection(diagnosticsSource);
  const bugReportPanel = createBugReportPanel(diagnosticsSource, { issueReporter: options.issueReporter ?? issueReporterFromBuild() });
  const inputMethodElement = inputMethodSectionEl
    ? sectionOf("controls", "input-method", { main: inputMethodSectionEl, covers: ["input.mode", ...INPUT_SENSITIVITY_IDS] })
    : null;
  // Its own tab, under +, where someone looking for which version runs looks for it.
  const about = createAboutPanel({ publishedVersion, site: REPOSITORY_SLUG || undefined });
  // The input-method button lands here, so its section starts open.
  const controlsSections: PanelSection[] = [
    ...(inputMethodElement ? [{ id: "input-method", title: "Input method", element: inputMethodElement, defaultOpen: true }] : []),
    { id: "camera", title: settings.getSectionTitle("controls", "camera"), element: sectionOf("controls", "camera", {
      footer: note("Tilt: 0\u00B0 looks at the horizon, 90\u00B0 straight down."),
    }), defaultOpen: false },
    { id: "orbit", title: settings.getSectionTitle("controls", "orbit"), element: sectionOf("controls", "orbit"), defaultOpen: false },
    { id: "mouse", title: settings.getSectionTitle("controls", "mouse"), element: sectionOf("controls", "mouse"), defaultOpen: false },
    { id: "touch", title: settings.getSectionTitle("controls", "touch"), element: sectionOf("controls", "touch"), defaultOpen: false },
    { id: "controller", title: settings.getSectionTitle("controls", "controller"),
      element: sectionOf("controls", "controller", { main: controllerSectionEl ?? undefined }), defaultOpen: false },
  ];
  const themeControl = createThemeControl(settings);
  const interfaceSections: PanelSection[] = [
    { id: "toolbar", title: settings.getSectionTitle("interface", "toolbar"), element: sectionOf("interface", "toolbar", {
      main: themeControl.element,
      covers: ["interface.theme"],
      footer: note("Hiding a button never hides its tab: every tab stays under +."),
    }), defaultOpen: false },
    { id: "position", title: settings.getSectionTitle("interface", "position"), element: sectionOf("interface", "position"), defaultOpen: false },
    { id: "log", title: settings.getSectionTitle("interface", "log"), element: sectionOf("interface", "log"), defaultOpen: false },
    { id: "search", title: settings.getSectionTitle("interface", "search"), element: sectionOf("interface", "search"), defaultOpen: false },
  ];
  const settingsSections: PanelSection[] = [
    { id: "presets", title: "Presets", element: presets.element, defaultOpen: false },
    { id: "saved-settings", title: "Saved settings", element: savedSettings.element, defaultOpen: false },
    { id: "app-files", title: settings.getSectionTitle("settings", "app-files"), element: sectionOf("settings", "app-files", { footer: appFilesSection.element }), defaultOpen: false },
    { id: "diagnostics", title: settings.getSectionTitle("settings", "diagnostics"), element: sectionOf("settings", "diagnostics", { footer: diagnosticsSection.element }), defaultOpen: false },
  ];
  // Performance debug is about what the renderer does, so it is the Renderer tab's.
  const rendererPanel = createRendererPanel({
    renderer: runtime.renderer,
    onChange: force => applyRendererChoice(force, settings),
    settings,
    sections: [{
      id: "performance",
      title: settings.getSectionTitle("renderer", "performance"),
      element: sectionOf("renderer", "performance", {
        main: performanceMain,
        covers: ["interface.poiSpriteTuner", "interface.compassScaleTuner", ...Object.values(FRAME_PROFILING_IDS)],
      }),
    }],
  });
  // The sky is seen from the camera once its model is on; until then the Sun and its times of day are the view's place's.
  const skyPlace = () => runtime.sky.getEnvironment()?.illumination.observer ?? runtime.getViewState();
  const skyPanel = createSkyPanel({ settings, getPlace: skyPlace, openDateTime: () => options.overlayApiRef?.current?.openOrSelectTab("time") });
  const timePanel = createDateTimePanel({ settings, getPlace: skyPlace });
  // Scenes: one mounted at a time; `?scene=<id>` loads one the app offers, else the host's initial scene.
  const appBaseUrl = new URL(import.meta.env.BASE_URL ?? "/", window.location.href).href;
  const params = new URLSearchParams(window.location.search);
  const panoramaTest = params.get("panoramaTest") === "1";
  const panoramaTestHooks: { renderer: PanoramaRenderer | null } = { renderer: null };
  const scenes = createSceneController({
    runtime,
    settings,
    canvas,
    examples: options.scenes ?? SCENE_EXAMPLES,
    baseUrl: appBaseUrl,
    ...(panoramaTest ? { loadOptions: { internals: { onRenderer: renderer => { panoramaTestHooks.renderer = renderer; } } } } : {}),
  });
  const scenesPanel = createScenesPanel({ settings, controller: scenes });
  const offSceneLog = connectSceneLog(scenes, gameLog);
  const offSceneTrail = scenes.subscribe(state => diagnostics.sceneChanged(state));
  const panoramaTabs = createPanoramaTabs({
    settings,
    controller: scenes,
    openSettings: () => options.overlayApiRef?.current?.openOrSelectTab("panorama-settings"),
  });
  const sceneHotspots = createSceneHotspots({ controller: scenes, container: canvas.parentElement ?? rootElement });
  // While a panorama is entered, its credit takes the map's place at the bar's right end.
  const sceneHud = mapSourceSlot ? createSceneHud({ controller: scenes, container: mapSourceSlot, mapSource: mapSourceHud?.element, mapOnly: hudStatusEl ? [hudStatusEl] : [] }) : null;
  const requestedScene = params.get("scene") ?? options.initialScene;
  if (requestedScene) void scenes.load(requestedScene, { exampleId: true });
  if (panoramaTest) {
    window.__fossEarthPanoramaTest = {
      runtime,
      scenes,
      get renderer() { return panoramaTestHooks.renderer; },
      settings,
      math: { ...panoramaMath, effectiveOrbRadius },
      media: sceneMediaStore,
      diagnostics,
      publishedVersion,
    };
  }

  void gamepadStore.listProfileIds("foss-earth").then(async (ids) => {
    const stored = ids.length > 0 ? await gamepadStore.loadProfile("foss-earth", ids[0]) : null;
    if (!stored || stored.hostNamespace !== "foss-earth") {
      return;
    }
    gamepadRuntime.setProfile(withStickDeadzone(stored, stickDeadzone()));
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
      statusHud?.update(state, cameraAltitude());
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
    interfaceSections,
    settingsSections,
    aboutTab: about.element,
    bugReportTab: bugReportPanel.element,
    onBugReportShow: () => bugReportPanel.show(),
    mapTab: mapPanel.element,
    rendererTab: rendererPanel.element,
    skyTab: skyPanel.element,
    timeTab: timePanel.element,
    scenesTab: scenesPanel.element,
    panoramaTabs,
    scenes,
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
      hudFit?.destroy();
      northButton?.destroy();
      detachFullscreen?.();
      helpModal?.destroy();
      settingsBtnEl?.removeEventListener("click", onSettingsButtonClick);
      bugReportBtnEl?.removeEventListener("click", onBugReportClick);
      for (const stop of stopWatchingSettings) stop();
      for (const section of parameterSections) section.destroy();
      for (const control of parameterControls) control.destroy();
      themeControl.destroy();
      presets.destroy();
      savedSettings.destroy();
      appFilesSection.destroy();
      diagnosticsSection.destroy();
      bugReportPanel.destroy();
      about.dispose();
      offSceneTrail();
      diagnostics.destroy();
      publishedVersion.dispose();
      appFiles.dispose();
      unmountInlineInputMode?.();
      spriteTuner?.destroy();
      compassScaleTuner?.destroy();
      inputModeHud?.destroy();
      northBtnEl?.removeEventListener("click", resetNorth);
      offNavigationChange();
      sceneHud?.destroy();
      sceneHotspots.destroy();
      scenesPanel.destroy();
      panoramaTabs.destroy();
      offSceneLog();
      scenes.destroy();
      if (window.__fossEarthPanoramaTest?.scenes === scenes) delete window.__fossEarthPanoramaTest;
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
      skyPanel.destroy();
      timePanel.destroy();
      frameBudget.destroy();
      unbindFrameProfile();
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
