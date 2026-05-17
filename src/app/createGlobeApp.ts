import { createBabylonRuntime, type BabylonRuntime } from "../engine/babylon/createBabylonRuntime";
import type {
  GlobeHandle,
  GlobeLayer,
  GlobeLayerContext,
  GlobeViewState,
} from "../engine/types";

export interface GlobeAppHandle extends GlobeHandle {
  runtime: BabylonRuntime;
}

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
        <span id="rendererModePill" class="renderer-pill">Renderer: initializing...</span>
        <span id="runtimeModePill" class="renderer-pill">Tiles: initializing...</span>
      </div>
      <div id="runtimeNotice" class="runtime-notice" hidden>
        <strong id="runtimeNoticeTitle" class="runtime-notice-title"></strong>
        <p id="runtimeNoticeText" class="runtime-notice-text"></p>
        <button id="runtimeNoticeDismiss" class="runtime-notice-dismiss" type="button">Dismiss</button>
      </div>
      <div class="camera-controls">
        <button id="northUpBtn" class="camera-controls__north-up" type="button" title="Reset to north-up"
          aria-label="Reset camera to north-up">
          &#8593; N
        </button>
      </div>
    </div>
  `;

  const canvas = rootElement.querySelector<HTMLCanvasElement>("#globeCanvas");
  if (!canvas) {
    throw new Error('Expected to find a canvas element with id "globeCanvas".');
  }

  const rendererModePill = rootElement.querySelector<HTMLElement>("#rendererModePill");
  const runtimeModePill = rootElement.querySelector<HTMLElement>("#runtimeModePill");
  const runtimeNotice = rootElement.querySelector<HTMLElement>("#runtimeNotice");
  const runtimeNoticeTitle = rootElement.querySelector<HTMLElement>("#runtimeNoticeTitle");
  const runtimeNoticeText = rootElement.querySelector<HTMLElement>("#runtimeNoticeText");
  const runtimeNoticeDismiss = rootElement.querySelector<HTMLButtonElement>("#runtimeNoticeDismiss");
  const northUpBtn = rootElement.querySelector<HTMLButtonElement>("#northUpBtn");

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
  const layers = new Map<string, GlobeLayer>();

  if (rendererModePill) {
    rendererModePill.textContent = `Renderer: ${runtime.renderer.mode}`;
  }

  applyRuntimeStatus(runtime.status);

  northUpBtn?.addEventListener("click", () => {
    runtime.setViewState({ headingDeg: 0 });
  });

  console.info(
    `[app] runtime initialized renderer=${runtime.renderer.mode} mode=${runtime.status.mode} googleApiKeyProvided=${runtime.status.googleApiKeyProvided}`,
  );

  function addLayer(layer: GlobeLayer): void {
    if (layers.has(layer.id)) {
      removeLayer(layer.id);
    }

    layer.setup(layerContext);
    layers.set(layer.id, layer);
  }

  function removeLayer(layerId: string): void {
    const layer = layers.get(layerId);
    if (!layer) {
      return;
    }

    layer.destroy(layerContext);
    layers.delete(layerId);
  }

  return {
    runtime,
    addLayer,
    removeLayer,
    getViewState(): GlobeViewState | null {
      return runtime.getViewState();
    },
    setViewState(partial: Partial<GlobeViewState>): void {
      runtime.setViewState(partial);
    },
    destroy() {
      for (const layer of layers.values()) {
        layer.destroy(layerContext);
      }
      layers.clear();

      runtime.destroy();
      rootElement.replaceChildren();
    },
  };
}
