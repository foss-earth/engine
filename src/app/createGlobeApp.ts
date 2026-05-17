import { createBabylonRuntime, type BabylonRuntime } from "../engine/babylon/createBabylonRuntime";
import type {
  GlobeHandle,
  GlobeLayerContext,
  GlobeViewState,
} from "../engine/types";
import { createPoiTracking } from "../layers/poiTracking";
import { createLayerRegistry } from "../layers/layerRegistry";
import { MAX_PITCH_DEG } from "../camera/cameraState";
import { createStatusHud, type StatusHudHandle } from "../hud/statusHud";
import { createNorthButton, type NorthButtonHandle } from "../hud/northButton";
import { createHelpModal, type HelpModalHandle } from "../hud/helpModal";
import { createSettingsModal, type SettingsModalHandle } from "../hud/settingsModal";
import { createOrbitCompass, type OrbitCompassHandle } from "../visualization/orbitCompass";
import { createHemisphereCulling } from "../perf/culling";
import { createPerformanceMetrics } from "../perf/metrics";
import { createAnchorHeightResolver } from "../terrain/anchorHeight";
import { createTileHeightProvider } from "../terrain/tileHeightProvider";

export interface GlobeAppHandle extends GlobeHandle {
  runtime: BabylonRuntime;
}

const COMPASS_HEIGHT_OFFSET_METERS = 1_000;

