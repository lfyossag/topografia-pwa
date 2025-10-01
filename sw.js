/* sw.js — PWA para Informe de Topografía */
const VERSION = 'v6';
const CACHE_STATIC = `static-${VERSION}`;
const CACHE_DYNAMIC = `dynamic-${VERSION}`;
const ENDPOINT_DATA = "https://luisyg.app.n8n.cloud/webhook-test/datos";
const ENDPOINT_CATALOGS = "https://luisyg.app.n8n.cloud/webhook-test/obtener-datos";

/* ====== IndexedDB simple para cola de POST ====== */
const DB_NAME = 'topografia-bg';
const STORE = 'queue';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function queuePut(entry) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function queueAll() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function queueClear() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ====== Instalación / Activación ====== */
self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_STATIC).then(cache =>
      cache.addAll([
        '/', // si sirves desde raíz; ajusta si usas subruta
        '/manifest.webmanifest'
        // puedes añadir tus assets fingerprinted (app.css, app.js, logo, etc.)
      ]).catch(()=>{})
    )
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => {
      if (!k.startsWith('static-') && !k.startsWith('dynamic-')) return;
      if (k !== CACHE_STATIC && k !== CACHE_DYNAMIC) return caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

/* ====== Sync (Background Sync) ====== */
self.addEventListener('sync', event => {
  if (event.tag === 'sync-outbox') {
    event.waitUntil(flushQueue());
  }
});

async function flushQueue() {
  const items = await queueAll();
  if (!items.length) return;
  for (const it of items) {
    try {
      await fetch(ENDPOINT_DATA, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(it.headers||{}) },
        body: JSON.stringify(it.body)
      });
    } catch (e) {
      // si falla alguna, abortar: lo intentaremos después
      return;
    }
  }
  await queueClear();
}

/* ====== Estrategias de red ====== */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Solo manejar http(s)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // 1) POST a ENDPOINT_DATA → intentar red, si falla, encolar
  if (req.method === 'POST' && url.href.startsWith(ENDPOINT_DATA)) {
    event.respondWith((async () => {
      try {
        return await fetch(req); // éxito directo
      } catch (err) {
        // Clonar body
        let body = {};
        try {
          const clone = req.clone();
          body = await clone.json();
        } catch {}
        await queuePut({ body, headers: { /* puedes copiar cabeceras si las necesitas */ } });

        // Registrar sync si existe; si no, reintentar al 'online'
        if ('sync' in self.registration) {
          try { await self.registration.sync.register('sync-outbox'); } catch {}
        }
        // Responder "aceptado offline"
        return new Response(JSON.stringify({ queued: true }), { status: 202, headers: { 'Content-Type': 'application/json' } });
      }
    })());
    return;
  }

  // 2) GET a catálogos → Stale-While-Revalidate
  if (req.method === 'GET' && url.href.startsWith(ENDPOINT_CATALOGS)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_DYNAMIC);
      const cached = await cache.match(req);
      const netP = fetch(req).then(res => {
        cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      return cached || netP || new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    })());
    return;
  }

  // 3) Navegación (HTML) → Network First con fallback a cache
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try { return await fetch(req); }
      catch {
        const cache = await caches.open(CACHE_STATIC);
        const cached = await cache.match('/');
        return cached || new Response('<h1>Offline</h1>', { headers: { 'Content-Type': 'text/html' } });
      }
    })());
    return;
  }

  // 4) Otros GET (assets) → Cache First con actualización en background
  if (req.method === 'GET') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_STATIC);
      const cached = await cache.match(req);
      if (cached) {
        // actualizar en background
        fetch(req).then(res => caches.open(CACHE_STATIC).then(c => c.put(req, res))).catch(()=>{});
        return cached;
      }
      try {
        const res = await fetch(req);
        const putIn = (req.destination === 'document' || req.destination === 'script' || req.destination === 'style' || req.destination === 'image') ? CACHE_STATIC : CACHE_DYNAMIC;
        caches.open(putIn).then(c => c.put(req, res.clone()));
        return res;
      } catch {
        return cached || Response.error();
      }
    })());
  }
});

/* Reintentar cola cuando vuelve la conexión */
self.addEventListener('online', () => {
  flushQueue();
});
