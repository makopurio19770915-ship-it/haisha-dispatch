const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const MONGODB_URI = process.env.MONGODB_URI;
/** 工場ごとにデータを分けるDB名（未設定時は従来どおり dispatch_app） */
const MONGODB_DB = (process.env.MONGODB_DB || 'dispatch_app').trim() || 'dispatch_app';
/** 画面タイトル用の工場ラベル（例: AHHP）。未設定なら表示しない */
const FACTORY_LABEL = (process.env.FACTORY_LABEL || '').trim();
/** 配車担当者の共通パスワード（時間変更用）。未設定なら時間変更APIは使えない */
const DISPATCHER_PIN = (process.env.DISPATCHER_PIN || '').trim();
const FACTORY_DISPLAY_NAME = FACTORY_LABEL || 'AHVN';

const INITIAL_STATE = {
  requests: [],
  vehicles: [],
  drivers: [],
  places: [],
  nextId: 1,
  scheduleExcelMemos: {},
  /** 同じ日・同じ車両のカード表示順。キーは「日付||車両」、値は依頼番号の配列。依頼の中身とは別 */
  scheduleOrders: {},
  /** その並び順をいつ保存したか。古い通信が新しい並びを上書きしないために使う */
  scheduleOrderRev: {},
};

/** 廃車済み。マスタへ戻さない（画面の列からも外す） */
const RETIRED_VEHICLES = new Set(['BUS 61LD.02599']);

const DISCORD_WEBHOOK_URL = (process.env.DISCORD_WEBHOOK_URL || '').trim();

/**
 * 状態データを安全な形に整える（ID重複・nextId逆行を防ぐ）
 */
function normalizeState(input) {
  const merged = { ...INITIAL_STATE, ...(input || {}) };

  merged.requests = Array.isArray(merged.requests) ? merged.requests : [];
  merged.vehicles = (Array.isArray(merged.vehicles) ? merged.vehicles : []).filter(
    (v) => !RETIRED_VEHICLES.has(v)
  );
  merged.drivers = Array.isArray(merged.drivers) ? merged.drivers : [];
  merged.places = Array.isArray(merged.places) ? merged.places : [];
  merged.scheduleExcelMemos =
    merged.scheduleExcelMemos && typeof merged.scheduleExcelMemos === 'object'
      ? merged.scheduleExcelMemos
      : {};
  merged.scheduleOrders = sanitizeScheduleOrders(merged.scheduleOrders);
  merged.scheduleOrderRev = sanitizeScheduleOrderRev(merged.scheduleOrderRev);

  const usedIds = new Set();
  let maxId = 0;
  let nextId = Number.parseInt(merged.nextId, 10);
  if (!Number.isFinite(nextId) || nextId < 1) nextId = 1;

  merged.requests = merged.requests.map((req) => {
    const normalizedReq = { ...(req || {}) };
    normalizedReq.timeChangeHistory = normalizeTimeChangeHistory(normalizedReq.timeChangeHistory);
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

function sanitizeOrderIds(ids) {
  if (!Array.isArray(ids)) return [];
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    const n = Number.parseInt(id, 10);
    if (!Number.isFinite(n) || n < 1 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= 300) break;
  }
  return out;
}

function sanitizeScheduleOrders(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of Object.keys(raw)) {
    if (typeof key !== 'string' || !key || key.length > 400 || /[\0\n\r]/.test(key)) continue;
    const ids = sanitizeOrderIds(raw[key]);
    if (ids.length) out[key] = ids;
  }
  return out;
}

function sanitizeScheduleOrderRev(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const key of Object.keys(raw)) {
    if (typeof key !== 'string' || !key || key.length > 400 || /[\0\n\r]/.test(key)) continue;
    const n = Number(raw[key]);
    if (!Number.isFinite(n) || n < 0) continue;
    out[key] = n;
  }
  return out;
}

function normalizeTimeChangeHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || '').trim();
    if (!id || id.length > 80 || seen.has(id)) continue;
    seen.add(id);
    const before = item.before && typeof item.before === 'object' ? item.before : {};
    const after = item.after && typeof item.after === 'object' ? item.after : {};
    const discord = item.discord && typeof item.discord === 'object' ? item.discord : {};
    const status = discord.status === 'sent' || discord.status === 'failed' ? discord.status : 'failed';
    out.push({
      id,
      changedAt: String(item.changedAt || ''),
      changedBy: clipText(item.changedBy, 80),
      reason: clipText(item.reason, 500),
      before: {
        pickupDt: before.pickupDt || '',
        returnDt: before.returnDt || '',
      },
      after: {
        pickupDt: after.pickupDt || '',
        returnDt: after.returnDt || '',
      },
      discord: {
        status,
        notifiedAt: discord.notifiedAt ? String(discord.notifiedAt) : '',
        error: discord.error ? clipText(discord.error, 300) : '',
        attemptId: discord.attemptId ? String(discord.attemptId).slice(0, 80) : '',
      },
    });
    if (out.length >= 100) break;
  }
  return out;
}

