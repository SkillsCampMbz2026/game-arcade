/* Car Racing — a 3D race against seven rivals over three maps.

   The world is genuinely three-dimensional: the track is a ribbon of segments
   with real x/y/z world coordinates, and everything on screen comes from a
   perspective projection through a camera behind and above the car. Rendering
   uses the canvas 2D API rather than WebGL — projected segments are filled as
   trapezoids, painted far-to-near — which is how arcade racers drew 3D roads
   before GPUs. No dependencies, works offline.

   Simulation (createRace / stepRace / buildTrack / project) is pure and
   testable; only mountRacing touches the DOM. */

const RACE_W = 900;              // logical canvas pixels (16:9 widescreen)
const RACE_H = 506;
const UI = RACE_W / 480;         // scales HUD and car sizes with the canvas
const SEGMENT_LENGTH = 200;      // world units per road segment
const RUMBLE_LENGTH = 3;         // segments per rumble stripe
// Drawing further ahead keeps roughly 2.5s of road in view at the higher top
// speed, so corners still arrive with time to react.
const DRAW_DISTANCE = 240;       // segments drawn ahead of the camera
// Sized so the road fills the canvas at the player's position rather than
// running off both edges.
const ROAD_WIDTH = 1100;         // world units from centre line to verge
const FIELD_OF_VIEW = 100;       // degrees
const CAMERA_HEIGHT = 1000;      // world units above the road
const CAMERA_DEPTH = 1 / Math.tan((FIELD_OF_VIEW / 2) * Math.PI / 180);
const PLAYER_Z = CAMERA_HEIGHT * CAMERA_DEPTH; // camera-to-car distance
// Your own car is drawn at exactly the size the projection gives it at
// PLAYER_Z. Anything else and a rival alongside you would not match your car.
const PLAYER_DRAW = 1;
// Steering rate is deliberately independent of the centrifugal constant, so
// the two can be tuned without dragging each other around.
const STEER_RATE = 3.6;          // road-widths per second at full speed
const STEER_AUTHORITY = 0.35;    // you can still turn in when crawling
const CENTRIFUGAL = 0.64;        // how hard curves push you outward
const FOG_DENSITY = 4.5;

// There is no top speed. Engine force falls away as you go faster — the way
// real power-limited acceleration does — but it never reaches zero, so the car
// keeps gaining indefinitely. SPEED_REFERENCE is only a yardstick: it is the
// speed the dial calls 500 km/h, and what percentages are measured against.
const SPEED_REFERENCE = SEGMENT_LENGTH * 100;
const REFERENCE_KMH = 500;
const KMH_PER_UNIT = REFERENCE_KMH / SPEED_REFERENCE;
const ROLLING_DRAG = 900;               // constant, always acting
const COAST_DRAG = 0.35;                // aero, proportional to speed
const BRAKE_FORCE = SPEED_REFERENCE / 1.4;
const OFF_ROAD_DECEL = SPEED_REFERENCE / 1.6;
const OFF_ROAD_LIMIT = SPEED_REFERENCE / 4;
const OFF_ROAD_GRIP = 0.45;             // the grass barely steers
const DRAFT_RANGE = SEGMENT_LENGTH * 9; // tow distance behind a rival
const DRAFT_BOOST = 0.22;               // extra engine force in clean air behind
const RACE_LAPS = 3;

const speedInKmh = (speed) => Math.round(speed * KMH_PER_UNIT);

const RIVAL_COUNT = 7;
const GRID_SPACING = SEGMENT_LENGTH * 3;
const COUNTDOWN = 3.2;           // seconds on the grid
const LOOKAHEAD = SEGMENT_LENGTH * 18;
const FINISH_SEGMENTS = 4;       // how much of the track is checkered

const RIVAL_COLOURS = ['#38bdf8', '#c084fc', '#34d399', '#fb7185', '#f472b6', '#f97316', '#a3e635'];

// Every car on the grid is the same chassis, at the same size — the field is
// identical bodywork in different colours, and the only thing separating them
// is how they drive.
const CAR_SIZE = { width: 440, height: 330 };
const CAR_HALF_WIDTH = CAR_SIZE.width / (2 * ROAD_WIDTH);

// The one silhouette every car is drawn from: a rounded cartoon shape with a
// high domed roof, bulged rear haunches and a big glasshouse. Vertical values
// are fractions of the car's height (0 at the roof, 1 at the road); horizontal
// ones are fractions of its half-width.
const CAR_PROFILE = {
  roofY: 0.30,        // where the dome meets the shoulders
  waistY: 0.52,       // window line
  hipY: 0.86,         // widest point, over the wheels
  skirtY: 0.80,       // start of the shaded lower panel
  rockerY: 0.94,      // bottom of the bodywork
  shoulder: 0.72,
  hip: 1.0,
  rocker: 0.84,
  glassTop: 0.10,
  glassBottom: 0.50,
  glassHalf: 0.60,
  wheel: { x: 1.02, y: 0.78, radius: 0.25 },
  lights: { y: 0.60, half: 0.86, w: 0.13, h: 0.1 },
  bumper: { y: 0.83, half: 0.8, h: 0.09 },
};

/* The roster. Every entry is a set of numbers, not a look:

   power      engine force from a standstill, in world units/s^2
   powerBand  how far up the speed range that force holds on — the closest
              thing to a "top speed", since nothing is capped
   grip       steering response, and how well it resists being pushed wide
   braking    stopping force multiplier

   No two cars share a value on any axis, so each one is a distinct package. */
const CAR_MODELS = [
  {
    id: 'veloce', label: 'Veloce GT',
    blurb: 'Balanced all-rounder',
    power: 6000, powerBand: 21000, grip: 1.06, braking: 1.0,
  },
  {
    id: 'strato', label: 'Strato SV',
    blurb: 'Long-geared V12 missile',
    power: 5600, powerBand: 31000, grip: 0.88, braking: 0.92,
  },
  {
    id: 'volt', label: 'Volt RS',
    blurb: 'Electric — brutal off the line',
    power: 8600, powerBand: 14500, grip: 1.16, braking: 1.16,
  },
  {
    id: 'aurora', label: 'Aurora Club',
    blurb: 'Featherweight — grips and stops',
    power: 5400, powerBand: 17500, grip: 1.32, braking: 1.28,
  },
  {
    id: 'titan', label: 'Titan One',
    blurb: 'Hypercar — endless top end',
    power: 6500, powerBand: 36000, grip: 0.83, braking: 0.86,
  },
];

// Where a car sits against the rest of the roster, 0..1 per category. Driven
// off the same numbers the physics uses, so the bars can never lie.
function carStats(model, roster = CAR_MODELS) {
  const rank = (pick) => {
    const values = roster.map(pick);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    return hi === lo ? 1 : (pick(model) - lo) / (hi - lo);
  };

  return {
    speed: rank((m) => m.powerBand),
    accel: rank((m) => m.power),
    grip: rank((m) => m.grip),
    braking: rank((m) => m.braking),
  };
}

// A car's natural pace, used to set how hard each rival pushes.
const paceOf = (model) => SPEED_REFERENCE * (0.66 + 0.34 * carStats(model).speed);

