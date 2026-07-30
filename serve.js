/* Serve the arcade over HTTP, so other machines on the network can play it.

   The page mostly works opened straight off disk, but a file:// page is not
   allowed to fetch a sibling file, so the maze's monster model never arrives
   and it falls back to a stand-in creature. Served over HTTP everything loads.

   Node's own modules only — there is nothing to install.

     node serve.js                 all interfaces, port 8080
     node serve.js 3000            a different port
     node serve.js 8080 127.0.0.1  this machine only
*/
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || 8080);
const HOST = process.argv[3] || '0.0.0.0';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);

  // Nothing outside this directory, however the path is spelt.
  if (!path.resolve(file).startsWith(path.resolve(ROOT))) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('forbidden');
    return;
  }

  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      // Everything here is edited by hand; never serve a stale copy.
      'Cache-Control': 'no-store',
    }).end(body);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: node serve.js ${PORT + 1}`);
  } else if (err.code === 'EACCES') {
    console.error(`Not allowed to listen on port ${PORT}. Try one above 1024.`);
  } else {
    console.error(err.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`Game Arcade — serving ${ROOT}`);
  console.log(`  http://localhost:${PORT}/`);

  if (HOST === '0.0.0.0') {
    // Every address this machine can be reached on, for anyone else to use.
    for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
      for (const address of addresses || []) {
        if (address.family !== 'IPv4' || address.internal) continue;
        console.log(`  http://${address.address}:${PORT}/   (${name})`);
      }
    }
  }
  console.log('\nCtrl-C to stop.');
});
