/* Tic Tac Toe and Connect Four. Both are the same turn-based board game with
   different rules, so they share one implementation; ai.js supplies the rules
   and the CPU. */

const HUMAN = 'X';
const CPU = 'O';
const CPU_DELAY = 400;
const DEFAULT_SIZE = { tictactoe: '3', connect4: '7x6' };

function mountBoardGame(ctx, gameId) {
  let rules = rulesFor(gameId, DEFAULT_SIZE[gameId]);
  let cells = [];
  let board = [];
  let currentPlayer = HUMAN;
  let gameOver = false;
  let mode = 'human';   // 'human' | 'easy' | 'medium' | 'hard'
  let firstMark = 'X';  // which mark opens each round
  let roundId = 0;      // invalidates pending CPU moves after a reset
  let cpuTimer = null;
  let previewCol = null;
  const scores = { X: 0, O: 0, draw: 0 };

  const vsComputer = () => mode !== 'human';
  const nameOf = (mark) => rules.names[mark];

  /* ---------- controls ---------- */

  const sizeRow = segmented(
    GAMES[gameId].sizes.map((s) => ({ id: s.id, label: s.label })),
    rules.id, setSize, { ariaLabel: 'Board size' });

  const modeRow = segmented([
    { id: 'human', label: '2 Players' },
    { id: 'easy', label: 'Easy' },
    { id: 'medium', label: 'Medium' },
    { id: 'hard', label: 'Hard' },
  ], mode, setMode, { ariaLabel: 'Opponent' });

  const firstRow = segmented([
    { id: 'X', label: 'X first' },
    { id: 'O', label: 'O first' },
  ], firstMark, setFirst, { ariaLabel: 'Who moves first' });

  const scoreRow = statRow([
    { key: 'X', label: 'X', tone: 'x' },
    { key: 'draw', label: 'Draws', tone: 'muted' },
    { key: 'O', label: 'O', tone: 'o' },
  ]);

  const boardEl = document.createElement('div');
  boardEl.className = 'board';

  ctx.settings.append(sizeRow.el, modeRow.el, firstRow.el);
  ctx.score.append(scoreRow.el);
  ctx.stage.append(boardEl);
  ctx.controls.append(buttonRow([
    { label: 'New Round', onClick: newRound },
    { label: 'Reset Scores', onClick: resetScores, ghost: true },
  ]));
  ctx.setTheme(rules.gravity ? 'drop' : '');

  /* ---------- playing a move ---------- */

  function turnText(player) {
    if (!vsComputer()) return `${nameOf(player)}'s turn`;
    return player === HUMAN ? 'Your turn' : 'Computer is thinking…';
  }

  function play(index, player) {
    board[index] = player;
    const cell = cells[index];
    cell.textContent = player;
    cell.dataset.player = player;

    if (rules.gravity) {
      // Filled discs stay enabled: a disabled button emits no pointer events,
      // and clicking anywhere in a column has to keep working.
      cell.style.setProperty('--row', Math.floor(index / rules.cols));
      cell.classList.add('cell--dropped');
    } else {
      cell.disabled = true;
    }

    audio.play(rules.gravity ? 'drop' : 'place');

    const line = lineAt(board, index, rules);
    if (line) {
      const message = !vsComputer() ? `${nameOf(player)} wins!`
        : player === CPU ? 'Computer wins!'
        : 'You win!';
      endRound(message, player, line);
      return;
    }

    if (board.every(Boolean)) {
      endRound("It's a draw!", 'draw');
      return;
    }

    currentPlayer = other(player);
    ctx.setStatus(turnText(currentPlayer));

    if (vsComputer() && currentPlayer === CPU) scheduleCpuMove();
    else showPreview();
  }

  function handleHumanMove(index) {
    if (gameOver) return;
    if (vsComputer() && currentPlayer !== HUMAN) return;

    // Under gravity a click anywhere in a column drops a piece down it.
    const target = rules.gravity ? dropIndex(board, index % rules.cols, rules) : index;
    if (target === -1 || board[target]) return;
    play(target, currentPlayer);
  }

  function endRound(message, scoreKey, line) {
    gameOver = true;
    ctx.setStatus(message, true);
    boardEl.classList.remove('board--thinking');
    clearPreview();
    scores[scoreKey] += 1;
    scoreRow.set(scoreKey, scores[scoreKey]);

    audio.play(scoreKey === 'draw' ? 'draw' : (vsComputer() && scoreKey === CPU ? 'lose' : 'win'));

    cells.forEach((cell) => { cell.disabled = true; });
    if (line) line.forEach((i) => cells[i].classList.add('cell--win'));
  }

  function scheduleCpuMove() {
    const thisRound = roundId;
    boardEl.classList.add('board--thinking');
    clearPreview();

    cpuTimer = setTimeout(() => {
      cpuTimer = null;
      if (thisRound !== roundId || gameOver) return;
      boardEl.classList.remove('board--thinking');
      play(chooseMove(board, CPU, mode, rules), CPU);
    }, CPU_DELAY);
  }

  /* ---------- drop preview (Connect Four) ---------- */

  function showPreview(col = previewCol) {
    clearPreview();
    previewCol = col;

    if (!rules.gravity || col === null || gameOver) return;
    if (vsComputer() && currentPlayer !== HUMAN) return;

    const target = dropIndex(board, col, rules);
    if (target === -1) return;

    const cell = cells[target];
    cell.style.setProperty('--preview', `var(--${currentPlayer === 'X' ? 'x' : 'o'})`);
    cell.classList.add('cell--preview');
  }

  function clearPreview() {
    cells.forEach((cell) => cell.classList.remove('cell--preview'));
  }

  /* ---------- board construction & resets ---------- */

  function buildBoard() {
    boardEl.style.setProperty('--cols', rules.cols);
    boardEl.style.setProperty('--rows', rules.rows);
    boardEl.classList.toggle('board--drop', rules.gravity);
    boardEl.replaceChildren();
    cells = [];

    for (let i = 0; i < rules.cols * rules.rows; i++) {
      const cell = document.createElement('button');
      cell.className = 'cell';
      cell.dataset.index = i;
      cell.setAttribute('aria-label', rules.gravity
        ? `Drop in column ${(i % rules.cols) + 1}`
        : `Row ${Math.floor(i / rules.cols) + 1}, column ${(i % rules.cols) + 1}`);
      cells.push(cell);
    }

    boardEl.append(...cells);
  }

  function newRound() {
    roundId += 1;
    clearTimeout(cpuTimer);
    cpuTimer = null;

    board = Array(rules.cols * rules.rows).fill('');
    currentPlayer = firstMark;
    gameOver = false;

    cells.forEach((cell) => {
      cell.textContent = '';
      cell.disabled = false;
      cell.classList.remove('cell--win', 'cell--dropped', 'cell--preview');
      delete cell.dataset.player;
    });

    boardEl.classList.remove('board--thinking');
    ctx.setStatus(turnText(currentPlayer));

    if (vsComputer() && currentPlayer === CPU) scheduleCpuMove();
  }

  function resetScores() {
    Object.keys(scores).forEach((key) => {
      scores[key] = 0;
      scoreRow.set(key, 0);
    });
    newRound();
  }

  /* ---------- settings ---------- */

  // Every label that names the two sides depends on both the variant and the
  // opponent, so they are all refreshed together.
  function refreshLabels() {
    scoreRow.setLabel('X', vsComputer() ? `You (${nameOf('X')})` : nameOf('X'));
    scoreRow.setLabel('O', vsComputer() ? `CPU (${nameOf('O')})` : nameOf('O'));
    firstRow.setLabel('X', vsComputer() ? 'You first' : `${nameOf('X')} first`);
    firstRow.setLabel('O', vsComputer() ? 'CPU first' : `${nameOf('O')} first`);
    ctx.setHint(`${rules.gravity ? 'Connect' : 'Get'} ${rules.target} in a row`);
  }

  function setSize(sizeId) {
    rules = rulesFor(gameId, sizeId);
    refreshLabels();
    buildBoard();
    resetScores(); // scores aren't comparable across board sizes
  }

  function setMode(next) {
    mode = next;
    refreshLabels();
    resetScores(); // scores aren't comparable across opponents
  }

  function setFirst(mark) {
    firstMark = mark;
    newRound();
  }

  /* ---------- wiring ---------- */

  boardEl.addEventListener('click', (event) => {
    const cell = event.target.closest('.cell');
    if (cell) handleHumanMove(Number(cell.dataset.index));
  });

  boardEl.addEventListener('pointermove', (event) => {
    if (!rules.gravity) return;
    const cell = event.target.closest('.cell');
    const col = cell ? Number(cell.dataset.index) % rules.cols : null;
    if (col !== previewCol) showPreview(col);
  });

  boardEl.addEventListener('pointerleave', () => {
    previewCol = null;
    clearPreview();
  });

  refreshLabels();
  buildBoard();
  newRound();

  return {
    destroy() {
      clearTimeout(cpuTimer);
      roundId += 1; // any in-flight CPU move is now stale
    },
  };
}

registerGame({
  id: 'tictactoe',
  label: 'Tic Tac Toe',
  mount: (ctx) => mountBoardGame(ctx, 'tictactoe'),
});

registerGame({
  id: 'connect4',
  label: 'Connect Four',
  mount: (ctx) => mountBoardGame(ctx, 'connect4'),
});
