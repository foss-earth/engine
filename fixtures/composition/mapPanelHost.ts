import { createSettingsRegistry } from "@foss-earth/ui/settings";
import { createTrack } from "@foss-earth/ui/browser";
import { MAP_DETAIL_PARAMETERS } from "../../src/settings/catalogue/map.js";
import { createEngineMigrations } from "../../src/settings/migrations.js";
import { createMapDetailController as createCore, MAP_DETAIL_STORAGE_KEY, type MapDetailControllerOptions } from "../../src/map/mapDetailController.js";
import { createMapDetailPanel as createPanel } from "../../src/map/mapDetailPanel.js";

export function createMapDetailController(options: Partial<MapDetailControllerOptions> = {}) {
  const settings = options.settings ?? createSettingsRegistry({ storage: options.storage });
  if (!options.settings) {
    settings.register(MAP_DETAIL_PARAMETERS.filter(spec => spec.id.startsWith("map.detail.") && spec.kind !== "choice"));
    settings.migrateLegacy(createEngineMigrations(options.storage ?? null).filter(migration => migration.key === MAP_DETAIL_STORAGE_KEY));
  }
  return createCore({ ...options, settings, deviceHints: options.deviceHints ?? (() => ({})) });
}
let panelCount = 0;
export function createMapDetailPanel(controller: Parameters<typeof createPanel>[0]) {
  const suffix = String(++panelCount);
  return createPanel(controller, { document, createTrack, idSuffix: () => suffix });
}
