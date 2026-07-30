/* A small reader for binary glTF (.glb) files.

   three.js ships a GLTFLoader, but only in its examples — not in the core build
   this project vendors — and pulling in another 120 KB to read one model that
   uses none of the hard parts is a poor trade. This handles what the monster
   actually needs: glTF 2.0, triangle primitives, indexed positions and UVs,
   node transforms, and pbrMetallicRoughness colours and base-colour textures.
   No Draco, no skins, no animation, no morph targets.

   All the arithmetic — chunk parsing, accessors, the node hierarchy, merging —
   is plain JavaScript with no three.js in it, so it can be run and checked
   outside a browser. three.js is touched only at the very end, to wrap the
   finished arrays in geometry and materials. */

const GLB_MAGIC = 0x46546c67;      // 'glTF'
const GLB_JSON = 0x4e4f534a;       // 'JSON'
const GLB_BIN = 0x004e4942;        // 'BIN\0'

const GLB_PARTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

const GLB_COMPONENTS = {
  5120: { array: Int8Array, bytes: 1 },
  5121: { array: Uint8Array, bytes: 1 },
  5122: { array: Int16Array, bytes: 2 },
  5123: { array: Uint16Array, bytes: 2 },
  5125: { array: Uint32Array, bytes: 4 },
  5126: { array: Float32Array, bytes: 4 },
};

/* Split a .glb into its JSON description and its binary blob. Chunk lengths in
   the container are already padded to four bytes, so walking them needs no
   alignment of its own. */
function parseGLB(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 12 || view.getUint32(0, true) !== GLB_MAGIC) {
    throw new Error('not a .glb file');
  }
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`unsupported glTF version ${version}`);

  let json = null;
  let bin = null;
  let at = 12;

  while (at + 8 <= buffer.byteLength) {
    const length = view.getUint32(at, true);
    const kind = view.getUint32(at + 4, true);
    const body = at + 8;
    if (body + length > buffer.byteLength) break;

    if (kind === GLB_JSON) {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, body, length)));
    } else if (kind === GLB_BIN) {
      bin = new Uint8Array(buffer, body, length);
    }
    at = body + length;
  }

  if (!json) throw new Error('.glb has no JSON chunk');
  const needed = json.extensionsRequired;
  if (needed && needed.length) {
    throw new Error(`needs glTF extensions this reader does not have: ${needed.join(', ')}`);
  }

  return { json, bin: bin || new Uint8Array(0) };
}

/* One accessor as a flat typed array.

   The fast path hands back a view straight into the binary chunk, which is what
   a tightly packed accessor almost always allows. Interleaved or oddly aligned
   data falls through to a copy — rare, but a reader that only handled the fast
   path would silently produce nonsense rather than fail. */
function readAccessor(json, bin, index) {
  const accessor = json.accessors[index];
  const parts = GLB_PARTS[accessor.type];
  const component = GLB_COMPONENTS[accessor.componentType];
  if (!parts || !component) {
    throw new Error(`accessor ${index}: unsupported ${accessor.type}/${accessor.componentType}`);
  }
  if (accessor.sparse) throw new Error(`accessor ${index}: sparse data is not supported`);

  const total = accessor.count * parts;
  if (accessor.bufferView === undefined) return new component.array(total);   // all zeroes, per spec

  const view = json.bufferViews[accessor.bufferView];
  const start = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const packed = component.bytes * parts;
  const stride = view.byteStride || packed;
  const absolute = bin.byteOffset + start;

  if (stride === packed && absolute % component.bytes === 0) {
    return new component.array(bin.buffer, absolute, total);
  }

  const out = new component.array(total);
  const data = new DataView(bin.buffer, bin.byteOffset);
  const getter = {
    5120: (o) => data.getInt8(o),
    5121: (o) => data.getUint8(o),
    5122: (o) => data.getInt16(o, true),
    5123: (o) => data.getUint16(o, true),
    5125: (o) => data.getUint32(o, true),
    5126: (o) => data.getFloat32(o, true),
  }[accessor.componentType];

  for (let i = 0; i < accessor.count; i++) {
    for (let c = 0; c < parts; c++) {
      out[i * parts + c] = getter(start + i * stride + c * component.bytes);
    }
  }
  return out;
}

