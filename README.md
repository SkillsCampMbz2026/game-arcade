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
| **Escape the Maze** | First-person 3D maze runs — pick Small, Medium or Large and finish three |

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

Controls: **W / ↑** throttle, **A D** or **← →** steer, **S / ↓** brake,
**Q E** to drift, **Space** to pause.

## The maze

The one game that uses a library. The road racer fakes 3D with a perspective
projection onto a 2D canvas; the maze is real 3D — three.js, a WebGL camera,
instanced wall geometry and a torch that follows you.

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
maze is open to a dusk sky rather than roofed — the sun just going down, the
first stars out — and lit by that sky rather than by a lamp on the camera, so
the walls stay matte instead of glowing.

Controls: **W S** walk, **A D** strafe, **arrow keys** turn, **space** sprint,
and the mouse once you are fullscreen.

The minimap shows three things and nothing else: where you are, where you have
been, and where the exit is. It never draws walls you have not walked past and
never draws the route, so it helps you keep your bearings without solving the
maze for you.

Maze generation is a recursive backtracker, which produces a *perfect* maze:
every square reachable, exactly one route between any two points, no loops.

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

Open `index.html`. That's the whole of it.

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
    maze.js         Escape the Maze (three.js)
    style.css       everything visual
    vendor/         three.min.js, loaded on demand

Each game registers itself with `{ id, label, mount(ctx) }` and returns a
`destroy()` so the hub can tear down its timers and listeners on the way out.
Game rules are kept in pure functions, separate from anything that touches the
DOM, so they can be tested outside a browser.
