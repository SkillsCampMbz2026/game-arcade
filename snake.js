/* Snake — steer the snake into apples without hitting a wall or yourself.

   The rules live in pure functions (createSnakeState / snakeStep) so they can
   be tested outside the browser; only mountSnake touches the DOM. */

const SNAKE_SPEEDS = [
  { id: 'slow', label: 'Slow', ms: 170 },
  { id: 'normal', label: 'Normal', ms: 115 },
  { id: 'fast', label: 'Fast', ms: 70 },
];

const SNAKE_SIZES = [
  { id: 'small', label: 'Small', cells: 13 },
  { id: 'medium', label: 'Medium', cells: 17 },
  { id: 'large', label: 'Large', cells: 21 },
];

const SNAKE_CELL = 26; // logical canvas pixels per cell

// Not DIRECTIONS: ai.js already claims that name, and classic scripts all
// share one global lexical scope.
const SNAKE_DIRS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

const SNAKE_KEYS = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  w: 'up', s: 'down', a: 'left', d: 'right',
  W: 'up', S: 'down', A: 'left', D: 'right',
};

function spawnApple(snake, cells, rng = Math.random) {
  const occupied = new Set(snake.map((seg) => seg.y * cells + seg.x));
  const free = [];
  for (let i = 0; i < cells * cells; i++) if (!occupied.has(i)) free.push(i);
  if (free.length === 0) return null; // board full: nothing left to eat

  const pick = free[Math.floor(rng() * free.length)];
  return { x: pick % cells, y: Math.floor(pick / cells) };
}

function createSnakeState(cells, rng = Math.random) {
  const mid = Math.floor(cells / 2);
  const snake = [{ x: mid, y: mid }, { x: mid - 1, y: mid }, { x: mid - 2, y: mid }];
  return {
    snake,
    dir: SNAKE_DIRS.right,
    apple: spawnApple(snake, cells, rng),
    score: 0,
    alive: true,
    ate: false,
    cause: null,
  };
}

// Reversing into your own neck is an instant loss, so it is simply ignored.
function turnSnake(dir, requested) {
  if (requested.x === -dir.x && requested.y === -dir.y) return dir;
  return requested;
}

function snakeStep(state, { cells, wrap, rng = Math.random }) {
  if (!state.alive) return state;

  const head = state.snake[0];
  let x = head.x + state.dir.x;
  let y = head.y + state.dir.y;

  if (wrap) {
    x = (x + cells) % cells;
    y = (y + cells) % cells;
  } else if (x < 0 || y < 0 || x >= cells || y >= cells) {
    return { ...state, alive: false, ate: false, cause: 'wall' };
  }

  const ate = Boolean(state.apple) && x === state.apple.x && y === state.apple.y;
  // The tail vacates its cell on a normal move, so moving into it is legal.
  const body = ate ? state.snake : state.snake.slice(0, -1);

  if (body.some((seg) => seg.x === x && seg.y === y)) {
    return { ...state, alive: false, ate: false, cause: 'self' };
  }

  const snake = [{ x, y }, ...body];
  return {
    snake,
    dir: state.dir,
    ate,
    score: state.score + (ate ? 1 : 0),
    apple: ate ? spawnApple(snake, cells, rng) : state.apple,
    alive: true,
    cause: null,
  };
}

