/* Escape the Maze — a first-person maze, rendered with three.js.

   three.js is vendored in ./vendor as a classic script rather than pulled from
   a CDN or imported as an ES module: the arcade has to keep working offline
   and straight from a file:// page, where module imports are blocked by CORS.
   It is 600 KB, so it is only fetched the first time this game is opened
   rather than on every page load.

   Maze generation and the walker's movement are pure functions, testable
   outside a browser; only mountMaze touches three.js or the DOM. */

const THREE_SRC = 'vendor/three.min.js';

/* A course is a run of mazes to finish, each bigger than the last. Escaping
   one drops you straight into the next; the clock runs across the whole run,
   and only completing every maze counts as finishing the course. */
const MAZE_COURSES = [
  { id: 'sprint', label: 'Sprint', levels: [10, 14, 18] },
  { id: 'standard', label: 'Standard', levels: [10, 14, 18, 22, 26] },
  { id: 'marathon', label: 'Marathon', levels: [10, 14, 18, 22, 26, 30, 34, 38] },
];

const courseById = (id) => MAZE_COURSES.find((c) => c.id === id) || MAZE_COURSES[1];

const WALKER_RADIUS = 0.26;    // in cells; keeps you off the wall faces
const WALK_SPEED = 3.1;        // cells per second
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

