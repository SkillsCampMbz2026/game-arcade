/* Cut a .glb down to something a web page should be asked to download.

   The five weapon models total 138 MB, and 93% of that is texture data: base
   colour, normal, roughness, occlusion and emissive maps at 2048 or 4096
   square. For a viewmodel that occupies a corner of the screen and is lit by
   two directional lights, only the base colour is doing any visible work.

   So this keeps, per material, the base-colour map at 512 square re-encoded as
   JPEG, and throws the rest away. It also drops vertex attributes the renderer
   never reads — tangents, and the second through tenth UV sets, which one of
   these files really does carry.

   Resizing goes through PowerShell's System.Drawing rather than an image
   library, because there is no package manager in play here and Windows
   already has one.

     node tools/slim-glb.js in.glb out.glb [maxTextureSize]

   Windows only, for the image resizing. Not needed to play or build anything —
   it is here so the weapons can be regenerated, or a new model added, without
   having to work out what was done to the last ones.
*/
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { matFromNode, matMultiply } = require('../glb.js');

const [, , IN, OUT, SIZE_ARG] = process.argv;
const MAX_TEXTURE = Number(SIZE_ARG || 512);
if (!IN || !OUT) {
  console.error('usage: node slim-glb.js in.glb out.glb [maxTextureSize]');
  process.exit(1);
}

const GLB_JSON = 0x4e4f534a;
const GLB_BIN = 0x004e4942;
const mb = (n) => (n / 1048576).toFixed(2) + ' MB';

/* ---------- read ---------- */

const raw = fs.readFileSync(IN);
const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
const view = new DataView(buffer);
let json = null;
let bin = new Uint8Array(0);
for (let at = 12; at + 8 <= buffer.byteLength;) {
  const length = view.getUint32(at, true);
  const kind = view.getUint32(at + 4, true);
  const body = at + 8;
  if (kind === GLB_JSON) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, body, length)));
  else if (kind === GLB_BIN) bin = new Uint8Array(buffer, body, length);
  at = body + length;
}

/* ---------- which images are worth keeping ---------- */

// Only the base colour, under either of the two names a material may use.
const wanted = new Map();      // texture index -> image index
for (const material of json.materials || []) {
  const spec = material.extensions && material.extensions.KHR_materials_pbrSpecularGlossiness;
  const pbr = material.pbrMetallicRoughness || {};
  const ref = (spec && spec.diffuseTexture) || pbr.baseColorTexture;
  if (!ref) continue;
  const texture = json.textures[ref.index];
  if (texture && texture.source !== undefined) wanted.set(ref.index, texture.source);
}

/* ---------- resize what we keep ---------- */

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'slim-'));
const shrunk = new Map();      // image index -> Buffer of JPEG bytes

