'use strict';

// Kayıt katmanı: yüklenen sunumlar (her slaytın resmi) ve canlı oturumlar data/ klasöründe tutulur.
// Veritabanı yoktur; barındırma ortamının diski geçiciyse (ör. ücretsiz Render) sunucu yeniden
// başladığında yüklenenler silinir. Tüm metotlar Promise döner.

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

function createStorage({ dataDir }) {
  return createFileStorage(dataDir);
}

module.exports = { createStorage };
