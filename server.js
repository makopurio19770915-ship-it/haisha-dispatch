const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const MONGODB_URI = process.env.MONGODB_URI;

const INITIAL_STATE = { requests: [], vehicles: [], drivers: [], places: [], nextId: 1, scheduleExcelMemos: {} };

const DISCORD_WEBHOOK_URL = (process.env.DISCORD_WEBHOOK_URL || '').trim();

/**
 * 状態データを安全な形に整える（ID重複・nextId逆行を防ぐ）
 */
function normalizeState(input) {
  const merged = { ...INITIAL_STATE, ...(input || {}) };

  merged.requests = Array.isArray(merged.requests) ? merged.requests : [];
  merged.vehicles = Array.isArray(merged.vehicles) ? merged.vehicles : [];
  merged.drivers = Array.isArray(merged.drivers) ? merged.drivers : [];
  merged.places = Array.isArray(merged.places) ? merged.places : [];
  merged.scheduleExcelMemos =
    merged.scheduleExcelMemos && typeof merged.scheduleExcelMemos === 'object'
      ? merged.scheduleExcelMemos
      : {};

  const usedIds = new Set();
  let maxId = 0;
  let nextId = Number.parseInt(merged.nextId, 10);
  if (!Number.isFinite(nextId) || nextId < 1) nextId = 1;

  merged.requests = merged.requests.map((req) => {
    const normalizedReq = { ...(req || {}) };
    const parsedId = Number.parseInt(normalizedReq.id, 10);
    if (Number.isFinite(parsedId) && parsedId >= 1 && !usedIds.has(parsedId)) {
      normalizedReq.id = parsedId;
      usedIds.add(parsedId);
      if (parsedId > maxId) maxId = parsedId;
      return normalizedReq;
    }

    // 重複/不正IDは後段で採番し直す
    normalizedReq.id = null;
    return normalizedReq;
  });

  nextId = Math.max(nextId, maxId + 1);
  merged.requests = merged.requests.map((req) => {
    if (Number.isFinite(req.id) && req.id >= 1) return req;
    while (usedIds.has(nextId)) nextId += 1;
    req.id = nextId;
    usedIds.add(nextId);
    maxId = Math.max(maxId, nextId);
    nextId += 1;
    return req;
  });

  merged.nextId = Math.max(nextId, maxId + 1);
  return merged;
}

function clipText(s, max) {
  const t = String(s ?? '');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t || '—';
}

