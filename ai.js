/* Pure game logic + CPU strategies. No DOM access, so this file also runs
   under Node for the test suite (see the export at the bottom).

   A board is a flat array of '' | 'X' | 'O', indexed row-major from the top
   left: index = row * cols + col. `rules` describes the variant in play:
   { cols, rows, target, gravity, depth, names }. With gravity on, a move
   names a column and the piece falls to the lowest free row. */

const DIRECTIONS = [[0, 1], [1, 0], [1, 1], [1, -1]]; // →, ↓, ↘, ↙
const WIN_SCORE = 1e6;
// Value of a line-window by how many of its cells one side has filled.
const WINDOW_WEIGHTS = [0, 1, 12, 150, 2000];
// Connect Four only: holding the middle column is worth real tempo.
const CENTRE_BONUS = 6;

const GAMES = {
  tictactoe: {
    label: 'Tic Tac Toe',
    gravity: false,
    names: { X: 'X', O: 'O' },
    // 5x5 and 6x6 need only 4 in a row — needing all N would make them
    // near-unwinnable (a 6x6 win would have to fill an entire row).
    sizes: [
      { id: '3', label: '3 × 3', cols: 3, rows: 3, target: 3, depth: 9 },
      { id: '4', label: '4 × 4', cols: 4, rows: 4, target: 4, depth: 5 },
      { id: '5', label: '5 × 5', cols: 5, rows: 5, target: 4, depth: 4 },
      { id: '6', label: '6 × 6', cols: 6, rows: 6, target: 4, depth: 4 },
    ],
  },
  connect4: {
    label: 'Connect Four',
    gravity: true,
    names: { X: 'Red', O: 'Yellow' },
    sizes: [
      { id: '6x5', label: '6 × 5', cols: 6, rows: 5, target: 4, depth: 7 },
      { id: '7x6', label: '7 × 6', cols: 7, rows: 6, target: 4, depth: 7 },
      { id: '8x7', label: '8 × 7', cols: 8, rows: 7, target: 4, depth: 6 },
    ],
  },
};

const other = (mark) => (mark === 'X' ? 'O' : 'X');

function rulesFor(gameId, sizeId) {
  const game = GAMES[gameId];
  const size = game.sizes.find((s) => s.id === sizeId) || game.sizes[0];
  return { ...size, gravity: game.gravity, names: game.names, gameId };
}

function emptyCells(state) {
  return state.reduce((acc, value, i) => (value ? acc : [...acc, i]), []);
}

/* ---------- moves ---------- */

// Where a piece dropped down `col` comes to rest, or -1 if the column is full.
function dropIndex(state, col, { cols, rows }) {
  for (let row = rows - 1; row >= 0; row--) {
    const i = row * cols + col;
    if (!state[i]) return i;
  }
  return -1;
}

// Every cell a player may legally take right now. Under gravity that is at
// most one cell per column, which is what keeps the search tree narrow.
function legalMoves(state, rules) {
  if (!rules.gravity) return emptyCells(state);

  const moves = [];
  for (let col = 0; col < rules.cols; col++) {
    const i = dropIndex(state, col, rules);
    if (i !== -1) moves.push(i);
  }
  return moves;
}

/* ---------- win detection ---------- */

// The winning run through `index`, or undefined. Checking only the lines that
// pass through the last move keeps this cheap enough to call inside the search.
function lineAt(state, index, { cols, rows, target }) {
  const mark = state[index];
  if (!mark) return undefined;

  const row = Math.floor(index / cols);
  const col = index % cols;

  for (const [dr, dc] of DIRECTIONS) {
    const run = [index];

    for (const sign of [1, -1]) { // extend both ways along the direction
      for (let step = 1; ; step++) {
        const r = row + dr * step * sign;
        const c = col + dc * step * sign;
        if (r < 0 || r >= rows || c < 0 || c >= cols) break;
        if (state[r * cols + c] !== mark) break;
        run.push(r * cols + c);
      }
    }

    if (run.length >= target) return run.sort((a, b) => a - b);
  }

  return undefined;
}

// Whole-board scan. The UI always knows the last move and uses lineAt instead.
function lineFor(state, rules) {
  for (let i = 0; i < state.length; i++) {
    const line = lineAt(state, i, rules);
    if (line) return line;
  }
  return undefined;
}

// The legal move that completes a run for `mark` right now, or undefined.
function winningIndexFor(state, mark, rules) {
  return legalMoves(state, rules).find((i) => {
    state[i] = mark;
    const wins = Boolean(lineAt(state, i, rules));
    state[i] = '';
    return wins;
  });
}

/* ---------- difficulty levels ---------- */

// Easy: no strategy at all — misses wins and blocks.
function randomMove(state, cpu, rules) {
  const moves = legalMoves(state, rules);
  return moves[Math.floor(Math.random() * moves.length)];
}

// Medium: takes an immediate win, blocks an immediate loss, otherwise
// plays at random. Sound one move ahead, so it still walks into forks.
function mediumMove(state, cpu, rules) {
  const win = winningIndexFor(state, cpu, rules);
  if (win !== undefined) return win;

  const block = winningIndexFor(state, other(cpu), rules);
  if (block !== undefined) return block;

  return randomMove(state, cpu, rules);
}

