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

/* Fullscreen. By default the whole page goes fullscreen, which suits the board
   games and the canvas ones. A game can instead nominate one element — the
   maze points at its 3D viewport, because it also wants the pointer lock that
   comes with fullscreening just the view. Cleared on every game switch. */
let fullscreenTarget = null;

function gameContext() {
  return {
    settings: shell.settings,
    score: shell.score,
    stage: shell.stage,
    controls: shell.controls,
    setFullscreenTarget: (el) => { fullscreenTarget = el || null; },
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
  fullscreenTarget = null;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});

  const game = GAME_REGISTRY.find((g) => g.id === id) || GAME_REGISTRY[0];
  shell.root.classList.toggle('game--wide', Boolean(game.wide));
  shell.title.textContent = game.label;
  document.title = `${game.label} — Game Arcade`;

  session = game.mount(gameContext()) || null;
}

const soundBtn = document.getElementById('sound');
const fullscreenBtn = document.getElementById('fullscreen');

function paintSoundButton() {
  soundBtn.textContent = audio.enabled ? '🔊' : '🔇';
  soundBtn.setAttribute('aria-pressed', String(audio.enabled));
}

soundBtn.addEventListener('click', () => {
  audio.toggle();
  paintSoundButton();
});

paintSoundButton();

function paintFullscreenButton() {
  const on = Boolean(document.fullscreenElement);
  fullscreenBtn.setAttribute('aria-pressed', String(on));
  fullscreenBtn.title = on ? 'Leave fullscreen' : 'Fullscreen';
}

// Hide the control outright where the browser has no Fullscreen API rather
// than offering a button that does nothing.
if (typeof document.documentElement.requestFullscreen !== 'function') {
  fullscreenBtn.hidden = true;
} else {
  fullscreenBtn.addEventListener('click', () => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    const target = fullscreenTarget || document.documentElement;
    if (target.requestFullscreen) target.requestFullscreen().catch(() => {});
  });

  document.addEventListener('fullscreenchange', paintFullscreenButton);
  paintFullscreenButton();
}

const picker = segmented(
  GAME_REGISTRY.map((game) => ({ id: game.id, label: game.label })),
  GAME_REGISTRY[0].id,
  selectGame,
  { ariaLabel: 'Game', wrap: true });

shell.games.append(picker.el);
selectGame(GAME_REGISTRY[0].id);
