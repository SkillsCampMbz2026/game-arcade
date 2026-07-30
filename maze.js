/* Escape the Maze — a first-person maze, rendered with three.js.

   three.js is vendored in ./vendor as a classic script rather than pulled from
   a CDN or imported as an ES module: the arcade has to keep working offline
   and straight from a file:// page, where module imports are blocked by CORS.
   It is 600 KB, so it is only fetched the first time this game is opened
   rather than on every page load.

   Maze generation and the walker's movement are pure functions, testable
   outside a browser; only mountMaze touches three.js or the DOM. */

const THREE_SRC = 'vendor/three.min.js';
const MONSTER_MODEL = 'blue_monster.glb';
const MONSTER_HEIGHT = 1.42;     // world units, kept under the 1.5 wall height

/* The model is authored with its arms straight out. Swung down at the shoulder
   they hang like the reference picture and, more to the point, the thing then
   fits down a one-square corridor instead of standing 1.26 units wide in it. */
const MONSTER_SHOULDER = 1.15;   // radians
const BRICK_TEX = 256;   // texture edge, in pixels
const FACE_TEX = 256;    // the creature's face, likewise
const GUN_TEX = 256;     // and the gun in your hands

/* Pick a size and you get a run of three mazes at that scale, each a little
   bigger than the last. Escaping one drops you straight into the next; the
   clock runs across the whole run, and only finishing all three completes it.

   Even "small" is a big maze — the numbers are cells square, so a 16 is a
   33x33 grid and a 52 is a 105x105 one. */
const MAZE_COURSES = [
  { id: 'small', label: 'Small', levels: [16, 20, 24] },
  { id: 'medium', label: 'Medium', levels: [24, 30, 36] },
  { id: 'large', label: 'Large', levels: [36, 44, 52] },
];

const courseById = (id) => MAZE_COURSES.find((c) => c.id === id) || MAZE_COURSES[1];

/* How many are hunting you. They share the maze rather than the health bar:
   each one has its own hundred points and its own route to you. */
const MAZE_PACKS = [1, 2, 3, 4, 5];

const WALKER_RADIUS = 0.26;    // in cells; keeps you off the wall faces
const WALK_SPEED = 3.1;        // cells per second
const SPRINT_MULTIPLIER = 1.9; // while space is held
const TURN_SPEED = 2.4;        // radians per second
const MOUSE_SENSITIVITY = 0.0026;
const MAX_PITCH = 0.9;         // radians you can look up or down
// Corridors are one unit wide, so tall walls turn them into slot canyons with
// no sky in view. Keep the walls just above eye level.
const WALL_HEIGHT = 1.5;
const EYE_HEIGHT = 0.62;
// Not FIELD_OF_VIEW: racing.js already declares that at global scope.
const MAZE_FOV = 95;           // degrees; wide enough to feel first-person

/* ---------- maze generation ---------- */

/* A grid of (2*cols+1) x (2*rows+1): odd coordinates are cells, even ones are
   the walls between them. Carved by recursive backtracking, which produces a
   perfect maze — every cell reachable, exactly one route between any two. */
function buildMaze(cols, rows, rng = Math.random) {
  const w = cols * 2 + 1;
  const h = rows * 2 + 1;
  const grid = new Uint8Array(w * h).fill(1);   // 1 = wall, 0 = open
  const at = (x, y) => y * w + x;

  const visited = new Uint8Array(cols * rows);
  const stack = [{ cx: 0, cy: 0 }];
  visited[0] = 1;
  grid[at(1, 1)] = 0;

  while (stack.length) {
    const { cx, cy } = stack[stack.length - 1];
    const options = [];
    if (cy > 0 && !visited[(cy - 1) * cols + cx]) options.push([0, -1]);
    if (cy < rows - 1 && !visited[(cy + 1) * cols + cx]) options.push([0, 1]);
    if (cx > 0 && !visited[cy * cols + cx - 1]) options.push([-1, 0]);
    if (cx < cols - 1 && !visited[cy * cols + cx + 1]) options.push([1, 0]);

    if (!options.length) {
      stack.pop();
      continue;
    }

    const [dx, dy] = options[Math.floor(rng() * options.length)];
    const nx = cx + dx;
    const ny = cy + dy;
    grid[at(cx * 2 + 1 + dx, cy * 2 + 1 + dy)] = 0;   // knock out the wall
    grid[at(nx * 2 + 1, ny * 2 + 1)] = 0;             // and open the cell
    visited[ny * cols + nx] = 1;
    stack.push({ cx: nx, cy: ny });
  }

  return {
    w, h, cols, rows, grid,
    start: { x: 1, y: 1 },
    exit: { x: w - 2, y: h - 2 },
  };
}

const isWall = (maze, x, y) =>
  x < 0 || y < 0 || x >= maze.w || y >= maze.h || maze.grid[y * maze.w + x] === 1;

/* Breadth-first shortest route between two grid squares, or null.

   The monster re-runs this several times a second on grids of up to 11,000
   squares, so the working arrays are allocated once and reused. A visited mark
   is a generation stamp rather than a cleared flag, which means no 11,000-entry
   clear per call either — the cost is proportional to the squares actually
   reached, not to the size of the maze. */
let solveScratch = null;

function solveMaze(maze, from = maze.start, to = maze.exit) {
  const size = maze.w * maze.h;
  if (!solveScratch || solveScratch.came.length < size) {
    solveScratch = {
      came: new Int32Array(size),
      stamp: new Int32Array(size),
      queue: new Int32Array(size),
      gen: 0,
    };
  }

  const { came, stamp, queue } = solveScratch;
  const gen = ++solveScratch.gen;
  const start = from.y * maze.w + from.x;

  queue[0] = start;
  came[start] = start;
  stamp[start] = gen;
  let tail = 1;

  for (let head = 0; head < tail; head++) {
    const index = queue[head];
    const x = index % maze.w;
    const y = (index - x) / maze.w;

    if (x === to.x && y === to.y) {
      const path = [];
      let step = index;
      while (step !== came[step]) {
        path.push({ x: step % maze.w, y: (step - (step % maze.w)) / maze.w });
        step = came[step];
      }
      path.push({ ...from });
      return path.reverse();
    }

    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (isWall(maze, nx, ny)) continue;
      const next = ny * maze.w + nx;
      if (stamp[next] === gen) continue;
      stamp[next] = gen;
      came[next] = index;
      queue[tail++] = next;
    }
  }

  return null;
}

/* ---------- the walker ---------- */

/* Start in the middle of the start square, facing down an open corridor.

   Facing a fixed direction spawned you nose-to-wall about half the time, and a
   wall half a unit away fills the entire view with flat grey — which reads as
   a renderer that has failed rather than as a maze. A perfect maze always
   leaves at least one way out of the start square. */
const HEADINGS = [[1, 0, 0], [0, 1, Math.PI / 2], [-1, 0, Math.PI], [0, -1, -Math.PI / 2]];

/* A trail entry, as a single number rather than an "x,y" string.

   The minimap repaints the whole trail every frame, and by the end of a large
   run that is well over a thousand squares. Decoding a string key per square
   per frame meant a split, a map and two Number conversions each time — tens of
   thousands of throwaway arrays a second, which the collector then has to mop
   up mid-game. The widest grid is 105 squares across, so 128 leaves room. */
const MAZE_STRIDE = 128;
const cellKey = (x, y) => Math.floor(y) * MAZE_STRIDE + Math.floor(x);
const keyX = (key) => key % MAZE_STRIDE;
const keyY = (key) => (key - (key % MAZE_STRIDE)) / MAZE_STRIDE;

function createWalker(maze) {
  const open = HEADINGS.find(([dx, dy]) => !isWall(maze, maze.start.x + dx, maze.start.y + dy));

  return {
    x: maze.start.x + 0.5,
    y: maze.start.y + 0.5,
    yaw: open ? open[2] : 0,
    escaped: false,
    steps: 0,
    // Squares you have actually stood on. The minimap draws this and nothing
    // else, so it can never give the route away.
    trail: new Set([cellKey(maze.start.x, maze.start.y)]),
  };
}

// Slide along a wall rather than sticking to it: each axis is tested on its
// own, so brushing a corner while moving diagonally still lets you past.
function moveWalker(maze, walker, dx, dy) {
  const clear = (x, y) => {
    for (const [ox, oy] of [[-WALKER_RADIUS, -WALKER_RADIUS], [WALKER_RADIUS, -WALKER_RADIUS],
      [-WALKER_RADIUS, WALKER_RADIUS], [WALKER_RADIUS, WALKER_RADIUS]]) {
      if (isWall(maze, Math.floor(x + ox), Math.floor(y + oy))) return false;
    }
    return true;
  };

  if (dx && clear(walker.x + dx, walker.y)) walker.x += dx;
  if (dy && clear(walker.x, walker.y + dy)) walker.y += dy;
  return walker;
}

function stepWalker(maze, walker, input, dt) {
  if (walker.escaped) return walker;

  /* Yaw 0 faces +x, and the renderer maps it to a camera looking along
     (cos yaw, 0, sin yaw). With Y up that puts +z on the player's right, so
     INCREASING yaw swings the view to the right — pressing "right" has to add.
     Getting this backwards inverts the controls. */
  const turn = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  walker.yaw += turn * TURN_SPEED * dt;

  const speed = WALK_SPEED * (input.sprint ? SPRINT_MULTIPLIER : 1);
  const before = { x: walker.x, y: walker.y };

  const drive = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
  if (drive) {
    const distance = drive * speed * dt;
    moveWalker(maze, walker, Math.cos(walker.yaw) * distance, Math.sin(walker.yaw) * distance);
  }

  // Strafing: sideways without turning. The player's right is 90 degrees on
  // from the heading, which is (-sin yaw, cos yaw).
  const slide = (input.strafeRight ? 1 : 0) - (input.strafeLeft ? 1 : 0);
  if (slide) {
    const distance = slide * speed * dt;
    moveWalker(maze, walker, -Math.sin(walker.yaw) * distance, Math.cos(walker.yaw) * distance);
  }

  if (drive || slide) {
    walker.steps += Math.hypot(walker.x - before.x, walker.y - before.y);
  }

  if (walker.trail) walker.trail.add(cellKey(walker.x, walker.y));

  if (Math.floor(walker.x) === maze.exit.x && Math.floor(walker.y) === maze.exit.y) {
    walker.escaped = true;
  }

  return walker;
}

/* ---------- the thing in the maze ---------- */

/* It always knows exactly where you are. Every so often it runs the same
   breadth-first search the solver uses, from its square to yours, and walks
   the first step of that route. There is no line of sight to break and nowhere
   to hide — the only defence is that it is slower than you are, so long as you
   keep moving.

   Pure, like the walker: given a maze and a player it returns its new state,
   which is what makes the chase testable without a browser. */
const MONSTER_SPEED = 2.05;      // cells per second; player walks 3.1
const MONSTER_REPATH = 0.35;     // seconds between route recalculations
const MONSTER_REACH = 0.7;       // cells; how close before it can hit you
const MONSTER_MIN_START = 8;     // squares of head start, at least
const RESPAWN_MIN = 14;          // and further still when it comes back

/* It does not know where you are.

   It walks the maze looking, and only comes after you when it has a reason to:
   it sees you down an open line within its own field of view, it hears you
   moving close by, or you fire. What it then chases is the square it last had
   you in — not wherever you happen to be — so breaking line of sight and
   moving is a real escape rather than a delay.

   Running is loud. Sprinting doubles the distance at which it hears you, which
   is what makes the sprint bar a decision rather than a free button. */
const SIGHT_RANGE = 9;           // cells it can pick you out at
const SIGHT_CONE = 1.05;         // radians either side of where it is looking
const SIGHT_CLOSE = 1.3;         // inside this it notices you whatever way it faces
const HEAR_WALK = 2.2;           // cells
const HEAR_SPRINT = 5;           // cells, when you are running
const SHOT_NOISE = 15;           // a gunshot carries a long way
const LOSE_PATIENCE = 5;         // seconds spent chasing a stale sighting

/* A fight, rather than one fatal touch. Six shots put one down; it needs the
   better part of seven seconds of contact to finish you. */
const PLAYER_HEALTH = 160;
const MONSTER_HEALTH = 120;
const MONSTER_DAMAGE = 24;       // per second of contact
const HEALTH_REGEN = 3;          // per second, only once it is far off
const SHOT_DAMAGE = 20;          // six shots to a kill
const SHOT_COOLDOWN = 0.38;      // seconds between shots
const SHOT_RANGE = 16;           // cells
const AIM_ASSIST = 0.055;        // radians of forgiveness either side

/* Sprinting now costs something. A full bar is a little under four seconds at
   a run, and refills in about seven at a walk. */
const STAMINA_MAX = 100;
const SPRINT_DRAIN = 26;         // per second sprinting
const STAMINA_REGEN = 15;        // per second not sprinting
const SPRINT_FLOOR = 12;         // needed before a sprint can start again

// The minimap is repainted this often rather than every frame.
const MINIMAP_PERIOD = 1 / 18;

/* Somewhere to appear: as far from the player as the maze allows, and never
   near the exit — being made to walk into one to finish would not be fair. */
function spawnSpot(maze, walker, minGap, rng) {
  const far = [];
  let best = null;
  let bestGap = -1;

  for (let y = 1; y < maze.h - 1; y++) {
    for (let x = 1; x < maze.w - 1; x++) {
      if (isWall(maze, x, y)) continue;
      if (Math.abs(x - maze.exit.x) < 3 && Math.abs(y - maze.exit.y) < 3) continue;
      const gap = Math.abs(x - walker.x) + Math.abs(y - walker.y);
      if (gap >= minGap) far.push({ x, y });
      if (gap > bestGap) { bestGap = gap; best = { x, y }; }
    }
  }

  // A respawn asks for more room than a small maze has anywhere; take the
  // furthest square there is rather than giving up and landing on the player.
  return far.length ? far[Math.floor(rng() * far.length)] : (best || { ...maze.exit });
}