for (const source of new Set(wanted.values())) {
  const image = json.images[source];
  const bv = json.bufferViews[image.bufferView];
  const from = bv.byteOffset || 0;
  const bytes = Buffer.from(bin.subarray(from, from + bv.byteLength));
  const inFile = path.join(work, `img${source}.bin`);
  const outFile = path.join(work, `img${source}.jpg`);
  fs.writeFileSync(inFile, bytes);

  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${inFile}')
$scale = [Math]::Min(1.0, ${MAX_TEXTURE} / [Math]::Max($src.Width, $src.Height))
$w = [Math]::Max(1, [int]($src.Width * $scale))
$h = [Math]::Max(1, [int]($src.Height * $scale))
$dst = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($dst)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($src, 0, 0, $w, $h)
$g.Dispose()
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$p = New-Object System.Drawing.Imaging.EncoderParameters 1
$p.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 84
$dst.Save('${outFile}', $codec, $p)
"$($src.Width)x$($src.Height) -> ${'$'}w x ${'$'}h"
$src.Dispose(); $dst.Dispose()
`;
  const said = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  const jpeg = fs.readFileSync(outFile);
  shrunk.set(source, jpeg);
  console.log(`  image ${source}: ${said.trim()}  ${mb(bytes.length)} -> ${mb(jpeg.length)}`);
}

/* ---------- rebuild ---------- */

/* A fresh buffer holding only what is still referenced. Every accessor and
   image gets a new bufferView pointing into it, so all the discarded maps and
   attributes simply never make it across. */
const chunks = [];
let offset = 0;
const bufferViews = [];

function place(bytes, extra = {}) {
  // glTF wants accessor data four-byte aligned.
  while (offset % 4) { chunks.push(Buffer.alloc(1)); offset += 1; }
  const index = bufferViews.length;
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, ...extra });
  chunks.push(Buffer.from(bytes));
  offset += bytes.length;
  return index;
}

/* Backdrops.

   One of these models was exported with the studio floor still in the scene: a
   32-triangle plane two thousand units across, with a pistol two hundred units
   long sitting in the middle of it. Dropped by shape rather than by name — flat
   in one axis, and far larger than the actual subject. Nothing else in the five
   comes close to matching, so nothing else is touched. */
function primitiveBounds() {
  const found = [];
  const walk = (index, parent) => {
    const node = json.nodes[index];
    if (!node) return;
    const world = matMultiply(parent, matFromNode(node));
    if (node.mesh !== undefined) {
      for (const primitive of json.meshes[node.mesh].primitives) {
        const accessor = json.accessors[primitive.attributes.POSITION];
        if (!accessor || !accessor.min) continue;
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        // Every corner of the local box, so a rotated node is measured right.
        for (let corner = 0; corner < 8; corner++) {
          const p = [
            corner & 1 ? accessor.max[0] : accessor.min[0],
            corner & 2 ? accessor.max[1] : accessor.min[1],
            corner & 4 ? accessor.max[2] : accessor.min[2],
          ];
          for (let c = 0; c < 3; c++) {
            const v = world[c] * p[0] + world[4 + c] * p[1] + world[8 + c] * p[2] + world[12 + c];
            min[c] = Math.min(min[c], v);
            max[c] = Math.max(max[c], v);
          }
        }
        const size = max.map((v, i) => v - min[i]);
        found.push({
          primitive,
          name: json.meshes[node.mesh].name || '(unnamed)',
          tris: primitive.indices !== undefined ? json.accessors[primitive.indices].count / 3 : 0,
          size,
          diagonal: Math.hypot(...size),
          flatness: Math.min(...size) / (Math.max(...size) || 1),
        });
      }
    }
    for (const child of node.children || []) walk(child, world);
  };
  for (const root of (json.scenes[json.scene || 0].nodes || [])) {
    walk(root, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  }
  return found;
}

const measured = primitiveBounds();
const subject = measured.reduce((a, b) => (b.tris > (a ? a.tris : 0) ? b : a), null);
const backdrops = new Set();

if (subject) {
  /* A weapon is a thin object, and every part of it is thin in the same
     direction. A part several times thicker than the body across that axis is
     not attached to the gun — it is laid out beside it, the way a presentation
     model shows a magazine out of the well. Across these five, every genuine
     part measures under 1.2x the body and the one loose magazine measures
     3.4x, so the line is drawn well clear of both. */
  const thin = subject.size.indexOf(Math.min(...subject.size));

  for (const item of measured) {
    if (item === subject) continue;

    if (item.flatness < 0.01 && item.diagonal > subject.diagonal * 3) {
      backdrops.add(item.primitive);
      console.log(`  dropped a backdrop: "${item.name}", ${item.tris} tris, ${item.diagonal.toFixed(0)} across` +
        ` vs the subject's ${subject.diagonal.toFixed(0)}`);
      continue;
    }

    const ratio = item.size[thin] / (subject.size[thin] || 1);
    if (ratio > 2.5) {
      backdrops.add(item.primitive);
      console.log(`  dropped a loose part: "${item.name}", ${item.tris} tris, ` +
        `${ratio.toFixed(1)}x the body's thickness — laid beside the weapon, not on it`);
    }
  }
}

const DROP = /^(TANGENT|COLOR_|JOINTS_|WEIGHTS_)/;
const accessorMap = new Map();

function copyAccessor(index) {
  if (accessorMap.has(index)) return accessorMap.get(index);
  const accessor = json.accessors[index];
  const bv = json.bufferViews[accessor.bufferView];
  const parts = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[accessor.type];
  const width = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[accessor.componentType];
  const packed = parts * width;
  const stride = (bv && bv.byteStride) || packed;
  const start = (bv ? bv.byteOffset || 0 : 0) + (accessor.byteOffset || 0);

  // Repack tightly, so an interleaved source stops dragging its neighbours along.
  const out = Buffer.alloc(accessor.count * packed);
  for (let i = 0; i < accessor.count; i++) {
    Buffer.from(bin.buffer, bin.byteOffset + start + i * stride, packed).copy(out, i * packed);
  }

  const fresh = json.accessors.length + accessorMap.size;
  void fresh;
  const copy = {
    bufferView: place(out),
    componentType: accessor.componentType,
    count: accessor.count,
    type: accessor.type,
  };
  if (accessor.min) copy.min = accessor.min;
  if (accessor.max) copy.max = accessor.max;
  if (accessor.normalized) copy.normalized = true;
  accessorMap.set(index, copy);
  return copy;
}

