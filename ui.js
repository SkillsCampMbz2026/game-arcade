/* Shared UI building blocks and the game registry.

   Every game registers itself with { id, label, mount(ctx) }. mount() fills in
   the shell regions handed to it and returns { destroy() } so the hub can tear
   down timers and listeners when the player switches games. */

const GAME_REGISTRY = [];
const registerGame = (game) => { GAME_REGISTRY.push(game); };

// A segmented button group. Returns { el, setActive, setLabel, value }.
function segmented(options, activeId, onSelect, { ariaLabel, wrap } = {}) {
  let current = activeId;

  const el = document.createElement('div');
  el.className = `modes${wrap ? ' modes--wrap' : ''}`;
  if (!wrap) el.style.gridTemplateColumns = `repeat(${options.length}, 1fr)`;
  if (options.length >= 4 && !wrap) el.classList.add('modes--tight');
  if (ariaLabel) {
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', ariaLabel);
  }

  const buttonFor = (id) => [...el.children].find((b) => b.dataset.id === id);

  function setActive(id) {
    current = id;
    [...el.children].forEach((b) => b.classList.toggle('is-active', b.dataset.id === id));
  }

  for (const option of options) {
    const btn = document.createElement('button');
    btn.className = 'mode';
    btn.dataset.id = option.id;
    btn.textContent = option.label;
    btn.addEventListener('click', () => {
      if (option.id === current) return;
      setActive(option.id);
      onSelect(option.id);
    });
    el.append(btn);
  }

  setActive(activeId);

  return {
    el,
    setActive,
    setLabel: (id, text) => { const b = buttonFor(id); if (b) b.textContent = text; },
    get value() { return current; },
  };
}

// A row of colour swatches. options: [{ id, label, colour }]
function swatches(options, activeId, onSelect, { ariaLabel } = {}) {
  let current = activeId;

  const el = document.createElement('div');
  el.className = 'swatches';
  if (ariaLabel) {
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', ariaLabel);
  }

  function setActive(id) {
    current = id;
    [...el.children].forEach((b) => b.classList.toggle('is-active', b.dataset.id === id));
  }

  for (const option of options) {
    const btn = document.createElement('button');
    btn.className = 'swatch';
    btn.dataset.id = option.id;
    btn.style.background = option.colour;
    btn.title = option.label;
    btn.setAttribute('aria-label', option.label);
    btn.addEventListener('click', () => {
      if (option.id === current) return;
      setActive(option.id);
      onSelect(option.id);
    });
    el.append(btn);
  }

  setActive(activeId);

  return { el, setActive, get value() { return current; } };
}

// A spec card: labelled 0..1 bars plus a caption. entries: [{ key, label }]
function statBars(entries) {
  const el = document.createElement('div');
  el.className = 'spec';

  const grid = document.createElement('div');
  grid.className = 'spec__grid';

  const caption = document.createElement('p');
  caption.className = 'spec__caption';

  const fills = {};
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'spec__row';

    const label = document.createElement('span');
    label.className = 'spec__label';
    label.textContent = entry.label;

    const track = document.createElement('span');
    track.className = 'spec__track';
    const fill = document.createElement('i');
    fill.className = 'spec__fill';
    track.append(fill);

    row.append(label, track);
    grid.append(row);
    fills[entry.key] = fill;
  }

  el.append(grid, caption);

  return {
    el,
    // Values arrive as 0..1; the floor keeps the weakest car from reading as
    // "none of this stat at all".
    set: (values) => {
      for (const [key, fill] of Object.entries(fills)) {
        const v = Math.max(0, Math.min(1, values[key] ?? 0));
        fill.style.width = `${Math.round((0.18 + 0.82 * v) * 100)}%`;
      }
    },
    setCaption: (text) => { caption.textContent = text; },
  };
}

// A row of stat tiles. entries: [{ key, label, value, tone }]
function statRow(entries) {
  const el = document.createElement('div');
  el.className = 'scoreboard';
  el.style.gridTemplateColumns = `repeat(${entries.length}, 1fr)`;

  const values = {};
  const labels = {};

  for (const entry of entries) {
    const tile = document.createElement('div');
    tile.className = `score${entry.tone ? ` score--${entry.tone}` : ''}`;

    const label = document.createElement('span');
    label.className = 'score__label';
    label.textContent = entry.label;

    const value = document.createElement('span');
    value.className = 'score__value';
    value.textContent = entry.value === undefined ? '0' : entry.value;

    tile.append(label, value);
    el.append(tile);
    values[entry.key] = value;
    labels[entry.key] = label;
  }

  return {
    el,
    set: (key, text) => { if (values[key]) values[key].textContent = text; },
    setLabel: (key, text) => { if (labels[key]) labels[key].textContent = text; },
    setTone: (key, tone) => {
      const tile = values[key]?.parentElement;
      if (tile) tile.className = `score${tone ? ` score--${tone}` : ''}`;
    },
  };
}

// A row of buttons. buttons: [{ label, onClick, ghost }]
function buttonRow(buttons) {
  const el = document.createElement('div');
  el.className = 'controls';

  for (const spec of buttons) {
    const btn = document.createElement('button');
    btn.className = `btn${spec.ghost ? ' btn--ghost' : ''}`;
    btn.textContent = spec.label;
    btn.addEventListener('click', spec.onClick);
    el.append(btn);
  }

  return el;
}

// Directional pad for the real-time games (and for anyone without a keyboard).
// Snake only needs the press; driving needs press-and-hold, so `onRelease`
// turns each button into a held control.
function dpad(onPress, { horizontalOnly, onRelease } = {}) {
  const el = document.createElement('div');
  el.className = `dpad${horizontalOnly ? ' dpad--flat' : ''}`;

  const keys = horizontalOnly
    ? [['←', 'left'], ['→', 'right']]
    : [['↑', 'up'], ['←', 'left'], ['↓', 'down'], ['→', 'right']];

  for (const [glyph, dir] of keys) {
    const btn = document.createElement('button');
    btn.className = `dpad__btn dpad__btn--${dir}`;
    btn.textContent = glyph;
    btn.setAttribute('aria-label', dir);

    btn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      onPress(dir);
    });

    if (onRelease) {
      // pointerleave/cancel matter too: sliding off a held button must release it
      for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
        btn.addEventListener(type, () => onRelease(dir));
      }
    }

    el.append(btn);
  }

  return el;
}

// Buttons that report press and release, for controls that are held rather
// than tapped. items: [{ id, label }]
function holdRow(items, onPress, onRelease) {
  const el = document.createElement('div');
  el.className = 'holdrow';

  for (const item of items) {
    const btn = document.createElement('button');
    btn.className = 'holdrow__btn';
    btn.textContent = item.label;
    btn.setAttribute('aria-label', item.aria || item.label);

    btn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      onPress(item.id);
    });
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
      btn.addEventListener(type, () => onRelease(item.id));
    }

    el.append(btn);
  }

  return el;
}

const formatTime = (seconds) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

// Best-score persistence. A file:// page can throw on localStorage access,
// so every call is guarded and simply degrades to "no saved best".
const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* private mode or a blocked file:// origin — best scores just won't persist */
    }
  },
};
