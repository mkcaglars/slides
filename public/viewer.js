(function () {
  // İzleyici sayfası: sadece izler; slayt değiştirme, ileri/geri gibi hiçbir kontrol yoktur.
  const $ = (s) => document.querySelector(s);
  const params = new URLSearchParams(location.search);

  const socket = io({ autoConnect: true });
  let joinedCode = null;
  let wantCode = (params.get('kod') || params.get('code') || '').replace(/\D/g, '');
  let loadToken = 0;
  let lastUrl = null;

  function show(id) {
    $('#s-join').classList.toggle('hidden', id !== 's-join');
    $('#s-view').classList.toggle('hidden', id !== 's-view');
  }

  function setUrlCode(code) {
    const p = new URLSearchParams(location.search);
    if (code) p.set('kod', code); else { p.delete('kod'); p.delete('code'); }
    const q = p.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : ''));
  }

  function overlay(html) {
    const o = $('#overlay');
    if (!html) { o.classList.add('hidden'); o.replaceChildren(); return; }
    o.innerHTML = html;
    o.classList.remove('hidden');
  }

  // Yeni slaytı önce arka planda yükle, sonra göster (titreme olmasın)
  function render(state) {
    $('#v-title').textContent = state.title;
    $('#v-count').textContent = `${state.current + 1} / ${state.total}`;
    document.title = `${state.title} · Sunum`;
    $('#blackout').classList.toggle('hidden', !state.black);
    if (state.url === lastUrl) return;
    const token = ++loadToken;
    const img = new Image();
    img.onload = () => {
      if (token !== loadToken) return;
      $('#slide').src = state.url;
      lastUrl = state.url;
    };
    img.onerror = () => {
      if (token === loadToken) setTimeout(() => { if (token === loadToken) img.src = state.url + '&r=' + Date.now(); }, 1500);
    };
    img.src = state.url;
  }

  function join(code) {
    code = String(code || '').replace(/\D/g, '');
    if (code.length !== 6) {
      $('#join-error').textContent = 'Kod 6 haneli olmalı.';
      return;
    }
    $('#join-btn').disabled = true;
    socket.emit('viewer:join', { code }, (res) => {
      $('#join-btn').disabled = false;
      if (!res || !res.ok) {
        if (joinedCode) { ended('Sunum sona erdi.'); return; }
        $('#join-error').textContent = (res && res.error) || 'Katılınamadı.';
        show('s-join');
        setUrlCode(null);
        return;
      }
      joinedCode = code;
      wantCode = code;
      try { sessionStorage.setItem('slideCode', code); } catch { /* yok say */ }
      setUrlCode(code);
      $('#join-error').textContent = '';
      overlay(null);
      show('s-view');
      render(res.state);
      wakeBar();
    });
  }

  function ended(msg) {
    joinedCode = null;
    wantCode = '';
    lastUrl = null;
    try { sessionStorage.removeItem('slideCode'); } catch { /* yok say */ }
    setUrlCode(null);
    overlay(`<h2 style="margin:0">${msg}</h2><p style="margin:0;color:#cbd5e1">İzlediğiniz için teşekkürler.</p>
      <button class="btn primary" id="again">Başka bir sunuma katıl</button>`);
    $('#again').addEventListener('click', leave);
  }

  function leave() {
    socket.emit('viewer:leave');
    joinedCode = null;
    wantCode = '';
    lastUrl = null;
    try { sessionStorage.removeItem('slideCode'); } catch { /* yok say */ }
    setUrlCode(null);
    overlay(null);
    $('#slide').removeAttribute('src');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    $('#code').value = '';
    show('s-join');
    $('#code').focus();
  }

  socket.on('connect', () => {
    // İlk açılış veya bağlantı koptuktan sonra kaldığı sunuma yeniden bağlan
    const code = joinedCode || wantCode;
    if (code) join(code);
  });

  socket.on('disconnect', () => {
    if (joinedCode) overlay('<div class="spinner"></div><div>Bağlantı koptu, yeniden bağlanılıyor…</div>');
  });

  socket.on('state', (state) => { if (state.code === joinedCode) render(state); });
  socket.on('ended', (d) => ended(d && d.reason === 'idle' ? 'Sunum uzun süre işlem görmediği için kapandı.' : 'Sunum sona erdi.'));

  // --- Form ---
  const input = $('#code');
  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '').slice(0, 6);
    input.value = digits.length > 3 ? digits.slice(0, 3) + ' ' + digits.slice(3) : digits;
    $('#join-error').textContent = '';
  });
  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    join(input.value);
  });

  // --- Üst çubuk birkaç saniye sonra gizlenir, dokununca/hareket edince geri gelir ---
  let barTimer;
  function wakeBar() {
    $('#bar').classList.remove('faded');
    clearTimeout(barTimer);
    barTimer = setTimeout(() => $('#bar').classList.add('faded'), 3000);
  }
  ['mousemove', 'touchstart', 'click'].forEach((ev) => document.addEventListener(ev, () => { if (joinedCode) wakeBar(); }, { passive: true }));

  const canFullscreen = !!document.documentElement.requestFullscreen;
  if (!canFullscreen) $('#v-full').classList.add('hidden');
  $('#v-full').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  });
  $('#v-leave').addEventListener('click', leave);
  $('#slide').addEventListener('contextmenu', (e) => e.preventDefault());

  // Bağlantıdaki ?kod= ya da sayfa yenilenmeden önceki kod
  if (!wantCode) { try { wantCode = sessionStorage.getItem('slideCode') || ''; } catch { /* yok say */ } }
  if (wantCode) input.value = wantCode.slice(0, 3) + ' ' + wantCode.slice(3);
})();
