// Öğretmen paneli: PDF yükleme, sunum başlatma ve sunumu yönetme.
const $ = (s) => document.querySelector(s);

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

let toastTimer;
function toast(msg) {
  let t = $('.toast');
  if (!t) { t = el('div', { class: 'toast' }); document.body.append(t); }
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

const fmtCode = (c) => `${c.slice(0, 3)} ${c.slice(3)}`;
const slideUrl = (deckId, n) => `/api/decks/${deckId}/slides/${n}`;
const joinHost = () => location.host;

let socket = null;
let state = { decks: [], sessions: [] };
let presenting = null; // canlı sunumun kodu
try { presenting = sessionStorage.getItem('presenting'); } catch { /* yok say */ }

function call(event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload, (res) => {
      if (!res || !res.ok) toast((res && res.error) || 'İşlem başarısız.');
      resolve(res || { ok: false });
    });
  });
}

// ===================================================================== giriş

function showView(id) {
  for (const v of ['v-login', 'v-library', 'v-present']) $('#' + v).classList.toggle('hidden', v !== id);
  document.body.classList.toggle('presenting', id === 'v-present');
  $('#back').classList.toggle('hidden', id !== 'v-present');
  $('#logout').classList.toggle('hidden', id === 'v-login');
}

function connect() {
  if (socket) socket.disconnect();
  socket = io({ forceNew: true });
  socket.on('connect', () => { $('#conn').textContent = 'Bağlı'; });
  socket.on('disconnect', () => { $('#conn').textContent = 'Bağlantı koptu…'; });
  socket.on('teacher:state', (s) => {
    state = s;
    renderLibrary();
    if (presenting) {
      if (state.sessions.some((x) => x.code === presenting)) renderPresenter();
      else { toast('Sunum sona erdi.'); stopPresenting(); }
    } else if ($('#v-login').classList.contains('hidden') === false) {
      showView('v-library');
    }
  });
}

async function boot() {
  const me = await fetch('/api/me').then((r) => r.json()).catch(() => ({ teacher: false }));
  if (me.teacher) {
    showView(presenting ? 'v-present' : 'v-library');
    connect();
  } else {
    showView('v-login');
    $('#conn').textContent = '';
    $('#password').focus();
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: $('#password').value }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { $('#login-error').textContent = data.error || 'Giriş başarısız.'; return; }
  $('#password').value = '';
  showView('v-library');
  connect();
});

$('#logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  try { sessionStorage.removeItem('presenting'); } catch { /* yok say */ }
  location.reload();
});

// ===================================================================== kütüphane

function renderLibrary() {
  const live = $('#live-list');
  live.replaceChildren(...state.sessions.map((s) => el('div', { class: 'live-card' },
    el('div', {},
      el('div', { style: 'font-weight:800' }, s.title),
      el('div', { class: 'muted' }, `Slayt ${s.current + 1}/${s.total} · ${s.viewers} izleyici`)),
    el('div', { class: 'code-big' }, fmtCode(s.code)),
    el('div', { class: 'row' },
      el('button', { class: 'btn primary', onclick: () => startPresenting(s.code) }, 'Sunuma dön ▶'),
      el('button', { class: 'btn red', onclick: () => endSession(s.code) }, 'Bitir')))));
  $('#live-panel').classList.toggle('hidden', state.sessions.length === 0);

  const liveDecks = new Set(state.sessions.map((s) => s.deckId));
  const list = $('#deck-list');
  if (!state.decks.length) {
    list.replaceChildren(el('p', { class: 'muted' }, 'Henüz sunum yok. Yukarıdan bir PDF yükleyin.'));
    return;
  }
  list.replaceChildren(el('table', {},
    el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', {}, 'Sunum'), el('th', {}, 'Slayt'), el('th', {}, 'Yüklenme'), el('th', {}, ''))),
    el('tbody', {}, state.decks.map((d) => el('tr', {},
      el('td', {}, d.ready ? el('img', { class: 'deck-thumb', src: slideUrl(d.id, 0), loading: 'lazy', alt: '' }) : null),
      el('td', {}, el('strong', {}, d.title), ' ',
        liveDecks.has(d.id) ? el('span', { class: 'badge live' }, 'CANLI') : null,
        d.ready ? null : el('span', { class: 'badge warn' }, 'Yükleme tamamlanmadı')),
      el('td', {}, d.pageCount),
      el('td', { class: 'muted' }, new Date(d.createdAt).toLocaleDateString('tr-TR')),
      el('td', {}, el('div', { class: 'row', style: 'justify-content:flex-end;flex-wrap:nowrap' },
        d.ready && !liveDecks.has(d.id) ? el('button', { class: 'btn green small', onclick: () => startDeck(d) }, '▶ Başlat') : null,
        el('button', { class: 'btn ghost small', onclick: () => renameDeck(d) }, 'Adını değiştir'),
        el('button', { class: 'btn ghost small', disabled: liveDecks.has(d.id), onclick: () => deleteDeck(d) }, 'Sil'))))))));
}

