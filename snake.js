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

  function render() {
    const px = SNAKE_CELL;
    const span = size.cells * px;

    draw2d.fillStyle = '#0b1220';
    draw2d.fillRect(0, 0, span, span);

    // faint grid
    draw2d.strokeStyle = 'rgba(148, 163, 184, 0.08)';
    draw2d.lineWidth = 1;
    for (let i = 1; i < size.cells; i++) {
      draw2d.beginPath();
      draw2d.moveTo(i * px, 0);
      draw2d.lineTo(i * px, span);
      draw2d.moveTo(0, i * px);
      draw2d.lineTo(span, i * px);
      draw2d.stroke();
    }

    if (state.apple) {
      draw2d.fillStyle = '#f87171';
      draw2d.beginPath();
      draw2d.arc(state.apple.x * px + px / 2, state.apple.y * px + px / 2, px * 0.32, 0, Math.PI * 2);
      draw2d.fill();
    }

    state.snake.forEach((seg, i) => {
      const head = i === 0;
      draw2d.fillStyle = head ? '#86efac' : `rgba(74, 222, 128, ${Math.max(0.35, 1 - i / 28)})`;
      roundRect(draw2d, seg.x * px + 2, seg.y * px + 2, px - 4, px - 4, head ? 8 : 6);
      draw2d.fill();
    });

    if (!state.alive) {
      draw2d.fillStyle = 'rgba(15, 23, 42, 0.62)';
      draw2d.fillRect(0, 0, span, span);
    }
  }

  function roundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
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
