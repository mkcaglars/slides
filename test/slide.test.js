'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: connect } = require('socket.io-client');
const { createApp } = require('../server');

let dataDir;
let server;
let base;
let cookie;
const sockets = [];

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 3)]);

async function start() {
  const s = createApp({ dataDir, password: 'gizli' });
  await s.ready;
  await new Promise((r) => s.httpServer.listen(0, r));
  return s;
}

const urlOf = (s) => `http://localhost:${s.httpServer.address().port}`;
const req = (p, opts = {}) => fetch(base + p, { ...opts, headers: { ...(opts.headers || {}), ...(opts.auth === false ? {} : { cookie }) } });

function client(withCookie, srv = server) {
  const s = connect(urlOf(srv), { transports: ['websocket'], forceNew: true, extraHeaders: withCookie ? { cookie } : {} });
  sockets.push(s);
  return s;
}
const emit = (s, ev, payload) => new Promise((r) => s.emit(ev, payload, r));
const once = (s, ev) => new Promise((r) => s.once(ev, r));

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slide-test-'));
  server = await start();
  base = urlOf(server);
});

after(async () => {
  for (const s of sockets) s.close();
  await server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('yanlış şifreyle giriş yapılamaz, girişsiz yükleme yapılamaz', async () => {
  const bad = await req('/api/login', { method: 'POST', auth: false, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'x' }) });
  assert.strictEqual(bad.status, 401);
  const anon = await req('/api/decks', { method: 'POST', auth: false, headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(anon.status, 401);
  const forged = await req('/api/decks', { method: 'POST', headers: { cookie: 'slide_auth=9999999999999.abc', 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(forged.status, 401);
});

test('öğretmen girer, sunum yükler; izleyici kodla katılır ve sadece izler', async () => {
  const login = await req('/api/login', { method: 'POST', auth: false, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'gizli' }) });
  assert.strictEqual(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
  assert.deepStrictEqual(await (await req('/api/me')).json(), { teacher: true });

  // Sunum oluştur ve 3 slayt yükle
  const created = await (await req('/api/decks', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Hücre Bölünmesi', pageCount: 3, width: 960, height: 540 }),
  })).json();
  const id = created.deck.id;
  const early = await req(`/api/decks/${id}/finish`, { method: 'POST' });
  assert.strictEqual(early.status, 400, 'tüm slaytlar yüklenmeden bitirilemez');
  for (let n = 0; n < 3; n++) {
    const r = await req(`/api/decks/${id}/slides/${n}`, { method: 'PUT', headers: { 'Content-Type': n === 1 ? 'image/png' : 'image/jpeg' }, body: n === 1 ? PNG : JPEG });
    assert.strictEqual(r.status, 200);
  }
  const notImage = await req(`/api/decks/${id}/slides/0`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from('<script>alert(1)</script>') });
  assert.strictEqual(notImage.status, 400, 'resim olmayan dosya reddedilir');
  const outOfRange = await req(`/api/decks/${id}/slides/3`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: JPEG });
  assert.strictEqual(outOfRange.status, 400);
  assert.strictEqual((await req(`/api/decks/${id}/finish`, { method: 'POST' })).status, 200);

  const teacher = client(true);
  await once(teacher, 'teacher:state');
  const started = await emit(teacher, 'teacher:start', { deckId: id });
  assert.ok(started.ok);
  assert.match(started.code, /^\d{6}$/);
  const code = started.code;

  // Kodsuz/yanlış kodla katılım
  const viewer = client(false);
  assert.strictEqual((await emit(viewer, 'viewer:join', { code: '000000' === code ? '111111' : '000000' })).ok, false);
  const joined = await emit(viewer, 'viewer:join', { code: `${code.slice(0, 3)} ${code.slice(3)}` });
  assert.ok(joined.ok);
  assert.strictEqual(joined.state.current, 0);
  assert.strictEqual(joined.state.title, 'Hücre Bölünmesi');

  // İzleyici mevcut slaytı alabilir, henüz gösterilmeyen slaytları alamaz
  const cur = await req(joined.state.url, { auth: false });
  assert.strictEqual(cur.status, 200);
  assert.strictEqual(cur.headers.get('content-type'), 'image/jpeg');
  assert.strictEqual((await req(`/v/${code}/2`, { auth: false })).status, 404, 'ileriye bakılamaz');
  assert.strictEqual((await req(`/api/decks/${id}/slides/2`, { auth: false })).status, 401, 'öğretmen adresinden de alınamaz');

  // İzleyici kontrol edemez
  for (const ev of ['teacher:goto', 'teacher:black', 'teacher:end', 'teacher:start', 'teacher:deleteDeck']) {
    const r = await emit(viewer, ev, { code, n: 2, on: true, deckId: id, id });
    assert.strictEqual(r.ok, false, ev + ' izleyiciye kapalı olmalı');
  }

  // Öğretmen ilerletince izleyiciye anında gelir
  const stateP = once(viewer, 'state');
  assert.ok((await emit(teacher, 'teacher:goto', { code, n: 2 })).ok);
  const st = await stateP;
  assert.strictEqual(st.current, 2);
  assert.strictEqual((await req(st.url, { auth: false })).status, 200);
  assert.strictEqual((await req(`/v/${code}/1`, { auth: false })).status, 404, 'atlanan slayt gösterilmedi');

  const blackP = once(viewer, 'state');
  await emit(teacher, 'teacher:black', { code, on: true });
  assert.strictEqual((await blackP).black, true);

  // Geç katılan izleyici o anki slayttan başlar
  const late = client(false);
  const lj = await emit(late, 'viewer:join', { code });
  assert.strictEqual(lj.state.current, 2);
  assert.strictEqual(lj.state.black, true);

  // Canlı sunum silinemez
  assert.strictEqual((await emit(teacher, 'teacher:deleteDeck', { id })).ok, false);

  const endedP = once(viewer, 'ended');
  assert.ok((await emit(teacher, 'teacher:end', { code })).ok);
  await endedP;
  assert.strictEqual((await req(`/v/${code}/0`, { auth: false })).status, 404, 'bitince slaytlar kapanır');
  assert.strictEqual((await emit(late, 'viewer:join', { code })).ok, false);
});

test('canlı sunum sunucu yeniden başlayınca kaldığı yerden devam eder', async () => {
  const teacher = client(true);
  const st = await once(teacher, 'teacher:state');
  const deck = st.decks[0];
  const { code } = await emit(teacher, 'teacher:start', { deckId: deck.id });
  await emit(teacher, 'teacher:goto', { code, n: 1 });
  await new Promise((r) => setTimeout(r, 100)); // kayıt arka planda yazılır

  const second = await start();
  try {
    const v = client(false, second);
    const j = await emit(v, 'viewer:join', { code });
    assert.ok(j.ok, 'kod yeniden başlatmadan sonra geçerli');
    assert.strictEqual(j.state.current, 1);
    const img = await fetch(urlOf(second) + j.state.url);
    assert.strictEqual(img.status, 200);
    assert.strictEqual(img.headers.get('content-type'), 'image/png');
  } finally {
    await second.close();
  }
  await emit(teacher, 'teacher:end', { code });
});

test('QR kod katılım bağlantısını içerir', async () => {
  const r = await req('/api/qr/123456', { auth: false });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /svg/);
  assert.strictEqual((await req('/api/qr/abc', { auth: false })).status, 400);
});
