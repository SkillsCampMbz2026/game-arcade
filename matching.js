/* Matching Cards — flip two at a time and find every pair. */

const MATCH_SYMBOLS = ['🍎', '🚗', '🐍', '🎲', '🎧', '🌵', '🍕', '🚀', '⚽', '🎸', '🐙', '🍩', '🦊', '⛵', '🧩'];

const MATCH_SIZES = [
  { id: '4x3', label: '4 × 3', cols: 4, rows: 3 },
  { id: '4x4', label: '4 × 4', cols: 4, rows: 4 },
  { id: '6x4', label: '6 × 4', cols: 6, rows: 4 },
  { id: '6x5', label: '6 × 5', cols: 6, rows: 5 },
];

const FLIP_BACK_DELAY = 800;

// Two of each symbol, shuffled (Fisher-Yates). `rng` is injectable for tests.
function buildDeck(pairs, rng = Math.random) {
  const chosen = MATCH_SYMBOLS.slice(0, pairs);
  const deck = [...chosen, ...chosen];

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  return deck;
}

function mountMatching(ctx) {
  let size = MATCH_SIZES[1];
  let players = 1;
  let deck = [];
  let cards = [];
  let faceUp = [];            // indices flipped this turn, not yet resolved
  let matched = new Set();
  let moves = 0;
  let seconds = 0;
  let turn = 0;               // 2-player mode
  let pairScores = [0, 0];
  let started = false;
  let finished = false;
  let flipTimer = null;
  let tickTimer = null;

  const pairCount = () => (size.cols * size.rows) / 2;
  const bestKey = () => `match-best-${size.id}`;

  /* ---------- controls ---------- */

  const sizeRow = segmented(
    MATCH_SIZES.map((s) => ({ id: s.id, label: s.label })),
    size.id, setSize, { ariaLabel: 'Board size' });

  const playersRow = segmented([
    { id: '1', label: 'Solo' },
    { id: '2', label: '2 Players' },
  ], '1', setPlayers, { ariaLabel: 'Players' });

  let scoreRow = null;

  const gridEl = document.createElement('div');
  gridEl.className = 'cards';

  ctx.settings.append(sizeRow.el, playersRow.el);
  ctx.stage.append(gridEl);
  ctx.controls.append(buttonRow([{ label: 'New Game', onClick: newGame }]));
  ctx.setTheme('cards');

  /* ---------- scoreboard ---------- */

  function buildScoreboard() {
    ctx.score.replaceChildren();

    scoreRow = players === 1
      ? statRow([
        { key: 'moves', label: 'Moves', tone: 'muted' },
        { key: 'time', label: 'Time', value: '0:00', tone: 'muted' },
        { key: 'best', label: 'Best', value: '—', tone: 'x' },
      ])
      : statRow([
        { key: 'p1', label: 'Player 1', tone: 'x' },
        { key: 'left', label: 'Pairs Left', tone: 'muted' },
        { key: 'p2', label: 'Player 2', tone: 'o' },
      ]);

    ctx.score.append(scoreRow.el);
    refreshScores();
  }

  function refreshScores() {
    if (players === 1) {
      const best = storage.get(bestKey());
      scoreRow.set('moves', moves);
      scoreRow.set('time', formatTime(seconds));
      scoreRow.set('best', best ? `${best.moves}` : '—');
      scoreRow.setLabel('best', best ? `Best (${formatTime(best.seconds)})` : 'Best');
    } else {
      scoreRow.set('p1', pairScores[0]);
      scoreRow.set('p2', pairScores[1]);
      scoreRow.set('left', pairCount() - matched.size / 2);
      scoreRow.setTone('p1', turn === 0 ? 'x' : 'muted');
      scoreRow.setTone('p2', turn === 1 ? 'o' : 'muted');
    }
  }

  function statusText() {
    if (finished) return '';
    if (players === 1) return started ? 'Find the pairs' : 'Flip a card to start';
    return `Player ${turn + 1}'s turn`;
  }

  /* ---------- timer ---------- */

  function startClock() {
    if (started || players !== 1) return;
    started = true;
    tickTimer = setInterval(() => {
      seconds += 1;
      refreshScores();
    }, 1000);
  }

  function stopClock() {
    clearInterval(tickTimer);
    tickTimer = null;
  }

  /* ---------- gameplay ---------- */

  function flip(index) {
    if (finished || faceUp.length >= 2) return;
    if (matched.has(index) || faceUp.includes(index)) return;

    startClock();
    audio.play('flip');
    faceUp.push(index);
    cards[index].classList.add('is-face-up');

    if (faceUp.length < 2) return;

    moves += 1;
    const [a, b] = faceUp;

    if (deck[a] === deck[b]) {
      matched.add(a).add(b);
      cards[a].classList.add('is-matched');
      cards[b].classList.add('is-matched');
      faceUp = [];
      if (players === 2) pairScores[turn] += 1;
      refreshScores();
      audio.play('match');
      if (matched.size === deck.length) finish();
      else ctx.setStatus(statusText());
      return;
    }

    audio.play('miss');
    // A miss: show both briefly, then turn them back over.
    refreshScores();
    flipTimer = setTimeout(() => {
      flipTimer = null;
      cards[a].classList.remove('is-face-up');
      cards[b].classList.remove('is-face-up');
      faceUp = [];
      if (players === 2) {
        turn = 1 - turn;
        refreshScores();
      }
      ctx.setStatus(statusText());
    }, FLIP_BACK_DELAY);
  }

  function finish() {
    finished = true;
    stopClock();
    audio.play('finish');

    if (players === 1) {
      const best = storage.get(bestKey());
      const isBest = !best || moves < best.moves || (moves === best.moves && seconds < best.seconds);
      if (isBest) storage.set(bestKey(), { moves, seconds });
      refreshScores();
      ctx.setStatus(`Solved in ${moves} moves · ${formatTime(seconds)}${isBest ? ' · new best!' : ''}`, true);
    } else {
      const [p1, p2] = pairScores;
      ctx.setStatus(p1 === p2 ? `It's a draw — ${p1} each!`
        : `Player ${p1 > p2 ? 1 : 2} wins ${Math.max(p1, p2)}–${Math.min(p1, p2)}!`, true);
      refreshScores();
    }
  }

  /* ---------- setup ---------- */

  function buildGrid() {
    gridEl.style.setProperty('--cols', size.cols);
    gridEl.style.setProperty('--rows', size.rows);
    gridEl.replaceChildren();
    cards = [];

    deck.forEach((symbol, i) => {
      const card = document.createElement('button');
      card.className = 'card';
      card.dataset.index = i;
      card.setAttribute('aria-label', `Card ${i + 1}`);
      card.innerHTML =
        '<span class="card__inner">' +
        '<span class="card__face card__back"></span>' +
        `<span class="card__face card__front">${symbol}</span>` +
        '</span>';
      cards.push(card);
    });

    gridEl.append(...cards);
  }

  function newGame() {
    clearTimeout(flipTimer);
    flipTimer = null;
    stopClock();

    deck = buildDeck(pairCount());
    faceUp = [];
    matched = new Set();
    moves = 0;
    seconds = 0;
    turn = 0;
    pairScores = [0, 0];
    started = false;
    finished = false;

    buildGrid();
    buildScoreboard();
    ctx.setHint(`Match all ${pairCount()} pairs`);
    ctx.setStatus(statusText());
  }

  function setSize(id) {
    size = MATCH_SIZES.find((s) => s.id === id);
    newGame();
  }

  function setPlayers(id) {
    players = Number(id);
    newGame();
  }

  gridEl.addEventListener('click', (event) => {
    const card = event.target.closest('.card');
    if (card) flip(Number(card.dataset.index));
  });

  newGame();

  return {
    destroy() {
      clearTimeout(flipTimer);
      stopClock();
    },
  };
}

if (typeof registerGame !== 'undefined') {
  registerGame({ id: 'matching', label: 'Matching Cards', mount: mountMatching });
}

if (typeof module !== 'undefined') {
  module.exports = { buildDeck, MATCH_SIZES, MATCH_SYMBOLS };
}