/** 新規配車依頼を Discord へ（環境変数 DISCORD_WEBHOOK_URL が無ければ何もしない） */
async function notifyDiscordNewRequest(req) {
  if (!DISCORD_WEBHOOK_URL || !req) return;

  let pickup = '—';
  let ret = '—';
  try {
    if (req.pickupDt) pickup = new Date(req.pickupDt).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
  } catch { /* ignore */ }
  try {
    if (req.returnDt) ret = new Date(req.returnDt).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
  } catch { /* ignore */ }

  const embed = {
    title: `🚗 新規配車依頼 #${req.id}`,
    color: 0x1e40af,
    fields: [
      { name: '申請者', value: clipText(req.requester, 200), inline: true },
      { name: '人数', value: String(req.passengers ?? '—'), inline: true },
      { name: 'ステータス', value: clipText(req.status, 80), inline: true },
      { name: '乗車',
        value: clipText(pickup, 200), inline: false },
      { name: '返車予定', value: clipText(ret, 200), inline: false },
      { name: '出発地', value: clipText(req.from, 1000), inline: true },
      { name: '目的地', value: clipText(req.to, 1000), inline: true },
    ],
    timestamp: new Date().toISOString(),
  };
  if (req.notes && String(req.notes).trim()) {
    embed.fields.push({ name: '備考', value: clipText(req.notes, 1000), inline: false });
  }

  const r = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: '配車管理',
      embeds: [embed],
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status} ${txt.slice(0, 300)}`);
  }
}

/** 同時POSTで read→write が混ざらないよう直列化（依頼の取りこぼし防止） */
let mutationQueue = Promise.resolve();
function enqueueMutation(fn) {
  const run = () => fn();
  const p = mutationQueue.then(run, run);
  mutationQueue = p.then(
    () => {},
    () => {}
  );
  return p;
}

let mongoClient = null;
let mongoDb = null;
let useMongo = false;

async function initMongo() {
  const { MongoClient } = require('mongodb');
  mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();
  mongoDb = mongoClient.db('dispatch_app');
  const col = mongoDb.collection('state');
  const doc = await col.findOne({ _id: 'main' });
  if (!doc) {
    await col.insertOne({ _id: 'main', data: INITIAL_STATE });
  }
  useMongo = true;
  console.log('  保存先: MongoDB Atlas（クラウド永続）');
}

function initFileStorage() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(INITIAL_STATE, null, 2));
  }
  console.log('  保存先: ローカルファイル (' + DATA_FILE + ')');
}

async function readState() {
  if (useMongo) {
    const col = mongoDb.collection('state');
    const doc = await col.findOne({ _id: 'main' });
    return normalizeState(doc?.data || INITIAL_STATE);
  }
  try {
    return normalizeState(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch {
    return normalizeState(INITIAL_STATE);
  }
}

async function writeState(body) {
  const normalized = normalizeState(body);
  if (useMongo) {
    const col = mongoDb.collection('state');
    await col.updateOne({ _id: 'main' }, { $set: { data: normalized, updatedAt: new Date() } }, { upsert: true });
    return;
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(normalized, null, 2));
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/state', async (req, res) => {
  try {
    const data = await readState();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * 古いタブの全件保存で、別端末の新規依頼が消えないようにマージする。
 * - 同じ id はクライアント側の内容を優先（割当・完了・削除など）
 * - クライアントが知らない「新しい id」（id >= client.nextId）はサーバー側を残す
 */
function mergeIncomingState(current, incomingRaw) {
  const currentState = normalizeState(current);
  const incoming = normalizeState(incomingRaw);
  const incomingIds = new Set(
    incoming.requests
      .map((r) => Number.parseInt(r?.id, 10))
      .filter((id) => Number.isFinite(id) && id >= 1)
  );
  const clientNextId = Number.parseInt(incoming.nextId, 10);
  const preserveFrom = Number.isFinite(clientNextId) && clientNextId >= 1 ? clientNextId : 1;

  const preserved = currentState.requests.filter((r) => {
    const id = Number.parseInt(r?.id, 10);
    if (!Number.isFinite(id) || id < 1) return false;
    if (incomingIds.has(id)) return false;
    return id >= preserveFrom;
  });

  const mergedRequests = [...incoming.requests, ...preserved];
  const maxId = mergedRequests.reduce((max, r) => {
    const n = Number.parseInt(r?.id, 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);

  return normalizeState({
    ...incoming,
    requests: mergedRequests,
    nextId: Math.max(
      Number.parseInt(currentState.nextId, 10) || 1,
      Number.parseInt(incoming.nextId, 10) || 1,
      maxId + 1
    ),
  });
}

app.post('/api/state', async (req, res) => {
  try {
    let merged = null;
    await enqueueMutation(async () => {
      const current = await readState();
      merged = mergeIncomingState(current, req.body);
      await writeState(merged);
    });
    res.json({ ok: true, state: merged });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** 新規依頼のみサーバー側で追加（同時申請で他者の依頼が消えない） */
app.post('/api/requests', async (req, res) => {
  try {
    const b = req.body || {};
    let created = null;
    await enqueueMutation(async () => {
      const s = await readState();
      const maxExistingId = s.requests.reduce((max, r) => {
        const n = Number.parseInt(r?.id, 10);
        return Number.isFinite(n) && n > max ? n : max;
      }, 0);
      const id = Math.max(Number.parseInt(s.nextId, 10) || 1, maxExistingId + 1);
      s.nextId = id + 1;
      const newReq = {
        id,
        requester: String(b.requester || '').trim(),
        passengers: parseInt(b.passengers, 10) || 1,
        pickupDt: b.pickupDt,
        returnDt: b.returnDt || '',
        from: String(b.from || '').trim(),
        to: String(b.to || '').trim(),
        notes: String(b.notes || '').trim(),
        status: '申請中',
        vehicle: '',
        driver: '',
        createdAt: b.createdAt || new Date().toISOString(),
        scheduleMemo: '',
      };
      created = newReq;
      s.requests.unshift(newReq);
      await writeState(s);
    });
    const data = await readState();
    if (created && DISCORD_WEBHOOK_URL) {
      void notifyDiscordNewRequest(created).catch((err) =>
        console.warn('[Discord webhook]', err.message || err)
      );
    }
    res.json({ ok: true, state: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function start() {
  if (MONGODB_URI) {
    await initMongo();
  } else {
    initFileStorage();
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('\n========================================');
    console.log('  配車管理システム 起動中');
    console.log('========================================');
    console.log(`  このPCだけ: http://localhost:${PORT}`);
    console.log('');
    console.log('  ▼ スタッフに送るURL（localhost では開けません）');
    console.log('  ▼ Staff: do NOT use localhost on your PC');

    const nets = os.networkInterfaces();
    let hasLan = false;
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`     http://${net.address}:${PORT}`);
          hasLan = true;
        }
      }
    }
    if (!hasLan) {
      console.log('     （Wi-Fi/LAN に接続すると IP が表示されます）');
    }
    if (process.env.RENDER_EXTERNAL_URL) {
      console.log(`  クラウド: ${process.env.RENDER_EXTERNAL_URL}`);
    }
    if (DISCORD_WEBHOOK_URL) {
      console.log('  Discord: 新規依頼時に Webhook 通知を送ります');
    }
    console.log('========================================\n');
  });

  const shutdown = async () => {
    server.close();
    if (mongoClient) await mongoClient.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((e) => {
  console.error(e);
  process.exit(1);
});
