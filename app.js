/* The hub: owns the shared shell and swaps one game module in at a time. */

const shell = {
  root: document.getElementById('game'),
  title: document.getElementById('title'),
  games: document.getElementById('games'),
  settings: document.getElementById('settings'),
  hint: document.getElementById('hint'),
  score: document.getElementById('scoreboard'),
  status: document.getElementById('status'),
  stage: document.getElementById('stage'),
  controls: document.getElementById('controls'),
};

let session = null;

function gameContext() {
  return {
    settings: shell.settings,
    score: shell.score,
    stage: shell.stage,
    controls: shell.controls,
    setHint: (text) => { shell.hint.textContent = text; },
    setStatus: (text, highlight = false) => {
      shell.status.textContent = text;
      shell.status.classList.toggle('status--win', highlight);
    },
    setTheme: (theme) => { shell.root.dataset.theme = theme || ''; },
  };
}

function selectGame(id) {
  // Tear the previous game down first: its timers and window listeners would
  // otherwise keep running underneath the new one.
  if (session && typeof session.destroy === 'function') session.destroy();
  session = null;

  for (const region of [shell.settings, shell.score, shell.stage, shell.controls]) {
    region.replaceChildren();
  }
  shell.hint.textContent = '';
  shell.status.textContent = '';
  shell.status.classList.remove('status--win');
  shell.root.dataset.theme = '';

  const game = GAME_REGISTRY.find((g) => g.id === id) || GAME_REGISTRY[0];
  shell.root.classList.toggle('game--wide', Boolean(game.wide));
  shell.title.textContent = game.label;
  document.title = `${game.label} — Game Arcade`;

  session = game.mount(gameContext()) || null;
}

const picker = segmented(
  GAME_REGISTRY.map((game) => ({ id: game.id, label: game.label })),
  GAME_REGISTRY[0].id,
  selectGame,
  { ariaLabel: 'Game', wrap: true });

shell.games.append(picker.el);
selectGame(GAME_REGISTRY[0].id);