/* ---------- 4x4 matrices, column-major as glTF stores them ---------- */

const MAT_IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function matMultiply(a, b) {
  const out = new Array(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
    }
  }
  return out;
}

// A node's own transform: either a matrix outright, or translation/rotation/scale.
function matFromNode(node) {
  if (node.matrix) return node.matrix.slice();

  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];

  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;

  return [
    (1 - (qy * y2 + qz * z2)) * sx, (qx * y2 + qw * z2) * sx, (qx * z2 - qw * y2) * sx, 0,
    (qx * y2 - qw * z2) * sy, (1 - (qx * x2 + qz * z2)) * sy, (qy * z2 + qw * x2) * sy, 0,
    (qx * z2 + qw * y2) * sz, (qy * z2 - qw * x2) * sz, (1 - (qx * x2 + qy * y2)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

// A rotation about Z, for posing a limb at its own joint.
function matRotateZ(angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/* ---------- walking the scene into merged arrays ---------- */

/* Every triangle in the file, transformed into one space and grouped by
   material. Merging matters: the monster is 51 separate meshes as authored, and
   at five of them on screen that would be 255 draw calls a frame for one enemy.
   By material it comes to ten.

   `pose(name)` may return an extra matrix to apply at a named node, which is how
   a limb gets moved without editing the file. */
function glbGeometry(json, bin, { pose } = {}) {
  const groups = new Map();
  const bounds = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };

  const scene = json.scenes[json.scene || 0];
  if (!scene) throw new Error('.glb has no scene');

  for (const root of scene.nodes || []) walk(root, MAT_IDENTITY);

  function walk(nodeIndex, parent) {
    const node = json.nodes[nodeIndex];
    if (!node) return;

    let local = matFromNode(node);
    if (pose) {
      const extra = pose(node.name);
      if (extra) local = matMultiply(local, extra);
    }
    const world = matMultiply(parent, local);

    if (node.mesh !== undefined) {
      for (const primitive of json.meshes[node.mesh].primitives) collect(primitive, world);
    }
    for (const child of node.children || []) walk(child, world);
  }

  function collect(primitive, world) {
    if ((primitive.mode === undefined ? 4 : primitive.mode) !== 4) return;   // triangles only
    if (primitive.attributes.POSITION === undefined) return;

    const key = primitive.material === undefined ? -1 : primitive.material;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = { position: [], uv: [], index: [] };
      groups.set(key, bucket);
    }

    const position = readAccessor(json, bin, primitive.attributes.POSITION);
    const uv = primitive.attributes.TEXCOORD_0 === undefined
      ? null : readAccessor(json, bin, primitive.attributes.TEXCOORD_0);
    const first = bucket.position.length / 3;

    for (let i = 0; i < position.length; i += 3) {
      const [x, y, z] = [position[i], position[i + 1], position[i + 2]];
      const wx = world[0] * x + world[4] * y + world[8] * z + world[12];
      const wy = world[1] * x + world[5] * y + world[9] * z + world[13];
      const wz = world[2] * x + world[6] * y + world[10] * z + world[14];

      bucket.position.push(wx, wy, wz);
      const vertex = i / 3;
      bucket.uv.push(uv ? uv[vertex * 2] : 0, uv ? uv[vertex * 2 + 1] : 0);

      bounds.min[0] = Math.min(bounds.min[0], wx);
      bounds.min[1] = Math.min(bounds.min[1], wy);
      bounds.min[2] = Math.min(bounds.min[2], wz);
      bounds.max[0] = Math.max(bounds.max[0], wx);
      bounds.max[1] = Math.max(bounds.max[1], wy);
      bounds.max[2] = Math.max(bounds.max[2], wz);
    }

    const count = position.length / 3;
    if (primitive.indices === undefined) {
      for (let i = 0; i < count; i++) bucket.index.push(first + i);
    } else {
      const indices = readAccessor(json, bin, primitive.indices);
      for (let i = 0; i < indices.length; i++) bucket.index.push(first + indices[i]);
    }
  }

  return { groups, bounds };
}

/* ---------- and into three.js ---------- */

/* glTF colour factors are linear. This renderer writes linear values straight
   out without colour management, so a factor used as-is comes out close to
   black — 0.024 linear is a mid navy once converted, but a very dark one if it
   is taken for sRGB. */
function glbMaterial(json, definition, map) {
  const pbr = (definition && definition.pbrMetallicRoughness) || {};
  const material = new THREE.MeshPhongMaterial({
    color: 0xffffff,
    shininess: 8,
    specular: 0x191c21,
  });

  if (pbr.baseColorFactor) {
    const [r, g, b, a] = pbr.baseColorFactor;
    material.color.setRGB(r, g, b).convertLinearToSRGB();
    if (a !== undefined && a < 1) {
      material.transparent = true;
      material.opacity = a;
    }
  }
  if (map) material.map = map;
  if (definition && definition.doubleSided) material.side = THREE.DoubleSide;

  return material;
}

/* An embedded image as a texture. The bytes go through a blob URL rather than
   base64: the browser decodes the PNG for us and there is no third of a
   megabyte of string to build first. Loading is asynchronous, so the caller
   waits on `pending` before handing the model over. */
function glbTexture(json, bin, imageIndex, pending) {
  const image = json.images[imageIndex];
  if (!image || image.bufferView === undefined) return null;

  const view = json.bufferViews[image.bufferView];
  const from = view.byteOffset || 0;
  const bytes = bin.slice(from, from + view.byteLength);
  const url = URL.createObjectURL(new Blob([bytes], { type: image.mimeType || 'image/png' }));
  const texture = new THREE.Texture();
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;

  pending.push(new Promise((resolve) => {
    const element = new Image();
    element.onload = () => {
      texture.image = element;
      texture.needsUpdate = true;
      URL.revokeObjectURL(url);
      resolve();
    };
    // A map that will not decode is not worth failing the whole model over.
    element.onerror = () => { URL.revokeObjectURL(url); resolve(); };
    element.src = url;
  }));

  return texture;
}

/* The finished model: one mesh per material, normals computed because the file
   carries none, and every part baked into a single space. */
async function buildGLBModel(json, bin, options = {}) {
  const { groups, bounds } = glbGeometry(json, bin, options);
  const pending = [];
  const model = new THREE.Group();

  for (const [key, bucket] of groups) {
    const definition = key < 0 ? null : json.materials[key];
    const pbr = (definition && definition.pbrMetallicRoughness) || {};
    let map = null;
    if (pbr.baseColorTexture) {
      const source = json.textures[pbr.baseColorTexture.index];
      if (source && source.source !== undefined) map = glbTexture(json, bin, source.source, pending);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(bucket.position, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(bucket.uv, 2));
    geometry.setIndex(bucket.index);
    geometry.computeVertexNormals();

    model.add(new THREE.Mesh(geometry, glbMaterial(json, definition, map)));
  }

  await Promise.all(pending);
  model.userData.bounds = bounds;
  return model;
}

/* Fetch and build. Rejects rather than throwing anywhere the caller cannot see:
   opened from a file:// page a fetch of a sibling file is blocked outright, and
   the caller is expected to carry on without the model. */
async function loadGLB(url, options = {}) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const { json, bin } = parseGLB(await response.arrayBuffer());
  return buildGLBModel(json, bin, options);
}

if (typeof module !== 'undefined') {
  module.exports = {
    parseGLB, readAccessor, glbGeometry, matFromNode, matMultiply, matRotateZ,
  };
}
