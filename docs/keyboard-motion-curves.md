# Keyboard motion curves and additive forces

The map's Navigation tab tunes WASD pan, Q/E heading, F/R pitch and Shift/Control zoom (in/out), matching 0SFS throttle controls.
T/G zoom is available through the opt-in Enable T/G zoom toggle.
Each retains its 0.2 default sensitivity. Keyboard controls now have an
acceleration duration and shape plus a slowdown duration and shape. Values
apply live and use the shared settings registry's persistence and reset UI.
Cmd-drag and Cmd-swipe retain their gesture behavior; the separate Cmd-swipe
pitch inversion defaults on and can be switched off in this tab.

## Why curves were introduced

A held key is binary. It has no finger travel or swipe velocity from which to
infer how quickly the person wants to move. A configurable speed envelope
lets a tap make a small adjustment and a hold reach a predictable cruise speed.
A configurable release curve lets the person choose how long it coasts.
The user requested keyboard-only curve testing first, along with simultaneous
keyboard and trackpad use.

For normalized time t in [0, 1], u = 6t^5 - 15t^4 + 10t^3, acceleration
uses u^p and release uses (1 - u)^q. Shape 1 is a smooth S curve. Higher acceleration powers start more gently;
higher slowdown powers shed speed earlier. Duration 0 is immediate. A reversal
or a key pressed during slowdown starts from the current signed speed.
Every axis advances independently. Pan targets are normalized for diagonals.
The preview shares the runtime's curve function and shows a hold of at least
one second, extended to the acceleration duration if necessary, then release.
The graph shows the keyboard contribution before camera constraints; trackpad
motion adds to it.

## Force model and blending

The envelope specifies a source's desired speed over time. Each frame generates
an acceleration force F = (next velocity - previous velocity) / dt, with
normalized unit mass. `applyNavigationForce` integrates F * dt into the keyboard
contribution. These are navigation coordinates (screen pixels, heading/pitch
degrees and logarithmic zoom), rather than physical forces in newtons.

The existing inertial controller adds the keyboard contribution to pointer
impulses before applying motion to the one camera. Keyboard motion is scaled
by render dt; pointer momentum retains its existing exponential glide. Braking
a released key removes only that key source's contribution, preserving a
concurrent trackpad swipe's momentum. Mouse-drag inertia cancellation preserves
the keyboard contribution too. Input sensitivity controls the full-speed gain;
the old steady keyboard gain at the standard 0.82 glide is retained.

The keyboard envelope supplies its own braking force. Feeding it through the
pointer glide again would add a second slowdown and make the preview misleading.
The shared camera still enforces per-frame safety caps, terrain and pose limits.
At those limits the rendered curve can be clipped. Pan speed also depends on
viewport height and map scale. Simultaneous zoom/rotation use the camera's
shared anchor for each operation; zooming keys use the non-pointer anchor choice.

Focus loss, typing focus, suspension and disposal clear the keyboard source.
They do not clear concurrent pointer momentum. Cmd shortcuts do not add new
letter-key commands; already-held keys can continue during a Cmd-swipe. On Cmd
release, held letters are released to their normal slowdown because macOS can
omit their keyup events while Cmd is held.

## Runtime cost and physical feel

The input loop runs only while keys are held or their release curve is moving.
It stops after the coast, on focus loss and on disposal. It uses fixed-size
reused axis, speed and force storage, cached settings, and arithmetic on five
channels. Normal force integration reuses velocity storage and does not perform
picking, terrain work or DOM writes each frame. Anchors are acquired once for a
run of zoom/turn input. The SVG preview redraws on settings events, with no
animation loop or polling. No runtime performance improvement is claimed from
correctness tests alone; compare representative frame profiles before making
such a claim.

Speed stays continuous at a reversal or release. The curve determines the
acceleration and braking force; the shared integrator adds simultaneous device
contributions. The quintic base eases acceleration and braking at their endpoints; higher
powers change how force builds or fades. The allowed powers start at 0.75,
keeping endpoint acceleration and jerk finite. Zero durations respond
immediately, so gentle nonzero durations are the default. Further work could
retain acceleration through retargets and expose force/acceleration limits
after this keyboard experiment has hands-on feedback.

## Future uses and possible retrofit

Consider reusable, customizable movement curves wherever a binary or synthetic
command drives navigation: on-screen direction buttons, gamepad buttons,
auto-pan, accessibility switches, camera transitions or remote controls. A
future shared source API could expose mass, force limits and separate source
braking, while allowing curves to be selected or authored per movement.

Retrofit deliberately, after measuring each input's existing force, velocity,
anchor lifetime and handover behavior. Trackpad wheel streams already carry
OS acceleration and release momentum. Touch and pointer grabs encode direct
contact and should keep their contact point. Applying a keyboard envelope to
those streams can double acceleration/slowdown or introduce input lag. They
need their own source model and hands-on comparisons first. The current change
does not enable configurable curves for gestures, gamepads or transitions.

## Validation

Tests cover curve endpoints, direction reversal, immediate durations, frame-rate
independence, additive keyboard plus swipe motion, keyboard braking that leaves
pointer momentum, mouse cancellation preserving keyboard motion, shortcut/focus
cleanup and both Cmd-swipe pitch directions. The local Test-tab checklist is
intended for tuning the feel and trying simultaneous key holds and swipes.
