import type { ParameterSpec } from "@foss-earth/ui/settings";
export const POSITION_SEA_LEVEL_GRID_ID = "interface.position.seaLevelGrid";
const POSITION_ALTITUDE_ID = "interface.position.altitude";
const POSITION_READOUT = { tab: "interface", section: "position", level: "main" } as const;
/** Exact original sea-level model resource parameter; Toolbar owns presentation. */
export const POSITION_GEOID_PARAMETERS: readonly ParameterSpec[] = [
  {
    id: POSITION_SEA_LEVEL_GRID_ID,
    label: "Sea level grid",
    description: "The grid of NGA's EGM2008 geoid, mean sea level, that the altitude above sea level is measured from over Google 3D Tiles, which are drawn at their heights above the WGS84 ellipsoid. A finer grid is closer to the model and a larger download, made once a page when the altitude above sea level is first shown over Google 3D Tiles, and kept with the app's files. Raster terrain's heights are already above sea level and need no grid. Each grid's error is measured against every point of EGM2008's 5′ grid: src/terrain/geoidGrids/provenance.json.",
    unit: "none",
    kind: "choice",
    choices: [
      { id: "60", label: "1° (87 KiB)", description: "Within 12.6 m of EGM2008, 46 cm rms; more than 0.5 m off over 11.7% of the globe." },
      { id: "30", label: "30′ (302 KiB)", description: "Within 4.1 m of EGM2008, 17 cm rms; more than 0.5 m off over 2.4% of the globe." },
      { id: "15", label: "15′ (1008 KiB)", description: "Within 1.6 m of EGM2008, 5.5 cm rms; more than 0.5 m off over 0.07% of the globe." },
    ],
    default: "15",
    defaultReason: "It is within half a metre of EGM2008 over all but 0.07% of the globe, less than the readout's metre step, and is downloaded only beside Google 3D Tiles, whose own downloads are far larger.",
    home: POSITION_READOUT,
    visibleWhen: { id: POSITION_ALTITUDE_ID, value: "asl" },
    appliesLive: true,
    source: "src/terrain/geoid.ts",
  },
];
