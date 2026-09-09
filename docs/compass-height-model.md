# Compass height model

The orbit compass resolves anchor height through a small quantized cache backed by a deterministic
smooth global elevation model. The default height provider is continuous over the globe and
intentionally ignores buildings, trees, and tile LOD geometry, so camera anchors do not jump when
moving over dense city geometry. Layers can still provide cheap precomputed `anchorHeightSamples`
as part of their layer state:

```ts
return {
	anchorHeightSamples: [
		{ latDeg: 44.977753, lonDeg: -93.265011, heightMeters: 264 },
	],
};
```

Tracked POIs keep their exact mesh position. Normal camera anchors use layer samples when
available; otherwise the app uses `smoothSurfaceHeightMeters(lat, lon)` and falls back to the WGS84
ellipsoid only for invalid inputs. `smoothSurfaceEcef(lat, lon, offsetMeters)` is exported for
marker layers that need to place sprites or meshes above the same smooth ground model.

Resolved compass height is also vertically smoothed, so moving the anchor across city geometry does
not instantly snap the compass between street level and rooftops.

See also the [Smooth elevation height model proposal](proposals/smooth-elevation-height-model.md)
for the design rationale.
