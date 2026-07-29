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
// Sitting further back shrinks your own car and closes the size gap to the
// traffic ahead — at 1000 the player's car towered over nearby rivals.
const CAMERA_HEIGHT = 1500;      // world units above the road
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

// Engine force falls away as you go faster — the way real power-limited
// acceleration does — and the car is held to a top speed of 700 km/h.
// SPEED_REFERENCE is the yardstick percentages are measured against: it reads
// 500 km/h on the dial, so the cap sits at 1.4x it.
const SPEED_REFERENCE = SEGMENT_LENGTH * 100;
const REFERENCE_KMH = 500;
const KMH_PER_UNIT = REFERENCE_KMH / SPEED_REFERENCE;
const TOP_SPEED_KMH = 700;
const MAX_SPEED = TOP_SPEED_KMH / KMH_PER_UNIT;
const ROLLING_DRAG = 900;               // constant, always acting
const COAST_DRAG = 0.35;                // aero, proportional to speed
const BRAKE_FORCE = SPEED_REFERENCE / 1.4;
const OFF_ROAD_DECEL = SPEED_REFERENCE / 1.6;
const OFF_ROAD_LIMIT = SPEED_REFERENCE / 4;
const OFF_ROAD_GRIP = 0.45;             // the grass barely steers
const DRAFT_RANGE = SEGMENT_LENGTH * 9; // tow distance behind a rival
const DRAFT_BOOST = 0.22;               // extra engine force in clean air behind
// Drift: hold Q or E to break traction and slide. The slide builds while held
// and unwinds when let go, and scrubbing the tyres sideways costs you speed.
// Comfortably more than STEER_RATE: a slide has to beat simply turning the
// wheel, or there would be no reason to break traction at all.
const DRIFT_RATE = 5.4;                 // road-widths per second at full slide
const DRIFT_BUILD = 3.4;                // how fast the slide winds in and out
const DRIFT_SCRUB = 0.3;                // share of speed shed per second sliding
const RACE_LAPS = 6;

const speedInKmh = (speed) => Math.round(speed * KMH_PER_UNIT);

const RIVAL_COUNT = 7;
const GRID_SPACING = SEGMENT_LENGTH * 3;
const COUNTDOWN = 3.2;           // seconds on the grid
const LOOKAHEAD = SEGMENT_LENGTH * 18;
const FINISH_SEGMENTS = 4;       // how much of the track is checkered

const RIVAL_COLOURS = ['#38bdf8', '#c084fc', '#34d399', '#fb7185', '#f472b6', '#f97316', '#a3e635'];

// Every car is the same size — wide and low, the stance of a modern saloon.
const CAR_SIZE = { width: 360, height: 250 };
const CAR_HALF_WIDTH = CAR_SIZE.width / (2 * ROAD_WIDTH);

// Proportions shared by every car. Vertical values are fractions of the car's
// height (0 at the roof, 1 at the road); horizontal ones are fractions of its
// half-width.
const CAR_PROFILE = {
  deckY: 0.40,        // top of the boot lid, where the glass ends
  lightY: 0.53,       // tail light centre line
  hipY: 0.68,         // widest point, over the rear wheels
  bumperY: 0.66,      // top of the bumper face
  valanceY: 0.83,     // lower valance and diffuser
  bodyBottom: 0.90,
  shoulderHalf: 0.97,
  hipHalf: 1.0,
  bumperHalf: 0.95,
  valanceHalf: 0.8,
  wheel: { x: 0.9, y: 0.84, radius: 0.15 },
  plate: { y: 0.7, w: 0.4, h: 0.1 },
};

/* Five rear ends. Same chassis underneath — these only change how a car looks:

   glassTop/roofHalf  how far the roof runs back and how wide it stays
   lights             'connected' slim lamps joined by a dark strip,
                      'lshape' wrapping the corner, 'corner' stubby outboard
                      units, 'bar' a wide pair, 'fullbar' one lit strip
   exhausts           round2 | quad | single | none
   spoiler            height of the boot lip */
const CAR_LOOKS = {
  grancoupe: { glassTop: 0.06, glassHalf: 0.62, roofHalf: 0.5, lights: 'connected', exhausts: 'round2', spoiler: 0.4, diffuser: true },
  sport: { glassTop: 0.08, glassHalf: 0.58, roofHalf: 0.44, lights: 'lshape', exhausts: 'quad', spoiler: 0.75, diffuser: true },
  hatch: { glassTop: 0.04, glassHalf: 0.68, roofHalf: 0.58, lights: 'corner', exhausts: 'single', spoiler: 0.25, diffuser: false },
  estate: { glassTop: 0.02, glassHalf: 0.74, roofHalf: 0.66, lights: 'bar', exhausts: 'round2', spoiler: 0.15, diffuser: false },
  electric: { glassTop: 0.07, glassHalf: 0.64, roofHalf: 0.52, lights: 'fullbar', exhausts: 'none', spoiler: 0.3, diffuser: false },
};