/** 一括保存で履歴が消えないよう、サーバー側の時間変更履歴を優先して合成する */
function mergeTimeChangeHistory(serverHist, clientHist) {
  const byId = new Map();
  for (const h of normalizeTimeChangeHistory(serverHist)) byId.set(h.id, h);
  for (const h of normalizeTimeChangeHistory(clientHist)) {
    const existing = byId.get(h.id);
    if (!existing) {
      byId.set(h.id, h);
      continue;
    }
    // サーバーが sent 済みならクライアントの failed で上書きしない
    if (existing.discord.status === 'sent') continue;
    if (h.discord.status === 'sent') byId.set(h.id, h);
  }
  return [...byId.values()].sort((a, b) => String(a.changedAt).localeCompare(String(b.changedAt)));
}

function pinMatches(inputPin) {
  if (!DISPATCHER_PIN) return false;
  const a = Buffer.from(String(inputPin || ''), 'utf8');
  const b = Buffer.from(DISPATCHER_PIN, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return require('crypto').timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function requireDispatcherAuth(body) {
  if (!DISPATCHER_PIN) {
    const err = new Error('時間変更機能は未設定です（DISPATCHER_PIN）');
    err.status = 503;
    throw err;
  }
  if (!pinMatches(body?.pin)) {
    const err = new Error('パスワードが違います');
    err.status = 403;
    throw err;
  }
  const changedBy = String(body?.changedBy || '').trim();
  if (!changedBy) {
    const err = new Error('変更担当者名を入力してください');
    err.status = 400;
    throw err;
  }
  return changedBy;
}

function formatDtJa(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ja-JP', { dateStyle: 'long', timeStyle: 'short' });
  } catch {
    return String(iso);
  }
}

function formatRangeJa(pickupDt, returnDt) {
  const a = formatDtJa(pickupDt);
  const b = returnDt ? formatDtJa(returnDt) : '—';
  return `${a}〜${b}`;
}

function newHistoryId() {
  return `tch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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
      username: FACTORY_LABEL ? `配車管理（${FACTORY_LABEL}）` : '配車管理',
      embeds: [embed],
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status} ${txt.slice(0, 300)}`);
  }
}