async function startDeck(deck) {
  const res = await call('teacher:start', { deckId: deck.id });
  if (res.ok) {
    startPresenting(res.code);
    openJoinScreen();
  }
}

async function renameDeck(deck) {
  const title = prompt('Sunumun yeni adı:', deck.title);
  if (title && title.trim() && title.trim() !== deck.title) await call('teacher:rename', { id: deck.id, title });
}

async function deleteDeck(deck) {
  if (confirm(`"${deck.title}" silinsin mi? Bu geri alınamaz.`)) {
    const res = await call('teacher:deleteDeck', { id: deck.id });
    if (res.ok) toast('Sunum silindi.');
  }
}

async function endSession(code) {
  if (!confirm('Sunum bitirilsin mi? İzleyicilerin ekranında "Sunum sona erdi" yazacak.')) return;
  await call('teacher:end', { code });
}

// ===================================================================== PDF yükleme

let pdfjs = null;
async function loadPdfJs() {
  if (!pdfjs) {
    pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  }
  return pdfjs;
}

const LONG_SIDE = 1920; // slayt resimlerinin uzun kenarı (piksel)

function canvasToBlob(canvas) {
  return new Promise((resolve) => {
    canvas.toBlob((b) => {
      // Safari WebP üretemez; o zaman JPEG kullan
      if (b && b.type === 'image/webp') resolve(b);
      else canvas.toBlob(resolve, 'image/jpeg', 0.9);
    }, 'image/webp', 0.88);
  });
}

async function putWithRetry(url, blob) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': blob.type }, body: blob });
      if (res.ok) return;
      const data = await res.json().catch(() => ({}));
      if (res.status < 500 || attempt >= 3) throw new Error(data.error || `Yükleme hatası (${res.status})`);
    } catch (err) {
      if (attempt >= 3) throw err;
    }
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

let uploading = false;
async function uploadPdf(file) {
  if (!file || uploading) return;
  if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
    toast('Lütfen PDF dosyası seçin. PowerPoint\'ten "PDF olarak kaydet" ile alabilirsiniz.');
    return;
  }
  uploading = true;
  const status = $('#upload-status');
  const text = $('#upload-text');
  const bar = $('#upload-bar');
  status.classList.remove('hidden');
  bar.style.width = '0%';
  text.textContent = 'PDF açılıyor…';
  let task = null;
  try {
    const lib = await loadPdfJs();
    task = lib.getDocument({ data: await file.arrayBuffer() });
    const pdf = await task.promise;
    const first = (await pdf.getPage(1)).getViewport({ scale: 1 });
    const title = file.name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ').trim() || 'Sunum';
    const res = await fetch('/api/decks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, pageCount: pdf.numPages, width: first.width, height: first.height }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sunum oluşturulamadı.');
    const deck = data.deck;

    const canvas = document.createElement('canvas');
    for (let i = 1; i <= pdf.numPages; i++) {
      text.textContent = `Slayt ${i} / ${pdf.numPages} hazırlanıyor…`;
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: LONG_SIDE / Math.max(base.width, base.height) });
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvas, viewport, background: '#ffffff' }).promise;
      const blob = await canvasToBlob(canvas);
      await putWithRetry(`/api/decks/${deck.id}/slides/${i - 1}`, blob);
      page.cleanup();
      bar.style.width = `${(i / pdf.numPages) * 100}%`;
    }
    const fin = await fetch(`/api/decks/${deck.id}/finish`, { method: 'POST' });
    if (!fin.ok) throw new Error((await fin.json().catch(() => ({}))).error || 'Yükleme tamamlanamadı.');
    text.textContent = `"${title}" yüklendi (${deck.pageCount} slayt).`;
    toast('Sunum yüklendi.');
  } catch (err) {
    console.error(err);
    text.textContent = 'Yükleme başarısız: ' + (err.message || err);
  } finally {
    if (task) task.destroy();
    uploading = false;
    $('#file').value = '';
  }
}

$('#file').addEventListener('change', (e) => uploadPdf(e.target.files[0]));
const dz = $('#dropzone');
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragging'); });
dz.addEventListener('dragleave', () => dz.classList.remove('dragging'));
dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('dragging'); uploadPdf(e.dataTransfer.files[0]); });

// ===================================================================== sunum

let thumbsDeck = null;
const current = () => state.sessions.find((s) => s.code === presenting);

function startPresenting(code) {
  presenting = code;
  try { sessionStorage.setItem('presenting', code); } catch { /* yok say */ }
  thumbsDeck = null;
  showView('v-present');
  renderPresenter();
}

function stopPresenting() {
  presenting = null;
  try { sessionStorage.removeItem('presenting'); } catch { /* yok say */ }
  closeJoinScreen();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  showView('v-library');
}

function preload(url) { const i = new Image(); i.src = url; }