function createMonster(maze, walker, rng = Math.random, minGap = MONSTER_MIN_START) {
  const spot = spawnSpot(maze, walker, minGap, rng);

  return {
    x: spot.x + 0.5,
    y: spot.y + 0.5,
    yaw: 0,
    path: [],
    sinceRepath: MONSTER_REPATH,   // work out a route on the first step
    pathTo: null,
    mode: 'search',                // 'search' until it has a reason to hunt
    target: null,                  // the square it is walking to
    lastKnown: null,               // where it last had you
    checked: new Set(),            // squares it has already looked at
    patience: 0,                   // seconds left chasing a stale sighting
    health: MONSTER_HEALTH,
    dead: false,
    touching: false,
    flinch: 0,                     // counts down after a hit, for the flash
  };
}

/* Back on its feet somewhere else. The same object is reused rather than
   replaced: each creature in the 3D scene is matched to a monster by index, and
   swapping the object out would break that pairing. */
function respawnMonster(maze, walker, monster, rng = Math.random, minGap = RESPAWN_MIN) {
  const spot = spawnSpot(maze, walker, minGap, rng);
  monster.x = spot.x + 0.5;
  monster.y = spot.y + 0.5;
  monster.path = [];
  monster.sinceRepath = MONSTER_REPATH;
  monster.pathTo = null;
  monster.mode = 'search';
  monster.target = null;
  monster.lastKnown = null;
  monster.patience = 0;
  monster.checked = new Set();
  monster.health = MONSTER_HEALTH;
  monster.dead = false;
  monster.touching = false;
  monster.flinch = 0;
  return monster;
}

/* Which of them a shot would land on: the nearest one that is both inside the
   cone you are pointing down and not behind a wall. */
function pickTarget(maze, walker, monsters, range = SHOT_RANGE) {
  let best = null;
  let bestGap = Infinity;

  for (const monster of monsters || []) {
    if (!shotHits(maze, walker, monster, range)) continue;
    const gap = Math.hypot(monster.x - walker.x, monster.y - walker.y);
    if (gap < bestGap) { bestGap = gap; best = monster; }
  }

  return best;
}

// The closest of them, which is what the drone and the healing rule care about.
function nearestMonster(monsters, walker) {
  let best = null;
  let bestGap = Infinity;

  for (const monster of monsters || []) {
    if (monster.dead) continue;
    const gap = Math.hypot(monster.x - walker.x, monster.y - walker.y);
    if (gap < bestGap) { bestGap = gap; best = monster; }
  }

  return best;
}

/* Every open square in the maze, worked out once and kept on the maze itself.
   The searchers ask for a random one whenever they finish a sweep, and scanning
   eleven thousand squares each time they do adds up. */
function openCells(maze) {
  if (maze.openCells) return maze.openCells;

  const cells = [];
  for (let y = 1; y < maze.h - 1; y++) {
    for (let x = 1; x < maze.w - 1; x++) {
      if (!isWall(maze, x, y)) cells.push({ x, y });
    }
  }
  maze.openCells = cells;
  return cells;
}

/* Somewhere else to go and look.

   It remembers the squares it has already walked and heads for a distant one it
   has not, so each leg is a long traverse through territory it has not seen.
   Preferring the nearest unvisited square instead sounds tidier and measured
   far worse — short hops mean it spends its time re-pathing and shuffling
   around one junction rather than covering ground.

   Once most of the maze has been seen the memory is wiped and it starts again,
   so it never runs out of anywhere to go. */
function pickSearchTarget(maze, monster, rng = Math.random) {
  const cells = openCells(maze);
  if (!cells.length) return null;

  if (!monster.checked) monster.checked = new Set();
  if (monster.checked.size > cells.length * 0.7) monster.checked.clear();

  let best = null;
  let bestScore = -Infinity;
  // Sampling rather than sorting: the maze can be eleven thousand squares.
  for (let i = 0; i < 24; i++) {
    const cell = cells[Math.floor(rng() * cells.length)];
    const gap = Math.abs(cell.x - monster.x) + Math.abs(cell.y - monster.y);
    if (gap < 2) continue;                    // not the square it is stood on
    const fresh = monster.checked.has(cellKey(cell.x, cell.y)) ? 0 : 1;
    const score = fresh * 1000 + gap;         // somewhere new, and a good walk away
    if (score > bestScore) { bestScore = score; best = cell; }
  }
  return best;
}

/* Can it see you? Down an open line, inside its range, and within the arc it is
   actually facing — except at arm's length, where it hardly matters which way
   it happens to be looking. */
function monsterSees(maze, monster, walker) {
  const dx = walker.x - monster.x;
  const dy = walker.y - monster.y;
  const gap = Math.hypot(dx, dy);

  if (gap > SIGHT_RANGE) return false;
  if (!clearLine(maze, monster.x, monster.y, walker.x, walker.y)) return false;
  if (gap <= SIGHT_CLOSE) return true;

  const off = Math.atan2(dy, dx) - monster.yaw;
  return Math.abs(Math.atan2(Math.sin(off), Math.cos(off))) <= SIGHT_CONE;
}

// Can it hear you? Walls muffle but do not silence, so this ignores them.
function monsterHears(monster, walker, sprinting) {
  const gap = Math.hypot(walker.x - monster.x, walker.y - monster.y);
  return gap <= (sprinting ? HEAR_SPRINT : HEAR_WALK);
}

// Remember where you were, and go there.
function markSeen(monster, walker) {
  monster.mode = 'hunt';
  monster.lastKnown = { x: Math.floor(walker.x), y: Math.floor(walker.y) };
  monster.patience = LOSE_PATIENCE;
  return monster;
}

// A shot tells everything within earshot exactly where you were standing.
function alertMonsters(monsters, walker, range = SHOT_NOISE) {
  let woken = 0;
  for (const monster of monsters || []) {
    if (monster.dead) continue;
    if (Math.hypot(walker.x - monster.x, walker.y - monster.y) > range) continue;
    markSeen(monster, walker);
    woken += 1;
  }
  return woken;
}

function stepMonster(maze, monster, walker, dt, options = {}) {
  monster.flinch = Math.max(0, monster.flinch - dt);
  if (monster.dead || walker.escaped) {
    monster.touching = false;
    return monster;
  }

  const rng = options.rng || Math.random;

  /* Senses first. Being seen or heard refreshes where it thinks you are; losing
     both starts the clock running down on that guess. */
  if (monsterSees(maze, monster, walker) || monsterHears(monster, walker, options.sprinting)) {
    markSeen(monster, walker);
  } else if (monster.mode === 'hunt') {
    monster.patience -= dt;
    const spot = monster.lastKnown;
    const arrived = !spot
      || Math.hypot(monster.x - (spot.x + 0.5), monster.y - (spot.y + 0.5)) < 0.6;
    // Nothing here, and no more patience for it: back to looking.
    if (arrived || monster.patience <= 0) {
      monster.mode = 'search';
      monster.lastKnown = null;
      monster.target = null;
    }
  }

  // Somewhere new to look, once it has finished with the last place.
  if (monster.mode === 'search') {
    const spot = monster.target;
    const done = !spot
      || Math.hypot(monster.x - (spot.x + 0.5), monster.y - (spot.y + 0.5)) < 0.6;
    if (done) monster.target = pickSearchTarget(maze, monster, rng);
  }

  const goal = monster.mode === 'hunt' ? monster.lastKnown : monster.target;
  if (!goal) {
    monster.touching = false;
    return monster;
  }

  // Re-path on the timer, when the path runs out, or when the goal has moved.
  const goalKey = goal.y * MAZE_STRIDE + goal.x;
  monster.sinceRepath += dt;
  if (monster.sinceRepath >= MONSTER_REPATH || monster.pathTo !== goalKey
    || (monster.path.length === 0 && monster.sinceRepath >= MONSTER_REPATH * 0.25)) {
    monster.sinceRepath = 0;
    monster.pathTo = goalKey;
    const route = solveMaze(maze, { x: Math.floor(monster.x), y: Math.floor(monster.y) }, goal);
    monster.path = route ? route.slice(1) : [];
    // Nowhere to go: pick somewhere else rather than standing there.
    if (!monster.path.length && monster.mode === 'search') monster.target = null;
  }

  let budget = MONSTER_SPEED * dt;
  while (budget > 0 && monster.path.length) {
    const next = monster.path[0];
    const tx = next.x + 0.5;
    const ty = next.y + 0.5;
    const dx = tx - monster.x;
    const dy = ty - monster.y;
    const gap = Math.hypot(dx, dy);
    if (gap > 1e-6) monster.yaw = Math.atan2(dy, dx);   // it looks where it walks

    if (gap <= budget) {          // reached this square, move on to the next
      monster.x = tx;
      monster.y = ty;
      budget -= gap;
      monster.path.shift();
      if (monster.checked) monster.checked.add(cellKey(tx, ty));
    } else {
      monster.x += (dx / gap) * budget;
      monster.y += (dy / gap) * budget;
      budget = 0;
    }
  }

  monster.touching = Math.hypot(walker.x - monster.x, walker.y - monster.y) < MONSTER_REACH;
  return monster;
}

/* Is there an unbroken open line between two points? Sampled several times per
   square, so a shot cannot slip diagonally through the corner of a wall. */
function clearLine(maze, x0, y0, x1, y1) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 8);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (isWall(maze, Math.floor(x0 + (x1 - x0) * t), Math.floor(y0 + (y1 - y0) * t))) return false;
  }
  return true;
}

/* Does a shot land? Hitscan: the round travels in a straight line the instant
   it is fired, so all that matters is whether the creature is inside the cone
   you are pointing down and whether a wall is in the way.

   The cone widens as it gets closer, because that is how much of your view it
   actually fills — atan of its half-width over the distance — plus a fixed
   sliver of forgiveness so a shot that looks like it should connect does. */
function shotHits(maze, walker, monster, range = SHOT_RANGE) {
  if (!monster || monster.dead) return false;

  const dx = monster.x - walker.x;
  const dy = monster.y - walker.y;
  const gap = Math.hypot(dx, dy);
  if (gap > range) return false;

  const half = Math.atan2(0.42, Math.max(0.4, gap));
  const off = Math.atan2(dy, dx) - walker.yaw;
  // Wrap to -pi..pi, or a shot due west compares against a 6-radian error.
  const wrapped = Math.atan2(Math.sin(off), Math.cos(off));
  if (Math.abs(wrapped) > half + AIM_ASSIST) return false;

  return clearLine(maze, walker.x, walker.y, monster.x, monster.y);
}

/* Sprint stamina. Draining and refilling are both steady; the floor is what
   stops an almost-empty bar flickering you in and out of a run every frame.
   Standing still refills it — you only pay for ground covered. */
function stepSprint(sprint, wanted, moving, dt) {
  if (sprint.active && (!wanted || !moving || sprint.value <= 0)) sprint.active = false;
  else if (!sprint.active && wanted && moving && sprint.value >= SPRINT_FLOOR) sprint.active = true;

  sprint.value = sprint.active
    ? Math.max(0, sprint.value - SPRINT_DRAIN * dt)
    : Math.min(STAMINA_MAX, sprint.value + STAMINA_REGEN * dt);

  return sprint.active;
}

// How near it feels, 0 (far off) to 1 (on top of you). Straight-line distance,
// so it swells when it is round the corner rather than only in sight.
function monsterCloseness(monster, walker) {
  const gap = Math.hypot(walker.x - monster.x, walker.y - monster.y);
  return Math.max(0, Math.min(1, 1 - gap / 11));
}

/* The minimap: where the exit is, where you are, and where you have been.

   Deliberately nothing else — no walls, no unexplored ground and above all no
   route to the exit, so it helps you keep track without solving the maze for
   you. */
function drawMinimap(g, maze, walker, size, monsters) {
  const cell = size / Math.max(maze.w, maze.h);

  g.clearRect(0, 0, size, size);
  g.fillStyle = 'rgba(6, 11, 25, 0.72)';
  g.fillRect(0, 0, size, size);

  // Where you have been.
  g.fillStyle = 'rgba(148, 197, 255, 0.55)';
  const box = Math.max(1, cell);
  for (const key of walker.trail || []) {
    g.fillRect(keyX(key) * cell, keyY(key) * cell, box, box);
  }

  // The exit.
  const marker = Math.max(3, cell * 1.6);
  g.fillStyle = '#4ade80';
  g.fillRect(
    (maze.exit.x + 0.5) * cell - marker / 2,
    (maze.exit.y + 0.5) * cell - marker / 2,
    marker, marker);

  /* Each of them, but only once it is close enough that you would hear it
     anyway — a map that tracked the pack across the whole maze would remove
     all the tension. */
  const blip = Math.max(3, cell * 1.5);
  g.fillStyle = '#ef4444';
  for (const monster of monsters || []) {
    if (monster.dead || monsterCloseness(monster, walker) <= 0.35) continue;
    g.beginPath();
    g.arc(monster.x * cell, monster.y * cell, blip / 2, 0, Math.PI * 2);
    g.fill();
  }

  // You, with a nose showing which way you face.
  const px = walker.x * cell;
  const py = walker.y * cell;
  g.strokeStyle = '#fbbf24';
  g.lineWidth = Math.max(1.5, cell * 0.5);
  g.beginPath();
  g.moveTo(px, py);
  g.lineTo(px + Math.cos(walker.yaw) * cell * 2.4, py + Math.sin(walker.yaw) * cell * 2.4);
  g.stroke();

  g.fillStyle = '#fbbf24';
  g.beginPath();
  g.arc(px, py, Math.max(2.5, cell * 0.8), 0, Math.PI * 2);
  g.fill();
}

/* ---------- fallback renderer ---------- */

/* A first-person view drawn with plain 2D canvas, by raycasting: for every
   screen column, march a ray through the grid until it meets a wall and draw
   a slice as tall as that wall is near. No WebGL, no library — so the maze is
   playable on machines where three.js cannot get a context, which is common
   on remote desktops and anywhere hardware acceleration is switched off.

   Pure apart from the context it draws into, so it can be rendered and looked
   at outside a browser. */
