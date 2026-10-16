import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const page = readFileSync(new URL('./index.html', import.meta.url));
const port = Number(process.env.PORT || 3000);
createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/health') { res.writeHead(200, {'Content-Type': 'text/plain'}); res.end('ok'); return; }
  if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (path !== '/' && path !== '/index.html') { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache'});
  res.end(req.method === 'HEAD' ? undefined : page);
}).listen(port, '0.0.0.0', () => console.log(`Pigeon Patrol listening on ${port}`));