const CAR_PAINTS = [
  { id: 'sunburst', label: 'Sunburst', colour: '#fbbf24' },
  { id: 'inferno', label: 'Inferno', colour: '#ef4444' },
  { id: 'azure', label: 'Azure', colour: '#38bdf8' },
  { id: 'viper', label: 'Viper', colour: '#22c55e' },
  { id: 'amethyst', label: 'Amethyst', colour: '#a855f7' },
  { id: 'magma', label: 'Magma', colour: '#f97316' },
  { id: 'ghost', label: 'Ghost', colour: '#e2e8f0' },
  { id: 'midnight', label: 'Midnight', colour: '#334155' },
];

const ROAD = {
  LENGTH: { SHORT: 25, MEDIUM: 50, LONG: 100 },
  CURVE: { EASY: 2, MEDIUM: 4, HARD: 6 },
  HILL: { LOW: 20, MEDIUM: 40, HIGH: 60 },
};

/* ---------- small maths helpers ---------- */

const clampNumber = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const interpolate = (a, b, percent) => a + (b - a) * percent;
const easeIn = (a, b, p) => a + (b - a) * p ** 2;
const easeInOut = (a, b, p) => a + (b - a) * (-Math.cos(p * Math.PI) / 2 + 0.5);
const percentRemaining = (n, total) => (n % total) / total;