// Breadth-first shortest route between two grid squares, or null.
function solveMaze(maze, from = maze.start, to = maze.exit) {
  const seen = new Int32Array(maze.w * maze.h).fill(-1);
  const queue = [from.y * maze.w + from.x];
  seen[queue[0]] = queue[0];

  for (let head = 0; head < queue.length; head++) {
    const index = queue[head];
    const x = index % maze.w;
    const y = (index - x) / maze.w;

    if (x === to.x && y === to.y) {
      const path = [];
      let step = index;
      while (step !== seen[step]) {
        path.push({ x: step % maze.w, y: (step - (step % maze.w)) / maze.w });
        step = seen[step];
      }
      path.push({ ...from });
      return path.reverse();
    }

    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (isWall(maze, nx, ny)) continue;
      const next = ny * maze.w + nx;
      if (seen[next] !== -1) continue;
      seen[next] = index;
      queue.push(next);
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

const cellKey = (x, y) => `${Math.floor(x)},${Math.floor(y)}`;

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

  const drive = (input.forward ? 1 : 0) - (input.back ? 1 : 0);
  if (drive) {
    const distance = drive * WALK_SPEED * dt;
    const before = { x: walker.x, y: walker.y };
    moveWalker(maze, walker, Math.cos(walker.yaw) * distance, Math.sin(walker.yaw) * distance);
    walker.steps += Math.hypot(walker.x - before.x, walker.y - before.y);
  }

  if (walker.trail) walker.trail.add(cellKey(walker.x, walker.y));

  if (Math.floor(walker.x) === maze.exit.x && Math.floor(walker.y) === maze.exit.y) {
    walker.escaped = true;
  }

  return walker;
}

/* The minimap: where the exit is, where you are, and where you have been.

   Deliberately nothing else — no walls, no unexplored ground and above all no
   route to the exit, so it helps you keep track without solving the maze for
   you. */
function drawMinimap(g, maze, walker, size) {
  const cell = size / Math.max(maze.w, maze.h);

  g.clearRect(0, 0, size, size);
  g.fillStyle = 'rgba(6, 11, 25, 0.72)';
  g.fillRect(0, 0, size, size);

  // Where you have been.
  g.fillStyle = 'rgba(148, 197, 255, 0.55)';
  for (const key of walker.trail || []) {
    const [x, y] = key.split(',').map(Number);
    g.fillRect(x * cell, y * cell, Math.max(1, cell), Math.max(1, cell));
  }

  // The exit.
  const marker = Math.max(3, cell * 1.6);
  g.fillStyle = '#4ade80';
  g.fillRect(
    (maze.exit.x + 0.5) * cell - marker / 2,
    (maze.exit.y + 0.5) * cell - marker / 2,
    marker, marker);

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
function drawRaycast(g, maze, walker, pitch, width, height) {
  const fov = (MAZE_FOV * Math.PI) / 180;
  const planeHalf = Math.tan(fov / 2);
  const project = width / 2 / planeHalf;         // world units to pixels at 1 away
  const horizon = height * 0.5 + pitch * height * 0.55;

  const dirX = Math.cos(walker.yaw);
  const dirY = Math.sin(walker.yaw);
  const planeX = -dirY * planeHalf;
  const planeY = dirX * planeHalf;

  // A bright night sky above the horizon, dark tiled ground below it.
  const sky = g.createLinearGradient(0, 0, 0, Math.max(1, horizon));
  sky.addColorStop(0, '#050b1f');
  sky.addColorStop(0.55, '#132a63');
  sky.addColorStop(1, '#3f6fb5');
  g.fillStyle = sky;
  g.fillRect(0, 0, width, Math.max(0, horizon));

  // Stars, placed from a fixed sequence so they hold still as you turn.
  let star = 987654321;
  for (let i = 0; i < 150; i++) {
    star = (star * 1664525 + 1013904223) >>> 0;
    const sx = star % width;
    const sy = (star >> 8) % Math.max(1, Math.floor(horizon));
    if (sy > horizon - 4) continue;
    g.fillStyle = `rgba(255, 255, 255, ${0.3 + ((star >> 20) % 60) / 100})`;
    g.fillRect(sx, sy, (star >> 3) % 15 === 0 ? 2 : 1, 1);
  }

  const ground = g.createLinearGradient(0, horizon, 0, height);
  ground.addColorStop(0, '#161a20');
  ground.addColorStop(1, '#3a4048');
  g.fillStyle = ground;
  g.fillRect(0, Math.max(0, horizon), width, height - Math.max(0, horizon));

  const depth = new Float64Array(width);

  for (let x = 0; x < width; x++) {
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
    depth[x] = distance;

    const top = horizon - ((WALL_HEIGHT - EYE_HEIGHT) / distance) * project;
    const bottom = horizon + (EYE_HEIGHT / distance) * project;

    /* Brickwork. Where along the wall face the ray landed decides which brick
       this column belongs to, so the courses run in a proper staggered bond
       rather than lining up. Faces along one axis are shaded darker, which is
       what makes corners legible, and everything fades into the night. */
    const fade = Math.min(1, distance / 16);
    const side = hitVertical ? 1 : 0.82;
    const tone = (light) => {
      const base = light ? 236 : 196;
      const v = Math.round(base * side * (1 - fade) + 58 * fade);
      return `rgb(${v}, ${v}, ${Math.min(255, v + 6)})`;
    };

    let wallX = hitVertical ? walker.y + distance * rayY : walker.x + distance * rayX;
    wallX -= Math.floor(wallX);

    const courses = 5;
    const courseH = (bottom - top) / courses;

    for (let c = 0; c < courses; c++) {
      const yTop = top + c * courseH;
      /* Two bricks across each cell face, every other course shifted by half
         a brick. The shift has to be half a BRICK (0.5 here), not half a cell
         — offset by a whole brick and the stagger cancels the course step,
         leaving vertical stripes instead of a bond. */
      const brick = Math.floor(wallX * 2 + (c % 2) * 0.5);
      g.fillStyle = tone(((brick + c) % 2 + 2) % 2 === 0);
      g.fillRect(x, yTop, 1, Math.max(1, courseH + 1));
    }

    if (distance < 9) {
      const near = 1 - distance / 9;

      // Mortar. Capped in pixels: a course close up is thousands of pixels
      // tall, and a percentage of that paints fat grey bands across the wall.
      const mortar = Math.min(3, Math.max(1, courseH * 0.06));
      g.fillStyle = `rgba(88, 94, 102, ${0.7 * near})`;
      for (let c = 1; c < courses; c++) g.fillRect(x, top + c * courseH, 1, mortar);

      // Tiny white flecks, from a fixed hash so they sit still on the wall.
      const grain = ((Math.floor(wallX * 64) * 73856093) ^ (mapX * 19349663) ^ (mapY * 83492791)) >>> 0;
      if (grain % 5 === 0) {
        g.fillStyle = `rgba(255, 255, 255, ${0.5 * near})`;
        g.fillRect(x, top + ((grain >> 8) % Math.max(1, Math.floor(bottom - top))), 1, 1);
      }
    }

    // Floor tiles: one line per grid step away, which reads as square tiles
    // running off into the distance.
    if (x % 2 === 0) {
      for (let step = 1; step <= 12; step++) {
        const y = horizon + (EYE_HEIGHT / step) * project;
        if (y >= height || y <= horizon) continue;
        if (y > bottom) continue;
        g.fillStyle = `rgba(226, 232, 240, ${0.1 * (1 - step / 12)})`;
        g.fillRect(x, y, 2, 1);
      }
    }
  }

  // The exit, billboarded and depth-tested against the wall slices.
  const relX = maze.exit.x + 0.5 - walker.x;
  const relY = maze.exit.y + 0.5 - walker.y;
  const det = planeX * dirY - dirX * planeY;
  if (det !== 0) {
    const invDet = 1 / det;
    const camX = invDet * (dirY * relX - dirX * relY);
    const camY = invDet * (-planeY * relX + planeX * relY);

    if (camY > 0.15) {
      const screenX = (width / 2) * (1 + camX / camY);
      const size = (project / camY) * 0.85;
      const bottom = horizon + (EYE_HEIGHT / camY) * project;

      for (let x = Math.floor(screenX - size / 2); x < screenX + size / 2; x++) {
        if (x < 0 || x >= width) continue;
        if (depth[x] <= camY) continue;                 // hidden behind a wall
        const edge = 1 - Math.abs((x - screenX) / (size / 2));
        g.fillStyle = `rgba(74, 222, 128, ${0.35 + edge * 0.5})`;
        g.fillRect(x, bottom - size * 1.5, 1, size * 1.5);
      }
    }
  }
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

function makeTextures() {
  if (textures) return textures;

  // A deterministic speckle, so bricks and tiles have grain without needing a
  // photograph. Same input always gives the same dots.
  const speckle = (g, x, y, w, h, count, alpha) => {
    g.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    let n = ((x * 73856093) ^ (y * 19349663)) >>> 0;
    for (let i = 0; i < count; i++) {
      n = (n * 1664525 + 1013904223) >>> 0;
      const px = x + (n % w);
      const py = y + ((n >> 9) % h);
      g.fillRect(px, py, 1, 1);
    }
  };

  // Brick: rectangles alternating between off-white and light grey, flecked
  // with tiny white dots.
  const brick = paintCanvas(256, (g, size) => {
    const rows = 6;
    const cols = 4;
    const brickH = size / rows;
    const brickW = size / cols;

    g.fillStyle = '#8f959c';                       // mortar
    g.fillRect(0, 0, size, size);

    for (let row = 0; row < rows; row++) {
      const offset = (row % 2) * 0.5;
      for (let i = -1; i < cols + 1; i++) {
        const x = Math.round((i + offset) * brickW);
        const y = Math.round(row * brickH);
        const w = Math.round(brickW) - 3;
        const h = Math.round(brickH) - 3;

        // Alternate the two tones in a running bond.
        const offWhite = (row + i) % 2 === 0;
        g.fillStyle = offWhite ? '#ecebe6' : '#c2c7cc';
        g.fillRect(x + 2, y + 2, w, h);

        speckle(g, x + 2, y + 2, Math.max(1, w), Math.max(1, h), 14, offWhite ? 0.85 : 0.6);

        g.fillStyle = 'rgba(255, 255, 255, 0.35)';  // light catching the top
        g.fillRect(x + 2, y + 2, w, 1);
      }
    }
  });

  // Capstone for the wall tops, which are on show with no ceiling.
  const cap = paintCanvas(64, (g, size) => {
    g.fillStyle = '#d5d7d4';
    g.fillRect(0, 0, size, size);
    speckle(g, 0, 0, size, size, 90, 0.7);
    g.fillStyle = 'rgba(110, 118, 126, 0.3)';
    g.fillRect(0, 0, size, 2);
    g.fillRect(0, size - 2, size, 2);
  });

  // Floor: dark grey square tiles, also flecked with white.
  const floor = paintCanvas(256, (g, size) => {
    const half = size / 2;
    g.fillStyle = '#15181d';                       // grout
    g.fillRect(0, 0, size, size);

    for (let ty = 0; ty < 2; ty++) {
      for (let tx = 0; tx < 2; tx++) {
        const x = tx * half + 3;
        const y = ty * half + 3;
        const w = half - 6;
        const shade = 58 + ((tx + ty) % 2) * 6;
        g.fillStyle = `rgb(${shade}, ${shade + 2}, ${shade + 5})`;
        g.fillRect(x, y, w, w);
        speckle(g, x, y, w, w, 34, 0.55);
      }
    }
  });

  /* A bright night: deep blue overhead easing to a lit horizon, thick with
     stars, with the moon low enough to see from inside the maze. */
  const sky = paintCanvas(512, (g, size) => {
    const grad = g.createLinearGradient(0, 0, 0, size);
    grad.addColorStop(0, '#050b1f');
    grad.addColorStop(0.4, '#132a63');
    grad.addColorStop(0.72, '#2f5fa8');
    grad.addColorStop(1, '#7fa9d8');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);

    let n = 987654321;
    for (let i = 0; i < 520; i++) {
      n = (n * 1664525 + 1013904223) >>> 0;
      const x = n % size;
      const y = (n >> 7) % Math.floor(size * 0.78);
      const bright = 0.35 + ((n >> 20) % 65) / 100;
      const big = (n >> 3) % 17 === 0;
      g.fillStyle = `rgba(255, 255, 255, ${bright})`;
      g.fillRect(x, y, big ? 2 : 1, big ? 2 : 1);
    }

    const moonX = size * 0.68;
    const moonY = size * 0.3;
    const glow = g.createRadialGradient(moonX, moonY, 4, moonX, moonY, 90);
    glow.addColorStop(0, 'rgba(226, 236, 255, 0.55)');
    glow.addColorStop(1, 'rgba(226, 236, 255, 0)');
    g.fillStyle = glow;
    g.fillRect(moonX - 95, moonY - 95, 190, 190);
    g.fillStyle = '#eef3ff';
    g.beginPath();
    g.ellipse(moonX, moonY, 22, 22, 0, 0, Math.PI * 2);
    g.fill();
  });
  sky.wrapS = THREE.ClampToEdgeWrapping;
  sky.wrapT = THREE.ClampToEdgeWrapping;

  textures = { brick, cap, floor, sky };
  return textures;
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
  let scene = null;
  let camera = null;
  let renderer = null;
  let walls = null;
  let torch = null;
  let exitPillar = null;
  let exitGlow = null;
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
  const input = { forward: false, back: false, left: false, right: false };

  const bestKey = () => `maze-best-${course.id}`;
  const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  /* ---------- chrome ---------- */

  const courseRow = segmented(
    MAZE_COURSES.map((c) => ({ id: c.id, label: `${c.label} (${c.levels.length})` })),
    course.id, (id) => { course = courseById(id); restart(); },
    { ariaLabel: 'Course' });

  const scoreRow = statRow([
    { key: 'level', label: 'Maze', value: '1', tone: 'x' },
    { key: 'time', label: 'Total Time', value: '0:00', tone: 'muted' },
    { key: 'left', label: 'Shortest Route', value: '—', tone: 'muted' },
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

  // Shown in place of the 3D view when it cannot start.
  function fallbackNote(reason) {
    const note = document.createElement('p');
    note.className = 'viewport__note';
    note.textContent = reason || 'The 3D view needs WebGL, which this browser has not enabled.';
    return note;
  }

  ctx.settings.append(courseRow.el);
  ctx.score.append(scoreRow.el);
  ctx.stage.append(view, pad);
  ctx.controls.append(buttonRow([{ label: 'New Run', onClick: restart }]));
  // The shell's fullscreen button drives the 3D view rather than the whole
  // page, so going fullscreen also grabs the pointer for mouse look.
  ctx.setFullscreenTarget(view);
  ctx.setTheme('maze');
  ctx.setHint('W / ↑ walk · A D or ← → turn · ⛶ fullscreen for mouse look');

  function setInput(dir, down) {
    if (dir === 'up') input.forward = down;
    else if (dir === 'down') input.back = down;
    else if (dir === 'left') input.left = down;
    else if (dir === 'right') input.right = down;
  }

  /* ---------- three.js scene ---------- */

  function buildScene() {
    if (scene) disposeScene();

    const skin = makeTextures();

    scene = new THREE.Scene();
    // Fog is tinted to the night horizon so distant walls fade into the sky
    // rather than into a band that would give the open top away.
    scene.fog = new THREE.Fog(0x2b4a7d, 9, 52);

    camera = new THREE.PerspectiveCamera(MAZE_FOV, 16 / 10, 0.05, 220);

    // Sky: a big sphere seen from the inside, unaffected by fog.
    const skyDome = new THREE.Mesh(
      new THREE.SphereGeometry(110, 32, 20),
      new THREE.MeshBasicMaterial({ map: skin.sky, side: THREE.BackSide, fog: false }));
    skyDome.position.set(maze.w / 2, 0, maze.h / 2);
    scene.add(skyDome);

    const wallGeometry = new THREE.BoxGeometry(1, WALL_HEIGHT, 1);
    const brickSide = new THREE.MeshLambertMaterial({ map: skin.brick, color: 0xffffff });
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

    // Floor tiles, one per grid square. The texture holds a 2x2 block, so the
    // repeat is half the maze in each direction.
    const floorTexture = skin.floor.clone();
    floorTexture.needsUpdate = true;
    floorTexture.wrapS = THREE.RepeatWrapping;
    floorTexture.wrapT = THREE.RepeatWrapping;
    floorTexture.repeat.set(maze.w / 2, maze.h / 2);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(maze.w, maze.h),
      new THREE.MeshLambertMaterial({ map: floorTexture, color: 0xffffff }));
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

    // Moonlight: cool and bright enough to read the walls by, with the
    // brickwork picking up the blue of the sky.
    scene.add(new THREE.HemisphereLight(0x9fc0f0, 0x2a3038, 0.95));

    const moon = new THREE.DirectionalLight(0xdce8ff, 0.75);
    moon.position.set(maze.w * 0.35, 34, -maze.h * 0.25);
    scene.add(moon);

    // A warm lamp on the camera keeps nearby walls from going flat.
    torch = new THREE.PointLight(0xffe0b0, 0.85, 9, 1.8);
    camera.add(torch);
    scene.add(camera);
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
  }

  function startRenderer() {
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
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

  function resize() {
    const { full, width, height } = viewportSize();

    if (flatCanvas) {
      flatCanvas.width = width;
      flatCanvas.height = height;
      flatCanvas.style.width = '100%';
      flatCanvas.style.height = full ? '100%' : 'auto';
      return;
    }

    if (!renderer || !camera) return;
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
    view.replaceChildren(flatCanvas, minimap);
    resize();
    ctx.setHint('W / ↑ walk · A D or ← → turn · ⛶ fullscreen for mouse look');
    ctx.setStatus(`${reason} Playing in 2D instead.`);
    loadLevel();
    start();
  }

  /* ---------- loop ---------- */

  function loop(time) {
    frame = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (time - lastTime) / 1000 || 0);
    lastTime = time;

    const before = walker.escaped;
    stepWalker(maze, walker, input, dt);
    if (!courseDone) seconds += dt;

    // A little head bob while walking, and a torch that flickers.
    const walking = (input.forward || input.back) && !walker.escaped;
    bob = walking ? bob + dt * 9 : 0;
    const eye = EYE_HEIGHT + (walking ? Math.sin(bob) * 0.035 : 0);

    if (torch) torch.intensity = 2.1 + Math.sin(seconds * 11) * 0.14 + Math.sin(seconds * 4.3) * 0.1;
    if (exitGlow) exitGlow.intensity = 1.8 + Math.sin(seconds * 3) * 0.7;
    if (exitPillar) exitPillar.rotation.y += dt * 0.6;

    if (flat) {
      drawRaycast(flat, maze, { ...walker, y: walker.y }, pitch, flatCanvas.width, flatCanvas.height);
    } else {
      camera.position.set(walker.x, eye, walker.y);
      camera.rotation.set(pitch, -walker.yaw - Math.PI / 2, 0, 'YXZ');
      renderer.render(scene, camera);
    }

    drawMinimap(map2d, maze, walker, MINIMAP_PX);
    scoreRow.set('time', clock(seconds));

    if (walker.escaped && !before) escape();
  }

  // Escaping one maze drops you straight into the next. The clock keeps
  // running across the whole course; only the last one finishes the run.
  function escape() {
    const last = level >= course.levels.length - 1;

    if (!last) {
      level += 1;
      audio.play('match');
      loadLevel();
      ctx.setStatus(`Maze ${level + 1} of ${course.levels.length} — keep going`);
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
    frame = requestAnimationFrame(loop);
  }

  function stop() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    running = false;
  }

  function restart() {
    stop();
    level = 0;
    seconds = 0;
    courseDone = false;
    input.forward = input.back = input.left = input.right = false;

    scoreRow.set('time', clock(0));
    scoreRow.set('best', storage.get(bestKey()) ? clock(storage.get(bestKey())) : '—');
    loadLevel();

    if (!renderer && !flat) return;     // still loading
    if (renderer) view.replaceChildren(renderer.domElement, minimap);
    resize();
    ctx.setStatus(`Maze 1 of ${course.levels.length} — find the way out`);
    start();
  }

  /* ---------- input ---------- */

  const KEYS = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', s: 'down', a: 'left', d: 'right',
    W: 'up', S: 'down', A: 'left', D: 'right',
  };

  function onKeyDown(event) {
    const dir = KEYS[event.key];
    if (!dir) return;
    event.preventDefault();
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
      : `Maze ${level + 1} of ${course.levels.length} — find the way out`);
  }

  function onMouseMove(event) {
    if (!mouseLook) return;                    // no pointer lock, no mouse look
    walker.yaw += (event.movementX || 0) * MOUSE_SENSITIVITY;
    pitch -= (event.movementY || 0) * MOUSE_SENSITIVITY;
    pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
  }

  // Clicking the view while already fullscreen re-grabs the pointer, which is
  // what players expect after pressing Esc once.
  view.addEventListener('click', () => {
    if (inFullscreen() && !mouseLook && view.requestPointerLock) view.requestPointerLock();
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
    MAZE_COURSES, courseById, WALKER_RADIUS, WALK_SPEED, TURN_SPEED,
    drawRaycast, drawMinimap, cellKey, MAZE_FOV, WALL_HEIGHT, EYE_HEIGHT,
  };
}