const accessors = [];
const remember = (index) => {
  const copy = copyAccessor(index);
  const at = accessors.indexOf(copy);
  if (at >= 0) return at;
  accessors.push(copy);
  return accessors.length - 1;
};

const meshRemap = new Map();
const meshes = [];

(json.meshes || []).forEach((mesh, old) => {
  const kept = {
  name: mesh.name,
  primitives: mesh.primitives.filter((primitive) => !backdrops.has(primitive)).map((primitive) => {
    const attributes = {};
    for (const [name, index] of Object.entries(primitive.attributes)) {
      if (DROP.test(name)) continue;
      if (/^TEXCOORD_/.test(name) && name !== 'TEXCOORD_0') continue;
      attributes[name] = remember(index);
    }
    const copy = { attributes };
    if (primitive.indices !== undefined) copy.indices = remember(primitive.indices);
    if (primitive.material !== undefined) copy.material = primitive.material;
    if (primitive.mode !== undefined) copy.mode = primitive.mode;
    return copy;
  }),
  };

  /* A mesh whose every primitive was dropped is not just empty, it is invalid
     glTF — and it would leave the discarded part's name behind in the file,
     which is a confusing thing to find later. Drop it and renumber. */
  if (!kept.primitives.length) return;
  meshRemap.set(old, meshes.length);
  meshes.push(kept);
});

// Nodes point at meshes by index, so they have to follow the renumbering.
const nodes = (json.nodes || []).map((node) => {
  const copy = { ...node };
  if (node.mesh !== undefined) {
    if (meshRemap.has(node.mesh)) copy.mesh = meshRemap.get(node.mesh);
    else delete copy.mesh;
  }
  return copy;
});

// Images and textures, keeping only the base-colour ones.
const images = [];
const textures = [];
const textureMap = new Map();
for (const [textureIndex, source] of wanted) {
  const jpeg = shrunk.get(source);
  if (!jpeg) continue;
  const imageIndex = images.length;
  images.push({ mimeType: 'image/jpeg', bufferView: place(jpeg) });
  textureMap.set(textureIndex, textures.length);
  textures.push({ source: imageIndex, sampler: 0 });
}

const materials = (json.materials || []).map((material) => {
  const spec = material.extensions && material.extensions.KHR_materials_pbrSpecularGlossiness;
  const pbr = material.pbrMetallicRoughness || {};
  const ref = (spec && spec.diffuseTexture) || pbr.baseColorTexture;
  const colour = (spec && spec.diffuseFactor) || pbr.baseColorFactor;

  const out = { name: material.name, pbrMetallicRoughness: {} };
  if (colour) out.pbrMetallicRoughness.baseColorFactor = colour;
  if (ref && textureMap.has(ref.index)) {
    out.pbrMetallicRoughness.baseColorTexture = { index: textureMap.get(ref.index) };
  }
  if (material.doubleSided) out.doubleSided = true;
  // Nothing here needs an extension any more: the colour has been lifted out.
  return out;
});

const slim = {
  asset: { version: '2.0', generator: 'slim-glb: base colour only, textures at ' + MAX_TEXTURE },
  scene: json.scene || 0,
  scenes: json.scenes,
  nodes,
  meshes,
  accessors,
  bufferViews,
  buffers: [{ byteLength: offset }],
  materials,
};
if (images.length) {
  slim.images = images;
  slim.textures = textures;
  slim.samplers = [{ wrapS: 10497, wrapT: 10497 }];
}

/* ---------- write ---------- */

const binChunk = Buffer.concat(chunks);
const binPadded = Buffer.concat([binChunk, Buffer.alloc((4 - (binChunk.length % 4)) % 4)]);
let jsonText = Buffer.from(JSON.stringify(slim), 'utf8');
jsonText = Buffer.concat([jsonText, Buffer.alloc((4 - (jsonText.length % 4)) % 4, 0x20)]);

const header = Buffer.alloc(12);
header.write('glTF', 0, 'ascii');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonText.length + 8 + binPadded.length, 8);

const jsonHeader = Buffer.alloc(8);
jsonHeader.writeUInt32LE(jsonText.length, 0);
jsonHeader.writeUInt32LE(GLB_JSON, 4);

const binHeader = Buffer.alloc(8);
binHeader.writeUInt32LE(binPadded.length, 0);
binHeader.writeUInt32LE(GLB_BIN, 4);

fs.writeFileSync(OUT, Buffer.concat([header, jsonHeader, jsonText, binHeader, binPadded]));
fs.rmSync(work, { recursive: true, force: true });

const before = fs.statSync(IN).size;
const after = fs.statSync(OUT).size;
console.log(`  ${path.basename(IN)}: ${mb(before)} -> ${mb(after)}  (${(before / after).toFixed(0)}x smaller)`);