/* The roster:

   power      engine force from a standstill, in world units/s^2
   powerBand  how far up the speed range that force holds on — the closest
              thing to a "top speed", since nothing is capped
   grip       steering response, and how well it resists being pushed wide
   braking    stopping force multiplier
   look       which rear end from CAR_LOOKS it wears

   No two cars share a value on any axis, so each one is a distinct package,
   and each wears a different body. */
const CAR_MODELS = [
  {
    id: 'veloce', label: 'Veloce GT',
    blurb: 'Gran coupe — balanced all-rounder',
    look: 'grancoupe',
    power: 6000, powerBand: 21000, grip: 1.06, braking: 1.0,
  },
  {
    id: 'strato', label: 'Strato SV',
    blurb: 'Sport saloon — long-geared V12',
    look: 'sport',
    power: 5600, powerBand: 31000, grip: 0.88, braking: 0.92,
  },
  {
    id: 'volt', label: 'Volt RS',
    blurb: 'Electric — brutal off the line',
    look: 'electric',
    power: 8600, powerBand: 14500, grip: 1.16, braking: 1.16,
  },
  {
    id: 'aurora', label: 'Aurora Club',
    blurb: 'Hot hatch — grips and stops best',
    look: 'hatch',
    power: 5400, powerBand: 17500, grip: 1.32, braking: 1.28,
  },
  {
    id: 'titan', label: 'Titan One',
    blurb: 'Long-roof estate — endless top end',
    look: 'estate',
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

// A car's natural pace, used to set how hard each rival pushes. Scaled off the
// cap so the field stays competitive with a player who can reach it.
const paceOf = (model) => MAX_SPEED * (0.54 + 0.28 * carStats(model).speed);

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
    post: n % 4 === 0,                 // guardrail upright
    gantry: n > 40 && n % 90 === 0,    // overhead sign bridge
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
      cloud: 'rgba(240, 249, 255, 0.3)',
      ridgeFar: '#0b5f8e', ridgeFarLit: '#1b7bb0',
      ridgeNear: '#0369a1', ridgeNearLit: '#0e86c4',
      ground: '#14867c',
      grassLight: '#1aa44e', grassDark: '#189146',
      rumbleLight: '#f8fafc', rumbleDark: '#dc2626',
      roadLight: '#5a5651', roadDark: '#4c4842',
      wear: 'rgba(28, 25, 23, 0.24)',
      hazeStrong: 'rgba(186, 230, 253, 0.85)', hazeSoft: 'rgba(186, 230, 253, 0.4)',
      lane: '#f8fafc', fog: '#bae6fd',
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
      cloud: 'rgba(255, 237, 213, 0.22)',
      ridgeFar: '#8a3517', ridgeFarLit: '#a8451f',
      ridgeNear: '#9a3412', ridgeNearLit: '#c2551d',
      ground: '#c2620b',
      grassLight: '#d9820a', grassDark: '#c67208',
      rumbleLight: '#fef3c7', rumbleDark: '#7f1d1d',
      roadLight: '#5a5651', roadDark: '#4c4842',
      wear: 'rgba(41, 37, 36, 0.22)',
      hazeStrong: 'rgba(253, 230, 138, 0.8)', hazeSoft: 'rgba(251, 191, 36, 0.35)',
      lane: '#fef3c7', fog: '#fde68a',
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
      cloud: 'rgba(76, 29, 149, 0.35)',
      ridgeFar: '#131c31', ridgeFarLit: '#24304f',
      ridgeNear: '#1e1b4b', ridgeNearLit: '#392f7a',
      ground: '#151d2e',
      grassLight: '#232f42', grassDark: '#1c2637',
      rumbleLight: '#f8fafc', rumbleDark: '#7c3aed',
      roadLight: '#44444c', roadDark: '#3a3a41',
      wear: 'rgba(9, 9, 11, 0.3)',
      hazeStrong: 'rgba(88, 45, 160, 0.7)', hazeSoft: 'rgba(76, 29, 149, 0.35)',
      lane: '#fde68a', fog: '#6d3fbf',
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
    drift: 0,        // -1 fully sliding left .. +1 fully sliding right
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

  /* Drift. The slide winds in toward whichever key is held and unwinds when
     released, so it takes a moment to break traction and a moment to gather it
     back up. It only bites while the car is actually rolling. */
  const wantDrift = (input.driftLeft ? -1 : 0) + (input.driftRight ? 1 : 0);
  const wind = DRIFT_BUILD * dt;
  state.drift += clampNumber(wantDrift - state.drift, -wind, wind);
  if (wantDrift === 0 && Math.abs(state.drift) < 0.01) state.drift = 0;

  const sliding = Math.abs(state.drift);
  if (sliding > 0.01) {
    state.playerX += state.drift * DRIFT_RATE * dt * Math.min(1.3, speedPercent);
    state.speed -= state.speed * DRIFT_SCRUB * sliding * dt;   // tyre scrub
  }

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
  state.speed = clampNumber(state.speed, 0, MAX_SPEED);

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
  const input = {
    left: false, right: false, accel: false, brake: false,
    driftLeft: false, driftRight: false,
  };
  let frame = null;
  let lastTime = 0;
  let running = false;
  let revs = null;        // the engine note, while the race is running
  let lastBeep = null;    // which countdown number has already sounded

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
  const driftPad = holdRow([
    { id: 'driftLeft', label: '⟲ Q', aria: 'Drift left' },
    { id: 'driftRight', label: 'E ⟳', aria: 'Drift right' },
  ], (id) => setInput(id, true), (id) => setInput(id, false));

  ctx.stage.append(canvas, pad, driftPad);
  ctx.controls.append(controlsEl);
  ctx.setTheme('race');
  ctx.setHint('W / ↑ accelerate · A D or ← → steer · S / ↓ brake · Q E drift');

  function setInput(dir, down) {
    if (dir === 'left') input.left = down;
    else if (dir === 'right') input.right = down;
    else if (dir === 'up') input.accel = down;
    else if (dir === 'down') input.brake = down;
    else if (dir === 'driftLeft') input.driftLeft = down;
    else if (dir === 'driftRight') input.driftRight = down;
  }

  /* ---------- loop ---------- */

  function loop(time) {
    frame = requestAnimationFrame(loop);
    // Clamp dt so a backgrounded tab resuming cannot tunnel the car through traffic.
    const dt = Math.min(0.05, (time - lastTime) / 1000 || 0);
    lastTime = time;

    const wasCounting = state.countdown > 0;
    const bumpedBefore = state.bumped;
    stepRace(state, input, dt);
    render();
    refreshScores();

    // One beep per second on the grid, then a longer tone on green.
    if (wasCounting) {
      const mark = Math.ceil(state.countdown - 0.2);
      if (mark !== lastBeep) {
        lastBeep = mark;
        audio.play(mark > 0 ? 'beep' : 'go');
      }
    }
    if (state.bumped > bumpedBefore) audio.play('crash');
    // Sliding tyres howl like the grass does.
    if (revs) {
      revs.set(state.speed / SPEED_REFERENCE, input.accel,
        state.offRoad || Math.abs(state.drift) > 0.25);
    }

    if (wasCounting && state.countdown === 0) ctx.setStatus('Go!');
    if (state.finished) finish();
  }

  function start() {
    stop();
    running = true;
    lastTime = performance.now();
    if (!revs) revs = audio.engine();
    frame = requestAnimationFrame(loop);
    pauseEl.textContent = 'Pause';
  }

  // Silences the engine as well as the loop, so pausing or leaving the game
  // never strands a running oscillator.
  function stop() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    running = false;
    if (revs) { revs.stop(); revs = null; }
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
    audio.play(state.place <= 3 ? 'finish' : 'lose');

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
    lastBeep = null;
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

    /* Bank the whole world through a corner. The car stays level and the
       horizon tilts around it, which is what selling a chase camera as three
       dimensional really takes. Scaled up slightly so the rotated frame still
       covers the canvas corners. */
    const roll = clampNumber(baseSegment.curve * Math.min(1.4, state.speed / SPEED_REFERENCE)
      * 0.007, -0.055, 0.055);

    g.save();
    g.translate(RACE_W / 2, RACE_H * 0.55);
    g.rotate(roll);
    g.scale(1.08, 1.08);
    g.translate(-RACE_W / 2, -RACE_H * 0.55);

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

    // Barriers run near-to-far so the nearer rail overlaps the one behind it.
    for (const segment of visible) drawBarrier(segment, palette);

    // Scenery and cars, far to near, so nearer things paint over further ones.
    for (let i = visible.length - 1; i >= 0; i--) {
      const segment = visible[i];
      if (segment.gantry) drawGantry(segment, palette);
      for (const sprite of segment.sprites) drawSprite(segment, sprite, palette);
      for (const car of segment.cars) drawRival(segment, car);
    }

    g.restore();   // the car and the HUD stay level while the world banks

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

    clouds(horizon, shift);

    /* Three ridges rather than two, the furthest palest, each one lit along
       its own skyline. Depth in a backdrop comes from things getting hazier
       with distance, not from more detail. */
    ridge(palette.ridgeFar, palette.ridgeFarLit, horizon + 2, 58, 0.011, shift * 0.22);
    ridge(palette.ridgeFar, palette.ridgeFarLit, horizon + 3, 42, 0.017, shift * 0.4);
    ridge(palette.ridgeNear, palette.ridgeNearLit, horizon + 5, 28, 0.031, shift * 0.68);

    g.fillStyle = palette.ground;
    g.fillRect(0, horizon, RACE_W, RACE_H - horizon);

    /* Haze sitting on the horizon. The road and grass fade into the sky over
       the last stretch, which is what stops the far end of the track ending
       in a hard green line against the hills. */
    const haze = g.createLinearGradient(0, horizon - 34, 0, horizon + 58);
    haze.addColorStop(0, 'rgba(0, 0, 0, 0)');
    haze.addColorStop(0.34, palette.hazeStrong);
    haze.addColorStop(0.58, palette.hazeSoft);
    haze.addColorStop(1, 'rgba(0, 0, 0, 0)');
    g.fillStyle = haze;
    g.fillRect(0, horizon - 34, RACE_W, 92);

    function ridge(colour, lit, base, height, frequency, offset) {
      const top = [];
      for (let i = -100; i <= RACE_W + 100; i += 12) {
        const h = height * (0.55 + 0.45 * Math.sin((i + offset) * frequency))
          + height * 0.28 * Math.sin((i + offset) * frequency * 2.7);
        top.push([i, base - h]);
      }

      g.fillStyle = colour;
      g.beginPath();
      g.moveTo(-100, base);
      for (const [x, y] of top) g.lineTo(x, y);
      g.lineTo(RACE_W + 100, base);
      g.closePath();
      g.fill();

      // A lit crest: the same skyline, dropped a few pixels and filled back.
      g.fillStyle = lit;
      g.beginPath();
      g.moveTo(top[0][0], top[0][1] + 5);
      for (const [x, y] of top) g.lineTo(x, y);
      for (let i = top.length - 1; i >= 0; i--) g.lineTo(top[i][0], top[i][1] + 5);
      g.closePath();
      g.fill();
    }

    // Slow, soft cloud bands. Ellipses rather than sprites: they cost nothing
    // and there is no texture to load.
    function clouds(base, drift) {
      for (let i = 0; i < 7; i++) {
        const seed = i * 137.5;
        const y = base - 70 - (i % 3) * 34 - (i % 2) * 12;
        const x = (((seed * 6.4 + drift * (0.25 + (i % 3) * 0.12)) % (RACE_W + 320)) + RACE_W + 320)
          % (RACE_W + 320) - 160;
        const w = 60 + (i % 4) * 26;
        /* Built from overlapping ellipses, each drawn as one path so the
           overlaps do not double-composite into hard internal edges. Two
           passes — a wide soft base and a smaller brighter cap — read as a
           cloud with a lit top rather than as a row of blobs. */
        for (const [pass, squash, alpha] of [[1, 1, 0.55], [0.62, 0.72, 1]]) {
          g.fillStyle = palette.cloud;
          g.globalAlpha = alpha;
          g.beginPath();
          for (const [ox, oy, rx, ry] of [[0, 0, w, w * 0.2], [-w * 0.42, w * 0.09, w * 0.5, w * 0.15],
            [w * 0.36, w * 0.07, w * 0.56, w * 0.17], [-w * 0.12, -w * 0.06, w * 0.42, w * 0.16]]) {
            g.moveTo(x + ox * pass + rx * pass, y + oy - w * 0.04 * (1 - pass));
            g.ellipse(x + ox * pass, y + oy - w * 0.04 * (1 - pass),
              rx * pass, ry * squash, 0, 0, Math.PI * 2);
          }
          g.fill();
          g.globalAlpha = 1;
        }
      }
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

    /* Two darker bands where the racing line has polished the tarmac. They
       run with the road, so they curve and shrink with it and give a plain
       grey surface something to read the corners by. */
    if (p1.w > 12) {
      for (const lane of [-0.45, 0.45]) {
        trapezoid(p1.x + p1.w * lane, p1.y, p1.w * 0.2,
          p2.x + p2.w * lane, p2.y, p2.w * 0.2, palette.wear);
      }
    }

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

  /* A continuous crash barrier down each verge. Because it is built from the
     same projected segment pair as the road, it shrinks and curves with the
     tarmac — a solid rail running away to the horizon is the strongest depth
     cue on screen, far more so than scattered roadside objects. */
  function drawBarrier(segment, palette) {
    const p1 = segment.p1.screen;
    const p2 = segment.p2.screen;
    if (p1.w < 2) return;

    // Fade the rail into the distance with alpha. A full-width fog rectangle
    // like the road uses would repaint the sky and the scenery behind it.
    g.globalAlpha = Math.max(0.05, segment.fog);

    const railTop = (s) => s.w * 0.16;             // height scales with distance
    const h1 = railTop(p1);
    const h2 = railTop(p2);
    const out = 1.16;                              // just beyond the rumble strip

    for (const side of [-1, 1]) {
      const x1 = p1.x + side * p1.w * out;
      const x2 = p2.x + side * p2.w * out;

      if (segment.post) {                          // upright, every few segments
        g.fillStyle = '#475569';
        g.beginPath();
        g.moveTo(x1 - p1.w * 0.02, p1.y);
        g.lineTo(x1 + p1.w * 0.02, p1.y);
        g.lineTo(x1 + p1.w * 0.02, p1.y - h1);
        g.lineTo(x1 - p1.w * 0.02, p1.y - h1);
        g.closePath();
        g.fill();
      }

      g.fillStyle = side < 0 ? '#cbd5e1' : '#e2e8f0';   // rail face
      g.beginPath();
      g.moveTo(x1, p1.y - h1 * 0.45);
      g.lineTo(x2, p2.y - h2 * 0.45);
      g.lineTo(x2, p2.y - h2);
      g.lineTo(x1, p1.y - h1);
      g.closePath();
      g.fill();

      if (segment.dark) {                          // dashed shadow under the rail
        g.fillStyle = 'rgba(15, 23, 42, 0.35)';
        g.beginPath();
        g.moveTo(x1, p1.y - h1 * 0.45);
        g.lineTo(x2, p2.y - h2 * 0.45);
        g.lineTo(x2, p2.y - h2 * 0.2);
        g.lineTo(x1, p1.y - h1 * 0.2);
        g.closePath();
        g.fill();
      }
    }

    g.globalAlpha = 1;
  }

  /* A sign bridge spanning the road. Passing under one is the clearest signal
     that the world has height as well as depth. */
  function drawGantry(segment, palette) {
    const s = segment.p1.screen;
    if (s.w < 6) return;

    const span = s.w * 1.3;
    const height = s.w * 1.15;
    const legW = Math.max(1, s.w * 0.06);
    const beamH = Math.max(1.5, s.w * 0.18);
    const top = s.y - height;

    g.save();
    g.beginPath();
    g.rect(0, 0, RACE_W, Math.max(0, segment.clip));
    g.clip();
    g.globalAlpha = Math.max(0.2, segment.fog);

    g.fillStyle = '#475569';                       // legs
    g.fillRect(s.x - span, s.y - height, legW, height);
    g.fillRect(s.x + span - legW, s.y - height, legW, height);

    g.fillStyle = '#334155';                       // beam
    g.fillRect(s.x - span, top, span * 2, beamH);

    if (s.w > 22) {                                // sign panels
      g.fillStyle = palette.ridgeNear;
      g.fillRect(s.x - span * 0.62, top + beamH * 0.18, span * 0.5, beamH * 0.64);
      g.fillRect(s.x + span * 0.12, top + beamH * 0.18, span * 0.5, beamH * 0.64);
    }

    g.globalAlpha = 1;
    g.restore();
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

  /* The back of a modern car.

     Wide and low: a tapered glasshouse over a boot lid, slim tail lights
     sweeping in toward a dark trim strip that links them across the centre, a
     bumper carrying the number plate, and a valance with exhausts below it.
     CAR_PROFILE fixes the proportions every car shares; each model's `look`
     varies the roofline, light signature, spoiler and pipes. Detail is gated
     on on-screen size so distant cars stay clean. */
  function drawCar(x, y, w, h, colour, model, options = {}) {
    const { braking = false } = options;
    const p = CAR_PROFILE;
    const look = CAR_LOOKS[model.look] || CAR_LOOKS.grancoupe;
    const detailed = w > 40;
    const mid = w > 18;

    const half = w / 2;
    const at = (v) => y + h * v;
    const across = (f) => x + half * f;
    const r = Math.max(0.6, w * 0.02);

    const glassTop = at(look.glassTop);
    const deck = at(p.deckY);

    /* --- shadow --------------------------------------------------------- */
    g.fillStyle = 'rgba(2, 6, 23, 0.42)';
    g.beginPath();
    g.ellipse(x, at(0.985), half * 1.04, h * 0.055, 0, 0, Math.PI * 2);
    g.fill();

    /* --- rear tyres ----------------------------------------------------- */
    if (mid) {
      const radius = h * p.wheel.radius;
      const wy = at(p.wheel.y);
      for (const side of [-1, 1]) {
        const wx = across(side * p.wheel.x);
        g.fillStyle = '#1c1c1f';
        g.beginPath();
        g.ellipse(wx, wy, radius * 0.72, radius, 0, 0, Math.PI * 2);
        g.fill();
      }
    }

    /* --- glasshouse ------------------------------------------------------ */
    const pillar = () => {
      g.beginPath();
      g.moveTo(across(-look.glassHalf - 0.06), deck);
      g.quadraticCurveTo(across(-look.glassHalf), glassTop, across(-look.roofHalf), glassTop);
      g.lineTo(across(look.roofHalf), glassTop);
      g.quadraticCurveTo(across(look.glassHalf), glassTop, across(look.glassHalf + 0.06), deck);
      g.closePath();
    };

    g.fillStyle = shade(colour, -0.3);          // C-pillars and roof edge
    pillar();
    g.fill();

    if (mid) {                                   // tinted screen
      const glass = g.createLinearGradient(0, glassTop, 0, deck);
      glass.addColorStop(0, 'rgba(120, 150, 180, 0.55)');
      glass.addColorStop(0.5, 'rgba(24, 34, 52, 0.92)');
      glass.addColorStop(1, 'rgba(12, 18, 30, 0.95)');
      // Inset well inside the pillars so a band of bodywork frames the screen.
      g.fillStyle = glass;
      g.beginPath();
      g.moveTo(across(-look.glassHalf + 0.07), deck - h * 0.03);
      g.quadraticCurveTo(across(-look.glassHalf + 0.09), glassTop + h * 0.06,
        across(-look.roofHalf + 0.07), glassTop + h * 0.05);
      g.lineTo(across(look.roofHalf - 0.07), glassTop + h * 0.05);
      g.quadraticCurveTo(across(look.glassHalf - 0.09), glassTop + h * 0.06,
        across(look.glassHalf - 0.07), deck - h * 0.03);
      g.closePath();
      g.fill();

      if (detailed) {                            // reflection across the screen
        g.fillStyle = 'rgba(186, 210, 236, 0.14)';
        g.beginPath();
        g.moveTo(across(-look.glassHalf + 0.07), deck - h * 0.03);
        g.lineTo(across(-look.roofHalf * 0.2), glassTop + h * 0.05);
        g.lineTo(across(look.roofHalf * 0.25), glassTop + h * 0.05);
        g.lineTo(across(-look.glassHalf * 0.3), deck - h * 0.03);
        g.closePath();
        g.fill();
      }
    }

    /* --- boot lid and flanks -------------------------------------------- */
    const bodyPath = () => {
      g.beginPath();
      g.moveTo(across(-p.shoulderHalf), deck + h * 0.04);
      g.quadraticCurveTo(across(-p.hipHalf), at(p.hipY * 0.9), across(-p.hipHalf), at(p.hipY));
      g.lineTo(across(-p.bumperHalf), at(p.bodyBottom));
      g.lineTo(across(p.bumperHalf), at(p.bodyBottom));
      g.lineTo(across(p.hipHalf), at(p.hipY));
      g.quadraticCurveTo(across(p.hipHalf), at(p.hipY * 0.9), across(p.shoulderHalf), deck + h * 0.04);
      g.quadraticCurveTo(across(0), deck - h * 0.03, across(-p.shoulderHalf), deck + h * 0.04);
      g.closePath();
    };

    // Panel shading: lit across the top of the boot, falling away at the hips.
    const panel = g.createLinearGradient(0, deck, 0, at(p.bodyBottom));
    panel.addColorStop(0, shade(colour, 0.2));
    panel.addColorStop(0.35, colour);
    panel.addColorStop(1, shade(colour, -0.3));
    g.fillStyle = panel;
    bodyPath();
    g.fill();

    if (mid) {
      g.save();
      bodyPath();
      g.clip();

      const flank = g.createLinearGradient(across(-1), 0, across(1), 0);
      flank.addColorStop(0, 'rgba(2, 6, 23, 0.4)');
      flank.addColorStop(0.2, 'rgba(2, 6, 23, 0)');
      flank.addColorStop(0.8, 'rgba(2, 6, 23, 0)');
      flank.addColorStop(1, 'rgba(2, 6, 23, 0.45)');
      g.fillStyle = flank;
      g.fillRect(across(-1.1), deck, w * 1.1, h);

      if (detailed) {                            // shoulder crease
        g.fillStyle = 'rgba(248, 250, 252, 0.16)';
        roundRect(across(-p.shoulderHalf * 0.92), deck + h * 0.035,
          half * p.shoulderHalf * 1.84, h * 0.012, r);
        g.fill();
      }
      g.restore();
    }

    /* --- boot lip spoiler ------------------------------------------------ */
    if (look.spoiler > 0.1 && mid) {
      g.fillStyle = shade(colour, 0.1);
      roundRect(across(-p.shoulderHalf * 0.97), deck - h * 0.055 * look.spoiler,
        half * p.shoulderHalf * 1.94, h * 0.06 * look.spoiler + h * 0.02, r);
      g.fill();
    }

    /* --- tail lights ----------------------------------------------------- */
    const lampY = at(p.lightY);
    const lampH = Math.max(1.4, h * 0.085);
    const lamp = braking ? '#ff6b6b' : '#d92d20';
    const inner = braking ? '#ffd0d0' : '#f87171';

    if (mid) {
      // Dark trim strip linking the two lamps across the boot.
      // Everything here stays inside `edge` — the bodywork's own outline at the
      // light line. Overshoot it and the lamps paint onto the road.
      const edge = p.shoulderHalf * 0.9;
      const reach = look.lights === 'corner' ? 0.5 : 0.3;

      if (look.lights === 'connected' || look.lights === 'fullbar') {
        g.fillStyle = look.lights === 'fullbar' ? lamp : '#111116';
        roundRect(across(-edge), lampY - lampH * 0.26,
          half * edge * 2, lampH * 0.62, lampH * 0.26);
        g.fill();
      }

      // A slim horizontal lamp, tapering slightly toward the centre.
      const blade = (outerF, innerF, top, bottom, taper) => {
        g.beginPath();
        g.moveTo(across(outerF), lampY - top);
        g.lineTo(across(innerF), lampY - top * taper);
        g.lineTo(across(innerF), lampY + bottom * taper);
        g.lineTo(across(outerF), lampY + bottom);
        g.closePath();
        g.fill();
      };

      for (const side of [-1, 1]) {
        g.fillStyle = lamp;
        if (look.lights === 'lshape') {           // hooks down round the corner
          g.beginPath();
          g.moveTo(across(side * edge), lampY - lampH * 0.45);
          g.lineTo(across(side * reach), lampY - lampH * 0.2);
          g.lineTo(across(side * reach), lampY + lampH * 0.3);
          g.lineTo(across(side * edge * 0.78), lampY + lampH * 0.35);
          g.lineTo(across(side * edge * 0.78), lampY + lampH * 1.0);
          g.lineTo(across(side * edge), lampY + lampH * 1.0);
          g.closePath();
          g.fill();
        } else {
          blade(side * edge, side * reach, lampH * 0.45, lampH * 0.45, 0.62);
        }

        if (detailed) {                           // bright LED core inside it
          g.fillStyle = inner;
          blade(side * edge * 0.97, side * (reach + 0.04), lampH * 0.2, lampH * 0.12, 0.5);
        }
      }

      if (detailed) {                             // glow, clipped to the tail
        g.globalAlpha = braking ? 0.4 : 0.16;
        g.fillStyle = lamp;
        roundRect(across(-edge), lampY - lampH * 0.7,
          half * edge * 2, lampH * 1.7, lampH * 0.6);
        g.fill();
        g.globalAlpha = 1;
      }

      if (detailed) {                             // badge
        g.fillStyle = 'rgba(226, 232, 240, 0.85)';
        g.beginPath();
        g.arc(x, lampY + lampH * 0.15, Math.max(0.8, w * 0.018), 0, Math.PI * 2);
        g.fill();
      }
    } else {
      g.fillStyle = lamp;
      g.fillRect(across(-0.8), lampY, w * 0.8, Math.max(1, lampH * 0.6));
    }

    /* --- bumper, plate, valance, pipes ----------------------------------- */
    if (mid) {
      g.fillStyle = shade(colour, -0.16);         // bumper face
      roundRect(across(-p.bumperHalf), at(p.bumperY), half * p.bumperHalf * 2,
        h * (p.bodyBottom - p.bumperY), r * 1.4);
      g.fill();

      if (detailed) {                             // number plate
        g.fillStyle = '#e8eaed';
        roundRect(across(-p.plate.w), at(p.plate.y), half * p.plate.w * 2, h * p.plate.h, r * 0.8);
        g.fill();
        g.fillStyle = '#1e3a8a';
        g.fillRect(across(-p.plate.w) + w * 0.006, at(p.plate.y) + h * 0.008,
          w * 0.018, h * p.plate.h - h * 0.016);
      }
    }

    if (detailed) {
      g.fillStyle = '#17171b';                    // valance / diffuser
      roundRect(across(-p.valanceHalf), at(p.valanceY), half * p.valanceHalf * 2,
        h * (p.bodyBottom - p.valanceY) + h * 0.02, r);
      g.fill();

      if (look.diffuser) {
        g.fillStyle = '#2b2b33';
        for (let i = -2; i <= 2; i++) {
          g.fillRect(across(i * 0.16) - w * 0.008, at(p.valanceY) + h * 0.012,
            w * 0.016, h * (p.bodyBottom - p.valanceY) - h * 0.01);
        }
      }

      const pipe = h * 0.032;
      const tips = { round2: [-0.62, 0.62], quad: [-0.66, -0.48, 0.48, 0.66], single: [0.6], none: [] };
      const spots = tips[look.exhausts] || [];
      for (const f of spots) {
        g.fillStyle = '#c9cdd4';                  // chrome tip
        g.beginPath();
        g.ellipse(across(f), at(p.valanceY) + h * 0.035, pipe * (look.exhausts === 'quad' ? 0.8 : 1.15),
          pipe * 0.85, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#0b0b0e';
        g.beginPath();
        g.ellipse(across(f), at(p.valanceY) + h * 0.035, pipe * (look.exhausts === 'quad' ? 0.5 : 0.75),
          pipe * 0.52, 0, 0, Math.PI * 2);
        g.fill();
      }

      g.fillStyle = '#7f1d1d';                    // corner reflectors
      for (const side of [-1, 1]) {
        roundRect(across(side * p.bumperHalf * 0.9) - (side > 0 ? w * 0.05 : 0),
          at(p.valanceY) - h * 0.05, w * 0.05, h * 0.02, r * 0.5);
        g.fill();
      }
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

    // Body roll: lean into the steering and the corner, then kick the tail out
    // when drifting — sliding left swings the back of the car to the left.
    const slide = state.drift || 0;
    const lean = ((input.left ? -1 : 0) + (input.right ? 1 : 0)) * 0.055
      + (state.curve || 0) * Math.min(1.6, speedPercent) * 0.012
      + slide * 0.16;

    if (Math.abs(slide) > 0.08) drawSmoke(x, y + h, w, slide, speedPercent);

    g.save();
    g.translate(x, y + h);
    g.rotate(lean);
    g.translate(-x, -(y + h));
    drawCar(x + slide * w * 0.06, y, w, h, carPaint().colour, model, { braking: input.brake });
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

  /* Tyre smoke off the rear wheels while sliding. The puffs are placed from
     distance travelled rather than a random spray, so they stream away from
     the car steadily instead of flickering. */
  function drawSmoke(x, ground, w, slide, speedPercent) {
    const puffs = 7;
    const strength = Math.min(1, Math.abs(slide));

    for (let i = 0; i < puffs; i++) {
      const age = ((state.travelled / 90) + i / puffs) % 1;
      const spread = w * (0.34 + age * 0.85);
      const size = w * (0.09 + age * 0.26) * strength;
      // Puffs billow outward and rise as they fall behind the car.
      const fade = (1 - age) ** 0.7 * 0.62 * strength * Math.min(1, speedPercent + 0.5);
      if (fade <= 0.01) continue;

      for (const side of [-1, 1]) {
        g.globalAlpha = fade;
        g.fillStyle = '#f1f5f9';
        g.beginPath();
        g.ellipse(x + side * spread - slide * w * age * 0.6,
          ground - age * w * 0.22, size, size * 0.72, 0, 0, Math.PI * 2);
        g.fill();
      }
    }

    g.globalAlpha = 1;
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
    q: 'driftLeft', e: 'driftRight', Q: 'driftLeft', E: 'driftRight',
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
    REFERENCE_KMH, RACE_LAPS, DRAW_DISTANCE, DRAFT_RANGE, TOP_SPEED_KMH, MAX_SPEED,
    DRIFT_RATE, DRIFT_BUILD, DRIFT_SCRUB,
    CAR_SIZE, CAR_HALF_WIDTH, CAR_PROFILE, CAR_LOOKS, PLAYER_DRAW,
  };
}
