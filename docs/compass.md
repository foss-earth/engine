# Compass

Two drawings share one control, Interface → Compass (`visualization.compass.mode`). Horizon is the
default. Legacy is the compass on the ground. There is no off position: one of them is always
drawn. The toolbar's north button is neither of them. On the globe it resets heading to north and
pitch to look down. Inside a spherical image it turns that view to face north, level, and
leaves the globe camera alone. It stays in the bar when the view is fitted.

`visualization.compass.heightOffset` is still Controls → Camera. It moves the orbit target, which
is the point the camera turns about, whether or not the ground compass is the drawing on screen.
See [compass-height-model.md](compass-height-model.md).

## Horizon

`horizonCompassPlacements` in `src/visualization/horizonPlacement.ts` puts N, E, S and W just above
the earth's limb, as seen from the camera.

The horizon is the tangent to a sphere of the WGS84 equatorial radius (6,378,137 m) around the
origin. Geographic north and east at the camera are projected onto the plane perpendicular to the
geocentric up. At a pole that north collapses onto up, so the letters use a stable tangent instead
of a true north. Each letter's baseline sits `HORIZON_COMPASS_LIFT` (1.4°) above that tangent, and
the letter is `HORIZON_COMPASS_ANGULAR_SIZE` (2.6°) tall, so its world size grows with distance and
it keeps the same size on screen.

A camera inside the sphere, which happens if the eye is clipped into the ground, gets the same
letters on a short ring in the local sky rather than a tangent that does not exist.

The letters are billboards in the same rendering group as the terrain, so the earth hides the ones
behind it and a mountain can cover one. They are not a screen overlay: looking straight down from
street level leaves the horizon outside the view, and the letters leave with it. They show when the
limb is in frame, including a view of the whole earth.

N is red (`#ef4444`). E, S and W are white. Each texture is stroked and then filled. A stroke drawn
after the fill covered the letter, and on the limb they read as faint gray. The dark stroke is the
halo; the fill stays the letter.

## Legacy

The ground compass is the ring, the east-west line, the south-to-center line, the red needle, and
the four letters around the orbit target. Its size is two ranges, radius and camera distance, shown
in Interface → Compass only while Legacy is selected. The letter-size control is there too.

The radius runs from its smallest to its largest across the distance range, then stays at the end
it has reached. The defaults keep the old proportion, 3.5% of camera distance: the smallest radius
is 8,000 m and the largest is 240,000 m, so the distance range is those divided by 0.035. A saved
`visualization.compass.radius` or `visualization.compass.distance` replaces that default. Reset the
setting to pick up 8,000 m. The old `foss-earth.compass-scale-defaults` blob migrates once; keys
already stored under `visualization.compass.minRadius` or `visualization.compass.radiusScale` do not.

The center lines fade with camera distance, across the nearer half of the near distance, and are
gone inside that. They used to fade by comparing the unclamped radius with the smallest radius.
Once the radius is interpolated between two distances, that unclamped value does not fall to zero
as the camera comes in, so a larger minimum (8,000 m) left the center visible up close. Fade in
distance, not in that extrapolated radius.

The letters use the unclamped proportional radius, `camera distance × radius scale × letter size`,
and they update when the zoom changes even while the ring is clamped. A letter sized from the
clamped radius stays a fixed size in the world and shrinks on screen as the camera pulls back.
Their world size is capped at 5,000,000 m.

## North button

The N on the bottom-left toolbar is themed in `toolbar` (`src/styles/toolbar.css`), not by the
compass mode. The SVG text is `currentColor`, and the stylesheet sets the fill: white in the dark
theme, `#0f172a` in the light theme. The red triangle stays `#ef4444`. An inline fill on the text
would ignore the theme.
