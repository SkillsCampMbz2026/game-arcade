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
const WALL_HEIGHT = 2.1;
const EYE_HEIGHT = 0.95;

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

function createWalker(maze) {
  return {
    x: maze.start.x + 0.5,     // stand in the middle of the start square
    y: maze.start.y + 0.5,
    yaw: 0,                    // 0 looks along +x
    escaped: false,
    steps: 0,
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

  if (Math.floor(walker.x) === maze.exit.x && Math.floor(walker.y) === maze.exit.y) {
    walker.escaped = true;
  }

  return walker;
}

/* ---------- the game module ---------- */

// Fetches three.js once, on first use.
let threeLoading = null;
function loadThree() {
  if (typeof THREE !== 'undefined') return Promise.resolve(true);
  if (threeLoading) return threeLoading;

  threeLoading = new Promise((resolve) => {
    const tag = document.createElement('script');
    tag.src = THREE_SRC;
    tag.onload = () => resolve(typeof THREE !== 'undefined');
    tag.onerror = () => resolve(false);
    document.head.appendChild(tag);
  });

  return threeLoading;
}

function webglAvailable() {
  try {
    if (!window.WebGLRenderingContext) return false;
    const probe = document.createElement('canvas');
    return Boolean(probe.getContext('webgl') || probe.getContext('experimental-webgl'));
  } catch {
    return false;
  }
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

  const minimap = document.createElement('canvas');
  minimap.className = 'minimap';
  const map2d = minimap.getContext('2d');

  const pad = dpad((dir) => setInput(dir, true), { onRelease: (dir) => setInput(dir, false) });

  ctx.settings.append(courseRow.el);
  ctx.score.append(scoreRow.el);
  ctx.stage.append(view, pad);
  ctx.controls.append(buttonRow([
    { label: 'New Run', onClick: restart },
    { label: 'Fullscreen', onClick: toggleFullscreen, ghost: true },
  ]));
  ctx.setTheme('maze');
  ctx.setHint('W / ↑ walk · A D or ← → turn · fullscreen for mouse look');

  function setInput(dir, down) {
    if (dir === 'up') input.forward = down;
    else if (dir === 'down') input.back = down;
    else if (dir === 'left') input.left = down;
    else if (dir === 'right') input.right = down;
  }

  /* ---------- three.js scene ---------- */

  function buildScene() {
    if (scene) disposeScene();

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x090d1a);
    scene.fog = new THREE.Fog(0x090d1a, 3, 15);

    camera = new THREE.PerspectiveCamera(75, 16 / 10, 0.05, 80);

    const wallGeometry = new THREE.BoxGeometry(1, WALL_HEIGHT, 1);
    const wallMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff });

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

      // Deterministic per-block shade so the stonework has texture rather than
      // reading as one flat slab.
      const noise = ((x * 73856093) ^ (y * 19349663)) % 100 / 100;
      tint.setHSL(0.6, 0.12, 0.32 + noise * 0.16);
      walls.setColorAt(i, tint);
    });

    walls.instanceMatrix.needsUpdate = true;
    if (walls.instanceColor) walls.instanceColor.needsUpdate = true;
    scene.add(walls);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(maze.w, maze.h),
      new THREE.MeshLambertMaterial({ color: 0x141c2e }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(maze.w / 2, 0, maze.h / 2);
    scene.add(floor);

    // A ceiling turns open-topped trenches into real corridors.
    const ceiling = new THREE.Mesh(
      new THREE.PlaneGeometry(maze.w, maze.h),
      new THREE.MeshLambertMaterial({ color: 0x0c1322 }));
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.set(maze.w / 2, WALL_HEIGHT, maze.h / 2);
    scene.add(ceiling);

    // The exit: a glowing pillar you can pick out from down a corridor.
    exitPillar = new THREE.Mesh(
      new THREE.BoxGeometry(0.62, WALL_HEIGHT * 0.95, 0.62),
      new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.6 }));
    exitPillar.position.set(maze.exit.x + 0.5, WALL_HEIGHT / 2, maze.exit.y + 0.5);
    scene.add(exitPillar);

    exitGlow = new THREE.PointLight(0x4ade80, 2.2, 9);
    exitGlow.position.set(maze.exit.x + 0.5, 1.2, maze.exit.y + 0.5);
    scene.add(exitGlow);

    scene.add(new THREE.AmbientLight(0x8ba0c4, 0.28));
    torch = new THREE.PointLight(0xffd9a0, 2.1, 9, 1.6);
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

  function resize() {
    if (!renderer || !camera) return;

    // Windowed the view keeps a fixed 0.62 letterbox; fullscreen it takes the
    // screen's own shape, or the picture would come out stretched.
    const full = inFullscreen();
    const width = (full ? window.innerWidth : view.clientWidth) || 640;
    const height = full ? (window.innerHeight || 480) : Math.round(width * 0.62);

    renderer.setSize(width, height, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = full ? '100%' : 'auto';
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
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

    camera.position.set(walker.x, eye, walker.y);
    camera.rotation.set(pitch, -walker.yaw - Math.PI / 2, 0, 'YXZ');
    renderer.render(scene, camera);
    drawMinimap();
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
    minimap.width = maze.w * 6;
    minimap.height = maze.h * 6;

    if (renderer) buildScene();
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

    if (!renderer) return;              // still loading, or unsupported
    view.replaceChildren(renderer.domElement, minimap);
    resize();
    ctx.setStatus(`Maze 1 of ${course.levels.length} — find the way out`);
    start();
  }

  /* ---------- minimap ---------- */

  function drawMinimap() {
    const cell = 6;
    map2d.fillStyle = 'rgba(2, 6, 23, 0.75)';
    map2d.fillRect(0, 0, minimap.width, minimap.height);

    map2d.fillStyle = '#334155';
    for (let y = 0; y < maze.h; y++) {
      for (let x = 0; x < maze.w; x++) {
        if (isWall(maze, x, y)) map2d.fillRect(x * cell, y * cell, cell, cell);
      }
    }

    map2d.fillStyle = '#4ade80';
    map2d.fillRect(maze.exit.x * cell, maze.exit.y * cell, cell, cell);

    map2d.fillStyle = '#fbbf24';        // you, with a nose showing your heading
    map2d.beginPath();
    map2d.arc(walker.x * cell, walker.y * cell, cell * 0.5, 0, Math.PI * 2);
    map2d.fill();
    map2d.strokeStyle = '#fbbf24';
    map2d.lineWidth = 2;
    map2d.beginPath();
    map2d.moveTo(walker.x * cell, walker.y * cell);
    map2d.lineTo((walker.x + Math.cos(walker.yaw) * 1.4) * cell,
      (walker.y + Math.sin(walker.yaw) * 1.4) * cell);
    map2d.stroke();
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
  const canFullscreen = typeof view.requestFullscreen === 'function';

  function inFullscreen() {
    return document.fullscreenElement === view;
  }

  function toggleFullscreen() {
    if (!canFullscreen) return;
    if (inFullscreen()) document.exitFullscreen();
    else view.requestFullscreen().catch(() => {});
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

  if (!webglAvailable()) {
    ctx.setStatus('This browser has no WebGL, so the 3D view cannot run.');
    view.append(minimap);
  } else {
    ctx.setStatus('Loading the 3D engine…');
    loadThree().then((ok) => {
      if (destroyed) return;
      if (!ok) {
        ctx.setStatus('Could not load the 3D engine.');
        view.append(minimap);
        return;
      }
      startRenderer();
      restart();
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
      if (renderer) renderer.dispose();
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
  };
}