/* The creature, drawn column by column so the wall depths can hide it.

   Its silhouette is described as bands: for a given position across the body,
   which parts are present and how tall they are. That keeps it one pass over
   the columns — the same pass that tests each column against the wall in front
   of it — with the fur ragged by a fixed hash so the outline is not a clean
   curve. The face is the shared texture, blitted on at the end. */
const FUR_BLUE = ['#1d63a8', '#256fb8', '#1a5b9b', '#2a7ac6'];

function drawCreature(g, cx, feet, wide, tall, distance, depth, width, flinch = 0) {
  const half = wide / 2;
  const left = Math.floor(cx - half * 1.35);
  const right = Math.ceil(cx + half * 1.35);
  // Solid until it is some way off, then fading into the haze. Thinning it out
  // at close range let the brickwork behind show straight through it.
  const fade = distance < 6 ? 1 : Math.max(0.3, 1 - (distance - 6) / 14);
  const hit = Math.min(1, flinch * 4);

  /* Heights as fractions of the whole figure, measured up from the feet, and
     how far out across it each part reaches. Reading the figure off one table
     keeps the parts joined up: the torso ends exactly where the legs start. */
  const yAt = (f) => feet - tall * f;
  const PARTS = [
    // reachFrom, reachTo, top, bottom, orange?
    [0, 0.95, 1.02, 0.7, false],    // head (domed, handled below)
    [0, 0.8, 0.72, 0.38, false],    // torso, nearly as broad as the head
    [0.18, 0.52, 0.39, 0.06, false],// legs, long and close together
    [0.14, 0.6, 0.07, 0, true],     // feet
    [0.85, 1.25, 0.68, 0.18, false],// arms, hanging almost to the floor
    [0.85, 1.3, 0.19, 0.03, true],  // hands
  ];

  for (let x = left; x <= right; x++) {
    if (x < 0 || x >= width) continue;
    if (depth[x] <= distance) continue;          // behind a wall

    const reach = Math.abs((x - cx) / half);

    /* Ragged fur, and a tone that shifts every few columns. Changing it on
       every column turns the body into pinstripes rather than fur. */
    const shag = (((x * 2654435761) ^ 0x9e3779b9) >>> 0) % 1000 / 1000;
    const clump = ((((x / 3 | 0) * 374761393) >>> 0) % 4);
    const fringe = tall * 0.018 * (shag - 0.5);
    const fur = hit > 0 ? blend(FUR_BLUE[clump], '#f87171', hit * 0.7) : FUR_BLUE[clump];
    const mitt = hit > 0 ? blend('#d98324', '#f87171', hit * 0.6) : '#d98324';

    g.globalAlpha = fade;

    PARTS.forEach(([from, until, top, bottom, orange], i) => {
      if (reach < from || reach > until) return;

      let hi = top;
      if (i === 0) {
        // The head falls away toward its edges rather than being a slab.
        const dome = Math.sqrt(Math.max(0, 1 - (reach / until) ** 2));
        hi = bottom + (top - bottom) * dome;
      }
      if (hi <= bottom) return;

      g.fillStyle = orange ? mitt : fur;
      g.fillRect(x, yAt(hi) + (orange ? 0 : fringe), 1,
        Math.max(1, tall * (hi - bottom) + 1));
    });

    g.globalAlpha = 1;
  }

  /* The face, from the same texture the 3D creature wears, so the two cannot
     drift apart. Depth-tested at the centre only: the head is narrow enough
     that a per-column test would not change what you see. */
  const slab = creatureFace();
  const mid = Math.round(cx);
  if (slab && wide > 14 && mid >= 0 && mid < width && depth[mid] > distance) {
    const size = wide * 1.2;
    g.globalAlpha = fade;
    g.drawImage(slab, 0, 0, FACE_TEX, FACE_TEX,
      cx - size / 2, yAt(0.82) - size / 2, size, size);
    g.globalAlpha = 1;
  }
}

// Mix two #rrggbb colours, for the flash when it takes a hit.
function blend(a, b, t) {
  const parse = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const k = Math.max(0, Math.min(1, t));
  return `rgb(${Math.round(ar + (br - ar) * k)}, ${Math.round(ag + (bg - ag) * k)}, ${Math.round(ab + (bb - ab) * k)})`;
}

function drawRaycast(g, maze, walker, pitch, width, height, monsters, recoil = 0) {
  const fov = (MAZE_FOV * Math.PI) / 180;
  const planeHalf = Math.tan(fov / 2);
  const project = width / 2 / planeHalf;         // world units to pixels at 1 away
  const horizon = height * 0.5 + pitch * height * 0.55;

  const dirX = Math.cos(walker.yaw);
  const dirY = Math.sin(walker.yaw);
  const planeX = -dirY * planeHalf;
  const planeY = dirX * planeHalf;

  // Dusk above the horizon, dark tiled ground below it.
  const sky = g.createLinearGradient(0, 0, 0, Math.max(1, horizon));
  sky.addColorStop(0, '#1d3f70');
  sky.addColorStop(0.2, '#2f568f');
  sky.addColorStop(0.45, '#6d9ad0');
  sky.addColorStop(0.66, '#a8c4dc');
  sky.addColorStop(0.8, '#cdd8dc');
  sky.addColorStop(0.92, '#e8c9a0');
  sky.addColorStop(1, '#f3b378');
  g.fillStyle = sky;
  g.fillRect(0, 0, width, Math.max(0, horizon));

  // Only the first few stars, high up where the sky is still dark.
  let star = 987654321;
  for (let i = 0; i < 40; i++) {
    star = (star * 1664525 + 1013904223) >>> 0;
    const sx = star % width;
    const sy = (star >>> 8) % Math.max(1, Math.floor(horizon * 0.4));
    g.fillStyle = `rgba(255, 255, 255, ${0.2 + ((star >>> 20) % 40) / 100})`;
    g.fillRect(sx, sy, 1, 1);
  }

  const ground = g.createLinearGradient(0, horizon, 0, height);
  ground.addColorStop(0, '#161a20');
  ground.addColorStop(1, '#3a4048');
  g.fillStyle = ground;
  g.fillRect(0, Math.max(0, horizon), width, height - Math.max(0, horizon));

  /* Where a point on the floor lands on screen. Returns null behind the
     camera. The monster and the exit are placed with the same maths. */
  const det = planeX * dirY - dirX * planeY;
  const floorPoint = (wx, wy) => {
    if (det === 0) return null;
    const relX = wx - walker.x;
    const relY = wy - walker.y;
    const camX = (dirY * relX - dirX * relY) / det;
    const camY = (-planeY * relX + planeX * relY) / det;
    if (camY <= 0.08) return null;
    return { x: (width / 2) * (1 + camX / camY), y: horizon + (EYE_HEIGHT / camY) * project };
  };

  /* Floor grout, laid on the world grid so it stays put as you walk rather
     than sliding along with you. Each line is sampled and stroked as a
     polyline: a straight world line stays straight under a perspective
     projection, so the sampling is only there to drop the part behind the
     camera. Drawn before the walls, which paint over whatever runs past them. */
  // Half-cell slabs, matching the 3D floor. Whole-cell ones put every grout
  // line under a wall in a one-cell-wide corridor, leaving the floor bare.
  // The reach is short because fog and walls hide anything further anyway,
  // and every extra ring costs two whole polylines a frame.
  const TILE = 0.5;
  const REACH = 16;
  const originX = Math.floor(walker.x / TILE) * TILE;
  const originY = Math.floor(walker.y / TILE) * TILE;
  g.strokeStyle = 'rgba(214, 226, 244, 0.13)';
  g.lineWidth = 1;
  for (let axis = 0; axis < 2; axis++) {
    for (let i = -REACH; i <= REACH; i++) {
      let drawing = false;
      g.beginPath();
      for (let s = -REACH; s <= REACH; s++) {
        const point = axis === 0
          ? floorPoint(originX + i * TILE, originY + s * TILE)
          : floorPoint(originX + s * TILE, originY + i * TILE);
        if (!point) { drawing = false; continue; }
        if (drawing) g.lineTo(point.x, point.y);
        else { g.moveTo(point.x, point.y); drawing = true; }
      }
      g.stroke();
    }
  }

  const depth = new Float64Array(width);

  /* Cast one ray every COLUMN_STEP pixels and fill that many pixels wide.
     Wall slices are vertical, so a two-pixel granularity on their edges is
     invisible, while halving the column count halves both the ray marching and
     — far more importantly — the number of fill calls the canvas has to
     service. At full width this loop was issuing tens of thousands of fills a
     frame, which no 2D canvas keeps up with. */
  const COLUMN_STEP = width > 1100 ? 3 : 2;
  const slab = brickSlab();

  for (let x = 0; x < width; x += COLUMN_STEP) {
    const cameraX = (2 * x) / width - 1;
    const rayX = dirX + planeX * cameraX;
    const rayY = dirY + planeY * cameraX;

    let mapX = Math.floor(walker.x);
    let mapY = Math.floor(walker.y);
    const deltaX = rayX === 0 ? Infinity : Math.abs(1 / rayX);
    const deltaY = rayY === 0 ? Infinity : Math.abs(1 / rayY);

    let stepX;
    let sideX;
    if (rayX < 0) { stepX = -1; sideX = (walker.x - mapX) * deltaX; }
    else { stepX = 1; sideX = (mapX + 1 - walker.x) * deltaX; }

    let stepY;
    let sideY;
    if (rayY < 0) { stepY = -1; sideY = (walker.y - mapY) * deltaY; }
    else { stepY = 1; sideY = (mapY + 1 - walker.y) * deltaY; }

    // Digital differential analysis: hop grid line to grid line.
    let hitVertical = false;
    let guard = 0;
    while (guard++ < 512) {
      if (sideX < sideY) { sideX += deltaX; mapX += stepX; hitVertical = true; }
      else { sideY += deltaY; mapY += stepY; hitVertical = false; }
      if (isWall(maze, mapX, mapY)) break;
    }

    const distance = Math.max(0.0001, hitVertical ? sideX - deltaX : sideY - deltaY);
    // Every pixel this ray stands for shares its depth, so the billboards
    // further down can still test any column they touch.
    for (let c = x; c < x + COLUMN_STEP && c < width; c++) depth[c] = distance;

    const top = horizon - ((WALL_HEIGHT - EYE_HEIGHT) / distance) * project;
    const bottom = horizon + (EYE_HEIGHT / distance) * project;

    /* Brickwork. Where along the wall face the ray landed decides which brick
       this column belongs to, so the courses run in a proper staggered bond
       rather than lining up. Faces along one axis are shaded darker, which is
       what makes corners legible, and everything fades into the night. */
    /* Matte, not glowing: the tones top out well below white and fade toward
       the dusk haze rather than toward black, so nothing looks lit from
       within. The two axes are shaded differently, which is what makes a
       corner read as a corner. */
    const fade = Math.min(1, distance / 22);
    const side = hitVertical ? 1 : 0.78;

    let wallX = hitVertical ? walker.y + distance * rayY : walker.x + distance * rayX;
    wallX -= Math.floor(wallX);

    const slice = Math.max(1, bottom - top + 1);

    /* One textured slice per column. The brick canvas already carries the
       bond, the joints, the bevels, the flecks and the contact shadow at the
       foot of the wall, all baked in — so this single call replaces the forty
       fills that painting each of those separately used to take. */
    if (slab) {
      const sx = Math.min(BRICK_TEX - 1, Math.floor(wallX * BRICK_TEX));
      g.drawImage(slab, sx, 0, 1, BRICK_TEX, x, top, COLUMN_STEP, slice);
    } else {
      // No offscreen canvas to slice: plain tone, so the maze still draws.
      const v = Math.round(206 * side * (1 - fade) + 150 * fade);
      g.fillStyle = `rgb(${v}, ${v}, ${Math.min(255, v + 6)})`;
      g.fillRect(x, top, COLUMN_STEP, slice);
    }

    /* Shading goes on as overlays, which is why the texture is painted at full
       brightness. Faces along one axis are darkened so corners stay legible,
       and everything washes toward the dusk haze with distance rather than
       toward black — nothing should look lit from within. */
    if (!hitVertical) {
      g.fillStyle = `rgba(28, 34, 46, ${(1 - side) * (1 - fade)})`;
      g.fillRect(x, top, COLUMN_STEP, slice);
    }
    if (fade > 0.02) {
      g.fillStyle = `rgba(150, 152, 158, ${fade * 0.85})`;
      g.fillRect(x, top, COLUMN_STEP, slice);
    }

    // Near the edge of a wall face, deepen the shade so corners stand out.
    const edge = Math.min(wallX, 1 - wallX);
    if (edge < 0.04) {
      g.fillStyle = `rgba(28, 34, 44, ${0.2 * (1 - edge / 0.04) * (1 - fade)})`;
      g.fillRect(x, top, COLUMN_STEP, slice);
    }

  }

  // The pack, billboarded and depth-tested like the exit.
  /* Furthest first, so a nearer one paints over the one behind it. Sorting a
     copy: the caller's array is the live game state. */
  const pack = (monsters || [])
    .filter((m) => !m.dead)
    .map((m) => ({ m, gap: Math.hypot(m.x - walker.x, m.y - walker.y) }))
    .sort((a, b) => b.gap - a.gap);

  for (const { m, gap } of pack) {
    const spot = floorPoint(m.x, m.y);
    if (!spot || gap <= 0.05) continue;
    const camY = (EYE_HEIGHT / (spot.y - horizon)) * project;
    const tall = (project / camY) * 1.45;
    drawCreature(g, spot.x, spot.y, tall * 0.42, tall, camY, depth, width, m.flinch);
  }

  // The exit, billboarded and depth-tested against the wall slices.
  const exit = floorPoint(maze.exit.x + 0.5, maze.exit.y + 0.5);
  if (exit && exit.y > horizon) {
    const camY = (EYE_HEIGHT / (exit.y - horizon)) * project;
    const size = (project / camY) * 0.85;

    for (let x = Math.floor(exit.x - size / 2); x < exit.x + size / 2; x++) {
      if (x < 0 || x >= width) continue;
      if (depth[x] <= camY) continue;                 // hidden behind a wall
      const edge = 1 - Math.abs((x - exit.x) / (size / 2));
      g.fillStyle = `rgba(74, 222, 128, ${0.35 + edge * 0.5})`;
      g.fillRect(x, exit.y - size * 1.5, 1, size * 1.5);
    }
  }

  // Your own gun, over everything else.
  drawGun(g, width, height, recoil);
}

