# Game Arcade

Five games in one page. No build step, no dependencies, no network — plain
HTML, CSS and JavaScript that runs straight from a file.

**[▶ Play it](https://skillscampmbz2026.github.io/game-arcade/)**

## The games

| Game | What's in it |
|---|---|
| **Tic Tac Toe** | 3×3 to 6×6 boards, Easy / Medium / Hard CPU, pick who moves first |
| **Connect Four** | 6×5, 7×6 and 8×7 boards, drop preview, falling discs |
| **Matching Cards** | Four board sizes, solo against the clock or two players |
| **Snake** | Three speeds and sizes, solid walls or wrap-around, saved best scores |
| **Car Racing** | 3D perspective racer — 8 cars, 3 laps, 3 maps, pick your car and paint |

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

- **No top speed.** Engine force falls away as you gain pace, the way real
  power-limited acceleration does, but never reaches zero. The car keeps
  gaining indefinitely; it just takes longer and longer.
- **Five cars, one body.** Identical bodywork in different colours — the only
  thing separating them is power, power band, grip and braking, and no two
  share a value on any axis. The spec bars are computed from the same numbers
  the physics uses, so they cannot drift out of sync with how a car drives.
- Slipstreaming, speed-squared cornering load, hills that hide the road behind
  them, and collision swept across every segment a frame crosses.

Controls: **W / ↑** throttle, **A D** or **← →** steer, **S / ↓** brake,
**Space** to pause.

## Running it

Open `index.html`. That's the whole of it.

## Layout

    index.html      the shared shell
    app.js          the hub — swaps one game module in at a time
    ui.js           shared widgets and the game registry
    ai.js           board-game rules and CPU strategies
    boardgames.js   Tic Tac Toe and Connect Four
    matching.js     Matching Cards
    snake.js        Snake
    racing.js       Car Racing
    style.css       everything visual

Each game registers itself with `{ id, label, mount(ctx) }` and returns a
`destroy()` so the hub can tear down its timers and listeners on the way out.
Game rules are kept in pure functions, separate from anything that touches the
DOM, so they can be tested outside a browser.