function renderPresenter() {
  const s = current();
  if (!s) return;
  const deck = state.decks.find((d) => d.id === s.deckId);
  if (!deck) return;
  $('#p-title').textContent = s.title;
  $('#p-counter').textContent = `${s.current + 1} / ${s.total}`;
  $('#p-code').textContent = fmtCode(s.code);
  $('#p-url').textContent = joinHost();
  const qr = `/api/qr/${s.code}`;
  if ($('#p-qr').getAttribute('src') !== qr) { $('#p-qr').src = qr; $('#js-qr').src = qr; }
  $('#p-viewers').textContent = s.viewers;
  $('#js-viewers').textContent = `${s.viewers} kişi katıldı`;
  $('#js-title').textContent = s.title;
  $('#js-url').textContent = joinHost();
  $('#js-code').textContent = fmtCode(s.code);
  const cur = slideUrl(deck.id, s.current);
  if ($('#p-current').getAttribute('src') !== cur) $('#p-current').src = cur;
  const hasNext = s.current + 1 < s.total;
  $('#p-nextimg').classList.toggle('hidden', !hasNext);
  if (hasNext && $('#p-nextimg').getAttribute('src') !== slideUrl(deck.id, s.current + 1)) $('#p-nextimg').src = slideUrl(deck.id, s.current + 1);
  $('#p-nextnote').textContent = hasNext ? '' : 'Son slayttasınız.';
  $('#p-prev').disabled = s.current === 0;
  $('#p-next').disabled = !hasNext;
  $('#p-black').classList.toggle('active', s.black);
  $('#p-black').textContent = s.black ? '⬛ Karartmayı kaldır' : '⬛ Ekranı karart';
  $('#p-black-note').classList.toggle('hidden', !s.black);
  $('#p-stage').style.aspectRatio = `${deck.width} / ${deck.height}`;
  if (hasNext) preload(slideUrl(deck.id, s.current + 1));
  if (s.current > 0) preload(slideUrl(deck.id, s.current - 1));

  // Küçük resim şeridi (sunum başına bir kez kurulur)
  const thumbs = $('#p-thumbs');
  if (thumbsDeck !== deck.id) {
    thumbsDeck = deck.id;
    thumbs.replaceChildren(...Array.from({ length: deck.pageCount }, (_, i) => el('button', { 'data-n': i, onclick: () => go(i), title: `Slayt ${i + 1}` },
      el('img', { src: slideUrl(deck.id, i), loading: 'lazy', alt: '' }),
      el('span', {}, i + 1))));
  }
  const shown = new Set(s.shown || []);
  thumbs.querySelectorAll('button').forEach((b) => {
    const n = Number(b.dataset.n);
    b.classList.toggle('current', n === s.current);
    b.classList.toggle('seen', shown.has(n) && n !== s.current);
  });
  const cb = thumbs.querySelector('button.current');
  if (cb) cb.scrollIntoView({ block: 'nearest', inline: 'center' });
}

function go(n) {
  const s = current();
  if (!s || n < 0 || n >= s.total || n === s.current) return;
  // Öğretmen ekranı anında güncellensin; sunucu onayı ardından gelir
  s.current = n;
  s.shown = [...new Set([...(s.shown || []), n])];
  renderPresenter();
  call('teacher:goto', { code: s.code, n });
}

function toggleBlack() {
  const s = current();
  if (!s) return;
  s.black = !s.black;
  renderPresenter();
  call('teacher:black', { code: s.code, on: s.black });
}

function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else $('#p-stage').requestFullscreen().catch(() => toast('Tam ekran açılamadı.'));
}

function openJoinScreen() { $('#join-screen').classList.remove('hidden'); }
function closeJoinScreen() { $('#join-screen').classList.add('hidden'); }

$('#p-prev').addEventListener('click', () => { const s = current(); if (s) go(s.current - 1); });
$('#p-next').addEventListener('click', () => { const s = current(); if (s) go(s.current + 1); });
$('#p-black').addEventListener('click', toggleBlack);
$('#p-full').addEventListener('click', toggleFull);
$('#p-join').addEventListener('click', openJoinScreen);
$('#js-close').addEventListener('click', closeJoinScreen);
$('#p-end').addEventListener('click', () => { const s = current(); if (s) endSession(s.code); });
$('#back').addEventListener('click', stopPresenting);
// Tam ekrandayken slayta tıklamak ileri götürür (projeksiyonda pratik)
$('#p-stage').addEventListener('click', () => { if (document.fullscreenElement) { const s = current(); if (s) go(s.current + 1); } });

document.addEventListener('keydown', (e) => {
  if (!presenting || $('#v-present').classList.contains('hidden')) return;
  if (e.target.closest('input, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  const s = current();
  if (!s) return;
  const k = e.key;
  if (!$('#join-screen').classList.contains('hidden')) {
    if (k === 'Escape' || k === 'ArrowRight' || k === ' ' || k === 'PageDown' || k === 'Enter') { closeJoinScreen(); e.preventDefault(); }
    return;
  }
  if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n', 'N'].includes(k)) go(s.current + 1);
  else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p', 'P'].includes(k)) go(s.current - 1);
  else if (k === 'Home') go(0);
  else if (k === 'End') go(s.total - 1);
  else if (k === 'b' || k === 'B' || k === '.') toggleBlack();
  else if (k === 'f' || k === 'F') toggleFull();
  else return;
  e.preventDefault();
});

boot();