/* ---------- the game module ---------- */

/* Fetches three.js once, on first use. Resolves to a reason string on failure
   rather than hanging: a script tag that never fires either event — a stalled
   or blocked fetch — would otherwise leave the game on "Loading…" forever. */
const THREE_TIMEOUT = 20000;
let threeLoading = null;

function loadThree() {
  if (typeof THREE !== 'undefined') return Promise.resolve(null);
  if (threeLoading) return threeLoading;

  threeLoading = new Promise((resolve) => {
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      resolve(reason);
    };

    const timer = setTimeout(
      () => finish('Timed out fetching the 3D engine.'), THREE_TIMEOUT);

    const tag = document.createElement('script');
    tag.src = THREE_SRC;
    tag.onload = () => {
      clearTimeout(timer);
      finish(typeof THREE === 'undefined' ? 'The 3D engine loaded but did not start.' : null);
    };
    tag.onerror = () => {
      clearTimeout(timer);
      finish(`Could not fetch ${THREE_SRC}.`);
    };

    document.head.appendChild(tag);
  });

  return threeLoading;
}

/* Textures, painted onto 2D canvases at load time — no image files, so the
   arcade stays a plain static page. Built once and shared by every level. */
let textures = null;

function paintCanvas(size, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  draw(canvas.getContext('2d'), size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

// A deterministic speckle, so bricks and tiles have grain without needing a
// photograph. Same input always gives the same dots.
const speckle = (g, x, y, w, h, count, alpha) => {
  g.fillStyle = `rgba(255, 255, 255, ${alpha})`;
  let n = ((x * 73856093) ^ (y * 19349663)) >>> 0;
  for (let i = 0; i < count; i++) {
    n = (n * 1664525 + 1013904223) >>> 0;
    const px = x + (n % w);
    const py = y + ((n >>> 9) % h);
    g.fillRect(px, py, 1, 1);
  }
};

// A deterministic 0..1 per position, for per-brick and per-tile variation.
const jitter = (a, b) => {
  let n = (((a + 1) * 374761393) ^ ((b + 1) * 668265263)) >>> 0;
  n = (n ^ (n >>> 13)) * 1274126177 >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
};

/* Brick: rectangles alternating between off-white and light grey, flecked
   with tiny white dots.

   The texture maps once over the full height of a wall, not tiled, so the
   shading baked in at the bottom lands where the wall meets the floor. That
   contact shadow is what stops corridors looking like flat cardboard, and it
   costs nothing at runtime — no lights, no shadow maps. */
function paintBrick(g, size) {
  const rows = 8;
  const cols = 4;
  const brickH = size / rows;
  const brickW = size / cols;

  // Mortar, deliberately uneven — a perfectly flat bed is the giveaway.
  g.fillStyle = '#8b9198';
  g.fillRect(0, 0, size, size);
  speckle(g, 0, 0, size, size, 500, 0.1);
  for (let i = 0; i < 260; i++) {
    const n = jitter(i, 7);
    const m = jitter(i, 13);
    g.fillStyle = `rgba(${100 + Math.round(n * 40)}, ${104 + Math.round(n * 38)}, 112, 0.3)`;
    g.fillRect(m * size, n * size, 1 + n * 3, 1 + m * 2);
  }

  for (let row = 0; row < rows; row++) {
    const offset = (row % 2) * 0.5;
    for (let i = -1; i < cols + 1; i++) {
      const x = Math.round((i + offset) * brickW);
      const y = Math.round(row * brickH);
      const w = Math.max(1, Math.round(brickW) - 3);
      const h = Math.max(1, Math.round(brickH) - 3);
      const rn = jitter(row, i);
      const rn2 = jitter(i, row + 31);

      /* Two base tones in a running bond, then every brick shifted in value
         AND in hue: real brick and stone vary warm to cool, not just light to
         dark, and a wall of pure greys is what reads as computer-generated. */
      const offWhite = (row + i) % 2 === 0;
      const aged = rn2 > 0.86;                  // the occasional much darker one
      const base = (offWhite ? 231 : 196) - (aged ? 34 : 0);
      const v = Math.round(base + (rn - 0.5) * 24);
      const warm = (rn2 - 0.5) * 12;            // + toward sand, - toward slate
      g.fillStyle = `rgb(${v + Math.round(warm)}, ${v + Math.round(warm * 0.3)}, ${v - Math.round(warm * 0.7)})`;
      g.fillRect(x + 2, y + 2, w, h);

      speckle(g, x + 2, y + 2, Math.max(1, w), Math.max(1, h), 18, offWhite ? 0.8 : 0.55);

      // A wash of blotching across the face, so no brick is one flat colour.
      for (let b = 0; b < 3 && w > 3 && h > 3; b++) {
        const bn = jitter(row * 7 + b, i * 5);
        const bm = jitter(i * 11 + b, row * 3);
        g.fillStyle = `rgba(${bn > 0.5 ? 255 : 92}, ${bn > 0.5 ? 253 : 96}, ${bn > 0.5 ? 246 : 104}, 0.07)`;
        g.beginPath();
        g.ellipse(x + 2 + bm * w, y + 2 + bn * h, w * 0.3, h * 0.42, bn * 3, 0, Math.PI * 2);
        g.fill();
      }

      // Bevel: light along the top and left, shadow along the bottom edge.
      g.fillStyle = 'rgba(255, 255, 255, 0.42)';
      g.fillRect(x + 2, y + 2, w, 1);
      g.fillRect(x + 2, y + 2, 1, h);
      g.fillStyle = 'rgba(74, 82, 92, 0.3)';
      g.fillRect(x + 2, y + h + 1, w, 1);
      g.fillRect(x + w + 1, y + 2, 1, h);

      // A chipped corner here and there, showing the mortar behind.
      if (rn > 0.9) {
        const cw = Math.max(2, w * 0.16);
        g.fillStyle = 'rgba(126, 132, 140, 0.85)';
        g.beginPath();
        g.moveTo(x + 2 + w - cw, y + h + 1);
        g.lineTo(x + 2 + w, y + h + 1);
        g.lineTo(x + 2 + w, y + h + 1 - cw);
        g.closePath();
        g.fill();
      }
    }
  }

  /* Grime running down from the bed joints. Water tracks down a wall and leaves
     stains under every horizontal joint, and that streaking is most of what
     separates weathered masonry from a clean tiling pattern. */
  for (let row = 1; row < rows; row++) {
    for (let i = 0; i < 7; i++) {
      const n = jitter(row * 17, i * 3);
      if (n > 0.55) continue;
      const x = n * size;
      const y = row * brickH;
      const run = brickH * (0.5 + n * 2.6);
      const streak = g.createLinearGradient(0, y, 0, y + run);
      streak.addColorStop(0, 'rgba(84, 88, 94, 0.3)');
      streak.addColorStop(1, 'rgba(84, 88, 94, 0)');
      g.fillStyle = streak;
      g.fillRect(x, y, 1 + n * 5, run);
    }
  }

  // Baked shading: dark where the wall meets the floor, a touch of shade up
  // under the capstone, and a wash of grime low down.
  const foot = g.createLinearGradient(0, size * 0.6, 0, size);
  foot.addColorStop(0, 'rgba(24, 30, 40, 0)');
  foot.addColorStop(1, 'rgba(22, 28, 38, 0.46)');
  g.fillStyle = foot;
  g.fillRect(0, size * 0.6, size, size * 0.4);

  const head = g.createLinearGradient(0, 0, 0, size * 0.13);
  head.addColorStop(0, 'rgba(40, 46, 56, 0.32)');
  head.addColorStop(1, 'rgba(40, 46, 56, 0)');
  g.fillStyle = head;
  g.fillRect(0, 0, size, size * 0.13);
}

function paintCap(g, size) {
  g.fillStyle = '#d5d7d4';
  g.fillRect(0, 0, size, size);
  speckle(g, 0, 0, size, size, 90, 0.7);
  // A weathered edge all the way round, so the tops read as capped stone
  // rather than as the cubes being cut off.
  g.fillStyle = 'rgba(110, 118, 126, 0.32)';
  g.fillRect(0, 0, size, 3);
  g.fillRect(0, size - 3, size, 3);
  g.fillRect(0, 0, 3, size);
  g.fillRect(size - 3, 0, 3, size);
  g.fillStyle = 'rgba(255, 255, 255, 0.3)';
  g.fillRect(3, 3, size - 6, 1);
}

// Floor: dark grey square tiles, also flecked with white.
function paintFloor(g, size) {
  const cells = 4;
  const step = size / cells;

  // Grout, uneven, with grit sitting in it.
  g.fillStyle = '#101318';
  g.fillRect(0, 0, size, size);
  speckle(g, 0, 0, size, size, 340, 0.07);

  for (let ty = 0; ty < cells; ty++) {
    for (let tx = 0; tx < cells; tx++) {
      const x = tx * step + 2;
      const y = ty * step + 2;
      const w = Math.max(1, step - 4);
      const n = jitter(tx, ty);
      const n2 = jitter(tx + 17, ty + 5);

      // Each slab a different cast — poured concrete never matches its
      // neighbour, and four identical greys read as vinyl.
      const shade = 52 + ((tx + ty) % 2) * 7 + Math.round(n * 10);
      const cool = Math.round((n2 - 0.5) * 7);
      g.fillStyle = `rgb(${shade - cool}, ${shade + 1}, ${shade + 5 + cool})`;
      g.fillRect(x, y, w, w);

      // Blotching across the face, at a bigger scale than the grain.
      for (let b = 0; b < 4 && w > 3; b++) {
        const bn = jitter(tx * 13 + b, ty * 7);
        const bm = jitter(ty * 11 + b, tx * 3);
        g.fillStyle = bn > 0.5
          ? `rgba(200, 210, 226, ${0.03 + bn * 0.03})`
          : `rgba(4, 7, 12, ${0.05 + bn * 0.06})`;
        g.beginPath();
        g.ellipse(x + bm * w, y + bn * w, w * 0.34, w * 0.26, bn * 3, 0, Math.PI * 2);
        g.fill();
      }

      speckle(g, x, y, w, w, 30, 0.45);

      /* A hairline crack across some slabs, wandering rather than straight.
         One crooked line does more for a concrete floor than any amount of
         extra grain. */
      if (n2 > 0.62) {
        g.strokeStyle = 'rgba(6, 9, 14, 0.5)';
        g.lineWidth = 1;
        g.beginPath();
        let cx = x + n * w;
        let cy = y;
        g.moveTo(cx, cy);
        for (let seg = 1; seg <= 6; seg++) {
          cx += (jitter(tx + seg, ty * 3) - 0.5) * w * 0.4;
          cy += w / 6;
          g.lineTo(cx, cy);
        }
        g.stroke();
      }

      // Each slab catches a little light along its top-left corner.
      g.fillStyle = 'rgba(226, 232, 240, 0.1)';
      g.fillRect(x, y, w, 1);
      g.fillRect(x, y, 1, w);
      g.fillStyle = 'rgba(6, 9, 14, 0.38)';
      g.fillRect(x, y + w - 1, w, 1);
      g.fillRect(x + w - 1, y, 1, w);
    }
  }

  // A couple of damp patches, spanning slabs and ignoring the grid.
  for (let i = 0; i < 3; i++) {
    const n = jitter(i * 29, 41);
    const m = jitter(i * 13, 91);
    const damp = g.createRadialGradient(m * size, n * size, 2, m * size, n * size, size * 0.22);
    damp.addColorStop(0, 'rgba(2, 5, 10, 0.3)');
    damp.addColorStop(1, 'rgba(2, 5, 10, 0)');
    g.fillStyle = damp;
    g.fillRect(0, 0, size, size);
  }
}

/* Dusk: the light is still up, but night is coming. Deep blue overhead
   warming through to a golden horizon, with only the first few stars high
   up rather than a full night sky. */
function paintSky(g, size) {
  /* More stops than a sky strictly needs. Real twilight is not a linear ramp —
     it holds its blue, then turns quickly through green-grey into the warm band
     just above the horizon, and a three-stop gradient shows its seams. */
  const grad = g.createLinearGradient(0, 0, 0, size);
  grad.addColorStop(0, '#1d3f70');
  grad.addColorStop(0.18, '#2f568f');
  grad.addColorStop(0.4, '#6d9ad0');
  grad.addColorStop(0.58, '#a8c4dc');
  grad.addColorStop(0.7, '#cdd8dc');
  grad.addColorStop(0.8, '#e8c9a0');
  grad.addColorStop(0.9, '#f3b378');
  grad.addColorStop(1, '#ef9a5e');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);

  // Stars, only in the darker upper band, a few of them bright.
  let n = 987654321;
  for (let i = 0; i < 140; i++) {
    n = (n * 1664525 + 1013904223) >>> 0;
    const x = n % size;
    const y = (n >>> 7) % Math.floor(size * 0.34);
    const high = 1 - y / (size * 0.34);
    const bright = (0.15 + ((n >>> 20) % 50) / 100) * high;
    g.fillStyle = `rgba(255, 255, 255, ${bright})`;
    const big = ((n >>> 15) % 100) > 94;
    if (big) {
      // A handful get a cross of light rather than a single pixel.
      g.fillRect(x - 1, y, 3, 1);
      g.fillRect(x, y - 1, 1, 3);
    } else {
      g.fillRect(x, y, 1, 1);
    }
  }

  // The sun just going down: a tight core inside a wide bloom.
  const sunX = size * 0.7;
  const sunY = size * 0.8;
  const bloom = g.createRadialGradient(sunX, sunY, 4, sunX, sunY, size * 0.42);
  bloom.addColorStop(0, 'rgba(255, 236, 196, 0.75)');
  bloom.addColorStop(0.25, 'rgba(255, 214, 150, 0.28)');
  bloom.addColorStop(1, 'rgba(255, 200, 140, 0)');
  g.fillStyle = bloom;
  g.fillRect(0, 0, size, size);

  g.fillStyle = 'rgba(255, 246, 220, 0.85)';
  g.beginPath();
  g.arc(sunX, sunY, size * 0.028, 0, Math.PI * 2);
  g.fill();

  /* Cloud banks, built up from several passes of decreasing size and rising
     opacity. Soft edges are the whole point: one flat ellipse reads as a
     lozenge no matter how you shape it, and stacked translucent passes give the
     fall-off that makes it read as vapour. */
  let c = 24680;
  for (let i = 0; i < 18; i++) {
    c = (c * 1664525 + 1013904223) >>> 0;
    const cx = c % size;
    const cy = size * 0.36 + ((c >>> 8) % Math.floor(size * 0.46));
    const cw = 42 + ((c >>> 16) % 96);
    const warmth = Math.min(1, Math.max(0, (cy / size - 0.36) / 0.46));
    const lobes = [];
    for (let lobe = 0; lobe < 6; lobe++) {
      c = (c * 1664525 + 1013904223) >>> 0;
      lobes.push([
        (lobe / 5 - 0.5) * cw * 1.7,
        ((c >>> 4) % 11) - 5,
        cw * (0.26 + ((c >>> 12) % 32) / 100),
        0.14 + ((c >>> 22) % 12) / 100,
      ]);
    }

    for (const [scale, alpha] of [[1.25, 0.1], [1, 0.16], [0.7, 0.2], [0.42, 0.22]]) {
      const top = `rgba(238, 245, 255, ${alpha * (1 - warmth * 0.35)})`;
      const under = `rgba(255, ${Math.round(206 + warmth * 34)}, ${Math.round(168 + warmth * 20)}, ${alpha * (0.5 + warmth)})`;
      const band = g.createLinearGradient(0, cy - cw * 0.2, 0, cy + cw * 0.2);
      band.addColorStop(0, top);
      band.addColorStop(1, under);
      g.fillStyle = band;

      g.beginPath();
      for (const [ox, oy, rx, squash] of lobes) {
        const w = rx * scale;
        const h = rx * squash * scale;
        g.moveTo(cx + ox * scale + w, cy + oy - cw * 0.03 * (1 - scale));
        g.ellipse(cx + ox * scale, cy + oy - cw * 0.03 * (1 - scale), w, h, 0, 0, Math.PI * 2);
      }
      g.fill();
    }
  }

  // A brighter band sitting on the horizon, where the air is thickest.
  const haze = g.createLinearGradient(0, size * 0.86, 0, size);
  haze.addColorStop(0, 'rgba(255, 226, 186, 0)');
  haze.addColorStop(1, 'rgba(255, 226, 186, 0.42)');
  g.fillStyle = haze;
  g.fillRect(0, size * 0.86, size, size * 0.14);
}

/* The creature's face, on a transparent square.

   Painted once and used by both renderers — mapped onto a plane on the front of
   the head in 3D, blitted onto the silhouette in the 2D fallback — so the two
   cannot drift apart. It is also the only part of it with any fine detail, and
   a texture is far cheaper than a mesh per tooth. */
function paintFace(g, size) {
  const cx = size / 2;

  // Eyes: white domes, black pupils, a thin dark rim so they read against fur.
  for (const side of [-1, 1]) {
    const ex = cx + side * size * 0.15;
    const ey = size * 0.3;
    g.fillStyle = '#0b1220';
    g.beginPath();
    g.ellipse(ex, ey, size * 0.115, size * 0.115, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#f8fafc';
    g.beginPath();
    g.ellipse(ex, ey, size * 0.1, size * 0.1, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#0b1220';
    g.beginPath();
    g.ellipse(ex + side * size * 0.012, ey + size * 0.012, size * 0.052, size * 0.058, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255, 255, 255, 0.9)';
    g.beginPath();
    g.ellipse(ex - size * 0.03, ey - size * 0.032, size * 0.018, size * 0.014, 0, 0, Math.PI * 2);
    g.fill();
  }

  // The grin: a wide red muzzle ring, a black gullet, and two rows of teeth.
  const my = size * 0.58;
  const mw = size * 0.34;
  const mh = size * 0.19;

  g.fillStyle = '#e11d48';
  g.beginPath();
  g.ellipse(cx, my, mw, mh, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fb7185';                       // lighter inner lip
  g.beginPath();
  g.ellipse(cx, my, mw * 0.9, mh * 0.86, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#0a0a0c';
  g.beginPath();
  g.ellipse(cx, my, mw * 0.76, mh * 0.7, 0, 0, Math.PI * 2);
  g.fill();

  /* Teeth as triangles hung from the lips, their length following the curve of
     the mouth so the middle ones are longest — which is what makes a row of
     spikes read as a jaw rather than as a comb. */
  const teeth = 11;
  const span = mw * 1.34;
  for (let i = 0; i < teeth; i++) {
    const t = (i + 0.5) / teeth;
    const tx = cx - span / 2 + span * t;
    const curve = Math.sin(t * Math.PI);
    const lip = mh * 0.7 * Math.sqrt(Math.max(0, 1 - ((tx - cx) / (mw * 0.76)) ** 2));
    if (lip <= 0) continue;
    const long = mh * 0.52 * curve;
    const wide = span / teeth * 0.42;

    for (const dir of [-1, 1]) {
      g.fillStyle = dir < 0 ? '#f8fafc' : '#e2e8f0';
      g.beginPath();
      g.moveTo(tx - wide, my + dir * lip);
      g.lineTo(tx + wide, my + dir * lip);
      g.lineTo(tx, my + dir * (lip - long));
      g.closePath();
      g.fill();
    }
  }
}

/* The gun, as you hold it: seen from behind and above, pointing away up and to
   the left out of the bottom-right corner of the screen.

   Drawn blocky on purpose — laid out on a coarse grid as a character map, one
   filled square per cell, no curves and no gradients. Reading it off a picture
   rather than out of a list of drawing calls makes it far easier to change: to
   move the sight, move the S.

   Painted once onto a transparent square and used by both renderers, the same
   trick as the creature's face — a plane pinned to the camera in 3D, a blit
   into the corner in the 2D fallback — so there is one drawing of it rather
   than two that drift. */
const GUN_PIXELS = [
  '................',
  '..S.............',
  '.MSS............',
  '.MM=BB..........',
  '..MMBBBB........',
  '...=bBBBBB......',
  '....==bBBBBB....',
  '......==bBBBb...',
  '........==BBBb..',
  '.........gBBBb..',
  '.........gGGGb..',
  '........ggGGGG..',
  '.......HHhGGGG..',
  '......HHHHhGGa..',
  '.....HHHHHhaaaa.',
  '......HHHhaaaaaa',
];

const GUN_INK = {
  S: '#3d4348',   // front sight
  M: '#1b1f23',   // muzzle
  B: '#a8b1b7',   // slide, lit
  b: '#5c646a',   // slide, shaded
  '=': '#cbd3d8', // highlight along the top
  g: '#2f2a25',   // frame and trigger guard
  G: '#25201c',   // grip
  H: '#d98324',   // glove
  h: '#c2741f',   // glove, shaded
  a: '#7c4a21',   // forearm
};

function paintGun(g, size) {
  const cells = GUN_PIXELS.length;
  const step = size / cells;

  for (let row = 0; row < cells; row++) {
    for (let col = 0; col < GUN_PIXELS[row].length; col++) {
      const ink = GUN_INK[GUN_PIXELS[row][col]];
      if (!ink) continue;
      g.fillStyle = ink;
      // Ceil, so neighbouring cells meet with no hairline of background.
      g.fillRect(Math.floor(col * step), Math.floor(row * step),
        Math.ceil(step), Math.ceil(step));
    }
  }
}

let gunSlab = null;

function gunCanvas() {
  if (gunSlab !== null) return gunSlab;
  gunSlab = false;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = GUN_TEX;
    canvas.height = GUN_TEX;
    const g = canvas.getContext('2d');
    if (g) {
      paintGun(g, GUN_TEX);
      gunSlab = canvas;
    }
  } catch {
    gunSlab = false;
  }
  return gunSlab;
}

/* The gun in the corner of the 2D view. Recoil runs 0..1 and kicks it down and
   back, which is what makes a shot feel like it left the barrel. */
function drawGun(g, width, height, recoil = 0) {
  const slab = gunCanvas();
  if (!slab) return;

  /* Sized off the shorter edge as well as the wider one, and anchored so the
     weapon reads whole with only the forearm running off the corner. */
  const size = Math.max(150, Math.min(width * 0.34, height * 0.62));
  const kick = recoil * size * 0.1;
  g.drawImage(slab, 0, 0, GUN_TEX, GUN_TEX,
    width - size * 0.96 + kick * 0.5, height - size * 0.96 + kick, size, size);
}

let faceSlab = null;

// The same face on a plain canvas, for the fallback to blit.
function creatureFace() {
  if (faceSlab !== null) return faceSlab;
  faceSlab = false;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = FACE_TEX;
    canvas.height = FACE_TEX;
    const g = canvas.getContext('2d');
    if (g) {
      paintFace(g, FACE_TEX);
      faceSlab = canvas;
    }
  } catch {
    faceSlab = false;
  }
  return faceSlab;
}

/* Shaggy blue fur: vertical streaks in a handful of tones, so the body has
   direction to it rather than being one flat colour. */
function paintFur(g, size) {
  g.fillStyle = '#1d63a8';
  g.fillRect(0, 0, size, size);

  let n = 5150;
  for (let i = 0; i < 900; i++) {
    n = (n * 1664525 + 1013904223) >>> 0;
    const x = n % size;
    const y = (n >>> 9) % size;
    const len = 8 + ((n >>> 18) % 34);
    const tone = (n >>> 5) % 4;
    g.fillStyle = ['#2b7fc9', '#14507f', '#3a97dd', '#0f4272'][tone];
    g.fillRect(x, y, 1 + ((n >>> 22) % 2), len);
  }
}

/* A normal map for the brickwork, derived from the same layout the colour map
   uses: bricks stand proud, joints are recessed. Encoded the usual way — the
   surface slope in x and y as red and green, with blue near full — so the walls
   catch the light along every joint instead of being flat panels with a picture
   of brick on them. */
function paintBrickNormal(g, size) {
  const rows = 8;
  const cols = 4;
  const brickH = size / rows;
  const brickW = size / cols;
  const edge = Math.max(2, Math.round(brickH * 0.16));

  g.fillStyle = 'rgb(128, 128, 255)';             // flat, facing straight out
  g.fillRect(0, 0, size, size);

  for (let row = 0; row < rows; row++) {
    const offset = (row % 2) * 0.5;
    for (let i = -1; i < cols + 1; i++) {
      const x = Math.round((i + offset) * brickW);
      const y = Math.round(row * brickH);
      const w = Math.round(brickW) - 3;
      const h = Math.round(brickH) - 3;

      for (let e = 0; e < edge; e++) {
        const slope = Math.round(110 * (1 - e / edge));   // steepest at the joint
        // Top edge tips up, bottom edge tips down.
        g.fillStyle = `rgb(128, ${128 + slope}, 235)`;
        g.fillRect(x + 2, y + 2 + e, w, 1);
        g.fillStyle = `rgb(128, ${128 - slope}, 235)`;
        g.fillRect(x + 2, y + h + 1 - e, w, 1);
        // Left edge tips left, right edge tips right.
        g.fillStyle = `rgb(${128 - slope}, 128, 235)`;
        g.fillRect(x + 2 + e, y + 2, 1, h);
        g.fillStyle = `rgb(${128 + slope}, 128, 235)`;
        g.fillRect(x + w + 1 - e, y + 2, 1, h);
      }
    }
  }
}

/* Wrapped as three.js textures for the WebGL scene. */
function makeTextures() {
  if (textures) return textures;

  const brick = paintCanvas(BRICK_TEX, paintBrick);
  const relief = paintCanvas(BRICK_TEX, paintBrickNormal);
  const cap = paintCanvas(64, paintCap);
  const floor = paintCanvas(256, paintFloor);
  const fur = paintCanvas(128, paintFur);
  const face = paintCanvas(FACE_TEX, paintFace);
  const gun = paintCanvas(GUN_TEX, paintGun);
  const sky = paintCanvas(512, paintSky);
  sky.wrapS = THREE.ClampToEdgeWrapping;
  sky.wrapT = THREE.ClampToEdgeWrapping;
  face.wrapS = THREE.ClampToEdgeWrapping;
  face.wrapT = THREE.ClampToEdgeWrapping;
  gun.wrapS = THREE.ClampToEdgeWrapping;
  gun.wrapT = THREE.ClampToEdgeWrapping;
  // Blocky on purpose: smoothing it back out defeats the point.
  gun.magFilter = THREE.NearestFilter;
  gun.minFilter = THREE.NearestFilter;
  gun.generateMipmaps = false;

  textures = { brick, relief, cap, floor, fur, face, gun, sky };
  return textures;
}

/* The same brickwork on a plain canvas, for the 2D fallback to cut column
   slices out of with drawImage.

   Painting a wall slice feature by feature — bond, bed joint, two bevels,
   perpend, contact shading — came to forty fill calls per screen column, which
   is tens of thousands a frame and more than a 2D canvas will service at sixty
   frames a second. One textured slice per column replaces the lot, and carries
   more detail than the hand-drawn version did. */
let flatSkin = null;

function brickSlab() {
  if (flatSkin !== null) return flatSkin;
  flatSkin = false;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = BRICK_TEX;
    canvas.height = BRICK_TEX;
    const g = canvas.getContext('2d');
    if (g) {
      paintBrick(g, BRICK_TEX);
      flatSkin = canvas;
    }
  } catch {
    flatSkin = false;   // no 2D canvas available; callers fall back to flat tone
  }
  return flatSkin;
}

/* The monster model, fetched and prepared once for the whole page.

   Resolves to null rather than rejecting when it cannot be had: opened from a
   file:// page a fetch of a sibling file is blocked outright, and the maze has
   to stay playable, so the caller falls back to the creature built out of
   primitives. */
let monsterModelLoad = null;

function loadMonsterModel() {
  if (monsterModelLoad) return monsterModelLoad;

  monsterModelLoad = loadGLB(MONSTER_MODEL, {
    pose: (name) => {
      if (name === 'ShoulderL') return matRotateZ(MONSTER_SHOULDER);
      if (name === 'ShoulderR') return matRotateZ(-MONSTER_SHOULDER);
      return null;
    },
  }).then((model) => {
    /* Stand it on the floor at the right height. The offset is scaled because
       a node's position is in its parent's units, applied after its own scale
       rather than before. */
    const box = model.userData.bounds;
    const scale = MONSTER_HEIGHT / (box.max[1] - box.min[1]);
    model.scale.setScalar(scale);
    model.position.set(
      -((box.min[0] + box.max[0]) / 2) * scale,
      -box.min[1] * scale,
      -((box.min[2] + box.max[2]) / 2) * scale);
    return model;
  }).catch(() => null);

  return monsterModelLoad;
}

/* Is WebGL usable? Answered once and remembered.

   The probe has to give its context straight back. A browser only allows a
   handful of live WebGL contexts (around 16), and a probe canvas that is
   dropped without being released still holds one — so asking this question on
   every visit slowly used them all up, after which creating the real renderer
   started failing. */
let webglSupport = null;

function webglAvailable() {
  if (webglSupport !== null) return webglSupport;

  try {
    if (!window.WebGLRenderingContext) {
      webglSupport = false;
      return false;
    }
    const probe = document.createElement('canvas');
    const gl = probe.getContext('webgl') || probe.getContext('experimental-webgl');
    if (gl && gl.getExtension) {
      const release = gl.getExtension('WEBGL_lose_context');
      if (release) release.loseContext();
    }
    webglSupport = Boolean(gl);
  } catch {
    webglSupport = false;
  }

  return webglSupport;
}

function mountMaze(ctx) {
  let course = MAZE_COURSES[1];
  let level = 0;                     // which maze of the course you are on
  let maze = buildMaze(course.levels[0], course.levels[0]);
  let walker = createWalker(maze);
  let courseDone = false;
  let monsters = [];
  let packSize = MAZE_PACKS[0];
  let stalker = null;
  let dead = false;
  let health = PLAYER_HEALTH;
  let kills = 0;
  let shotTimer = 0;                       // counts down to the next shot
  let flash = 0;                           // muzzle flash, seconds remaining
  let recoil = 0;                          // 1 the instant a shot goes off, easing to 0
  let gunMesh = null;                       // the one you are holding
  let killer = null;                        // whichever of them finished you
  let deathTurn = 0;                        // how far through looking at it
  const sprint = { value: STAMINA_MAX, active: false };
  const drive = {                          // what stepWalker is actually given
    forward: false, back: false, left: false, right: false,
    strafeLeft: false, strafeRight: false, sprint: false,
  };
  let footfall = 0;
  let mapAge = MINIMAP_PERIOD;   // draw on the first frame
  const lastFoot = { x: null, y: null };
  let scene = null;
  let camera = null;
  let renderer = null;
  let walls = null;
  let coping = null;
  let reveal = null;
  let torch = null;
  let exitPillar = null;
  let exitGlow = null;
  let creatures = [];       // one group per monster, paired by index
  let monsterModel = null;  // the supplied .glb, once it has arrived
  let pitch = 0;          // mouse look up/down, radians
  let mouseLook = false;  // only true while the pointer is locked
  let flatCanvas = null;  // the 2D fallback view, when WebGL is unavailable
  let flat = null;
  let frame = null;
  let lastTime = 0;
  let seconds = 0;
  let running = false;
  let bob = 0;
  let destroyed = false;
  const input = {
    forward: false, back: false, left: false, right: false,
    strafeLeft: false, strafeRight: false, sprint: false,
  };

  const bestKey = () => `maze-best-${course.id}`;
  const sizeLabel = () => `${course.levels[level]}x${course.levels[level]}`;
  const whereAmI = () => `Maze ${level + 1} of ${course.levels.length} · ${sizeLabel()}`;
  const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  /* ---------- chrome ---------- */

  const courseRow = segmented(
    MAZE_COURSES.map((c) => ({ id: c.id, label: `${c.label} (${c.levels[0]}–${c.levels[c.levels.length - 1]})` })),
    course.id, (id) => { course = courseById(id); restart(); },
    { ariaLabel: 'Maze size' });

  const packRow = segmented(
    MAZE_PACKS.map((n) => ({ id: String(n), label: `×${n}` })),
    String(packSize), (id) => { packSize = Number(id); restart(); },
    { ariaLabel: 'How many monsters' });

  const packNote = document.createElement('p');
  packNote.className = 'fieldnote';
  packNote.textContent = 'How many are hunting you';

  const scoreRow = statRow([
    { key: 'level', label: 'Maze', value: '1', tone: 'x' },
    { key: 'time', label: 'Total Time', value: '0:00', tone: 'muted' },
    { key: 'left', label: 'Shortest Route', value: '—', tone: 'muted' },
    { key: 'kills', label: 'Put Down', value: '0', tone: 'x' },
    { key: 'best', label: 'Best Run', value: '—', tone: 'o' },
  ]);

  const view = document.createElement('div');
  view.className = 'viewport';


  const pad = dpad((dir) => setInput(dir, true), { onRelease: (dir) => setInput(dir, false) });

  // Overlaid on the view in both renderers, at a fixed size so it stays
  // legible windowed and does not balloon in fullscreen.
  const MINIMAP_PX = 220;
  const minimap = document.createElement('canvas');
  minimap.className = 'minimap';
  minimap.width = MINIMAP_PX;
  minimap.height = MINIMAP_PX;
  const map2d = minimap.getContext('2d');

  /* The HUD lives in the DOM rather than being painted into the canvas, so one
     copy serves both renderers and it stays crisp in fullscreen, where the
     canvas itself is drawn at less than screen resolution. */
  function meter(kind, label) {
    const el = document.createElement('div');
    el.className = `gauge gauge--${kind}`;
    const name = document.createElement('span');
    name.className = 'gauge__label';
    name.textContent = label;
    const track = document.createElement('span');
    track.className = 'gauge__track';
    const fill = document.createElement('span');
    fill.className = 'gauge__fill';
    track.append(fill);
    el.append(name, track);
    return {
      el,
      label: name,
      set(fraction, dim) {
        fill.style.width = `${(Math.max(0, Math.min(1, fraction)) * 100).toFixed(1)}%`;
        el.classList.toggle('is-dim', Boolean(dim));
        el.classList.toggle('is-low', fraction < 0.3);
      },
    };
  }

  const healthBar = meter('health', 'You');
  const sprintBar = meter('sprint', 'Sprint');
  const foeBar = meter('foe', 'Searching');
  const foeLabel = foeBar.label;

  const hud = document.createElement('div');
  hud.className = 'hud';
  hud.append(healthBar.el, sprintBar.el, foeBar.el);

  // Crosshair, and the muzzle flash that blooms behind it on every shot.
  const sight = document.createElement('div');
  sight.className = 'sight';

  /* The death screen, inside the viewport rather than in the page chrome, so it
     is still there when you die in fullscreen — which is where you will spend
     most of your time. */
  const gameOver = document.createElement('div');
  gameOver.className = 'gameover';
  gameOver.hidden = true;

  const goneTitle = document.createElement('p');
  goneTitle.className = 'gameover__title';
  goneTitle.textContent = 'YOU DIED';

  const goneLine = document.createElement('p');
  goneLine.className = 'gameover__line';

  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'gameover__btn';
  retryBtn.textContent = 'Retry';
  retryBtn.addEventListener('click', (event) => {
    event.stopPropagation();     // the view below fires the gun on mousedown
    restart();
  });

  gameOver.append(goneTitle, goneLine, retryBtn);

  /* The foe bar tracks whichever one you are pointing at, and the nearest one
     when you are pointing at none — so shooting into a pack always shows you
     the health of the thing you are actually hitting. */
  function refreshBars(closeness) {
    healthBar.set(health / PLAYER_HEALTH);
    sprintBar.set(sprint.value / STAMINA_MAX, !sprint.active && sprint.value < SPRINT_FLOOR);

    const aimed = pickTarget(maze, walker, monsters);
    const shown = aimed || nearestMonster(monsters, walker);
    const hunting = monsters.some((m) => !m.dead && m.mode === 'hunt');
    foeBar.set(shown ? shown.health / MONSTER_HEALTH : 0,
      !shown || (!aimed && !hunting && closeness < 0.12));
    foeBar.el.classList.toggle('is-hunting', hunting);
    foeLabel.textContent = hunting ? 'Hunting' : 'Searching';

    sight.classList.toggle('is-firing', flash > 0);
    sight.classList.toggle('is-ready', shotTimer <= 0);
    sight.classList.toggle('is-on-target', Boolean(aimed));
  }

  // Shown in place of the 3D view when it cannot start.
  function fallbackNote(reason) {
    const note = document.createElement('p');
    note.className = 'viewport__note';
    note.textContent = reason || 'The 3D view needs WebGL, which this browser has not enabled.';
    return note;
  }

  ctx.settings.append(courseRow.el, packRow.el, packNote);
  ctx.score.append(scoreRow.el);
  const fireRow = document.createElement('div');
  fireRow.className = 'holdrow';
  const fireBtn = document.createElement('button');
  fireBtn.type = 'button';
  fireBtn.className = 'holdrow__btn holdrow__btn--fire';
  fireBtn.textContent = 'Fire';
  fireBtn.addEventListener('click', () => fire());
  fireRow.append(fireBtn);

  ctx.stage.append(view, pad, fireRow);
  ctx.controls.append(buttonRow([{ label: 'New Run', onClick: restart }]));
  // The shell's fullscreen button drives the 3D view rather than the whole
  // page, so going fullscreen also grabs the pointer for mouse look.
  ctx.setFullscreenTarget(view);
  ctx.setTheme('maze');
  ctx.setHint('W S walk · A D strafe · space sprint (loud!) · click or F to shoot · ⛶ mouse look');

  function setInput(dir, down) {
    if (dir === 'up') input.forward = down;
    else if (dir === 'down') input.back = down;
    else if (dir === 'left') input.left = down;
    else if (dir === 'right') input.right = down;
    else if (dir === 'strafeLeft') input.strafeLeft = down;
    else if (dir === 'strafeRight') input.strafeRight = down;
    else if (dir === 'sprint') input.sprint = down;
  }

  /* ---------- three.js scene ---------- */

  function buildScene() {
    if (scene) disposeScene();

    const skin = makeTextures();

    scene = new THREE.Scene();
    // Fog tinted to the dusk horizon, and pushed well back: seeing a long way
    // down a corridor is most of what sells the depth.
    scene.fog = new THREE.Fog(0xc9b79c, 14, 80);

    camera = new THREE.PerspectiveCamera(MAZE_FOV, 16 / 10, 0.05, 220);

    // Sky: a big sphere seen from the inside, unaffected by fog.
    const skyDome = new THREE.Mesh(
      new THREE.SphereGeometry(110, 32, 20),
      new THREE.MeshBasicMaterial({ map: skin.sky, side: THREE.BackSide, fog: false }));
    skyDome.position.set(maze.w / 2, 0, maze.h / 2);
    scene.add(skyDome);

    const wallGeometry = new THREE.BoxGeometry(1, WALL_HEIGHT, 1);
    /* Phong rather than Lambert, for the normal map: every joint and bevel in
       the brickwork then catches the light as real relief instead of being a
       photograph of brick on a flat panel. It is the single biggest thing that
       makes the corridors read as three-dimensional, and it costs one texture
       rather than any extra geometry. */
    const brickSide = new THREE.MeshPhongMaterial({
      map: skin.brick,
      normalMap: skin.relief,
      normalScale: new THREE.Vector2(0.85, 0.85),
      shininess: 6,
      specular: 0x2a2f36,
      color: 0xffffff,
    });
    const brickTop = new THREE.MeshLambertMaterial({ map: skin.cap, color: 0xffffff });
    // BoxGeometry face order is +x, -x, +y, -y, +z, -z — index 2 is the top,
    // which is on show now there is no ceiling.
    const wallMaterial = [brickSide, brickSide, brickTop, brickTop, brickSide, brickSide];

    // One InstancedMesh for every wall block: thousands of cubes in a single
    // draw call, which keeps even the largest maze smooth.
    const blocks = [];
    for (let y = 0; y < maze.h; y++) {
      for (let x = 0; x < maze.w; x++) {
        if (isWall(maze, x, y)) blocks.push([x, y]);
      }
    }

    walls = new THREE.InstancedMesh(wallGeometry, wallMaterial, blocks.length);
    const placer = new THREE.Object3D();
    const tint = new THREE.Color();

    blocks.forEach(([x, y], i) => {
      placer.position.set(x + 0.5, WALL_HEIGHT / 2, y + 0.5);
      placer.updateMatrix();
      walls.setMatrixAt(i, placer.matrix);

      // A whisper of per-block variation so a long run of wall does not read
      // as one flat repeat. Kept subtle: the bricks should blend, not stripe.
      const noise = (((x * 73856093) ^ (y * 19349663)) >>> 0) % 100 / 100;
      const shade = 0.93 + noise * 0.09;
      tint.setRGB(shade, shade, shade);
      walls.setColorAt(i, tint);
    });

    walls.instanceMatrix.needsUpdate = true;
    if (walls.instanceColor) walls.instanceColor.needsUpdate = true;
    scene.add(walls);

    /* A coping course capping every wall: a little wider than the wall, a
       little paler, with a shadow line under its overhang. It is what turns a
       row of cubes into built architecture, and because it is one instanced
       mesh with a single material it is one more draw call for the lot. */
    coping = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.13, 0.09, 1.13),
      new THREE.MeshPhongMaterial({ color: 0xdfe3e6, shininess: 18, specular: 0x3a4048 }),
      blocks.length);

    blocks.forEach(([x, y], i) => {
      placer.position.set(x + 0.5, WALL_HEIGHT + 0.02, y + 0.5);
      placer.updateMatrix();
      coping.setMatrixAt(i, placer.matrix);
    });
    coping.instanceMatrix.needsUpdate = true;
    scene.add(coping);

    // And a dark reveal in the shade of that overhang.
    reveal = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1.04, 0.05, 1.04),
      new THREE.MeshBasicMaterial({ color: 0x3d444c }),
      blocks.length);

    blocks.forEach(([x, y], i) => {
      placer.position.set(x + 0.5, WALL_HEIGHT - 0.04, y + 0.5);
      placer.updateMatrix();
      reveal.setMatrixAt(i, placer.matrix);
    });
    reveal.instanceMatrix.needsUpdate = true;
    scene.add(reveal);

    // Floor tiles, one per grid square. The texture holds a 2x2 block, so the
    // repeat is half the maze in each direction.
    const floorTexture = skin.floor.clone();
    floorTexture.needsUpdate = true;
    floorTexture.wrapS = THREE.RepeatWrapping;
    floorTexture.wrapT = THREE.RepeatWrapping;
    floorTexture.repeat.set(maze.w / 2, maze.h / 2);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(maze.w, maze.h),
      // A wide, weak highlight: sealed concrete rather than matte grit, which
      // is what gives the floor a direction under the sky.
      new THREE.MeshPhongMaterial({
        map: floorTexture, color: 0xffffff, shininess: 26, specular: 0x2d3646,
      }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(maze.w / 2, 0, maze.h / 2);
    scene.add(floor);

    // No ceiling — the maze is open to the sky.

    // The exit: a glowing pillar you can pick out from down a corridor.
    exitPillar = new THREE.Mesh(
      new THREE.BoxGeometry(0.62, WALL_HEIGHT * 0.95, 0.62),
      new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.6 }));
    exitPillar.position.set(maze.exit.x + 0.5, WALL_HEIGHT / 2, maze.exit.y + 0.5);
    scene.add(exitPillar);

    exitGlow = new THREE.PointLight(0x4ade80, 2.2, 9);
    exitGlow.position.set(maze.exit.x + 0.5, 1.2, maze.exit.y + 0.5);
    scene.add(exitGlow);

    /* Evening daylight. There is deliberately no lamp on the camera: a point
       light travelling with you paints a bright halo on whatever is nearest,
       which is the "glow" that makes it look dated. Flat, even light from the
       sky and a low sun keeps the surfaces matte. */
    scene.add(new THREE.HemisphereLight(0xcfe0f5, 0x4a4238, 1.15));

    const sun = new THREE.DirectionalLight(0xffd9a8, 0.8);
    sun.position.set(maze.w * 0.8, 22, -maze.h * 0.35);
    scene.add(sun);

    // A second, cooler light from the opposite side so the shaded faces are
    // readable instead of black.
    const fill = new THREE.DirectionalLight(0x9fbfe8, 0.35);
    fill.position.set(-maze.w * 0.4, 16, maze.h * 0.7);
    scene.add(fill);

    torch = null;
    scene.add(camera);

    /* The gun, parented to the camera so it rides with the view. depthTest off
       and a high renderOrder: it is the nearest thing there is, and testing it
       against the world only risks a wall clipping through your own hands. */
    gunMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.4, 0.4),
      new THREE.MeshBasicMaterial({
        map: skin.gun, transparent: true, depthTest: false, depthWrite: false, fog: false,
      }));
    gunMesh.position.set(0.16, -0.155, -0.34);
    gunMesh.renderOrder = 20;
    camera.add(gunMesh);

    /* The creatures — one per monster, paired by index.

       When the supplied model has arrived each monster wears a clone of it;
       until then, or on a page where it cannot be fetched at all, they wear one
       built out of primitives instead. Either way each gets its own copy of the
       materials, so a hit flashes the one that was shot rather than the pack.

       Clones share materials by default in three.js, which is exactly what we
       cannot have here. */
    creatures = monsters.map(() => {
      const group = new THREE.Group();
      const skins = [];

      if (monsterModel) {
        const body = monsterModel.clone(true);
        body.traverse((node) => {
          if (!node.isMesh) return;
          node.material = node.material.clone();
          skins.push({ material: node.material, base: node.material.color.clone() });
        });
        group.add(body);
      } else {
        skins.push(...builtInCreature(group, skin));
      }

      scene.add(group);
      return { group, skins };
    });
  }

  /* The stand-in: a shaggy blue thing made of primitives, with the face on one
     textured plane. Used whenever the model is unavailable, and the same shape
     the 2D fallback draws. */
  function builtInCreature(group, skin) {
    const fur = new THREE.MeshLambertMaterial({ map: skin.fur, color: 0xffffff });
    const mitt = new THREE.MeshLambertMaterial({ color: 0xd98324 });

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.29, 18, 14), fur);
    head.position.y = 1.14;
    head.scale.set(1.12, 1, 0.92);
    group.add(head);

    for (const [tx, tz, lean] of [[-0.16, -0.02, -0.5], [0.02, 0.06, 0.1], [0.18, -0.04, 0.55]]) {
      const tuft = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.22, 7), fur);
      tuft.position.set(tx, 1.36, tz);
      tuft.rotation.z = lean;
      group.add(tuft);
    }

    const facePlane = new THREE.Mesh(
      new THREE.PlaneGeometry(0.52, 0.52),
      new THREE.MeshLambertMaterial({
        map: skin.face, transparent: true, alphaTest: 0.4, color: 0xffffff,
      }));
    facePlane.position.set(0, 1.13, 0.28);
    group.add(facePlane);

    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.16, 0.46, 14), fur);
    torso.position.y = 0.74;
    group.add(torso);

    for (const side of [-1, 1]) {
      const loop = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.1, 8), fur);
      loop.position.set(side * 0.07, 0.95, 0.17);
      loop.rotation.z = side * Math.PI * 0.5;
      group.add(loop);

      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.045, 0.78, 8), fur);
      arm.position.set(side * 0.25, 0.6, 0.02);
      arm.rotation.z = side * 0.16;
      group.add(arm);

      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), mitt);
      hand.position.set(side * 0.32, 0.22, 0.04);
      hand.scale.set(1, 1.5, 0.8);
      group.add(hand);

      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.05, 0.56, 8), fur);
      leg.position.set(side * 0.1, 0.29, 0);
      group.add(leg);

      const foot = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), mitt);
      foot.position.set(side * 0.1, 0.05, 0.06);
      foot.scale.set(0.85, 0.55, 1.5);
      group.add(foot);
    }

    return [{ material: fur, base: fur.color.clone() }, { material: mitt, base: mitt.color.clone() }];
  }

  // three.js does not free GPU buffers on its own; rebuilding a maze every
  // level would otherwise leak one whole scene each time.
  function disposeScene() {
    scene.traverse((node) => {
      if (node.geometry) node.geometry.dispose();
      if (node.material) {
        const list = Array.isArray(node.material) ? node.material : [node.material];
        list.forEach((m) => m.dispose());
      }
    });
    if (camera) camera.clear();
    creatures = [];
    coping = null;
    reveal = null;
  }

  function startRenderer() {
    // Multisampling is the first thing to go: at this pixel count it costs
    // more than it returns, and the walls are flat colour with no thin
    // geometry for the jaggies to show on.
    renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    resize();
    view.append(renderer.domElement);
    window.addEventListener('resize', resize);
  }

  // Windowed the view keeps a fixed 0.62 letterbox; fullscreen it takes the
  // screen's own shape, or the picture would come out stretched.
  function viewportSize() {
    const full = inFullscreen();
    const width = (full ? window.innerWidth : view.clientWidth) || 640;
    const height = full ? (window.innerHeight || 480) : Math.round(width * 0.62);
    return { full, width, height };
  }

  /* Both renderers draw into a buffer no bigger than this and let CSS stretch
     it to fit. Fullscreen on a large display is otherwise several times the
     pixels of the windowed view — the raycaster's cost is per pixel drawn, and
     the WebGL one still has to shade every one of them. Slight softness in
     fullscreen is a far better trade than a halved frame rate. */
  const MAX_FLAT_WIDTH = 1100;
  const MAX_GL_PIXELS = 2.4e6;

  function resize() {
    const { full, width, height } = viewportSize();

    if (flatCanvas) {
      const scale = Math.min(1, MAX_FLAT_WIDTH / width);
      flatCanvas.width = Math.round(width * scale);
      flatCanvas.height = Math.round(height * scale);
      flatCanvas.style.width = '100%';
      flatCanvas.style.height = full ? '100%' : 'auto';
      return;
    }

    if (!renderer || !camera) return;

    /* Pixel ratio from a budget rather than straight from the device. A 2x
       ratio on a fullscreen 1440p panel is fifteen million pixels a frame,
       which is what turns a smooth maze into a slideshow on integrated
       graphics — and the difference is barely visible at this scale. */
    const device = Math.min(2, window.devicePixelRatio || 1);
    const budget = Math.sqrt(MAX_GL_PIXELS / Math.max(1, width * height));
    renderer.setPixelRatio(Math.max(0.75, Math.min(device, budget)));

    renderer.setSize(width, height, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = full ? '100%' : 'auto';
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  /* The no-WebGL path: same game, drawn by raycasting onto a 2D canvas. */
  function startFallback(reason) {
    if (flatCanvas) return;
    flatCanvas = document.createElement('canvas');
    flatCanvas.className = 'viewport__canvas';
    flat = flatCanvas.getContext('2d');
    view.replaceChildren(flatCanvas, minimap, hud, sight, gameOver);
    resize();
    ctx.setHint('W S walk · A D strafe · space sprint (loud!) · click or F to shoot · ⛶ mouse look');
    ctx.setStatus(`${reason} Playing in 2D instead.`);
    loadLevel();
    start();
  }

  /* ---------- loop ---------- */

  function loop(time) {
    frame = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (time - lastTime) / 1000 || 0);
    lastTime = time;

    if (dead) return deathFrame(dt);

    const before = walker.escaped;

    /* Sprinting is gated on the bar rather than on the key: hold space with an
       empty bar and you simply walk. Standing still refills it, so the cost is
       for ground covered, not for holding a key down. */
    const moving = input.forward || input.back || input.strafeLeft || input.strafeRight;
    Object.assign(drive, input);
    drive.sprint = stepSprint(sprint, input.sprint, moving, dt);

    stepWalker(maze, walker, drive, dt);
    if (!dead) for (const m of monsters) stepMonster(maze, m, walker, dt, { sprinting: drive.sprint });
    if (!courseDone && !dead) seconds += dt;

    shotTimer = Math.max(0, shotTimer - dt);
    flash = Math.max(0, flash - dt);
    recoil = Math.max(0, recoil - dt * 5.5);   // kicks instantly, settles over ~180 ms

    const closest = nearestMonster(monsters, walker);
    const near = closest ? monsterCloseness(closest, walker) : 0;

    /* Taking damage, and healing back only once the pack has lost you.

       Being surrounded hurts more than being cornered by one, but the total is
       capped at two of them: five all landing blows at once would take you from
       full to dead inside a second, which reads as a bug rather than as a
       mistake you made. */
    if (!dead && !courseDone) {
      const mauling = monsters.reduce((n, m) => n + (m.touching ? 1 : 0), 0);
      if (mauling) {
        health -= MONSTER_DAMAGE * Math.min(2, mauling) * dt;
        if (Math.random() < dt * 2) audio.play('hurt');
        if (health <= 0) return killed();
      } else if (near < 0.2 && health < PLAYER_HEALTH) {
        health = Math.min(PLAYER_HEALTH, health + HEALTH_REGEN * dt);
      }
    }

    refreshBars(near);

    // A little head bob while walking, and a torch that flickers.
    const walking = (input.forward || input.back) && !walker.escaped;
    bob = walking ? bob + dt * 9 : 0;
    const eye = EYE_HEIGHT + (walking ? Math.sin(bob) * 0.035 : 0);

    // The exit still pulses — it is the one thing that should catch your eye.
    // The walls are lit only by the sky, with no flicker on them at all.
    if (exitGlow) exitGlow.intensity = 1.4 + Math.sin(seconds * 3) * 0.5;
    if (exitPillar) exitPillar.rotation.y += dt * 0.6;

    /* Each creature follows its own monster, always facing you and lurching a
       little as it walks. The lurch is offset per index so a pack does not move
       as one body. */
    creatures.forEach(({ group, skins }, i) => {
      const m = monsters[i];
      group.visible = Boolean(m) && !m.dead && !dead;
      if (!group.visible) return;

      const step = seconds * 6 + i * 1.7;
      group.position.set(m.x, Math.abs(Math.sin(step)) * 0.05, m.y);
      group.rotation.y = Math.atan2(walker.x - m.x, walker.y - m.y);
      group.rotation.z = Math.sin(step * 0.5) * 0.05;

      // Every part of it flushes red for a moment where the round went in.
      const hit = Math.min(1, m.flinch * 4);
      for (const { material, base } of skins) {
        material.color.setRGB(
          base.r + (1 - base.r) * hit * 0.85,
          base.g * (1 - hit * 0.6),
          base.b * (1 - hit * 0.6));
      }
    });

    if (gunMesh) {
      // Sways with the walk, kicks down and back on every shot.
      gunMesh.position.set(
        0.16 + Math.sin(bob * 0.5) * 0.006 + recoil * 0.022,
        -0.155 + Math.cos(bob) * 0.005 - recoil * 0.05,
        -0.34 + recoil * 0.045);
      gunMesh.rotation.z = -recoil * 0.24;
    }

    if (flat) {
      drawRaycast(flat, maze, walker, pitch, flatCanvas.width, flatCanvas.height, monsters, recoil);
    } else {
      camera.position.set(walker.x, eye, walker.y);
      camera.rotation.set(pitch, -walker.yaw - Math.PI / 2, 0, 'YXZ');
      renderer.render(scene, camera);
    }

    mapAge += dt;
    if (mapAge >= MINIMAP_PERIOD) {
      mapAge = 0;
      drawMinimap(map2d, maze, walker, MINIMAP_PX, monsters);
    }
    scoreRow.set('time', clock(seconds));

    // Proximity drone, and a footstep every so often as you cover ground.
    const hunted = monsters.some((m) => !m.dead && m.mode === 'hunt');
    if (stalker) stalker.set(dead ? 0 : near * (hunted ? 1 : 0.45));
    footfall += Math.hypot(walker.x - (lastFoot.x ?? walker.x), walker.y - (lastFoot.y ?? walker.y));
    lastFoot.x = walker.x;
    lastFoot.y = walker.y;
    if (footfall > 0.75) {
      footfall = 0;
      audio.play('step');
    }

    if (walker.escaped && !before) escape();
  }

  /* The last thing you see is the thing that did it.

     The loop keeps running after you die rather than stopping dead, so the view
     can swing round onto your killer over about half a second. Nothing in the
     world moves while it does — the pack is frozen where it stood. */
  function deathFrame(dt) {
    deathTurn = Math.min(1, deathTurn + dt * 2.2);

    if (killer) {
      const dx = killer.x - walker.x;
      const dy = killer.y - walker.y;
      const gap = Math.max(0.35, Math.hypot(dx, dy));

      // Shortest way round, or a turn of 350 degrees the wrong way.
      const wanted = Math.atan2(dy, dx);
      const swing = Math.atan2(Math.sin(wanted - walker.yaw), Math.cos(wanted - walker.yaw));
      walker.yaw += swing * Math.min(1, dt * 6);

      // Look up into its face rather than at its knees.
      const up = Math.atan2(1.05 - EYE_HEIGHT, gap);
      pitch += (Math.min(MAX_PITCH, up) - pitch) * Math.min(1, dt * 6);
    }

    if (creatures.length) {
      creatures.forEach(({ group }, i) => {
        const m = monsters[i];
        group.visible = Boolean(m) && !m.dead;
        if (group.visible) {
          group.position.set(m.x, 0, m.y);
          group.rotation.y = Math.atan2(walker.x - m.x, walker.y - m.y);
        }
      });
    }

    const sink = EYE_HEIGHT - deathTurn * 0.22;   // knees giving way
    if (flat) {
      drawRaycast(flat, maze, walker, pitch, flatCanvas.width, flatCanvas.height, monsters, 0);
    } else if (renderer) {
      if (gunMesh) gunMesh.visible = false;       // you have dropped it
      camera.position.set(walker.x, sink, walker.y);
      camera.rotation.set(pitch, -walker.yaw - Math.PI / 2, 0, 'YXZ');
      renderer.render(scene, camera);
    }

    // Once it has finished turning there is nothing left to animate.
    if (deathTurn >= 1) stop();
  }

  // Out of health. The run ends wherever you were in it.
  function killed() {
    dead = true;
    health = 0;
    deathTurn = 0;
    // Whichever of them actually had hold of you, else the nearest.
    killer = monsters.find((m) => m.touching) || nearestMonster(monsters, walker);
    refreshBars(1);
    if (stalker) { stalker.stop(); stalker = null; }
    audio.play('caught');

    /* Release the pointer, or the Retry button cannot be clicked: under pointer
       lock there is no cursor to click it with. Fullscreen itself is left
       alone — you should not be thrown out of the game to restart. */
    if (document.exitPointerLock && document.pointerLockElement === view) {
      document.exitPointerLock();
    }

    goneLine.textContent =
      `Maze ${level + 1} of ${course.levels.length} · ${clock(seconds)}` +
      `${kills ? ` · ${kills} put down` : ''}`;
    gameOver.hidden = false;
    retryBtn.focus();

    ctx.setStatus(`It got you on maze ${level + 1} of ${course.levels.length} · ${clock(seconds)}`, false);
  }

  /* Firing. Hitscan, so the shot lands or misses the instant you pull the
     trigger; the rate of fire is what stops you emptying a hundred points into
     it in half a second. */
  function fire() {
    if (dead || courseDone || shotTimer > 0) return;
    shotTimer = SHOT_COOLDOWN;
    flash = 0.07;
    recoil = 1;
    audio.play('shot');

    // Loud. Everything within earshot now knows exactly where you fired from.
    alertMonsters(monsters, walker);

    // Whichever of them is nearest along the line you are pointing.
    const target = pickTarget(maze, walker, monsters);
    if (!target) return;

    audio.play('impact');
    target.health -= SHOT_DAMAGE;
    target.flinch = 0.22;

    if (target.health > 0) {
      refreshBars(monsterCloseness(target, walker));
      return;
    }

    // Down, and back on its feet somewhere else entirely.
    kills += 1;
    scoreRow.set('kills', kills);
    audio.play('slain');
    respawnMonster(maze, walker, target);
    refreshBars(0);
    ctx.setStatus(packSize > 1
      ? `One down — and already back up somewhere. ${kills} so far, ${packSize} still out there.`
      : `Down — but it is already back on its feet somewhere. ${kills} so far.`);
  }

  // Escaping one maze drops you straight into the next. The clock keeps
  // running across the whole course; only the last one finishes the run.
  function escape() {
    const last = level >= course.levels.length - 1;

    if (!last) {
      level += 1;
      audio.play('match');
      loadLevel();
      ctx.setStatus(`${whereAmI()} — keep going`);
      return;
    }

    stop();
    courseDone = true;
    audio.play('finish');

    const best = storage.get(bestKey());
    const isBest = !best || seconds < best;
    if (isBest) storage.set(bestKey(), seconds);
    scoreRow.set('best', clock(storage.get(bestKey(), seconds)));
    ctx.setStatus(
      `Course complete — all ${course.levels.length} mazes in ${clock(seconds)}${isBest ? ' · new best!' : ''}`,
      true);
  }

  // Builds the current level's maze without resetting the run's clock.
  function loadLevel() {
    const cells = course.levels[level];
    maze = buildMaze(cells, cells);
    walker = createWalker(maze);
    monsters = Array.from({ length: packSize },
      () => createMonster(maze, walker));
    health = PLAYER_HEALTH;
    sprint.value = STAMINA_MAX;
    refreshBars(0);
    footfall = 0;
    lastFoot.x = null;
    lastFoot.y = null;
    pitch = 0;

    const route = solveMaze(maze);
    scoreRow.set('level', `${level + 1}/${course.levels.length}`);
    scoreRow.set('left', route ? `${route.length} steps` : '—');

    if (renderer && !flat) buildScene();
  }

  function start() {
    stop();
    running = true;
    lastTime = performance.now();
    if (!stalker) stalker = audio.stalker();
    frame = requestAnimationFrame(loop);
  }

  function stop() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    running = false;
    if (stalker) { stalker.stop(); stalker = null; }
  }

  function restart() {
    stop();
    level = 0;
    seconds = 0;
    courseDone = false;
    dead = false;
    killer = null;
    deathTurn = 0;
    recoil = 0;
    if (gunMesh) gunMesh.visible = true;
    gameOver.hidden = true;
    health = PLAYER_HEALTH;
    kills = 0;
    sprint.value = STAMINA_MAX;
    sprint.active = false;
    shotTimer = 0;
    scoreRow.set('kills', 0);
    Object.keys(input).forEach((k) => { input[k] = false; });

    scoreRow.set('time', clock(0));
    scoreRow.set('best', storage.get(bestKey()) ? clock(storage.get(bestKey())) : '—');
    loadLevel();

    if (!renderer && !flat) return;     // still loading
    if (renderer) view.replaceChildren(renderer.domElement, minimap, hud, sight, gameOver);
    resize();
    ctx.setStatus(`${whereAmI()} — find the way out`);
    start();
  }

  /* ---------- input ---------- */

  /* A and D strafe rather than turn — turning is the arrow keys or the mouse.
     Space sprints while held. */
  const KEYS = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', s: 'down', a: 'strafeLeft', d: 'strafeRight',
    W: 'up', S: 'down', A: 'strafeLeft', D: 'strafeRight',
    ' ': 'sprint',
  };

  function onKeyDown(event) {
    if (dead && (event.key === 'Enter' || event.key === 'r' || event.key === 'R')) {
      event.preventDefault();
      restart();
      return;
    }
    if (event.key === 'f' || event.key === 'F') {
      event.preventDefault();
      fire();
      return;
    }
    const dir = KEYS[event.key];
    if (!dir) return;
    event.preventDefault();   // stops space scrolling the page
    setInput(dir, true);
  }

  function onKeyUp(event) {
    const dir = KEYS[event.key];
    if (dir) setInput(dir, false);
  }

  /* Fullscreen + mouse look.

     The two are deliberately tied together through the Pointer Lock API: going
     fullscreen grabs the pointer so the mouse steers the camera, and leaving
     fullscreen releases it, so the mouse goes back to being an ordinary
     cursor. The browser drops pointer lock by itself on exit; the listener
     below just keeps our own flag and the status line honest. */
  function inFullscreen() {
    return document.fullscreenElement === view;
  }

  function onFullscreenChange() {
    if (inFullscreen()) {
      if (view.requestPointerLock) view.requestPointerLock();
    } else if (document.exitPointerLock && document.pointerLockElement === view) {
      document.exitPointerLock();
    }
    resize();
  }

  function onPointerLockChange() {
    mouseLook = document.pointerLockElement === view;
    if (courseDone) return;
    ctx.setStatus(mouseLook
      ? 'Mouse look on — Esc to leave fullscreen'
      : `${whereAmI()} — find the way out`);
  }

  function onMouseMove(event) {
    if (!mouseLook) return;                    // no pointer lock, no mouse look
    walker.yaw += (event.movementX || 0) * MOUSE_SENSITIVITY;
    pitch -= (event.movementY || 0) * MOUSE_SENSITIVITY;
    pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
  }

  // Clicking the view while already fullscreen re-grabs the pointer, which is
  // what players expect after pressing Esc once.
  view.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    if (inFullscreen() && !mouseLook) {
      // The click that takes the pointer back should not also cost a round.
      if (view.requestPointerLock) view.requestPointerLock();
      return;
    }
    event.preventDefault();
    fire();
  });

  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('pointerlockchange', onPointerLockChange);
  document.addEventListener('mousemove', onMouseMove);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  /* ---------- boot ---------- */

  restart();   // sets up the maze and the stats even if 3D never arrives

  /* Whatever goes wrong with WebGL, the maze still has to be playable, so
     every failure falls back to the raycaster rather than to an apology. */
  if (!webglAvailable()) {
    startFallback('No WebGL here.');
  } else {
    ctx.setStatus('Loading the 3D engine…');
    loadThree()
      .then((reason) => {
        if (destroyed) return;
        if (reason) {
          startFallback(reason);
          return;
        }
        startRenderer();     // may still throw: a probe passing does not
        restart();           // guarantee a real context can be created

        /* The model comes after the engine, and the maze is already playable
           by the time it lands. Rebuilding the scene then is cheap and means
           nothing has to wait on a fetch that may never succeed. */
        loadMonsterModel().then((model) => {
          if (destroyed || !model || !renderer || flat) return;
          monsterModel = model;
          buildScene();
        });
      })
      .catch((error) => {
        if (destroyed) return;
        renderer = null;
        startFallback(`3D unavailable (${error && error.message ? error.message : error}).`);
      });
  }

  return {
    destroy() {
      destroyed = true;
      stop();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      document.removeEventListener('mousemove', onMouseMove);
      if (scene) disposeScene();
      window.removeEventListener('resize', resize);
      // Hand the WebGL context straight back. Disposing alone leaves it live
      // until the collector runs, and the browser only allows a handful.
      if (renderer) {
        if (renderer.forceContextLoss) renderer.forceContextLoss();
        renderer.dispose();
        renderer = null;
      }
    },
  };
}

