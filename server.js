'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const { createStorage } = require('./storage');

// ---------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------

const clean = (s, max = 120) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, max);
const newId = () => crypto.randomBytes(8).toString('hex');
const IMAGE_TYPES = ['image/webp', 'image/jpeg', 'image/png'];
const MAX_SLIDES = 500;
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000; // 12 saat işlem olmayan sunum kapanır
const COOKIE = 'slide_auth';
const COOKIE_DAYS = 30;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Dosyanın gerçekten resim olduğunu ilk baytlarından kontrol et
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

// ---------------------------------------------------------------------------
// Uygulama
// ---------------------------------------------------------------------------

function createApp(opts = {}) {
  const password = opts.password || process.env.TEACHER_PASSWORD || 'ogretmen123';
  const databaseUrl = opts.databaseUrl !== undefined ? opts.databaseUrl : process.env.DATABASE_URL;
  const dataDir = opts.dataDir || path.join(__dirname, 'data');
  // Şifre değişirse eski oturum çerezleri de geçersiz olur
  const secret = process.env.SESSION_SECRET || crypto.createHash('sha256').update('slide:' + password).digest('hex');
  const storage = createStorage({ databaseUrl, dataDir });

  let decks = [];
  const sessions = new Map(); // kod -> canlı sunum

  // --- Öğretmen kimlik doğrulaması (imzalı çerez) ---------------------------

  const sign = (value) => crypto.createHmac('sha256', secret).update(value).digest('hex');
  function makeToken() {
    const exp = String(Date.now() + COOKIE_DAYS * 86400000);
    return `${exp}.${sign(exp)}`;
  }
  function validToken(token) {
    const [exp, sig] = String(token || '').split('.');
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    return safeEqual(sig, sign(exp));
  }
  const isTeacher = (req) => validToken(parseCookies(req.headers.cookie)[COOKIE]);

  // --- Oturum yardımcıları --------------------------------------------------

  function newCode() {
    for (;;) {
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      if (!sessions.has(code)) return code;
    }
  }

  const room = (code) => 'sess:' + code;
  const viewerCount = (code) => (io.sockets.adapter.rooms.get(room(code)) || { size: 0 }).size;
  const deckById = (id) => decks.find((d) => d.id === id);

  function persistSession(s) {
    storage.saveSession({
      code: s.code, deckId: s.deckId, current: s.current, black: s.black,
      shown: [...s.shown], startedAt: s.startedAt, lastActivity: s.lastActivity,
    }).catch((err) => console.error('Sunum durumu kaydedilemedi:', err.message));
  }

  function viewState(s) {
    const deck = deckById(s.deckId);
    return {
      code: s.code,
      title: deck ? deck.title : '',
      total: deck ? deck.pageCount : 0,
      current: s.current,
      black: s.black,
      aspect: deck ? deck.width / deck.height : 16 / 9,
      url: `/v/${s.code}/${s.current}?d=${s.deckId}`,
    };
  }

  function teacherState() {
    return {
      decks,
      sessions: [...sessions.values()].map((s) => ({
        ...viewState(s), deckId: s.deckId, viewers: viewerCount(s.code), startedAt: s.startedAt, shown: [...s.shown],
      })),
    };
  }

  const pushTeachers = () => io.to('teachers').emit('teacher:state', teacherState());

  function endSession(code, reason) {
    const s = sessions.get(code);
    if (!s) return;
    sessions.delete(code);
    storage.deleteSession(code).catch((err) => console.error('Sunum silinemedi:', err.message));
    io.to(room(code)).emit('ended', { reason });
    io.in(room(code)).socketsLeave(room(code));
    pushTeachers();
  }

  // --- HTTP -----------------------------------------------------------------

  const app = express();
  app.set('trust proxy', 1); // Render vb. arkasında https bilgisini doğru almak için
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/vendor/pdfjs', express.static(path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'legacy', 'build')));
  app.get(['/ogretmen', '/teacher'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'teacher.html')));
  app.get('/health', (req, res) => res.json({ ok: true }));

  // Basit giriş denemesi sınırı: IP başına dakikada 10 deneme
  const attempts = new Map();
  app.post('/api/login', express.json(), (req, res) => {
    const now = Date.now();
    const a = attempts.get(req.ip) || { count: 0, reset: now + 60000 };
    if (now > a.reset) { a.count = 0; a.reset = now + 60000; }
    if (++a.count > 10) return res.status(429).json({ error: 'Çok fazla deneme. Bir dakika sonra tekrar deneyin.' });
    attempts.set(req.ip, a);
    if (!safeEqual((req.body && req.body.password) || '', password)) return res.status(401).json({ error: 'Şifre hatalı.' });
    res.cookie(COOKIE, makeToken(), {
      httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: COOKIE_DAYS * 86400000, path: '/',
    });
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  app.get('/api/me', (req, res) => res.json({ teacher: isTeacher(req) }));

  const requireTeacher = (req, res, next) => (isTeacher(req) ? next() : res.status(401).json({ error: 'Giriş gerekli.' }));

  // Yeni sunum kaydı: slayt resimleri ardından tek tek yüklenir
  app.post('/api/decks', requireTeacher, express.json(), async (req, res) => {
    const title = clean(req.body && req.body.title);
    const pageCount = Number(req.body && req.body.pageCount);
    const width = Number(req.body && req.body.width);
    const height = Number(req.body && req.body.height);
    if (!title) return res.status(400).json({ error: 'Sunum adı gerekli.' });
    if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_SLIDES) {
      return res.status(400).json({ error: `Sunum 1-${MAX_SLIDES} slayt olmalı.` });
    }
    if (!(width > 0 && height > 0)) return res.status(400).json({ error: 'Slayt boyutu geçersiz.' });
    const deck = { id: newId(), title, pageCount, width, height, ready: false, createdAt: Date.now() };
    await storage.saveDeck(deck);
    decks.unshift(deck);
    pushTeachers();
    res.json({ ok: true, deck });
  });

  app.put('/api/decks/:id/slides/:n', requireTeacher, express.raw({ type: IMAGE_TYPES, limit: '15mb' }), async (req, res) => {
    const deck = deckById(req.params.id);
    const n = Number(req.params.n);
    if (!deck) return res.status(404).json({ error: 'Sunum bulunamadı.' });
    if (!Number.isInteger(n) || n < 0 || n >= deck.pageCount) return res.status(400).json({ error: 'Slayt numarası geçersiz.' });
    const mime = Buffer.isBuffer(req.body) ? sniffImage(req.body) : null;
    if (!mime) return res.status(400).json({ error: 'Slayt resmi okunamadı.' });
    await storage.putSlide(deck.id, n, mime, req.body);
    res.json({ ok: true });
  });

  app.post('/api/decks/:id/finish', requireTeacher, async (req, res) => {
    const deck = deckById(req.params.id);
    if (!deck) return res.status(404).json({ error: 'Sunum bulunamadı.' });
    const count = await storage.countSlides(deck.id);
    if (count !== deck.pageCount) return res.status(400).json({ error: `Slaytların ${count}/${deck.pageCount} tanesi yüklendi.` });
    deck.ready = true;
    await storage.saveDeck(deck);
    pushTeachers();
    res.json({ ok: true, deck });
  });

  async function sendSlide(res, deckId, n) {
    const slide = await storage.getSlide(deckId, n);
    if (!slide) return res.status(404).end();
    res.set('Content-Type', slide.mime);
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(slide.data);
  }

  // Öğretmen tüm slaytları görebilir (önizleme, sonraki slayt, küçük resimler)
  app.get('/api/decks/:id/slides/:n', requireTeacher, async (req, res) => {
    const deck = deckById(req.params.id);
    if (!deck) return res.status(404).end();
    await sendSlide(res, deck.id, Number(req.params.n));
  });

  // İzleyici sadece öğretmenin bu sunumda gösterdiği slaytları alabilir (ileriye bakılamaz)
  app.get('/v/:code/:n', async (req, res) => {
    const s = sessions.get(req.params.code);
    const n = Number(req.params.n);
    if (!s || !s.shown.has(n)) return res.status(404).end();
    await sendSlide(res, s.deckId, n);
  });

  // Katılım bağlantısı için QR kod (öğretmen ekranında gösterilir)
  app.get('/api/qr/:code', async (req, res) => {
    if (!/^\d{6}$/.test(req.params.code)) return res.status(400).end();
    const url = `${req.protocol}://${req.get('host')}/?kod=${req.params.code}`;
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.set('Content-Type', 'image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(svg);
  });

  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Dosya çok büyük.' });
    console.error(err);
    res.status(500).json({ error: 'Sunucu hatası.' });
    void next;
  });

  // --- Socket.IO ------------------------------------------------------------

  const httpServer = http.createServer(app);
  const io = new Server(httpServer);

  io.on('connection', (socket) => {
    const teacher = validToken(parseCookies(socket.handshake.headers.cookie)[COOKIE]);
    socket.data = { teacher, code: null };
    if (teacher) {
      socket.join('teachers');
      socket.emit('teacher:state', teacherState());
    }

    // İzleyici: koda göre sunuma katılır, sadece izler
    socket.on('viewer:join', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const code = String((payload && payload.code) || '').replace(/\D/g, '');
      const s = sessions.get(code);
      if (!s) return reply({ ok: false, error: 'Bu kodla açık bir sunum bulunamadı.' });
      if (socket.data.code && socket.data.code !== code) socket.leave(room(socket.data.code));
      socket.data.code = code;
      socket.join(room(code));
      reply({ ok: true, state: viewState(s) });
      pushTeachers();
    });

    socket.on('viewer:leave', () => {
      if (socket.data.code) socket.leave(room(socket.data.code));
      socket.data.code = null;
      pushTeachers();
    });

    const teacherOnly = (event, handler) => {
      socket.on(event, (payload, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        if (!socket.data.teacher) return reply({ ok: false, error: 'Yetkisiz.' });
        Promise.resolve()
          .then(() => handler(payload || {}, reply))
          .catch((err) => reply({ ok: false, error: err.message || 'Hata oluştu.' }));
      });
    };

    teacherOnly('teacher:start', ({ deckId }, reply) => {
      const deck = deckById(deckId);
      if (!deck) throw new Error('Sunum bulunamadı.');
      if (!deck.ready) throw new Error('Bu sunumun yüklenmesi tamamlanmamış.');
      const code = newCode();
      const s = { code, deckId, current: 0, black: false, shown: new Set([0]), startedAt: Date.now(), lastActivity: Date.now() };
      sessions.set(code, s);
      persistSession(s);
      pushTeachers();
      reply({ ok: true, code });
    });

    teacherOnly('teacher:goto', ({ code, n }, reply) => {
      const s = sessions.get(code);
      if (!s) throw new Error('Sunum bulunamadı.');
      const deck = deckById(s.deckId);
      const target = Number(n);
      if (!Number.isInteger(target) || target < 0 || target >= deck.pageCount) throw new Error('Slayt numarası geçersiz.');
      s.current = target;
      s.shown.add(target);
      s.lastActivity = Date.now();
      persistSession(s);
      io.to(room(code)).emit('state', viewState(s));
      pushTeachers();
      reply({ ok: true });
    });

    teacherOnly('teacher:black', ({ code, on }, reply) => {
      const s = sessions.get(code);
      if (!s) throw new Error('Sunum bulunamadı.');
      s.black = !!on;
      s.lastActivity = Date.now();
      persistSession(s);
      io.to(room(code)).emit('state', viewState(s));
      pushTeachers();
      reply({ ok: true });
    });

    teacherOnly('teacher:end', ({ code }, reply) => {
      if (!sessions.has(code)) throw new Error('Sunum bulunamadı.');
      endSession(code, 'teacher');
      reply({ ok: true });
    });

    teacherOnly('teacher:rename', async ({ id, title }, reply) => {
      const deck = deckById(id);
      const t = clean(title);
      if (!deck) throw new Error('Sunum bulunamadı.');
      if (!t) throw new Error('Sunum adı gerekli.');
      deck.title = t;
      await storage.saveDeck(deck);
      pushTeachers();
      for (const s of sessions.values()) if (s.deckId === id) io.to(room(s.code)).emit('state', viewState(s));
      reply({ ok: true });
    });

    teacherOnly('teacher:deleteDeck', async ({ id }, reply) => {
      if (!deckById(id)) throw new Error('Sunum bulunamadı.');
      if ([...sessions.values()].some((s) => s.deckId === id)) throw new Error('Bu sunum şu an canlı; önce sunumu bitirin.');
      await storage.deleteDeck(id);
      decks = decks.filter((d) => d.id !== id);
      pushTeachers();
      reply({ ok: true });
    });

    socket.on('disconnect', () => {
      if (socket.data.code) pushTeachers();
    });
  });

  // Uzun süre işlem görmeyen sunumları kapat
  const sweeper = setInterval(() => {
    for (const s of sessions.values()) if (Date.now() - s.lastActivity > SESSION_IDLE_MS) endSession(s.code, 'idle');
  }, 10 * 60 * 1000);
  sweeper.unref();

  // Açılışta kayıtlı sunumları ve (yeniden başlatma öncesi) canlı oturumları yükle
  const ready = storage.init()
    .then(() => storage.listDecks())
    .then((list) => { decks = list.sort((a, b) => b.createdAt - a.createdAt); })
    .then(() => storage.listSessions())
    .then((list) => {
      for (const s of list) {
        if (!deckById(s.deckId) || Date.now() - s.lastActivity > SESSION_IDLE_MS) {
          storage.deleteSession(s.code).catch(() => {});
          continue;
        }
        sessions.set(s.code, { ...s, shown: new Set(s.shown) });
      }
    });

  async function close() {
    clearInterval(sweeper);
    io.close();
    httpServer.close();
    await storage.close();
  }

  return { app, httpServer, io, ready, storage, close };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { httpServer, ready, storage } = createApp();
  ready.then(() => httpServer.listen(port, () => {
    console.log(`Sunum sunucusu çalışıyor: http://localhost:${port}`);
    console.log(`Öğretmen paneli:         http://localhost:${port}/ogretmen`);
    console.log(`Kayıt yeri:              ${storage.kind === 'postgres' ? 'PostgreSQL (DATABASE_URL)' : 'data/ klasörü'}`);
    if (!process.env.TEACHER_PASSWORD) console.log('Uyarı: TEACHER_PASSWORD ayarlanmadı, varsayılan şifre "ogretmen123".');
  })).catch((err) => {
    console.error('Kayıt sistemi başlatılamadı (DATABASE_URL doğru mu?):', err.message);
    process.exit(1);
  });
}

module.exports = { createApp };