function mountSnake(ctx) {
  let speed = SNAKE_SPEEDS[1];
  let size = SNAKE_SIZES[1];
  let wrap = false;
  let state = createSnakeState(size.cells);
  let queued = [];       // buffered turns, applied one per tick
  let timer = null;
  let running = false;
  let over = false;

  const bestKey = () => `snake-best-${size.id}-${wrap ? 'wrap' : 'walls'}`;

  /* ---------- controls ---------- */

  const speedRow = segmented(
    SNAKE_SPEEDS.map((s) => ({ id: s.id, label: s.label })),
    speed.id, (id) => { speed = SNAKE_SPEEDS.find((s) => s.id === id); restart(); },
    { ariaLabel: 'Speed' });

  const sizeRow = segmented(
    SNAKE_SIZES.map((s) => ({ id: s.id, label: s.label })),
    size.id, (id) => { size = SNAKE_SIZES.find((s) => s.id === id); restart(); },
    { ariaLabel: 'Board size' });

  const wallRow = segmented([
    { id: 'walls', label: 'Solid Walls' },
    { id: 'wrap', label: 'Wrap Around' },
  ], 'walls', (id) => { wrap = id === 'wrap'; restart(); }, { ariaLabel: 'Edges' });

  const scoreRow = statRow([
    { key: 'score', label: 'Apples', tone: 'x' },
    { key: 'length', label: 'Length', value: '3', tone: 'muted' },
    { key: 'best', label: 'Best', tone: 'o' },
  ]);

  const canvas = document.createElement('canvas');
  canvas.className = 'canvas';
  const draw2d = canvas.getContext('2d');

  const pauseBtn = { label: 'Pause', onClick: togglePause, ghost: true };
  const controlsEl = buttonRow([{ label: 'New Game', onClick: restart }, pauseBtn]);
  const pauseEl = controlsEl.lastElementChild;

  ctx.settings.append(speedRow.el, sizeRow.el, wallRow.el);
  ctx.score.append(scoreRow.el);
  ctx.stage.append(canvas, dpad(steer));
  ctx.controls.append(controlsEl);
  ctx.setTheme('snake');
  ctx.setHint('Arrow keys or WASD · Space to pause');

  /* ---------- loop ---------- */

  function tick() {
    if (queued.length) state = { ...state, dir: turnSnake(state.dir, queued.shift()) };

    state = snakeStep(state, { cells: size.cells, wrap });

    if (state.ate) audio.play('eat');
    if (!state.alive) return finish(`Game over — ${state.cause === 'wall' ? 'hit the wall' : 'bit yourself'}`);
    if (!state.apple) return finish('Perfect! You filled the board');

    refreshScores();
    render();
  }

  function start() {
    stop();
    running = true;
    timer = setInterval(tick, speed.ms);
    pauseEl.textContent = 'Pause';
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    running = false;
  }

  function togglePause() {
    if (over) return restart();
    if (running) {
      stop();
      pauseEl.textContent = 'Resume';
      ctx.setStatus('Paused');
    } else {
      start();
      ctx.setStatus(`Score ${state.score}`);
    }
  }

  function finish(message) {
    audio.play(state.alive ? 'win' : 'lose');
    stop();
    over = true;
    pauseEl.textContent = 'Play Again';

    const best = storage.get(bestKey(), 0);
    const isBest = state.score > best;
    if (isBest) storage.set(bestKey(), state.score);

    refreshScores();
    render();
    ctx.setStatus(`${message} · ${state.score} apples${isBest && state.score > 0 ? ' · new best!' : ''}`, true);
  }

  function restart() {
    stop();
    over = false;
    queued = [];
    state = createSnakeState(size.cells);
    resizeCanvas();
    refreshScores();
    render();
    ctx.setStatus(`Score ${state.score}`);
    start();
  }

  function steer(name) {
    const dir = SNAKE_DIRS[name];
    if (!dir || over) return;
    // Buffer at most two turns so a quick double-tap round a corner registers.
    const last = queued.length ? queued[queued.length - 1] : state.dir;
    if ((dir.x === last.x && dir.y === last.y) || queued.length >= 2) return;
    queued.push(dir);
  }

  function refreshScores() {
    scoreRow.set('score', state.score);
    scoreRow.set('length', state.snake.length);
    scoreRow.set('best', storage.get(bestKey(), 0));
  }

  /* ---------- rendering ---------- */

  function resizeCanvas() {
    canvas.width = size.cells * SNAKE_CELL;
    canvas.height = size.cells * SNAKE_CELL;
  }

  /* The board: a dark checkerboard lawn with a vignette, so the middle reads
     brighter than the corners and the snake has something to sit on. */
  function drawBoard(span, px) {
    const base = draw2d.createLinearGradient(0, 0, span, span);
    base.addColorStop(0, '#101c31');
    base.addColorStop(0.5, '#0c1526');
    base.addColorStop(1, '#080f1d');
    draw2d.fillStyle = base;
    draw2d.fillRect(0, 0, span, span);

    for (let y = 0; y < size.cells; y++) {
      for (let x = 0; x < size.cells; x++) {
        if ((x + y) % 2) continue;
        draw2d.fillStyle = 'rgba(148, 197, 255, 0.035)';
        draw2d.fillRect(x * px, y * px, px, px);
      }
    }

    // Grid lines, barely there — enough to judge a turn by.
    draw2d.strokeStyle = 'rgba(148, 163, 184, 0.06)';
    draw2d.lineWidth = 1;
    draw2d.beginPath();
    for (let i = 1; i < size.cells; i++) {
      draw2d.moveTo(i * px, 0);
      draw2d.lineTo(i * px, span);
      draw2d.moveTo(0, i * px);
      draw2d.lineTo(span, i * px);
    }
    draw2d.stroke();

    const vignette = draw2d.createRadialGradient(
      span / 2, span / 2, span * 0.28, span / 2, span / 2, span * 0.78);
    vignette.addColorStop(0, 'rgba(0, 0, 0, 0)');
    vignette.addColorStop(1, 'rgba(2, 5, 12, 0.55)');
    draw2d.fillStyle = vignette;
    draw2d.fillRect(0, 0, span, span);

    // Solid walls are a real hazard, so they get a real edge. Wrapping edges
    // get a dashed one, to show they are open.
    draw2d.lineWidth = 3;
    draw2d.strokeStyle = wrap ? 'rgba(56, 189, 248, 0.3)' : 'rgba(56, 189, 248, 0.55)';
    if (wrap) draw2d.setLineDash([px * 0.4, px * 0.32]);
    draw2d.beginPath();
    draw2d.rect(1.5, 1.5, span - 3, span - 3);
    draw2d.stroke();
    draw2d.setLineDash([]);
  }

  /* An apple: a lit sphere rather than a flat disc, with a stem and a leaf. */
  function drawApple(cx, cy, r) {
    draw2d.fillStyle = 'rgba(248, 113, 113, 0.16)';   // the glow it casts
    draw2d.beginPath();
    draw2d.arc(cx, cy, r * 1.9, 0, Math.PI * 2);
    draw2d.fill();

    const skin = draw2d.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r * 1.15);
    skin.addColorStop(0, '#fecaca');
    skin.addColorStop(0.35, '#f87171');
    skin.addColorStop(1, '#9f1239');
    draw2d.fillStyle = skin;
    draw2d.beginPath();
    draw2d.arc(cx, cy, r, 0, Math.PI * 2);
    draw2d.fill();

    draw2d.fillStyle = '#7c2d12';                     // stem
    draw2d.fillRect(cx - r * 0.08, cy - r * 1.35, r * 0.16, r * 0.5);

    draw2d.fillStyle = '#4ade80';                     // leaf
    draw2d.beginPath();
    draw2d.ellipse(cx + r * 0.4, cy - r * 1.1, r * 0.42, r * 0.2, -0.5, 0, Math.PI * 2);
    draw2d.fill();

    draw2d.fillStyle = 'rgba(255, 255, 255, 0.75)';   // specular
    draw2d.beginPath();
    draw2d.ellipse(cx - r * 0.34, cy - r * 0.36, r * 0.22, r * 0.14, -0.7, 0, Math.PI * 2);
    draw2d.fill();
  }

  /* The snake as one continuous tapering tube rather than a row of tiles:
     a disc at every segment plus a bar bridging each adjacent pair. Pairs that
     are not adjacent are the seam where the body wrapped round the edge, and
     bridging those would draw a bar straight across the board. */
  function drawSnake(px) {
    const body = state.snake;
    const n = body.length;
    const at = (seg) => [seg.x * px + px / 2, seg.y * px + px / 2];
    const radius = (i) => px * (0.42 - 0.1 * Math.min(1, i / Math.max(8, n - 1)));
    const adjacent = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;

    /* Each pass lays a whole tube down in one flat colour. Shading a segment
       individually looks banded — the joins between segments do not share the
       gradient — so the roundness comes from stacking narrowing passes rather
       than from per-segment gradients. */
    /* The whole tube goes into ONE path and is filled once. Filling segment
       by segment double-composites every overlap, which shows up as a bright
       bead at each joint on any translucent pass. */
    const pass = (scale, lift, colour) => {
      draw2d.beginPath();
      for (let i = n - 1; i >= 0; i--) {
        const [cx, cy] = at(body[i]);
        const y = cy + lift;
        const r = radius(i) * scale;
        draw2d.moveTo(cx + r, y);
        draw2d.arc(cx, y, r, 0, Math.PI * 2);

        // Bridge to the segment ahead — but only if it is actually next door.
        // A non-adjacent pair is the seam where the body wrapped round an
        // edge, and bridging that draws a bar straight across the board.
        if (i > 0 && adjacent(body[i], body[i - 1])) {
          const [nx, ny] = at(body[i - 1]);
          const link = Math.min(r, radius(i - 1) * scale);
          const flat = cy === ny;
          draw2d.rect(
            Math.min(cx, nx) - (flat ? 0 : link),
            Math.min(y, ny + lift) - (flat ? link : 0),
            flat ? Math.abs(nx - cx) : link * 2,
            flat ? link * 2 : Math.abs(ny - cy));
        }
      }
      draw2d.fillStyle = colour;
      draw2d.fill();
    };

    // Shaded head to tail with one gradient laid along the body's own axis.
    const [hx, hy] = at(body[0]);
    const [tx, ty] = at(body[n - 1]);
    let skin = '#3faf6d';
    if (hx !== tx || hy !== ty) {
      skin = draw2d.createLinearGradient(hx, hy, tx, ty);
      skin.addColorStop(0, '#5ce68f');
      skin.addColorStop(1, '#177a45');
    }

    pass(1, 0, '#052e16');                                                 // rim
    pass(0.86, 0, skin);                                                   // body
    if (state.alive) pass(0.4, -px * 0.13, 'rgba(214, 255, 233, 0.17)');   // sheen

    drawHead(at(body[0]), px);
  }

  function drawHead([cx, cy], px) {
    const { x: dx, y: dy } = state.dir;
    const side = { x: -dy, y: dx };            // 90 degrees from the heading
    const eyeOut = px * 0.17;
    const eyeFwd = px * 0.12;
    const eyeR = px * 0.11;

    // A forked tongue, flicking out ahead of the snake.
    if (state.alive) {
      draw2d.strokeStyle = '#fb7185';
      draw2d.lineWidth = Math.max(1, px * 0.06);
      const tipX = cx + dx * px * 0.72;
      const tipY = cy + dy * px * 0.72;
      draw2d.beginPath();
      draw2d.moveTo(cx + dx * px * 0.36, cy + dy * px * 0.36);
      draw2d.lineTo(tipX, tipY);
      for (const fork of [-1, 1]) {
        draw2d.moveTo(tipX, tipY);
        draw2d.lineTo(tipX + dx * px * 0.14 + side.x * fork * px * 0.13,
          tipY + dy * px * 0.14 + side.y * fork * px * 0.13);
      }
      draw2d.stroke();
    }

    for (const s of [-1, 1]) {
      const ex = cx + side.x * s * eyeOut + dx * eyeFwd;
      const ey = cy + side.y * s * eyeOut + dy * eyeFwd;

      draw2d.fillStyle = '#f8fafc';
      draw2d.beginPath();
      draw2d.arc(ex, ey, eyeR, 0, Math.PI * 2);
      draw2d.fill();

      if (state.alive) {
        draw2d.fillStyle = '#0f172a';
        draw2d.beginPath();
        draw2d.arc(ex + dx * eyeR * 0.35, ey + dy * eyeR * 0.35, eyeR * 0.55, 0, Math.PI * 2);
        draw2d.fill();
      } else {
        // Crossed-out eyes once it is over.
        draw2d.strokeStyle = '#0f172a';
        draw2d.lineWidth = Math.max(1, px * 0.07);
        draw2d.beginPath();
        draw2d.moveTo(ex - eyeR * 0.7, ey - eyeR * 0.7);
        draw2d.lineTo(ex + eyeR * 0.7, ey + eyeR * 0.7);
        draw2d.moveTo(ex + eyeR * 0.7, ey - eyeR * 0.7);
        draw2d.lineTo(ex - eyeR * 0.7, ey + eyeR * 0.7);
        draw2d.stroke();
      }
    }
  }

  function render() {
    const px = SNAKE_CELL;
    const span = size.cells * px;

    drawBoard(span, px);

    if (state.apple) {
      drawApple(state.apple.x * px + px / 2, state.apple.y * px + px / 2, px * 0.3);
    }

    drawSnake(px);

    if (!state.alive) {
      draw2d.fillStyle = state.cause ? 'rgba(69, 10, 10, 0.42)' : 'rgba(5, 46, 22, 0.4)';
      draw2d.fillRect(0, 0, span, span);
    }
  }

  /* ---------- input ---------- */

  function onKeyDown(event) {
    if (event.key === ' ') {
      event.preventDefault();
      togglePause();
      return;
    }
    const name = SNAKE_KEYS[event.key];
    if (!name) return;
    event.preventDefault(); // stop the arrow keys scrolling the page
    steer(name);
  }

  window.addEventListener('keydown', onKeyDown);

  restart();

  return {
    destroy() {
      stop();
      window.removeEventListener('keydown', onKeyDown);
    },
  };
}

if (typeof registerGame !== 'undefined') {
  registerGame({ id: 'snake', label: 'Snake', mount: mountSnake });
}

if (typeof module !== 'undefined') {
  module.exports = { createSnakeState, snakeStep, spawnApple, turnSnake, SNAKE_DIRS, SNAKE_SIZES };
}