function ordinal(n) {
  const tail = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${tail[(v - 20) % 10] || tail[v] || tail[0]}`;
}

function increase(start, amount, max) {
  let result = (start + amount) % max;
  if (result < 0) result += max;
  return result;
}

// Distance from `from` forward to `to` around the looping track.
const forwardGap = (from, to, trackLength) => increase(to - from, 0, trackLength);

// Do two road-relative spans overlap? `percent` shrinks both for a bit of give.
function overlap(x1, w1, x2, w2, percent = 1) {
  const half = percent / 2;
  return !((x1 + w1 * half) < (x2 - w2 * half) || (x1 - w1 * half) > (x2 + w2 * half));
}

// Lighten (positive) or darken (negative) a #rrggbb colour.
function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (channel) => {
    const base = (n >> channel) & 255;
    const target = amount > 0 ? 255 : 0;
    return Math.round(base + (target - base) * Math.abs(amount));
  };
  return `rgb(${mix(16)}, ${mix(8)}, ${mix(0)})`;
}

/* ---------- the projection ---------- */

// Takes a world-space point to screen space through the camera. This is the
// whole of the 3D: everything drawn is placed by this function.
function project(point, cameraX, cameraY, cameraZ, cameraDepth, width, height, roadWidth) {
  point.camera.x = (point.world.x || 0) - cameraX;
  point.camera.y = (point.world.y || 0) - cameraY;
  point.camera.z = (point.world.z || 0) - cameraZ;

  point.screen.scale = cameraDepth / point.camera.z;
  point.screen.x = Math.round(width / 2 + point.screen.scale * point.camera.x * width / 2);
  point.screen.y = Math.round(height / 2 - point.screen.scale * point.camera.y * height / 2);
  point.screen.w = Math.round(point.screen.scale * roadWidth * width / 2);

  return point;
}

/* ---------- track construction ---------- */

const lastY = (segments) => (segments.length ? segments[segments.length - 1].p2.world.y : 0);

function addSegment(segments, curve, y) {
  const n = segments.length;
  segments.push({
    index: n,
    p1: { world: { x: 0, y: lastY(segments), z: n * SEGMENT_LENGTH }, camera: {}, screen: {} },
    p2: { world: { x: 0, y, z: (n + 1) * SEGMENT_LENGTH }, camera: {}, screen: {} },
    curve,
    cars: [],
    sprites: [],
    dark: Math.floor(n / RUMBLE_LENGTH) % 2 === 1,
    finish: n < FINISH_SEGMENTS,
    clip: 0,
    fog: 1,
  });
}

// One stretch of road: easing into `curve`, holding it, then easing out, while
// the elevation moves by `height` across the whole stretch.
function addRoad(segments, enter, hold, leave, curve, height) {
  const startY = lastY(segments);
  const endY = startY + height;
  const total = enter + hold + leave;
  let n = 0;

  for (let i = 0; i < enter; i++, n++) {
    addSegment(segments, easeIn(0, curve, i / enter), easeInOut(startY, endY, n / total));
  }
  for (let i = 0; i < hold; i++, n++) {
    addSegment(segments, curve, easeInOut(startY, endY, n / total));
  }
  for (let i = 0; i < leave; i++, n++) {
    addSegment(segments, easeInOut(curve, 0, i / leave), easeInOut(startY, endY, n / total));
  }
}

// `shape` tunes how twisty and hilly a map is; each map passes its own.
function buildTrack(rng = Math.random, shape = {}) {
  const {
    pieces = 8,
    curves = [ROAD.CURVE.EASY, ROAD.CURVE.MEDIUM],
    hills = [ROAD.HILL.LOW, ROAD.HILL.MEDIUM],
    lengths = [ROAD.LENGTH.SHORT, ROAD.LENGTH.MEDIUM, ROAD.LENGTH.LONG],
    straightBias = 0.25,
  } = shape;

  const segments = [];
  const pick = (list) => list[Math.floor(rng() * list.length)];

  addRoad(segments, ROAD.LENGTH.SHORT, ROAD.LENGTH.SHORT, ROAD.LENGTH.SHORT, 0, 0); // start straight

  for (let piece = 0; piece < pieces; piece++) {
    const length = pick(lengths);
    const direction = rng() < 0.5 ? -1 : 1;
    const roll = rng();

    if (roll < straightBias) addRoad(segments, length, length, length, 0, 0);
    else if (roll < straightBias + 0.35) addRoad(segments, length, length, length, pick(curves) * direction, 0);
    else if (roll < straightBias + 0.6) addRoad(segments, length, length, length, 0, pick(hills) * direction * SEGMENT_LENGTH / 10);
    else addRoad(segments, length, length, length, pick(curves) * direction, pick(hills) * direction * SEGMENT_LENGTH / 10);
  }

  // The track loops, so it has to come back to ground level and run straight
  // into its own start — otherwise there is a cliff at the seam.
  addRoad(segments, ROAD.LENGTH.MEDIUM, ROAD.LENGTH.MEDIUM, ROAD.LENGTH.MEDIUM, 0, -lastY(segments));
  addRoad(segments, ROAD.LENGTH.SHORT, ROAD.LENGTH.SHORT, ROAD.LENGTH.SHORT, 0, 0);

  // Snap the seam shut. Easing across thousands of segments leaves a rounding
  // residue, and the last segment has to meet the first one exactly.
  segments[segments.length - 1].p2.world.y = 0;

  return segments;
}

function addScenery(segments, rng, kinds, density) {
  for (const segment of segments) {
    if (segment.finish) continue; // keep the start line clear
    if (rng() >= density) continue;
    const side = rng() < 0.5 ? -1 : 1;
    segment.sprites.push({
      offset: side * (1.3 + rng() * 1.6),
      kind: kinds[Math.floor(rng() * kinds.length)],
    });
  }
}

/* ---------- the three maps ---------- */

const RACE_MAPS = [
  {
    id: 'coast',
    label: 'Coast',
    laps: RACE_LAPS,
    scenery: { kinds: ['palm', 'sign'], density: 0.11 },
    shape: {
      pieces: 6,
      curves: [ROAD.CURVE.EASY, ROAD.CURVE.MEDIUM],
      hills: [ROAD.HILL.LOW],
      lengths: [ROAD.LENGTH.SHORT, ROAD.LENGTH.MEDIUM, ROAD.LENGTH.LONG],
      straightBias: 0.4,
    },
    palette: {
      skyTop: '#0c4a6e', skyMid: '#0ea5e9', skyLow: '#7dd3fc',
      sun: '#fef9c3', sunGlow: 'rgba(254, 249, 195, 0.35)',
      ridgeFar: '#075985', ridgeNear: '#0369a1',
      ground: '#0f766e',
      grassLight: '#16a34a', grassDark: '#15803d',
      rumbleLight: '#f8fafc', rumbleDark: '#dc2626',
      roadLight: '#57534e', roadDark: '#44403c',
      lane: '#f8fafc', fog: '#7dd3fc',
    },
  },
  {
    id: 'canyon',
    label: 'Canyon',
    laps: RACE_LAPS,
    scenery: { kinds: ['cactus', 'rock'], density: 0.13 },
    shape: {
      pieces: 9,
      curves: [ROAD.CURVE.MEDIUM, ROAD.CURVE.HARD],
      hills: [ROAD.HILL.MEDIUM, ROAD.HILL.HIGH],
      lengths: [ROAD.LENGTH.SHORT, ROAD.LENGTH.MEDIUM],
      straightBias: 0.12,
    },
    palette: {
      skyTop: '#7c2d12', skyMid: '#ea580c', skyLow: '#fbbf24',
      sun: '#fff7ed', sunGlow: 'rgba(255, 237, 213, 0.4)',
      ridgeFar: '#7c2d12', ridgeNear: '#9a3412',
      ground: '#b45309',
      grassLight: '#d97706', grassDark: '#b45309',
      rumbleLight: '#fef3c7', rumbleDark: '#7f1d1d',
      roadLight: '#57534e', roadDark: '#44403c',
      lane: '#fef3c7', fog: '#fbbf24',
    },
  },
  {
    id: 'night',
    label: 'Night City',
    laps: RACE_LAPS,
    scenery: { kinds: ['lamp', 'tower'], density: 0.16 },
    shape: {
      pieces: 8,
      curves: [ROAD.CURVE.EASY, ROAD.CURVE.MEDIUM, ROAD.CURVE.HARD],
      hills: [ROAD.HILL.LOW, ROAD.HILL.MEDIUM],
      lengths: [ROAD.LENGTH.SHORT, ROAD.LENGTH.MEDIUM],
      straightBias: 0.2,
    },
    palette: {
      skyTop: '#020617', skyMid: '#1e1b4b', skyLow: '#4c1d95',
      sun: '#e2e8f0', sunGlow: 'rgba(226, 232, 240, 0.18)',
      ridgeFar: '#0f172a', ridgeNear: '#1e1b4b',
      ground: '#111827',
      grassLight: '#1f2937', grassDark: '#111827',
      rumbleLight: '#f8fafc', rumbleDark: '#7c3aed',
      roadLight: '#3f3f46', roadDark: '#27272a',
      lane: '#fde68a', fog: '#4c1d95',
    },
  },
];

const findSegment = (segments, z) =>
  segments[Math.floor(z / SEGMENT_LENGTH) % segments.length];

/* ---------- simulation ---------- */

function createRace(mapId, modelId = CAR_MODELS[0].id, rng = Math.random) {
  const map = RACE_MAPS.find((m) => m.id === mapId) || RACE_MAPS[0];
  const model = CAR_MODELS.find((m) => m.id === modelId) || CAR_MODELS[0];
  const segments = buildTrack(rng, map.shape);
  addScenery(segments, rng, map.scenery.kinds, map.scenery.density);

  const trackLength = segments.length * SEGMENT_LENGTH;

  const state = {
    map,
    model,
    halfWidth: CAR_HALF_WIDTH,
    segments,
    trackLength,
    laps: map.laps,
    raceDistance: trackLength * map.laps,
    rivals: [],
    z: 0,
    playerX: 0,
    speed: 0,
    progress: 0,
    travelled: 0,
    lap: 1,
    place: RIVAL_COUNT + 1,
    countdown: COUNTDOWN,
    time: 0,
    finished: false,
    offRoad: false,
    drafting: false,
    bumped: 0,
    steering: 0,
    curve: 0,
  };

  // A starting grid: rivals line up ahead in pairs, the player at the back.
  for (let i = 0; i < RIVAL_COUNT; i++) {
    const line = (i % 2 === 0 ? -1 : 1) * 0.42;
    const z = (i + 1) * GRID_SPACING;
    // Rivals take the other cars in the roster, so the field is mixed.
    const rivalModel = CAR_MODELS[(i + 1) % CAR_MODELS.length];
    const rival = {
      z,
      offset: line,
      line,
      percent: percentRemaining(z, SEGMENT_LENGTH),
      speed: 0,
      model: rivalModel,
      halfWidth: CAR_HALF_WIDTH,
      // A spread of paces, so the field strings out rather than moving as a block.
      targetSpeed: paceOf(rivalModel) * (0.94 + rng() * 0.12),
      progress: 0,
      colour: RIVAL_COLOURS[i % RIVAL_COLOURS.length],
      finished: false,
    };
    state.rivals.push(rival);
    findSegment(segments, z).cars.push(rival);
  }

  return state;
}

// Rivals hold a racing line, dodge whatever is close ahead, and ease off
// through tight curves.
function updateRivals(state, dt) {
  const player = { z: state.z, offset: state.playerX, speed: state.speed };
  const field = [...state.rivals, player];

  for (const car of state.rivals) {
    const segment = findSegment(state.segments, car.z);
    let target = car.targetSpeed;
    let dodge = 0;

    for (const other of field) {
      if (other === car) continue;
      const gap = forwardGap(car.z, other.z, state.trackLength);
      if (gap <= 0 || gap > LOOKAHEAD) continue;
      if (!overlap(car.offset, CAR_HALF_WIDTH * 2, other.offset, CAR_HALF_WIDTH * 2, 1.5)) continue;

      dodge = car.offset <= other.offset ? -1 : 1;
      if (Math.abs(car.offset) > 0.8) dodge = -Math.sign(car.offset); // stay on the tarmac
      target = Math.min(target, other.speed * 0.94);
      break;
    }

    car.offset += dodge
      ? dodge * dt * 1.3
      : (car.line - car.offset) * dt * 0.8; // drift back to its line
    car.offset = clampNumber(car.offset, -0.9, 0.9);

    // Tight corners cost the AI some speed, as they do the player.
    target *= 1 - Math.min(0.3, Math.abs(segment.curve) * 0.035);

    // Rivals accelerate and brake within their own car's limits.
    const pull = SPEED_REFERENCE * dt;
    const change = clampNumber(target - car.speed,
      -pull * car.model.braking, pull * 0.6 * (car.model.power / 6000));
    car.speed = Math.max(0, car.speed + change);

    const before = findSegment(state.segments, car.z);
    car.z = increase(car.z, dt * car.speed, state.trackLength);
    car.progress += dt * car.speed;
    car.percent = percentRemaining(car.z, SEGMENT_LENGTH);
    if (car.progress >= state.raceDistance) car.finished = true;

    const after = findSegment(state.segments, car.z);
    if (before !== after) {
      const i = before.cars.indexOf(car);
      if (i >= 0) before.cars.splice(i, 1);
      after.cars.push(car);
    }
  }
}

function standings(state) {
  return 1 + state.rivals.filter((r) => r.progress > state.progress).length;
}

// Engine force at a given speed. Falls away as the car gains pace — the shape
// of real power-limited acceleration — but stays strictly positive, so there
// is no speed the car cannot eventually exceed.
function engineForce(model, speed) {
  return model.power / (1 + Math.max(0, speed) / model.powerBand);
}

// Running in a rival's wake cuts through less air.
function draftFactor(state) {
  for (const car of state.rivals) {
    const gap = forwardGap(state.z, car.z, state.trackLength);
    if (gap <= 0 || gap > DRAFT_RANGE) continue;
    if (!overlap(state.playerX, CAR_HALF_WIDTH * 2, car.offset, CAR_HALF_WIDTH * 2, 1.6)) continue;
    return 1 + DRAFT_BOOST * (1 - gap / DRAFT_RANGE);
  }
  return 1;
}

// Collisions are checked across every segment the car passed through this
// frame. At high speed a single frame can span several segments, and only
// looking at the one you landed in would let you drive straight through cars.
function sweptCollision(state, fromZ, distance) {
  const { segments, trackLength } = state;
  const first = Math.floor(fromZ / SEGMENT_LENGTH);
  const spanned = Math.min(segments.length, Math.floor(distance / SEGMENT_LENGTH) + 1);

  for (let n = 0; n <= spanned; n++) {
    const segment = segments[(first + n) % segments.length];
    for (const car of segment.cars) {
      if (overlap(state.playerX, CAR_HALF_WIDTH * 2, car.offset, CAR_HALF_WIDTH * 2, 0.85)) {
        return car;
      }
    }
  }

  return null;
}

function stepRace(state, input, dt) {
  if (state.finished) return state;

  if (state.countdown > 0) {           // engines idle on the grid
    state.countdown = Math.max(0, state.countdown - dt);
    return state;
  }

  state.time += dt;
  updateRivals(state, dt);

  const { model } = state;
  const playerSegment = findSegment(state.segments, state.z + PLAYER_Z);
  const speedPercent = state.speed / SPEED_REFERENCE;
  state.offRoad = Math.abs(state.playerX) > 1;

  // Steering loads up as speed climbs past the reference — beyond it the car
  // gets progressively harder to turn, which is what keeps unlimited speed
  // from being a free win.
  const grip = model.grip * (state.offRoad ? OFF_ROAD_GRIP : 1);
  const weight = 1 / (1 + Math.max(0, speedPercent - 1) * 0.7);
  const steer = dt * STEER_RATE * grip * weight
    * Math.min(1, Math.max(STEER_AUTHORITY, speedPercent));

  if (input.left) state.playerX -= steer;
  else if (input.right) state.playerX += steer;
  state.steering = (input.left ? -1 : 0) + (input.right ? 1 : 0);

  // A curve throws you toward its outside edge with the square of speed, and
  // grip is what resists it. Uncapped, so genuinely fast corners need braking.
  state.playerX -= dt * speedPercent * speedPercent * playerSegment.curve
    * CENTRIFUGAL / model.grip;
  state.curve = playerSegment.curve;

  // Nothing happens unless you hold the throttle. Engine force always exceeds
  // zero, so there is no top speed — it just takes longer and longer.
  state.drafting = false;
  if (input.brake) {
    state.speed -= (BRAKE_FORCE * model.braking + COAST_DRAG * state.speed) * dt;
  } else if (input.accel) {
    const draft = draftFactor(state);
    state.drafting = draft > 1;
    state.speed += engineForce(model, state.speed) * draft * dt;
  } else {
    state.speed -= (ROLLING_DRAG + COAST_DRAG * state.speed) * dt;
  }

  if (state.offRoad && state.speed > OFF_ROAD_LIMIT) {
    state.speed -= OFF_ROAD_DECEL * dt;
  }

  state.playerX = clampNumber(state.playerX, -2, 2);
  state.speed = Math.max(0, state.speed); // no upper bound, by design

  // Contact with a rival scrubs off speed and shoves you aside — it costs you
  // places rather than ending the race.
  const step = dt * state.speed;
  const hit = sweptCollision(state, state.z, step);
  if (hit) {
    state.speed = Math.min(state.speed, hit.speed * 0.55);
    state.playerX += state.playerX <= hit.offset ? -0.06 : 0.06;
    state.playerX = clampNumber(state.playerX, -2, 2);
    state.bumped = 0.35; // seconds of shake left
  }

  state.bumped = Math.max(0, state.bumped - dt);
  state.z = increase(state.z, dt * state.speed, state.trackLength);
  state.progress += dt * state.speed;
  state.travelled += dt * state.speed;
  state.lap = Math.min(state.laps, Math.floor(state.progress / state.trackLength) + 1);
  state.place = standings(state);

  if (state.progress >= state.raceDistance) state.finished = true;

  return state;
}

/* ---------- the game module ---------- */

function mountRacing(ctx) {
  let mapId = RACE_MAPS[0].id;
  const input = { left: false, right: false, accel: false, brake: false };
  let frame = null;
  let lastTime = 0;
  let running = false;

  // Your garage, remembered between sessions.
  const garage = storage.get('race3d-car', {}) || {};
  let modelId = CAR_MODELS.some((m) => m.id === garage.modelId) ? garage.modelId : CAR_MODELS[0].id;
  let paintId = CAR_PAINTS.some((p) => p.id === garage.paintId) ? garage.paintId : CAR_PAINTS[0].id;

  const carModel = () => CAR_MODELS.find((m) => m.id === modelId);
  const carPaint = () => CAR_PAINTS.find((p) => p.id === paintId);
  const saveGarage = () => storage.set('race3d-car', { modelId, paintId });

  let state = createRace(mapId, modelId);

  const bestKey = () => `race3d-best-${mapId}`;
  const kmh = () => speedInKmh(state.speed);
  const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  /* ---------- chrome ---------- */

  const mapRow = segmented(
    RACE_MAPS.map((m) => ({ id: m.id, label: m.label })),
    mapId, (id) => { mapId = id; restart(); }, { ariaLabel: 'Map' });

  // Picking a different car changes how it drives, so it starts a fresh race.
  // Paint is cosmetic and applies to the car on track straight away.
  const modelRow = segmented(
    CAR_MODELS.map((m) => ({ id: m.id, label: m.label })),
    modelId, (id) => { modelId = id; saveGarage(); refreshCard(); restart(); },
    { ariaLabel: 'Car' });

  const paintRow = swatches(
    CAR_PAINTS.map((p) => ({ id: p.id, label: p.label, colour: p.colour })),
    paintId, (id) => { paintId = id; saveGarage(); render(); }, { ariaLabel: 'Paint' });

  const card = statBars([
    { key: 'speed', label: 'Top End' },
    { key: 'accel', label: 'Accel' },
    { key: 'grip', label: 'Grip' },
    { key: 'braking', label: 'Brakes' },
  ]);

  function refreshCard() {
    const model = carModel();
    card.set(carStats(model));
    card.setCaption(model.blurb);
  }

  const scoreRow = statRow([
    { key: 'place', label: 'Position', value: '—', tone: 'x' },
    { key: 'lap', label: 'Lap', value: '1', tone: 'muted' },
    { key: 'time', label: 'Time', value: '0:00', tone: 'muted' },
    { key: 'best', label: 'Best', value: '—', tone: 'o' },
  ]);

  const canvas = document.createElement('canvas');
  canvas.className = 'canvas';
  canvas.width = RACE_W;
  canvas.height = RACE_H;
  const g = canvas.getContext('2d');

  const controlsEl = buttonRow([
    { label: 'New Race', onClick: restart },
    { label: 'Pause', onClick: togglePause, ghost: true },
  ]);
  const pauseEl = controlsEl.lastElementChild;

  const pad = dpad((dir) => setInput(dir, true), { onRelease: (dir) => setInput(dir, false) });

  ctx.settings.append(mapRow.el, modelRow.el, paintRow.el, card.el);
  ctx.score.append(scoreRow.el);
  ctx.stage.append(canvas, pad);
  ctx.controls.append(controlsEl);
  ctx.setTheme('race');
  ctx.setHint('W / ↑ accelerate · A D or ← → steer · S / ↓ brake');

  function setInput(dir, down) {
    if (dir === 'left') input.left = down;
    else if (dir === 'right') input.right = down;
    else if (dir === 'up') input.accel = down;
    else if (dir === 'down') input.brake = down;
  }

  /* ---------- loop ---------- */

  function loop(time) {
    frame = requestAnimationFrame(loop);
    // Clamp dt so a backgrounded tab resuming cannot tunnel the car through traffic.
    const dt = Math.min(0.05, (time - lastTime) / 1000 || 0);
    lastTime = time;

    const wasCounting = state.countdown > 0;
    stepRace(state, input, dt);
    render();
    refreshScores();

    if (wasCounting && state.countdown === 0) ctx.setStatus('Go!');
    if (state.finished) finish();
  }

  function start() {
    stop();
    running = true;
    lastTime = performance.now();
    frame = requestAnimationFrame(loop);
    pauseEl.textContent = 'Pause';
  }

  function stop() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    running = false;
  }

  function togglePause() {
    if (state.finished) return restart();
    if (running) {
      stop();
      pauseEl.textContent = 'Resume';
      ctx.setStatus('Paused');
    } else {
      start();
      ctx.setStatus('Go!');
    }
  }

  function finish() {
    stop();
    pauseEl.textContent = 'Race Again';

    const best = storage.get(bestKey());
    const isBest = !best || state.time < best;
    if (isBest) storage.set(bestKey(), state.time);

    refreshScores();
    render();
    ctx.setStatus(
      `Finished ${ordinal(state.place)} of ${RIVAL_COUNT + 1} · ${clock(state.time)}${isBest ? ' · best time!' : ''}`,
      state.place <= 3);
  }

  function restart() {
    stop();
    input.left = input.right = input.accel = input.brake = false;
    state = createRace(mapId, modelId);
    refreshScores();
    render();
    ctx.setStatus('Get ready…');
    start();
  }

  function refreshScores() {
    const best = storage.get(bestKey());
    scoreRow.set('place', state.countdown > 0 ? '—' : ordinal(state.place));
    scoreRow.set('lap', `${state.lap}/${state.laps}`);
    scoreRow.set('time', clock(state.time));
    scoreRow.set('best', best ? clock(best) : '—');
  }

  /* ---------- rendering ---------- */

  function render() {
    const { segments, trackLength } = state;
    const palette = state.map.palette;
    const baseSegment = findSegment(segments, state.z);
    const basePercent = percentRemaining(state.z, SEGMENT_LENGTH);
    const playerSegment = findSegment(segments, state.z + PLAYER_Z);
    const playerPercent = percentRemaining(state.z + PLAYER_Z, SEGMENT_LENGTH);
    const playerY = interpolate(playerSegment.p1.world.y, playerSegment.p2.world.y, playerPercent);

    let maxY = RACE_H;
    let x = 0;
    let dx = -(baseSegment.curve * basePercent);

    drawSky(palette, playerY);

    // Road, near to far — each segment clipped by the nearest one drawn so far,
    // so a hill correctly hides the road behind it.
    const visible = [];
    for (let n = 0; n < DRAW_DISTANCE; n++) {
      const segment = segments[(baseSegment.index + n) % segments.length];
      const looped = segment.index < baseSegment.index;
      const cameraZ = state.z - (looped ? trackLength : 0);

      segment.fog = Math.exp(-FOG_DENSITY * (n / DRAW_DISTANCE) ** 2);
      segment.clip = maxY;

      project(segment.p1, state.playerX * ROAD_WIDTH - x, playerY + CAMERA_HEIGHT,
        cameraZ, CAMERA_DEPTH, RACE_W, RACE_H, ROAD_WIDTH);
      project(segment.p2, state.playerX * ROAD_WIDTH - x - dx, playerY + CAMERA_HEIGHT,
        cameraZ, CAMERA_DEPTH, RACE_W, RACE_H, ROAD_WIDTH);

      x += dx;
      dx += segment.curve;

      const behindCamera = segment.p1.camera.z <= CAMERA_DEPTH;
      const facingAway = segment.p2.screen.y >= segment.p1.screen.y;
      if (behindCamera || facingAway || segment.p2.screen.y >= maxY) continue;

      drawSegment(segment, palette);
      visible.push(segment);
      maxY = segment.p2.screen.y;
    }

    // Scenery and cars, far to near, so nearer things paint over further ones.
    for (let i = visible.length - 1; i >= 0; i--) {
      const segment = visible[i];
      for (const sprite of segment.sprites) drawSprite(segment, sprite, palette);
      for (const car of segment.cars) drawRival(segment, car);
    }

    drawPlayer();
    drawHud(palette);
  }

  function drawSky(palette, playerY) {
    const sky = g.createLinearGradient(0, 0, 0, RACE_H * 0.72);
    sky.addColorStop(0, palette.skyTop);
    sky.addColorStop(0.55, palette.skyMid);
    sky.addColorStop(1, palette.skyLow);
    g.fillStyle = sky;
    g.fillRect(0, 0, RACE_W, RACE_H);

    const horizon = RACE_H / 2 + 10 + playerY * 0.012;
    const shift = -state.playerX * 24 - (state.z / SEGMENT_LENGTH) * 0.35;

    // Sun / moon with a soft glow.
    const sunX = RACE_W * 0.7 + Math.sin(shift * 0.01) * 12;
    const sunY = horizon - 58;
    const glow = g.createRadialGradient(sunX, sunY, 4, sunX, sunY, 62);
    glow.addColorStop(0, palette.sunGlow);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = glow;
    g.fillRect(sunX - 70, sunY - 70, 140, 140);
    g.fillStyle = palette.sun;
    g.beginPath();
    g.arc(sunX, sunY, 17, 0, Math.PI * 2);
    g.fill();

    ridge(palette.ridgeFar, horizon + 2, 46, 0.017, shift * 0.35);
    ridge(palette.ridgeNear, horizon + 4, 30, 0.031, shift * 0.6);

    g.fillStyle = palette.ground;
    g.fillRect(0, horizon, RACE_W, RACE_H - horizon);

    function ridge(colour, base, height, frequency, offset) {
      g.fillStyle = colour;
      g.beginPath();
      g.moveTo(-100, base);
      for (let i = -100; i <= RACE_W + 100; i += 16) {
        const h = height * (0.55 + 0.45 * Math.sin((i + offset) * frequency))
          + height * 0.28 * Math.sin((i + offset) * frequency * 2.7);
        g.lineTo(i, base - h);
      }
      g.lineTo(RACE_W + 100, base);
      g.closePath();
      g.fill();
    }
  }

  function trapezoid(x1, y1, w1, x2, y2, w2, colour) {
    g.fillStyle = colour;
    g.beginPath();
    g.moveTo(x1 - w1, y1);
    g.lineTo(x2 - w2, y2);
    g.lineTo(x2 + w2, y2);
    g.lineTo(x1 + w1, y1);
    g.closePath();
    g.fill();
  }

  function drawSegment(segment, palette) {
    const p1 = segment.p1.screen;
    const p2 = segment.p2.screen;
    const { dark } = segment;

    g.fillStyle = dark ? palette.grassDark : palette.grassLight;
    g.fillRect(0, p2.y, RACE_W, p1.y - p2.y);

    const rumble1 = p1.w / 5;
    const rumble2 = p2.w / 5;
    trapezoid(p1.x, p1.y, p1.w + rumble1, p2.x, p2.y, p2.w + rumble2,
      dark ? palette.rumbleDark : palette.rumbleLight);
    trapezoid(p1.x, p1.y, p1.w, p2.x, p2.y, p2.w, dark ? palette.roadDark : palette.roadLight);

    if (segment.finish) {
      drawCheckers(segment);
    } else if (!dark) {
      trapezoid(p1.x, p1.y, p1.w / 40, p2.x, p2.y, p2.w / 40, palette.lane);
    }

    if (segment.fog < 1) {
      g.globalAlpha = 1 - segment.fog;
      g.fillStyle = palette.fog;
      g.fillRect(0, p2.y, RACE_W, p1.y - p2.y);
      g.globalAlpha = 1;
    }
  }

  // The start/finish line: a checkerboard laid across the full width of the road.
  function drawCheckers(segment) {
    const p1 = segment.p1.screen;
    const p2 = segment.p2.screen;
    const columns = 10;

    for (let i = 0; i < columns; i++) {
      const t1 = -1 + (2 * i) / columns;
      const t2 = -1 + (2 * (i + 1)) / columns;
      const dark = (i + segment.index) % 2 === 0;

      g.fillStyle = dark ? '#0f172a' : '#f8fafc';
      g.beginPath();
      g.moveTo(p1.x + p1.w * t1, p1.y);
      g.lineTo(p2.x + p2.w * t1, p2.y);
      g.lineTo(p2.x + p2.w * t2, p2.y);
      g.lineTo(p1.x + p1.w * t2, p1.y);
      g.closePath();
      g.fill();
    }
  }

  // Anything standing beside the road: projected, scaled and clipped by hills.
  function drawSprite(segment, sprite, palette) {
    const scale = segment.p1.screen.scale;
    const width = scale * ROAD_WIDTH * RACE_W / 2;
    const x = segment.p1.screen.x + width * sprite.offset;
    const y = segment.p1.screen.y;
    const unit = width * 0.5;
    if (unit < 1.2 || x < -120 || x > RACE_W + 120) return;

    const alpha = Math.max(0.15, segment.fog);

    g.save();
    g.beginPath();
    g.rect(0, 0, RACE_W, Math.max(0, segment.clip));
    g.clip();
    g.globalAlpha = alpha;

    if (sprite.kind === 'palm') {
      g.fillStyle = '#78350f';
      g.fillRect(x - unit * 0.06, y - unit * 1.5, unit * 0.12, unit * 1.5);
      g.fillStyle = '#15803d';
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        g.beginPath();
        g.ellipse(x + Math.cos(a) * unit * 0.32, y - unit * 1.5 + Math.sin(a) * unit * 0.18,
          unit * 0.34, unit * 0.12, a, 0, Math.PI * 2);
        g.fill();
      }
    } else if (sprite.kind === 'cactus') {
      g.fillStyle = '#166534';
      g.fillRect(x - unit * 0.1, y - unit * 1.1, unit * 0.2, unit * 1.1);
      g.fillRect(x - unit * 0.36, y - unit * 0.82, unit * 0.26, unit * 0.1);
      g.fillRect(x - unit * 0.36, y - unit * 0.82, unit * 0.1, unit * 0.34);
      g.fillRect(x + unit * 0.12, y - unit * 0.66, unit * 0.24, unit * 0.1);
      g.fillRect(x + unit * 0.26, y - unit * 0.66, unit * 0.1, unit * 0.28);
    } else if (sprite.kind === 'rock') {
      g.fillStyle = '#78350f';
      g.beginPath();
      g.moveTo(x - unit * 0.5, y);
      g.lineTo(x - unit * 0.2, y - unit * 0.62);
      g.lineTo(x + unit * 0.14, y - unit * 0.44);
      g.lineTo(x + unit * 0.5, y);
      g.closePath();
      g.fill();
    } else if (sprite.kind === 'lamp') {
      g.fillStyle = '#475569';
      g.fillRect(x - unit * 0.05, y - unit * 1.7, unit * 0.1, unit * 1.7);
      g.fillStyle = '#fde68a';
      g.beginPath();
      g.arc(x, y - unit * 1.72, unit * 0.17, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = alpha * 0.25; // cone of light, never read back off the context
      g.beginPath();
      g.moveTo(x, y - unit * 1.7);
      g.lineTo(x - unit * 0.5, y);
      g.lineTo(x + unit * 0.5, y);
      g.closePath();
      g.fill();
    } else if (sprite.kind === 'tower') {
      const h = unit * (1.6 + (segment.index % 5) * 0.34);
      g.fillStyle = '#1e293b';
      g.fillRect(x - unit * 0.4, y - h, unit * 0.8, h);
      g.fillStyle = '#facc15';
      for (let row = 1; row * unit * 0.3 < h; row++) {
        for (let col = 0; col < 2; col++) {
          if ((row + col + segment.index) % 3 === 0) continue;
          g.fillRect(x - unit * 0.26 + col * unit * 0.3, y - row * unit * 0.3, unit * 0.16, unit * 0.14);
        }
      }
    } else { // road sign
      g.fillStyle = '#94a3b8';
      g.fillRect(x - unit * 0.04, y - unit * 0.9, unit * 0.08, unit * 0.9);
      g.fillStyle = '#f8fafc';
      g.fillRect(x - unit * 0.34, y - unit * 1.3, unit * 0.68, unit * 0.42);
      g.fillStyle = '#dc2626';
      g.fillRect(x - unit * 0.26, y - unit * 1.22, unit * 0.52, unit * 0.26);
    }

    g.globalAlpha = 1;
    g.restore();
  }

  function drawRival(segment, car) {
    const scale = interpolate(segment.p1.screen.scale, segment.p2.screen.scale, car.percent);
    const roadX = interpolate(segment.p1.screen.x, segment.p2.screen.x, car.percent);
    const y = interpolate(segment.p1.screen.y, segment.p2.screen.y, car.percent);
    const width = scale * ROAD_WIDTH * RACE_W / 2;
    const x = roadX + width * car.offset;

    // Size comes from the car's real dimensions, projected like everything
    // else, so a wider car genuinely looks wider on the road.
    const w = (scale * CAR_SIZE.width * RACE_W) / 2;
    const h = (scale * CAR_SIZE.height * RACE_W) / 2;
    if (w < 1.5) return;

    g.save();
    g.beginPath();               // hills in front must hide cars behind them
    g.rect(0, 0, RACE_W, Math.max(0, segment.clip));
    g.clip();
    g.globalAlpha = Math.max(0.2, segment.fog);
    drawCar(x, y - h, w, h, car.colour, car.model);
    g.globalAlpha = 1;
    g.restore();
  }

  /* A rounded cartoon car, seen from behind.

     Flat fills rather than metallic gradients: a body colour, one lighter
     highlight and one darker skirt, exactly like a vector illustration. The
     silhouette is a single dome — bulging out over the rear wheels and curving
     up to a high roof — with a big soft-cornered rear screen in a thick dark
     frame. Every detail is gated on on-screen size so distant cars stay clean. */
  function drawCar(x, y, w, h, colour, model, options = {}) {
    const { braking = false } = options;
    const p = CAR_PROFILE;
    const detailed = w > 34;
    const mid = w > 15;

    const half = w / 2;
    const at = (v) => y + h * v;
    const across = (f) => x + half * f;

    const light = shade(colour, 0.26);
    const dark = shade(colour, -0.2);
    const ground = at(p.rockerY);

    /* --- shadow -------------------------------------------------------- */
    g.fillStyle = 'rgba(2, 6, 23, 0.4)';
    g.beginPath();
    g.ellipse(x, at(0.99), half * 1.05, h * 0.07, 0, 0, Math.PI * 2);
    g.fill();

    /* --- wheels, peeking out either side ------------------------------- */
    if (mid) {
      const radius = h * p.wheel.radius;
      const wy = at(p.wheel.y);
      for (const side of [-1, 1]) {
        const wx = across(side * p.wheel.x);
        g.fillStyle = '#3f3f46';                       // tyre
        g.beginPath();
        g.arc(wx, wy, radius, 0, Math.PI * 2);
        g.fill();

        if (detailed) {
          g.fillStyle = '#9ca3af';                     // rim
          g.beginPath();
          g.arc(wx, wy, radius * 0.56, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = '#6b7280';                     // hub
          g.beginPath();
          g.arc(wx, wy, radius * 0.2, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = '#d1d5db';                     // lug bolts
          g.beginPath();
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2;
            const bx = wx + Math.cos(a) * radius * 0.37;
            const by = wy + Math.sin(a) * radius * 0.37;
            g.moveTo(bx + radius * 0.07, by);
            g.arc(bx, by, radius * 0.07, 0, Math.PI * 2);
          }
          g.fill();
        }
      }
    }

    /* --- body: one bulging dome ---------------------------------------- */
    const bodyPath = () => {
      g.beginPath();
      g.moveTo(across(-p.rocker), ground);
      g.quadraticCurveTo(across(-p.hip), at(p.hipY), across(-p.hip), at(p.waistY));
      g.quadraticCurveTo(across(-p.hip), at(p.roofY + 0.1), across(-p.shoulder), at(p.roofY));
      g.quadraticCurveTo(across(-p.shoulder * 0.45), at(0), across(0), at(0));
      g.quadraticCurveTo(across(p.shoulder * 0.45), at(0), across(p.shoulder), at(p.roofY));
      g.quadraticCurveTo(across(p.hip), at(p.roofY + 0.1), across(p.hip), at(p.waistY));
      g.quadraticCurveTo(across(p.hip), at(p.hipY), across(p.rocker), ground);
      g.closePath();
    };

    g.fillStyle = colour;
    bodyPath();
    g.fill();

    if (mid) {
      g.save();
      bodyPath();
      g.clip();

      g.fillStyle = dark;                              // shaded skirt
      g.fillRect(across(-1.1), at(p.skirtY), w * 1.1, h);

      g.fillStyle = light;                             // highlight sweeps
      g.beginPath();
      g.ellipse(across(-0.34), at(p.waistY + 0.12), half * 0.4, h * 0.055,
        -0.22, 0, Math.PI * 2);
      g.fill();
      if (detailed) {
        g.beginPath();
        g.ellipse(across(0.46), at(p.waistY + 0.2), half * 0.24, h * 0.035,
          0.2, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
    }

    /* --- rear screen ---------------------------------------------------- */
    if (mid) {
      const glassBottom = at(p.glassBottom);
      const glassPath = () => {
        g.beginPath();
        g.moveTo(across(-p.glassHalf), glassBottom);
        g.quadraticCurveTo(across(-p.glassHalf), at(p.glassTop + 0.04),
          across(-p.glassHalf * 0.62), at(p.glassTop));
        g.lineTo(across(p.glassHalf * 0.62), at(p.glassTop));
        g.quadraticCurveTo(across(p.glassHalf), at(p.glassTop + 0.04),
          across(p.glassHalf), glassBottom);
        g.closePath();
      };

      g.strokeStyle = '#1c1c1c';                       // thick frame
      g.lineJoin = 'round';
      g.lineWidth = Math.max(1, w * 0.035);
      glassPath();
      g.stroke();

      g.fillStyle = '#a9c6cb';                         // tinted glass
      glassPath();
      g.fill();

      if (detailed) {                                  // lighter reflection band
        g.save();
        glassPath();
        g.clip();
        g.fillStyle = '#c3dade';
        g.beginPath();
        g.moveTo(across(-p.glassHalf), glassBottom);
        g.lineTo(across(-p.glassHalf * 0.1), at(p.glassTop));
        g.lineTo(across(p.glassHalf * 0.3), at(p.glassTop));
        g.lineTo(across(-p.glassHalf * 0.35), glassBottom);
        g.closePath();
        g.fill();
        g.restore();
      }
    }

    /* --- tail lights, bumper -------------------------------------------- */
    const lampY = at(p.lights.y);
    const lamp = braking ? '#fda4a4' : '#e8402a';

    if (mid) {
      g.fillStyle = lamp;
      for (const side of [-1, 1]) {
        roundRect(across(side * p.lights.half) - (side > 0 ? 0 : w * p.lights.w),
          lampY, w * p.lights.w, h * p.lights.h, Math.max(0.8, w * 0.02));
        g.fill();
      }
      if (detailed && braking) {
        g.globalAlpha = 0.4;
        for (const side of [-1, 1]) {
          roundRect(across(side * p.lights.half) - (side > 0 ? w * 0.02 : w * p.lights.w + w * 0.02),
            lampY - h * 0.03, w * (p.lights.w + 0.04), h * (p.lights.h + 0.06),
            Math.max(0.8, w * 0.03));
          g.fill();
        }
        g.globalAlpha = 1;
      }
    } else {
      g.fillStyle = lamp;
      g.fillRect(across(-0.7), lampY, w * 0.7, Math.max(1, h * p.lights.h));
    }

    if (detailed) {
      g.fillStyle = '#9ca3af';                         // chrome bumper
      roundRect(across(-p.bumper.half), at(p.bumper.y),
        half * p.bumper.half * 2, h * p.bumper.h, Math.max(1, w * 0.025));
      g.fill();
    }
  }

  function drawPlayer() {
    const model = state.model;
    const speedPercent = state.speed / SPEED_REFERENCE;
    const shake = state.bumped > 0 ? Math.sin(state.time * 60) * 4 * UI * state.bumped : 0;
    const rumble = state.offRoad ? Math.sin(state.travelled / 12) * 3 * UI * speedPercent : 0;
    const bob = Math.sin(state.travelled / 55) * 1.8 * UI * speedPercent;

    // Sized from the car's real dimensions. PLAYER_DRAW is a fixed fraction of
    // strict projection: the camera sits so close that a true projection would
    // fill the screen with bodywork.
    const w = (CAMERA_DEPTH / PLAYER_Z) * CAR_SIZE.width * (RACE_W / 2) * PLAYER_DRAW;
    const h = w * (CAR_SIZE.height / CAR_SIZE.width);
    const x = RACE_W / 2 + ((input.left ? -7 : 0) + (input.right ? 7 : 0)) * UI + shake;
    const y = RACE_H - h - 18 * UI + bob + rumble;

    // Body roll: lean into the steering, and into the corner you are taking.
    const lean = ((input.left ? -1 : 0) + (input.right ? 1 : 0)) * 0.055
      + (state.curve || 0) * Math.min(1.6, speedPercent) * 0.012;

    g.save();
    g.translate(x, y + h);
    g.rotate(lean);
    g.translate(-x, -(y + h));
    drawCar(x, y, w, h, carPaint().colour, model, { braking: input.brake });
    g.restore();

    // Speed streaks along the edges of the screen.
    if (speedPercent > 0.55) {
      g.strokeStyle = `rgba(248, 250, 252, ${(speedPercent - 0.55) * 0.5})`;
      g.lineWidth = 2 * UI;
      for (let i = 0; i < 8; i++) {
        const sy = (state.travelled / 6 + i * 70 * UI) % RACE_H;
        const sx = i % 2 === 0 ? (12 + i * 6) * UI : RACE_W - (12 + i * 6) * UI;
        g.beginPath();
        g.moveTo(sx, sy);
        g.lineTo(sx, sy + 34 * UI);
        g.stroke();
      }
    }
  }

  function drawHud(palette) {
    g.textBaseline = 'top';

    const font = (size) => `bold ${Math.round(size * UI)}px "Segoe UI", system-ui, sans-serif`;

    if (state.countdown > 0) {
      const n = Math.ceil(state.countdown - 0.2);
      const label = n <= 0 ? 'GO!' : String(n);
      g.font = font(78);
      g.textAlign = 'center';
      g.fillStyle = 'rgba(2, 6, 23, 0.45)';
      g.fillRect(0, RACE_H / 2 - 60 * UI, RACE_W, 110 * UI);
      g.fillStyle = n <= 0 ? '#4ade80' : '#f8fafc';
      g.fillText(label, RACE_W / 2, RACE_H / 2 - 48 * UI);
    } else {
      g.font = font(30);
      g.textAlign = 'left';
      g.fillStyle = 'rgba(2, 6, 23, 0.45)';
      g.fillRect(8 * UI, 8 * UI, 96 * UI, 40 * UI);
      g.fillStyle = state.place === 1 ? '#4ade80' : '#f8fafc';
      g.fillText(ordinal(state.place), 16 * UI, 12 * UI);

      g.font = font(15);
      g.fillStyle = 'rgba(226, 232, 240, 0.75)';
      g.fillText(`/${RIVAL_COUNT + 1}`, 74 * UI, 24 * UI);

      g.textAlign = 'right';
      g.fillStyle = 'rgba(2, 6, 23, 0.45)';
      g.fillRect(RACE_W - 130 * UI, 8 * UI, 122 * UI, 40 * UI);
      g.font = font(17);
      g.fillStyle = '#f8fafc';
      g.fillText(`LAP ${state.lap}/${state.laps}`, RACE_W - 16 * UI, 12 * UI);
      g.font = font(13);
      g.fillStyle = palette.lane;
      g.fillText(`${kmh()} km/h`, RACE_W - 16 * UI, 31 * UI);
    }

    if (state.finished) {
      g.fillStyle = 'rgba(2, 6, 23, 0.6)';
      g.fillRect(0, 0, RACE_W, RACE_H);
      g.textAlign = 'center';
      g.font = font(46);
      g.fillStyle = '#f8fafc';
      g.fillText('FINISH', RACE_W / 2, RACE_H / 2 - 54 * UI);
      g.font = font(30);
      g.fillStyle = state.place <= 3 ? '#4ade80' : '#e2e8f0';
      g.fillText(`${ordinal(state.place)} of ${RIVAL_COUNT + 1}`, RACE_W / 2, RACE_H / 2 + 2);
    }

    g.textAlign = 'left';
  }

  function roundRect(x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /* ---------- input ---------- */

  const KEY_TO_DIR = {
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    a: 'left', d: 'right', w: 'up', s: 'down',
    A: 'left', D: 'right', W: 'up', S: 'down',
  };

  function onKeyDown(event) {
    if (event.key === ' ') {
      event.preventDefault();
      togglePause();
      return;
    }
    const dir = KEY_TO_DIR[event.key];
    if (!dir) return;
    event.preventDefault(); // stop the arrow keys scrolling the page
    setInput(dir, true);
  }

  function onKeyUp(event) {
    const dir = KEY_TO_DIR[event.key];
    if (dir) setInput(dir, false);
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  refreshCard();
  restart();

  return {
    destroy() {
      stop();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    },
  };
}

if (typeof registerGame !== 'undefined') {
  registerGame({ id: 'racing', label: 'Car Racing', mount: mountRacing, wide: true });
}

if (typeof module !== 'undefined') {
  module.exports = {
    project, buildTrack, createRace, stepRace, findSegment, increase, overlap,
    standings, ordinal, forwardGap, addScenery, shade, speedInKmh,
    engineForce, carStats, paceOf, draftFactor, sweptCollision,
    SEGMENT_LENGTH, ROAD_WIDTH, CAMERA_DEPTH, CAMERA_HEIGHT, SPEED_REFERENCE,
    RACE_MAPS, RACE_W, RACE_H, RIVAL_COUNT, COUNTDOWN, OFF_ROAD_LIMIT,
    CAR_MODELS, CAR_PAINTS, STEER_RATE, STEER_AUTHORITY, CENTRIFUGAL,
    REFERENCE_KMH, RACE_LAPS, DRAW_DISTANCE, DRAFT_RANGE,
    CAR_SIZE, CAR_HALF_WIDTH, CAR_PROFILE, PLAYER_DRAW,
  };
}
