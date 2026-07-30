# Game Arcade

Six games in one page. No build step and no network — plain HTML, CSS and
JavaScript that runs straight from a file. The only dependency is three.js,
vendored in `vendor/` and loaded on demand by the maze.

**[▶ Play it](https://skillscampmbz2026.github.io/game-arcade/)**

## The games

| Game | What's in it |
|---|---|
| **Tic Tac Toe** | 3×3 to 6×6 boards, Easy / Medium / Hard CPU, pick who moves first |
| **Connect Four** | 6×5, 7×6 and 8×7 boards, drop preview, falling discs |
| **Matching Cards** | Four board sizes, solo against the clock or two players |
| **Snake** | Three speeds and sizes, solid walls or wrap-around, saved best scores |
| **Car Racing** | 3D perspective racer — 8 cars, 6 laps, 3 maps, pick your car and paint |
| **Escape the Maze** | First-person 3D maze runs — pick Small, Medium or Large, finish three, and fight off the thing chasing you |

## The CPU opponents

Tic Tac Toe and Connect Four share one engine (`ai.js`):

- **Easy** plays at random — it misses its own wins and won't block yours.
- **Medium** takes an immediate win and blocks an immediate loss, otherwise
  plays at random. It sees exactly one move ahead, so forks beat it.
- **Hard** is an alpha-beta search with centre-first move ordering. On 3×3 the
  search covers the whole game, so it is unbeatable — a draw is the best you
  can manage. On larger boards it searches as deep as it can afford within the
  400 ms thinking delay and falls back on a windowed heuristic.

## The racer

The world is genuinely three-dimensional: the track is a ribbon of segments
with real x/y/z coordinates, and everything on screen comes from a perspective
projection through a camera behind and above the car. It draws with the canvas
2D API rather than WebGL — projected segments filled as trapezoids, painted
far-to-near — which is how arcade racers drew 3D roads before GPUs.

- **700 km/h limiter.** Engine force falls away as you gain pace, the way real
  power-limited acceleration does, and is still pulling at the cap — so it is
  the limiter holding the car, not the car running out of puff.
- **Five cars, five bodies.** Gran coupé, sport saloon, hot hatch, estate and
  electric, each with its own roofline, light signature, spoiler and pipes.
  They are separated by power, power band, grip and braking, and no two share
  a value on any axis. The spec bars are computed from the same numbers the
  physics uses, so they cannot drift out of sync with how a car drives.
- Slipstreaming, speed-squared cornering load, hills that hide the road behind
  them, crash barriers and sign gantries, a world that banks through corners,
  and collision swept across every segment a frame crosses.
- **Aerial perspective.** Three parallax ridge lines, each paler than the one
  in front and lit along its own skyline; drifting cloud banks; and a haze
  band sitting on the horizon so the road and grass dissolve into the sky
  instead of ending in a hard line against the hills. The tarmac carries two
  polished bands where the racing line has worn it, which curve and narrow
  with the road and give a plain grey surface something to read corners by.

Controls: **W / ↑** throttle, **A D** or **← →** steer, **S / ↓** brake,
**Q E** to drift, **Space** to pause.

## The maze

The one game that uses a library. The road racer fakes 3D with a perspective
projection onto a 2D canvas; the maze is real 3D — three.js, a WebGL camera,
instanced wall geometry and sky lighting.

three.js is **vendored as a classic script** rather than pulled from a CDN or
imported as an ES module, because the arcade has to keep working offline and
straight from a `file://` page, where module imports are blocked by CORS. It is
600 KB, so it is fetched the first time you open the maze rather than on every
page load, and the game degrades to a message plus the minimap if WebGL is
unavailable.

The ⛶ button in the title bar fullscreens the maze view and locks the pointer,
so the mouse steers the camera —
leave fullscreen and it releases, and the mouse is an ordinary cursor again.
Keyboard turning works either way.

Pick a size and you get a run of three mazes at that scale, each a little
bigger than the last. Escape one and you drop straight into the next, with the
clock running across the whole run; only finishing all three completes it.
Small runs 16x16 to 24x24, Medium 24 to 36, Large 36 to 52 — a 52 is a 105x105
grid with a shortest route of around 940 steps.

Brick walls, tiled floors and the sky are painted onto 2D canvases at load
time and used as textures, so there are still no image files to download. The
maze is open to a dusk sky rather than roofed, and lit by that sky rather than
by a lamp on the camera, so the walls stay matte instead of glowing.

The sky takes more gradient stops than it strictly needs, because real twilight
is not a linear ramp: it holds its blue, then turns quickly through green-grey
into the warm band just above the horizon, and three stops show their seams.
Cloud banks are stacked from four passes of decreasing size and rising opacity
— soft edges are the whole point, since one flat ellipse reads as a lozenge no
matter how it is shaped. The sun is a tight core inside a wide bloom, there is
a brighter haze band on the horizon where the air is thickest, and the first
stars are out overhead with a handful bright enough to show a cross of light.

The floor is poured concrete rather than vinyl: each slab a slightly different
cast, blotched at a larger scale than its grain, with hairline cracks wandering
across some of them and damp patches that span slabs and ignore the grid.

Every wall is capped with a coping course — a little wider than the wall, a
little paler, with a dark reveal in the shade of its overhang. It is one more
instanced mesh with a single material, so the whole maze's worth of it is one
extra draw call, and it is what turns a grid of cubes into built architecture.
The floor carries a broad, weak highlight: sealed concrete rather than matte
grit, which gives it a direction under the sky.

The brickwork is weathered rather than tiled. A running bond in two greys, with
every brick shifted in value *and* in hue — real masonry varies warm to cool,
not just light to dark, and a wall of pure greys is what reads as
computer-generated. On top of that: the occasional much darker aged brick,
blotching across each face, chipped corners showing the mortar behind, an
uneven mortar bed, and grime streaking down from the horizontal joints, which
is most of what separates weathered stone from a clean repeating pattern.

Each brick is bevelled light along the top and shadowed along the
bottom. A **normal map generated from the same layout** turns all of that into
real relief in the 3D view — every joint and bevel catches the light instead of
being a photograph of brick on a flat panel, at the cost of one texture rather
than any extra geometry.

The wall texture maps once over the full height rather than tiling, so
a contact shadow can be baked into the bottom of it — the darkening where a
wall meets the floor is most of what stops a corridor reading as flat
cardboard, and being painted in it costs nothing at runtime: no extra lights,
no shadow maps.

### Keeping it smooth

The 2D fallback draws the same brickwork by cutting one-pixel-wide slices out
of that same texture with `drawImage`, one per screen column. It used to paint
each feature — bond, bed joint, two bevels, perpend, contact shading — as its
own fill, which came to roughly **forty fill calls per column: 68,000 canvas
calls a frame** at fullscreen width. No 2D canvas services that at sixty frames
a second, and it showed. One textured slice per column replaced the lot, and
carries more detail than the hand-drawn version did.

The rest of the frame budget went the same way:

- Rays are cast every second or third pixel and filled that wide. Wall slices
  are vertical, so the granularity on their edges is invisible.
- Both renderers draw into a buffer capped in size and let CSS stretch it.
  Fullscreen on a large display is otherwise several times the pixels of the
  windowed view, and the WebGL path took its pixel ratio straight from the
  device — 2× on a fullscreen 1440p panel is fifteen million pixels a frame.
  It comes from a budget now, and multisampling is off: it costs more than it
  returns on flat-coloured walls.
- Trail squares are packed into single numbers instead of "x,y" strings. The
  minimap repaints the whole trail, which by the end of a large run is a few
  thousand squares, and re-parsing a string key each time meant tens of
  thousands of throwaway arrays a second for the collector to mop up. The
  minimap is also repainted eighteen times a second rather than sixty.
- The route search reuses its working arrays and marks visited squares with a
  generation stamp, so there is no allocation and no 11,000-entry clear per
  call — the cost is proportional to the squares actually reached, not to the
  size of the maze. The monster runs one several times a second.

Together that is **68,000 draw calls a frame down to under 3,000**, and the
renderer's own time from 10 ms to 0.4 ms. The test suite holds a budget on the
call count, so a future flourish that undoes this fails loudly.

Controls: **W S** walk, **A D** strafe, **arrow keys** turn, **space** sprint,
**click** or **F** to shoot, and the mouse once you are fullscreen.

The minimap shows three things and nothing else: where you are, where you have
been, and where the exit is. It never draws walls you have not walked past and
never draws the route, so it helps you keep your bearings without solving the
maze for you.

Maze generation is a recursive backtracker, which produces a *perfect* maze:
every square reachable, exactly one route between any two points, no loops.

### The thing in the maze

Something else is down there, and it does **not** know where you are. It walks
the maze looking, and only comes after you when it has a reason to:

- **It sees you** down an open line, within nine squares, and inside the arc it
  is actually facing — except at arm's length, where which way it is looking
  stops mattering. A wall between you hides you completely.
- **It hears you** within a couple of squares at a walk. Running doubles that,
  which is what makes the sprint bar a decision rather than a free button: it
  gets you away and gives you away.
- **It hears you fire.** A gunshot carries fifteen squares and tells everything
  in earshot exactly which square you shot from.

What it then chases is **the square it last had you in**, not wherever you
happen to be. Break line of sight, move quietly, and it walks to where you were
and finds nothing. Five seconds of that and it gives up and goes back to
looking.

Searching is a real sweep, not a wander. It remembers the squares it has walked
and heads for a distant one it has not, so each leg crosses ground it has not
seen — a minute of it covers about 40% of a medium maze while walking roughly
that many squares, so it is barely retreading. (Preferring the *nearest*
unvisited square sounds tidier and measured much worse: short hops mean it
spends its time re-pathing and shuffling around one junction.)

It moves at 2.05 squares a second against your 2.5 walking and 4.25 sprinting —
quicker than it, but not by much, and only while the bar lasts.
It spawns at least eight squares away and never near the exit, so you are never
made to walk into one to finish.

The HUD's third gauge says which it is doing — **Searching** or **Hunting** —
so you always know whether you have been spotted. A low drone rides under
everything, rising as one closes, and only half as insistent while they are
still looking. They show on the minimap only when almost on top of you, so the
sound is your warning, not the map.

### The fight

You carry 160 points and each of them carries 120.

- **A pack of one to five.** Pick how many are hunting you. They share the maze
  but nothing else: each has its own hundred points and works out its own route
  to you. Being surrounded hurts more than being cornered by one, though the
  damage is capped at two of them at once — five landing blows together would
  take you from full to dead inside a second, which reads as a bug rather than
  as a mistake you made.
- **You have a gun**, and you can see it. Click, press **F**, or hit the trigger button. It is
  hitscan — the round lands or misses the instant you fire, so what matters is
  whether the creature is inside the cone you are pointing down and whether a
  wall is in the way. That cone widens as it gets closer, because that is how
  much of your view it actually fills, plus a sliver of forgiveness so a shot
  that looks like it should connect does. Twenty points a hit, six hits to a
  kill, and a third of a second between shots so you cannot empty a magazine
  into it in one go.
  A shot picks whichever of them is nearest along the line you are pointing, so
  firing into a crowd hits the one in front.
- **The crosshair does the aiming for you.** It closes up while the shot
  reloads and turns red the moment a creature is genuinely in the line of
  fire, so you never need a number on screen to know whether you are on target.
  The foe bar tracks whatever you are pointing at, and the nearest one when you
  are pointing at none.
- **It hurts you by degrees**, not all at once: twenty-four points a second
  while it is within reach, so getting on for seven seconds of contact finishes
  you. Break away and you heal slowly — but only once it has properly lost you,
  more than eight squares off.
- **Kill it and it comes straight back**, at least fourteen squares away with
  its health restored. It never returns within arm's reach, and in a maze too
  small to honour that distance it takes the furthest square there is rather
  than giving up and landing on top of you. The scoreboard counts how many you
  have put down.
- **The sprint bar** is what makes the chase a decision. A full bar buys just
  under four seconds at a run and refills in about seven at a walk, and it will
  not restart until there is a worthwhile amount back — so an almost-empty bar
  cannot flicker you in and out of a sprint. Standing still refills it: you pay
  for ground covered, not for holding a key down.

Health and stamina come back in full at the start of each maze in the run, and
so does every magazine.

**When one of them finishes you**, the view swings round onto whichever one
actually had hold of you and your knees give way, then **YOU DIED** comes up
over the top with a **Retry** button under it — or press Enter. The loop keeps
running through that half-second rather than stopping dead, which is what lets
the camera turn; nothing in the world moves while it does.

Dying under mouse look releases the pointer, because there is no cursor to
click Retry with otherwise, but it leaves you in fullscreen: you should not be
thrown out of the game to restart. Releasing it is only half the job — the
click handler takes the pointer *back* whenever the view is clicked in
fullscreen, so the first click after dying went to re-locking rather than to
the button, and Retry needed an Esc first. It does not do that while you are
down.

### The weapons

Five of them — 9mm, Revolver, SMG, Shotgun, Sniper — all supplied models, in
`weapons/`. **One gun per monster**: pick three and you carry the first three,
switched with the number keys or the wheel, each keeping its own rounds.

No two behave alike, and the 9mm is the yardstick the rest are set against:

| | damage | to a kill | rate/s | reach | magazine | reload |
|---|---|---|---|---|---|---|
| **9mm** | 8 | 15 | 9.1 | 16 | 15 | 1.40s |
| **Revolver** | 20 | 6 | 2.4 | 9 | 6 | 1.20s |
| **SMG** | 5 | 24 | 16.7 | 11 | 32 | 1.00s |
| **Shotgun** | 30 | 4 | 1.3 | 6 | 8 | 2.00s |
| **Sniper** | 60 | 2 | 0.6 | 30 | 5 | 2.60s |

The 9mm is the all-rounder — best at nothing, worst at nothing, and the only
one holding enough to kill without stopping. The sniper hits hardest and
reaches furthest but waits a second and a half between rounds. The shotgun
needs four hits and six squares. The SMG hits softest and does not care. The
revolver is quick to reload and slow to cock.

Those characters are pinned by tests written against the 9mm rather than by
rank — three of the five were asked for high damage, and only two can be in
any top two.

**Right-click brings the sights up**, narrowing the view from 95 degrees to 52
and bringing the weapon onto the centre line; sway and recoil damp to a fifth
while it is there. **R reloads**, and firing dry starts one by itself.

The weapon is drawn in **a second pass over a cleared depth buffer**, in a
little scene of its own with its own camera and lights. Simply turning depth
testing off would keep walls from cutting through it, but a solid model also
has to occlude itself — a barrel in front of a stock — and that needs a depth
buffer. Doing it this way means the gun can never clip through a wall you are
standing against, and it is lit the same wherever you happen to be.

Each model is authored to its own convention — three point down -Z, one down
+Z, one down +X — so the table in `maze.js` carries, per weapon, the turn that
aims it away from you, the length to scale it to, and where to hang it in the
corner. Those numbers were set by rendering each model through a **copy of the
game's own camera**, same field of view and aspect, rather than by trying it in
a browser and nudging. Five weapons times five numbers is a lot of nudging.

#### Getting them down to a sensible size

As supplied the five came to **138 MB**, and 93% of that was texture data:
base colour, normal, roughness, occlusion and emissive maps at up to 4096
square. For something that occupies a twentieth of the screen and is lit by two
directional lights, only the base colour does any visible work.

`tools/slim-glb.js` keeps that, at 512 square re-encoded as JPEG, and discards
the rest along with the vertex attributes nothing reads — tangents, and the
second through *tenth* UV sets, which one of these files really does carry.
**138 MB becomes 6.3 MB**, with the geometry untouched.

It also throws out two things that came with the models rather than being part
of them, found by shape rather than by name:

- **A backdrop.** One was exported with the studio floor still in shot: a
  32-triangle plane 2,930 units across, around a pistol 310 units long.
- **A loose part.** The same file had its magazine laid out beside the gun. A
  weapon is thin, and every part of one is thin the same way; that magazine
  measured 3.4x the body's thickness across that axis, where every genuine part
  of all five measures under 1.2x.

#### The blocky one

Until a model arrives — and on any page opened from `file://`, where a fetch of
a sibling file is blocked outright — you hold a painted gun instead. It is
deliberately blocky: laid out on a sixteen-square grid as a character map, one
filled square per cell. To move the sight, move the S. That is also what the 2D
fallback draws, blitted into the corner, since a model needs a GPU and that
renderer exists for machines without one.

### What it looks like

The 3D view wears `blue_monster.glb` — a supplied model, 51 meshes and 8,748
triangles of shaggy blue thing with a grin full of teeth and big gold hands and
feet.

three.js ships a GLTFLoader, but only in its examples, not in the core build
this project vendors, and pulling in another 120 KB to read one model that uses
none of the hard parts is a poor trade. `glb.js` reads it directly: glTF 2.0,
triangle primitives, indexed positions and UVs, node transforms, and
pbrMetallicRoughness colours and textures. No Draco, no skins, no animation. All
the arithmetic — chunks, accessors, the node hierarchy — is plain JavaScript
with no three.js in it, so it can be run and checked outside a browser; three.js
is touched only at the end, to wrap the finished arrays.

Two things the reader does beyond reading:

- **It merges by material.** As authored the monster is 51 separate meshes, and
  five of them on screen would be 255 draw calls a frame for one enemy. Grouped
  by material it comes to ten.
- **It can pose a joint.** The model's arms are authored straight out, which at
  1.42 units tall makes it 1.26 wide — wider than the one-square corridors it
  has to walk down. Swinging the shoulders down 1.15 radians brings that to
  0.79, and it hangs like the reference picture into the bargain.

glTF colour factors are linear, and this renderer writes linear values straight
out without colour management, so the reader converts them to sRGB by hand —
taken as-is, the blue comes out nearly black.

Each monster wears its own clone with its own copy of the materials: clones
share materials in three.js by default, which would mean shooting one flashed
the whole pack red.

A page opened straight from `file://` cannot fetch a sibling file at all, so
there the monsters wear a stand-in built out of primitives instead, with the
face on a single texture. That is also what the 2D fallback draws, column by
column — a .glb needs a GPU, and the fallback exists precisely for machines
without one.

## Looks

Everything on screen is drawn by the page — there is not one image file in the
repository. Where that shows:

- **Snake** is one continuous tapering tube, not a row of tiles: a disc at
  every segment plus a bridge to the next, laid down as a single path and
  filled once per pass. Filling it segment by segment double-composites the
  overlaps, which beads a bright blob onto every joint. Three passes — dark
  rim, shaded body, a sheen along the top — make it round. It sits on a
  checkerboard lawn under a vignette, with a lit edge that goes dashed when
  the walls wrap.
- **Connect Four** discs are lit from above-left over a darker rim, dropped
  into holes punched through a frame with a real inner shadow.
- **Cards** show a woven lattice back in the game's accent, so a face-down
  grid reads as a deck rather than as empty tiles.
- **One depth language.** A single hairline, lift shadow and inset shadow are
  defined once as custom properties and reused by every panel, tile, chip and
  button, so nothing sits at an arbitrary height. Each game's accent colour
  drives its own title, halo and button gradients from a single variable.

## Fullscreen

The ⛶ button in the title bar works in every game. Most fullscreen the whole
page; the maze points it at its 3D viewport instead, so going fullscreen there
also grabs the pointer for mouse look. It hides itself in browsers without the
Fullscreen API.

## Sound

Every effect is synthesised with the Web Audio API — no audio files, so this
stays a plain static page. The racer gets a continuous engine note that tracks
speed with road noise layered under it. The 🔊 button in the title bar
remembers your choice.

## Running it

Open `index.html` and it plays. One caveat: a `file://` page is not allowed to
fetch a sibling file, so the maze's monster model never arrives and it falls
back to a stand-in creature. To get everything, serve it:

    node serve.js            # all interfaces, port 8080
    node serve.js 8090       # a different port
    node serve.js 8090 127.0.0.1   # this machine only

Node's own modules only — there is nothing to install. Started on all
interfaces it prints every address it can be reached on, so anyone else on the
network can play. On Windows the port needs an inbound rule:

    New-NetFirewallRule -DisplayName "Game Arcade (LAN)" -Direction Inbound `
      -Action Allow -Protocol TCP -LocalPort 8090 `
      -Profile Domain,Private -RemoteAddress LocalSubnet

`-RemoteAddress LocalSubnet` keeps it to the local network rather than opening
the port to everything the machine can see. Remove it again with:

    Remove-NetFirewallRule -DisplayName "Game Arcade (LAN)"

## Layout

    index.html      the shared shell
    app.js          the hub — swaps one game module in at a time
    ui.js           shared widgets and the game registry
    audio.js        synthesised sound effects and the engine note
    ai.js           board-game rules and CPU strategies
    boardgames.js   Tic Tac Toe and Connect Four
    matching.js     Matching Cards
    snake.js        Snake
    racing.js       Car Racing
    glb.js          a small .glb reader, for the models
    weapons/        the five guns, slimmed for the web
    tools/          slim-glb.js, which did the slimming
    serve.js        a static server, for playing over a network
    maze.js         Escape the Maze (three.js)
    style.css       everything visual
    vendor/         three.min.js, loaded on demand

Each game registers itself with `{ id, label, mount(ctx) }` and returns a
`destroy()` so the hub can tear down its timers and listeners on the way out.
Game rules are kept in pure functions, separate from anything that touches the
DOM, so they can be tested outside a browser.