if (typeof registerGame !== 'undefined') {
  registerGame({ id: 'maze', label: 'Escape the Maze', mount: mountMaze, wide: true });
}

if (typeof module !== 'undefined') {
  module.exports = {
    buildMaze, solveMaze, isWall, createWalker, stepWalker, moveWalker,
    MAZE_COURSES, courseById, WALKER_RADIUS, WALK_SPEED, TURN_SPEED, SPRINT_MULTIPLIER,
    drawRaycast, drawMinimap, drawGun, cellKey, keyX, keyY, MAZE_FOV, WALL_HEIGHT, EYE_HEIGHT,
    makeTextures, drawCreature, createMonster, respawnMonster, spawnSpot,
    paintBrick, paintBrickNormal, paintCap, paintFloor, paintFur, paintFace, paintGun, paintSky,
    stepMonster, monsterCloseness, pickTarget, nearestMonster,
    monsterSees, monsterHears, alertMonsters, pickSearchTarget, openCells,
    SIGHT_RANGE, SIGHT_CONE, HEAR_WALK, HEAR_SPRINT, SHOT_NOISE, LOSE_PATIENCE,
    shotHits, clearLine, stepSprint, MAZE_PACKS,
    MONSTER_SPEED, MONSTER_MIN_START, MONSTER_REACH, MONSTER_DAMAGE, RESPAWN_MIN,
    PLAYER_HEALTH, MONSTER_HEALTH, SHOT_DAMAGE, SHOT_RANGE,
    STAMINA_MAX, SPRINT_DRAIN, STAMINA_REGEN, SPRINT_FLOOR,
  };
}