/** 時間変更を Discord チャンネルへ通知 */
async function notifyDiscordTimeChange(req, history) {
  if (!DISCORD_WEBHOOK_URL || !req || !history) return;

  const embed = {
    title: `配車依頼 #${req.id} 時間変更のお知らせ`,
    color: 0xd97706,
    fields: [
      { name: '工場', value: FACTORY_DISPLAY_NAME, inline: true },
      { name: '申請者', value: clipText(req.requester, 200), inline: true },
      { name: '変更担当者', value: clipText(history.changedBy, 80), inline: true },
      {
        name: '変更前',
        value: clipText(formatRangeJa(history.before?.pickupDt, history.before?.returnDt), 300),
        inline: false,
      },
      {
        name: '変更後',
        value: clipText(formatRangeJa(history.after?.pickupDt, history.after?.returnDt), 300),
        inline: false,
      },
      { name: '変更理由', value: clipText(history.reason, 500), inline: false },
    ],
    timestamp: new Date().toISOString(),
  };

  const r = await fetch(DISCORD_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: FACTORY_LABEL ? `配車管理（${FACTORY_LABEL}）` : '配車管理',
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
  mongoDb = mongoClient.db(MONGODB_DB);
  const col = mongoDb.collection('state');
  const doc = await col.findOne({ _id: 'main' });
  if (!doc) {
    await col.insertOne({ _id: 'main', data: INITIAL_STATE });
  }
  useMongo = true;
  console.log(`  保存先: MongoDB Atlas（クラウド永続 / DB: ${MONGODB_DB}）`);
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

/** 工場ラベルなど、画面表示用の設定を返す */
app.get('/api/config', (req, res) => {
  res.json({
    factoryLabel: FACTORY_LABEL || null,
    factoryDisplayName: FACTORY_DISPLAY_NAME,
    timeChangeEnabled: Boolean(DISPATCHER_PIN),
  });
});

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

  const currentById = new Map(
    currentState.requests
      .filter((r) => Number.isFinite(r?.id))
      .map((r) => [r.id, r])
  );
  const mergedRequests = [...incoming.requests, ...preserved].map((r) => {
    const id = Number.parseInt(r?.id, 10);
    if (!Number.isFinite(id)) return r;
    const serverReq = currentById.get(id);
    if (!serverReq) return r;
    return {
      ...r,
      timeChangeHistory: mergeTimeChangeHistory(serverReq.timeChangeHistory, r.timeChangeHistory),
    };
  });
  const maxId = mergedRequests.reduce((max, r) => {
    const n = Number.parseInt(r?.id, 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0);

  return normalizeState({
    ...incoming,
    requests: mergedRequests,
    // 並び順は専用APIだけが書く。依頼の一括保存で消したり、中身を書き換えたりしない
    scheduleOrders: currentState.scheduleOrders,
    scheduleOrderRev: currentState.scheduleOrderRev,
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

/**
 * 同じ日・同じ車両の表示順だけを保存する。
 * 依頼の本文・番号・ステータスは触らない。古い並びの通信は無視する。
 */
app.post('/api/schedule-order', async (req, res) => {
  try {
    const groupKey = String((req.body || {}).groupKey || '');
    if (!groupKey || groupKey.length > 400 || /[\0\n\r]/.test(groupKey)) {
      return res.status(400).json({ error: 'bad group' });
    }
    const ids = sanitizeOrderIds((req.body || {}).ids);
    const rev = Number((req.body || {}).rev);
    if (!Number.isFinite(rev)) return res.status(400).json({ error: 'bad rev' });

    let saved = null;
    await enqueueMutation(async () => {
      const s = await readState();
      const currentRev = Number(s.scheduleOrderRev[groupKey]) || 0;
      if (rev < currentRev) {
        saved = s;
        return;
      }
      if (ids.length) s.scheduleOrders[groupKey] = ids;
      else delete s.scheduleOrders[groupKey];
      s.scheduleOrderRev[groupKey] = rev;
      await writeState(s);
      saved = await readState();
    });
    res.json({
      ok: true,
      scheduleOrders: saved.scheduleOrders,
      scheduleOrderRev: saved.scheduleOrderRev,
    });
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
        timeChangeHistory: [],
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

/**
 * 配車担当者による時間変更（迎え・帰着のみ）。
 * 割当・ステータス・その他項目は維持。履歴を残し Discord へ通知する。
 */
app.post('/api/requests/:id/time-change', async (req, res) => {
  try {
    const changedBy = requireDispatcherAuth(req.body || {});
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id < 1) {
      return res.status(400).json({ error: '不正な依頼番号です' });
    }
    const pickupDt = String((req.body || {}).pickupDt || '').trim();
    const returnDt = String((req.body || {}).returnDt || '').trim();
    const reason = String((req.body || {}).reason || '').trim();
    if (!pickupDt) return res.status(400).json({ error: '迎え日時を入力してください' });
    if (!reason) return res.status(400).json({ error: '変更理由を入力してください' });
    if (returnDt && returnDt <= pickupDt) {
      return res.status(400).json({ error: '帰着予定は迎え日時より後にしてください' });
    }

    let historyEntry = null;
    let updatedReq = null;
    await enqueueMutation(async () => {
      const s = await readState();
      const reqItem = s.requests.find((r) => r.id === id);
      if (!reqItem) {
        const err = new Error('依頼が見つかりません');
        err.status = 404;
        throw err;
      }
      if (reqItem.status === 'キャンセル') {
        const err = new Error('キャンセル済みの依頼は変更できません');
        err.status = 400;
        throw err;
      }

      const before = {
        pickupDt: reqItem.pickupDt || '',
        returnDt: reqItem.returnDt || '',
      };
      reqItem.pickupDt = pickupDt;
      reqItem.returnDt = returnDt;
      historyEntry = {
        id: newHistoryId(),
        changedAt: new Date().toISOString(),
        changedBy,
        reason,
        before,
        after: { pickupDt, returnDt },
        discord: {
          status: 'failed',
          notifiedAt: '',
          error: '',
          attemptId: '',
        },
      };
      if (!Array.isArray(reqItem.timeChangeHistory)) reqItem.timeChangeHistory = [];
      reqItem.timeChangeHistory.push(historyEntry);
      updatedReq = reqItem;
      await writeState(s);
    });

    let discordStatus = 'failed';
    let discordError = '';
    if (DISCORD_WEBHOOK_URL) {
      try {
        await notifyDiscordTimeChange(updatedReq, historyEntry);
        discordStatus = 'sent';
      } catch (err) {
        discordError = err.message || String(err);
        console.warn('[Discord time-change]', discordError);
      }
    } else {
      discordError = 'DISCORD_WEBHOOK_URL 未設定';
    }

    await enqueueMutation(async () => {
      const s = await readState();
      const reqItem = s.requests.find((r) => r.id === id);
      if (!reqItem || !Array.isArray(reqItem.timeChangeHistory)) return;
      const hist = reqItem.timeChangeHistory.find((h) => h.id === historyEntry.id);
      if (!hist) return;
      hist.discord = {
        status: discordStatus,
        notifiedAt: discordStatus === 'sent' ? new Date().toISOString() : '',
        error: discordStatus === 'sent' ? '' : clipText(discordError, 300),
        attemptId: historyEntry.id,
      };
      await writeState(s);
    });

    const data = await readState();
    res.json({
      ok: true,
      state: data,
      discord: { status: discordStatus, error: discordError || null },
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/** Discord 通知の再送（sent 済みは重複防止のため拒否） */
app.post('/api/requests/:id/time-change/:historyId/resend-discord', async (req, res) => {
  try {
    requireDispatcherAuth(req.body || {});
    const id = Number.parseInt(req.params.id, 10);
    const historyId = String(req.params.historyId || '').trim();
    if (!Number.isFinite(id) || id < 1 || !historyId) {
      return res.status(400).json({ error: '不正な指定です' });
    }

    let targetReq = null;
    let targetHist = null;
    await enqueueMutation(async () => {
      const s = await readState();
      const reqItem = s.requests.find((r) => r.id === id);
      if (!reqItem) {
        const err = new Error('依頼が見つかりません');
        err.status = 404;
        throw err;
      }
      const hist = (reqItem.timeChangeHistory || []).find((h) => h.id === historyId);
      if (!hist) {
        const err = new Error('変更履歴が見つかりません');
        err.status = 404;
        throw err;
      }
      if (hist.discord?.status === 'sent') {
        const err = new Error('すでに通知済みです（重複防止）');
        err.status = 409;
        throw err;
      }
      targetReq = reqItem;
      targetHist = hist;
    });

    if (!DISCORD_WEBHOOK_URL) {
      return res.status(503).json({ error: 'DISCORD_WEBHOOK_URL が未設定です' });
    }

    try {
      await notifyDiscordTimeChange(targetReq, targetHist);
    } catch (err) {
      await enqueueMutation(async () => {
        const s = await readState();
        const reqItem = s.requests.find((r) => r.id === id);
        const hist = (reqItem?.timeChangeHistory || []).find((h) => h.id === historyId);
        if (hist) {
          hist.discord = {
            status: 'failed',
            notifiedAt: '',
            error: clipText(err.message || String(err), 300),
            attemptId: historyId,
          };
          await writeState(s);
        }
      });
      return res.status(502).json({ error: err.message || 'Discord通知に失敗しました' });
    }

    await enqueueMutation(async () => {
      const s = await readState();
      const reqItem = s.requests.find((r) => r.id === id);
      const hist = (reqItem?.timeChangeHistory || []).find((h) => h.id === historyId);
      if (hist) {
        hist.discord = {
          status: 'sent',
          notifiedAt: new Date().toISOString(),
          error: '',
          attemptId: historyId,
        };
        await writeState(s);
      }
    });

    const data = await readState();
    res.json({ ok: true, state: data, discord: { status: 'sent' } });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/** 保存データに廃車車両が残っていれば、起動時にマスタから外して書き戻す */
async function persistRetiredVehicleRemoval() {
  if (useMongo) {
    const doc = await mongoDb.collection('state').findOne({ _id: 'main' });
    const vehicles = doc?.data?.vehicles || [];
    if (!vehicles.some((v) => RETIRED_VEHICLES.has(v))) return;
    await writeState(doc.data || INITIAL_STATE);
  } else {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch {
      return;
    }
    const vehicles = raw?.vehicles || [];
    if (!vehicles.some((v) => RETIRED_VEHICLES.has(v))) return;
    await writeState(raw);
  }
  console.log('  廃車のため車両マスタから外しました: BUS 61LD.02599');
}

async function start() {
  if (MONGODB_URI) {
    await initMongo();
  } else {
    initFileStorage();
  }
  await persistRetiredVehicleRemoval();

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log('\n========================================');
    console.log(
      FACTORY_LABEL ? `  配車管理システム（${FACTORY_LABEL}）起動中` : '  配車管理システム 起動中'
    );
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
    if (FACTORY_LABEL) {
      console.log(`  工場ラベル: ${FACTORY_LABEL}`);
    }
    if (DISCORD_WEBHOOK_URL) {
      console.log('  Discord: 新規依頼・時間変更時に Webhook 通知を送ります');
    }
    if (DISPATCHER_PIN) {
      console.log('  時間変更: DISPATCHER_PIN 設定済み（担当者パスワード必須）');
    } else {
      console.log('  時間変更: DISPATCHER_PIN 未設定のため無効');
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
