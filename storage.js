'use strict';

// Kalıcı kayıt katmanı: DATABASE_URL varsa PostgreSQL, yoksa data/ klasörü.
// Sunumlar (deck) ve her slaytın resmi ile, sunucu yeniden başlarsa devam edebilmek için
// canlı oturumlar saklanır. Tüm metotlar Promise döner.

const fs = require('fs');
const path = require('path');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Dosyalar (yerel geliştirme)
// ---------------------------------------------------------------------------

function createFileStorage(dataDir) {
  const decksFile = path.join(dataDir, 'decks.json');
  const sessionsFile = path.join(dataDir, 'sessions.json');
  const slidesDir = path.join(dataDir, 'slides');
  let decks = [];
  let sessions = [];
  const slideFile = (deckId, n) => path.join(slidesDir, deckId, String(n));

  return {
    kind: 'file',
    async init() {
      fs.mkdirSync(slidesDir, { recursive: true });
      decks = readJson(decksFile, []);
      sessions = readJson(sessionsFile, []);
    },
    async listDecks() {
      return decks.map((d) => ({ ...d }));
    },
    async saveDeck(deck) {
      const i = decks.findIndex((d) => d.id === deck.id);
      if (i === -1) decks.push(deck);
      else decks[i] = deck;
      writeJson(decksFile, decks);
    },
    async deleteDeck(id) {
      decks = decks.filter((d) => d.id !== id);
      writeJson(decksFile, decks);
      fs.rmSync(path.join(slidesDir, id), { recursive: true, force: true });
    },
    async putSlide(deckId, n, mime, data) {
      fs.mkdirSync(path.join(slidesDir, deckId), { recursive: true });
      fs.writeFileSync(slideFile(deckId, n), data);
      fs.writeFileSync(slideFile(deckId, n) + '.type', mime);
    },
    async getSlide(deckId, n) {
      try {
        return { mime: fs.readFileSync(slideFile(deckId, n) + '.type', 'utf8'), data: fs.readFileSync(slideFile(deckId, n)) };
      } catch {
        return null;
      }
    },
    async countSlides(deckId) {
      try {
        return fs.readdirSync(path.join(slidesDir, deckId)).filter((f) => !f.endsWith('.type')).length;
      } catch {
        return 0;
      }
    },
    async listSessions() {
      return sessions.map((s) => ({ ...s }));
    },
    async saveSession(session) {
      const i = sessions.findIndex((s) => s.code === session.code);
      if (i === -1) sessions.push(session);
      else sessions[i] = session;
      writeJson(sessionsFile, sessions);
    },
    async deleteSession(code) {
      sessions = sessions.filter((s) => s.code !== code);
      writeJson(sessionsFile, sessions);
    },
    async close() {},
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL (Neon, Supabase, Render vb.)
// ---------------------------------------------------------------------------

function createPgStorage(databaseUrl) {
  const { Pool } = require('pg');
  const local = /@(localhost|127\.0\.0\.1)(:\d+)?\//.test(databaseUrl);
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: local || /sslmode=disable/.test(databaseUrl) ? false : { rejectUnauthorized: false },
    max: 5,
  });

  return {
    kind: 'postgres',
    async init() {
      // Tablo adları quiz uygulamasınınkilerle çakışmaz; aynı veritabanı paylaşılabilir.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS slide_decks (
          id         TEXT PRIMARY KEY,
          data       JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS slide_images (
          deck_id TEXT NOT NULL REFERENCES slide_decks(id) ON DELETE CASCADE,
          n       INTEGER NOT NULL,
          mime    TEXT NOT NULL,
          data    BYTEA NOT NULL,
          PRIMARY KEY (deck_id, n)
        );
        CREATE TABLE IF NOT EXISTS slide_sessions (
          code TEXT PRIMARY KEY,
          data JSONB NOT NULL
        );
      `);
    },
    async listDecks() {
      const { rows } = await pool.query('SELECT data FROM slide_decks ORDER BY created_at DESC');
      return rows.map((r) => r.data);
    },
    async saveDeck(deck) {
      await pool.query(
        'INSERT INTO slide_decks (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data',
        [deck.id, deck],
      );
    },
    async deleteDeck(id) {
      await pool.query('DELETE FROM slide_decks WHERE id = $1', [id]);
    },
    async putSlide(deckId, n, mime, data) {
      await pool.query(
        `INSERT INTO slide_images (deck_id, n, mime, data) VALUES ($1, $2, $3, $4)
         ON CONFLICT (deck_id, n) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data`,
        [deckId, n, mime, data],
      );
    },
    async getSlide(deckId, n) {
      const { rows } = await pool.query('SELECT mime, data FROM slide_images WHERE deck_id = $1 AND n = $2', [deckId, n]);
      return rows[0] || null;
    },
    async countSlides(deckId) {
      const { rows } = await pool.query('SELECT count(*)::int AS n FROM slide_images WHERE deck_id = $1', [deckId]);
      return rows[0].n;
    },
    async listSessions() {
      const { rows } = await pool.query('SELECT data FROM slide_sessions');
      return rows.map((r) => r.data);
    },
    async saveSession(session) {
      await pool.query(
        'INSERT INTO slide_sessions (code, data) VALUES ($1, $2) ON CONFLICT (code) DO UPDATE SET data = EXCLUDED.data',
        [session.code, session],
      );
    },
    async deleteSession(code) {
      await pool.query('DELETE FROM slide_sessions WHERE code = $1', [code]);
    },
    async close() {
      await pool.end();
    },
  };
}

function createStorage({ databaseUrl, dataDir }) {
  return databaseUrl ? createPgStorage(databaseUrl) : createFileStorage(dataDir);
}

module.exports = { createStorage };