function getGoogleApiKeyFromUrl(): string | null {
  const searchParams = new URLSearchParams(window.location.search);
  const key = searchParams.get("key") ?? searchParams.get("googleKey");
  if (!key) {
    return null;
  }

  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
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

export async function createGlobeApp(rootElement: HTMLElement): Promise<GlobeAppHandle> {
  rootElement.innerHTML = `
    <div class="globe-shell">
      <canvas id="globeCanvas" class="globe-canvas" aria-label="3D globe canvas"></canvas>

      <div class="boot-overlay">
        <span id="rendererModePill" class="renderer-pill">Renderer: initializing\u2026</span>
        <span id="runtimeModePill" class="renderer-pill">Tiles: initializing\u2026</span>
        <span id="perfMetricsPill" class="renderer-pill perf-pill">Perf: initializing\u2026</span>
      </div>

      <div id="runtimeNotice" class="runtime-notice" hidden>
        <strong id="runtimeNoticeTitle" class="runtime-notice-title"></strong>
        <p id="runtimeNoticeText" class="runtime-notice-text"></p>
        <button id="runtimeNoticeDismiss" class="runtime-notice-dismiss" type="button">Dismiss</button>
      </div>

      <div class="hud-bar">
        <span id="hudStatus" class="hud-status-text" aria-live="polite" aria-label="Camera status"></span>
        <button id="northButton" class="hud-circle-button north-button" type="button"
          title="Reset to north-up" aria-label="Reset camera to north-up">
          <svg id="northButtonSvg" viewBox="0 0 36 36" width="36" height="36" aria-hidden="true">
            <polygon points="18,5 14,14 22,14" fill="#ef4444"/>
            <text x="18" y="27" text-anchor="middle"
              fill="rgba(255,255,255,0.82)"
              font-family="system-ui,-apple-system,sans-serif"
              font-weight="700" font-size="13">N</text>
          </svg>
        </button>
        <button id="helpButton" class="hud-circle-button" type="button"
          title="Controls help" aria-label="Controls help">?</button>
        <button id="settingsButton" class="hud-circle-button settings-button" type="button"
          title="Settings" aria-label="Settings">&#9881;</button>
      </div>

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
              </div>
              <div class="help-axis-note">Changes Lat\u202F/\u202FLon</div>
            </div>
            <div class="help-axis">
              <div class="help-axis-title">Orbit</div>
              <div class="help-axis-triggers">
                <span class="help-trigger">Right drag</span>
                <span class="help-trigger">\u21E7\u202F+\u202F2-finger swipe</span>
                <span class="help-trigger">2-finger <small>(mobile)</small></span>
              </div>
              <div class="help-axis-note">Changes Heading\u202F/\u202FPitch</div>
            </div>
          </div>
          <p class="help-zoom">Zoom \u2014 Scroll wheel\u00B7Pinch</p>
          <button id="helpModalDismiss" class="modal-dismiss" type="button">Got it</button>
        </div>
      </div>

      <div id="settingsModal" class="modal-overlay" hidden aria-modal="true" role="dialog"
        aria-labelledby="settingsModalTitle">
        <div class="modal-card">
          <h2 id="settingsModalTitle" class="modal-title">Settings</h2>
          <p class="settings-line">Camera model: state-driven orbit geometry.</p>
          <p class="settings-line">Pitch: 0\u00B0\u202F=\u202Fhorizon, 90\u00B0\u202F=\u202Fstraight down.</p>
          <p id="settingsRendererLine" class="settings-renderer-line"></p>
          <button id="settingsModalDismiss" class="modal-dismiss" type="button">Close</button>
        </div>
      </div>
    </div>
  `;

  const canvas = rootElement.querySelector<HTMLCanvasElement>("#globeCanvas");
  if (!canvas) {
    throw new Error('Expected to find a canvas element with id "globeCanvas".');
  }

  const rendererModePill = rootElement.querySelector<HTMLElement>("#rendererModePill");
  const runtimeModePill = rootElement.querySelector<HTMLElement>("#runtimeModePill");
  const perfMetricsPill = rootElement.querySelector<HTMLElement>("#perfMetricsPill");
  const runtimeNotice = rootElement.querySelector<HTMLElement>("#runtimeNotice");
  const runtimeNoticeTitle = rootElement.querySelector<HTMLElement>("#runtimeNoticeTitle");
  const runtimeNoticeText = rootElement.querySelector<HTMLElement>("#runtimeNoticeText");
  const runtimeNoticeDismiss = rootElement.querySelector<HTMLButtonElement>("#runtimeNoticeDismiss");

  let runtimeNoticeDismissed = false;

  const applyRuntimeStatus = (status: BabylonRuntime["status"]): void => {
    if (runtimeModePill) {
      const hasWarning = Boolean(status.lastError);
      runtimeModePill.textContent = status.mode === "google-tiles"
        ? (hasWarning ? "Tiles: Google (warning)" : "Tiles: Google")
        : "Tiles: Fallback";

      runtimeModePill.classList.toggle("renderer-pill--fallback", status.mode === "fallback");
    }

    if (!runtimeNotice || !runtimeNoticeTitle || !runtimeNoticeText) {
      return;
    }

    if (runtimeNoticeDismissed) {
      runtimeNotice.hidden = true;
      return;
    }

    if (status.mode === "fallback") {
      runtimeNotice.hidden = false;
      runtimeNoticeTitle.textContent = "Fallback Mode";
      runtimeNoticeText.textContent = getFallbackNoticeMessage(status);
      return;
    }

    if (status.lastError) {
      runtimeNotice.hidden = false;
      runtimeNoticeTitle.textContent = "Google Tiles Warning";
      runtimeNoticeText.textContent = getGoogleWarningMessage(status);
      return;
    }

    runtimeNotice.hidden = true;
  };

  runtimeNoticeDismiss?.addEventListener("click", () => {
    runtimeNoticeDismissed = true;
    if (runtimeNotice) {
      runtimeNotice.hidden = true;
    }
  });

  const googleApiKey = getGoogleApiKeyFromUrl();

  const runtime = await createBabylonRuntime(canvas, {
    googleApiKey,
    onStatusChange: applyRuntimeStatus,
  });
  const layerContext: GlobeLayerContext = {
    scene: runtime.scene,
    engine: runtime.engine,
  };
  const poiTracking = createPoiTracking(runtime.scene, () => runtime.geospatialCamera);
  const culling = createHemisphereCulling(() => runtime.geospatialCamera?.globalPosition ?? null);
  const anchorHeights = createAnchorHeightResolver({
    provider: createTileHeightProvider(runtime.scene),
    heightOffsetMeters: COMPASS_HEIGHT_OFFSET_METERS,
  });
  runtime.configureOrbitTargetHeight({
    resolveSurfaceHeightMeters: anchorHeights.resolveHeight,
    initialOffsetMeters: COMPASS_HEIGHT_OFFSET_METERS,
  });
  const registry = createLayerRegistry(layerContext, poiTracking, culling, anchorHeights);
  const orbitCompass: OrbitCompassHandle = createOrbitCompass(runtime.scene);
  const performanceMetrics = createPerformanceMetrics({
    engine: runtime.engine,
    scene: runtime.scene,
    getTileMetrics: () => runtime.getTileMetrics(),
    getCullingStats: () => culling.getStats(),
  });

  if (rendererModePill) {
    rendererModePill.textContent = `Renderer: ${runtime.renderer.mode}`;
  }

  applyRuntimeStatus(runtime.status);

  // ── HUD setup ────────────────────────────────────────────────────
  const hudStatusEl = rootElement.querySelector<HTMLElement>("#hudStatus");
  const northBtnEl = rootElement.querySelector<HTMLButtonElement>("#northButton");
  const northBtnSvgEl = rootElement.querySelector<SVGElement>("#northButtonSvg");
  const helpBtnEl = rootElement.querySelector<HTMLButtonElement>("#helpButton");
  const helpModalEl = rootElement.querySelector<HTMLElement>("#helpModal");
  const settingsBtnEl = rootElement.querySelector<HTMLButtonElement>("#settingsButton");
  const settingsModalEl = rootElement.querySelector<HTMLElement>("#settingsModal");

  const statusHud: StatusHudHandle | null = hudStatusEl ? createStatusHud(hudStatusEl) : null;
  const northButton: NorthButtonHandle | null = northBtnSvgEl ? createNorthButton(northBtnSvgEl) : null;
  const helpModal: HelpModalHandle | null = helpModalEl ? createHelpModal(helpModalEl) : null;
  const settingsModal: SettingsModalHandle | null = settingsModalEl ? createSettingsModal(settingsModalEl) : null;

  settingsModal?.setRendererMode(runtime.renderer.mode);

  northBtnEl?.addEventListener("click", () => {
    poiTracking.exitTracking();
    runtime.setViewState({ headingDeg: 0, pitchDeg: MAX_PITCH_DEG });
  });
  helpBtnEl?.addEventListener("click", () => helpModal?.show());
  settingsBtnEl?.addEventListener("click", () => settingsModal?.show());

  // Update HUD every frame while the scene is running
  let hudObserver: ReturnType<typeof runtime.scene.onBeforeRenderObservable.add> | null = null;
  hudObserver = runtime.scene.onBeforeRenderObservable.add(() => {
    const state = runtime.getViewState();
    if (state) {
      statusHud?.update(state);
      northButton?.update(state.headingDeg);
    }
    const camera = runtime.geospatialCamera;
    const compassAnchor = anchorHeights.resolve(poiTracking.getOrbitTarget() ?? camera?.center ?? null);
    orbitCompass.update(compassAnchor, state?.zoomMeters ?? camera?.radius ?? 0);
    culling.update();
    const perfSnapshot = performanceMetrics.update();
    if (perfMetricsPill) {
      perfMetricsPill.textContent = performanceMetrics.format(perfSnapshot);
    }
  });

  console.info(
    `[app] runtime initialized renderer=${runtime.renderer.mode} mode=${runtime.status.mode} googleApiKeyProvided=${runtime.status.googleApiKeyProvided}`,
  );

  return {
    runtime,
    addLayer: registry.addLayer,
    removeLayer: registry.removeLayer,
    getViewState(): GlobeViewState | null {
      return runtime.getViewState();
    },
    setViewState(partial: Partial<GlobeViewState>): void {
      runtime.setViewState(partial);
    },
    destroy() {
      if (hudObserver) {
        runtime.scene.onBeforeRenderObservable.remove(hudObserver);
        hudObserver = null;
      }
      statusHud?.destroy();
      northButton?.destroy();
      helpModal?.destroy();
      settingsModal?.destroy();

      poiTracking.destroy();
      registry.destroy();
      culling.destroy();
      orbitCompass.destroy();

      runtime.destroy();
      rootElement.replaceChildren();
    },
  };
}