// Hard: alpha-beta search. On 3x3 the depth covers the whole game, so it plays
// perfectly; on larger boards it searches as deep as it can afford and falls
// back on the heuristic below.
function hardMove(state, cpu, rules) {
  const open = emptyCells(state);
  if (open.length === state.length) return openingMove(rules);

  const win = winningIndexFor(state, cpu, rules);
  if (win !== undefined) return win;

  const block = winningIndexFor(state, other(cpu), rules);
  if (block !== undefined) return block;

  return search([...state], cpu, cpu, depthFor(rules, open.length), -Infinity, Infinity, rules).index;
}

// Once few cells remain the whole endgame fits in the search, so play it out
// exactly rather than handing a half-finished position to the heuristic.
function depthFor({ depth }, open) {
  return open <= depth + 2 ? open : depth;
}

function openingMove({ cols, rows, gravity }) {
  const col = Math.floor((cols - 1) / 2);
  const row = gravity ? rows - 1 : Math.floor((rows - 1) / 2);
  return row * cols + col;
}

// Cells worth considering. Gravity already narrows this to one per column;
// otherwise, beyond 4x4 the board is mostly irrelevant empty space, so only
// play next to something already on the board.
function candidateMoves(state, rules) {
  if (rules.gravity) return orderMoves(legalMoves(state, rules), rules);

  const open = emptyCells(state);
  if (rules.cols <= 4) return orderMoves(open, rules);

  const near = open.filter((i) => hasNeighbour(state, i, rules));
  return orderMoves(near.length ? near : open, rules);
}

function hasNeighbour(state, index, { cols, rows }) {
  const row = Math.floor(index / cols);
  const col = index % cols;

  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const r = row + dr;
      const c = col + dc;
      if (r < 0 || r >= rows || c < 0 || c >= cols) continue;
      if (state[r * cols + c]) return true;
    }
  }

  return false;
}

// Centre-out ordering makes alpha-beta prune far more of the tree. Under
// gravity only the column matters, since the row is forced.
function orderMoves(indices, { cols, rows, gravity }) {
  const midC = (cols - 1) / 2;
  const midR = (rows - 1) / 2;

  const distance = (i) => {
    const dc = (i % cols) - midC;
    if (gravity) return dc * dc;
    const dr = Math.floor(i / cols) - midR;
    return dr * dr + dc * dc;
  };

  return [...indices].sort((a, b) => distance(a) - distance(b));
}

// Scores every window of `target` consecutive cells: a window one side has to
// itself is worth more the fuller it is, and a contested window is worthless.
function evaluate(state, cpu, rules) {
  const { cols, rows, target, gravity } = rules;
  let score = 0;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      for (const [dr, dc] of DIRECTIONS) {
        const endR = row + dr * (target - 1);
        const endC = col + dc * (target - 1);
        if (endR < 0 || endR >= rows || endC < 0 || endC >= cols) continue;

        let mine = 0;
        let theirs = 0;
        for (let step = 0; step < target; step++) {
          const cell = state[(row + dr * step) * cols + (col + dc * step)];
          if (cell === cpu) mine++;
          else if (cell) theirs++;
        }

        if (mine && theirs) continue; // both sides present: dead window
        if (mine) score += WINDOW_WEIGHTS[mine];
        else if (theirs) score -= WINDOW_WEIGHTS[theirs] * 1.1; // mild defensive bias
      }
    }
  }

  if (gravity) {
    const midCol = Math.floor(cols / 2);
    for (let row = 0; row < rows; row++) {
      const cell = state[row * cols + midCol];
      if (cell === cpu) score += CENTRE_BONUS;
      else if (cell) score -= CENTRE_BONUS;
    }
  }

  return score;
}

function search(state, player, cpu, depth, alpha, beta, rules) {
  const moves = candidateMoves(state, rules);
  if (depth === 0 || moves.length === 0) {
    return { score: evaluate(state, cpu, rules), index: moves[0] };
  }

  const maximizing = player === cpu;
  let best = { score: maximizing ? -Infinity : Infinity, index: moves[0] };

  for (const index of moves) {
    state[index] = player;

    // A win ends the line here; +depth so a faster win outranks a slower one.
    const score = lineAt(state, index, rules)
      ? (maximizing ? WIN_SCORE + depth : -WIN_SCORE - depth)
      : search(state, other(player), cpu, depth - 1, alpha, beta, rules).score;

    state[index] = '';

    if (maximizing) {
      if (score > best.score) best = { score, index };
      alpha = Math.max(alpha, score);
    } else {
      if (score < best.score) best = { score, index };
      beta = Math.min(beta, score);
    }

    if (beta <= alpha) break; // this branch is already refuted
  }

  return best;
}

const CPU_STRATEGIES = {
  easy: randomMove,
  medium: mediumMove,
  hard: hardMove,
};

function chooseMove(state, cpu, difficulty, rules) {
  return CPU_STRATEGIES[difficulty](state, cpu, rules);
}

if (typeof module !== 'undefined') {
  module.exports = {
    GAMES, rulesFor, lineAt, lineFor, emptyCells, legalMoves, dropIndex,
    other, chooseMove, winningIndexFor,
  };
}
