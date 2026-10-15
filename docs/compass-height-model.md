# Compass height model

The compass target, the point the globe camera orbits and the orbit compass marks, sits at the
height of the ground under it plus `visualization.compass.heightOffset`. Two pieces keep it there:

- `createAnchorHeightResolver` (`src/babylon/anchorHeight.ts`) gives the height under a latitude
  and longitude (cells of 0.002° by default key its cache and retries), and moves the compass toward
  a new height no faster than `camera.surfaceFollowSpeed`, so the compass does not snap between street level and rooftops.
  Where the provider has no height yet, the cell reads as the WGS84 ellipsoid (height 0) until it
  is asked again after `camera.surfaceRetry`, or sooner once the displayed surface changes
  (`surfaceRevision`); the compass moves toward that at the same bounded speed. `knownHeight` is
  the same lookup with null in place of that 0.
- `CameraController` (`src/babylon/cameraState.ts`) moves the orbit target to that height as a pan
  or an orbit carries it across the ground, at the same bounded speed. A view set over a point,
  the starting view or `setViewState` with a latitude or longitude, goes straight onto the ground
  there. Until something moves it, the runtime keeps its target on the ground the map shows before
  each frame it draws (`settleOnGround`): 2D map tiles appear flat and then take their terrain, and
  the view rises with them at `camera.surfaceFollowSpeed` rather than being left under them. Two
  cases go straight onto the ground instead: a target placed before any ground was known, once it
  is (even after the view has moved), and ground that came up past the eye, which would otherwise
  leave the view under it until it caught up. While a tracked point is the centre, it does not
  follow the ground: the tracked point's own height is the target's.

## Where the height comes from

The FOSS Earth app's provider is the displayed surface: `options.getSurfaceHeightMeters` when a
host supplies one, otherwise `runtime.surface.sample(lat, lon)`, the streamed terrain or 3D tiles
on screen. Because that geometry changes with its level of detail, the app creates the resolver
with `cacheProviderSamples: false`, so a cell is read again rather than kept from coarser tiles,
and gives the camera its `knownHeight`, so ground not loaded yet is not taken for ground at sea level.
Layers can give precomputed `anchorHeightSamples` in their layer state. A resolver that caches
uses them in place of its provider; the app's does not cache, so in the app they are not read:

```ts
return {
	anchorHeightSamples: [
		{ latDeg: 44.977753, lonDeg: -93.265011, heightMeters: 264 },
	],
};
```

An earlier version of this page described a continuous smooth global elevation model as the
default provider. That model, `smoothSurfaceHeightMeters(lat, lon)` and
`smoothSurfaceEcef(lat, lon, offsetMeters)` in `src/terrain/smoothElevation.ts`, is still exported
for hosts and for marker layers that place sprites above the same smooth ground, but the app's
compass no longer reads it. A host can pass it as the provider to get the old behaviour back.

Tracked POIs keep their exact mesh position. When tracking starts, the camera centre eases onto
the POI at the pace a glide slows by (`camera.inertiaDecay`) instead of jumping to it.

## Compass target and picked points

Zoom can act about a point other than the compass target (`input.*.zoomAnchor`; see
`docs/proposals/navigation-anchors.md` in foss-earth/research). Rotation always turns about the
compass target, which keeps its latitude and longitude while the view turns and tilts around it.
Picked points follow different rules from the compass target:

| | Compass target | Picked or pinned point |
| --- | --- | --- |
| Height | Ground under it from the provider, smoothed, plus the compass height offset | Exactly where the ray met the displayed surface or the ellipsoid, copied when picked |
| Follows the ground | Yes, at `camera.surfaceFollowSpeed` | No: terrain loading later moves none of them |
| Zoom limits | Measured to the target; the legacy zoom that lowers a raised target at the nearest distance applies | Measured from the eye to the point; a point picked nearer or farther than they allow may be left toward them, not further away |

During and after an anchored zoom the camera's centre stays the compass target: the point where
the line of sight comes down to the orbit target's height. From there it follows the ground at the
bounded speed as before, so an anchored zoom never makes the compass jump.

See also the [Smooth elevation height model proposal](proposals/smooth-elevation-height-model.md)
for the design rationale of the smooth model. How the compass is drawn, Horizon or Legacy, is
[compass.md](compass.md). The height here is the orbit target either way.
