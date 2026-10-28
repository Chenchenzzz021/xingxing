// Shared leaderboards for Xingxing, stored in Upstash Redis (Vercel Storage → Upstash for Redis).
// GET  /api/scores?board=zh|en|hsk1..hsk6|en1..en3&me=<playerId> → { top:[{id,name,score,t}], me:{rank,score}|null }
// GET  /api/scores?gold=zh|en&me=<playerId>                       → { week, lang, top:[{id,name,score,n,t}], me, honors:{week,top}, other }
//      (zh = HSK golden board, scores /300, pass 180; en = TOEIC golden board, scores /990, pass 600)
// POST /api/scores {id,name,level,mode,score}                     → { rankLang, rankLevel, total, best }
// POST /api/scores {action:'rename',id,name}                      → { ok }
// POST /api/scores {action:'exam',id,name,exam,score}             → { ok, dup, lang, avg, n, rank } (exam '<week>-hsk3-0' or '<week>-en2-1')
// POST /api/scores {action:'claim',id,lang}                       → { ok, lang, rank, gems, week } (last week's top 3 of that board, once)
// GET  /api/scores?device=<fp>                                   → { id, name } | {} (account already tied to this device)
// POST /api/scores {action:'device',id,fp}                        → { id, name } (the device's one account)
// `t` is the player's best title rank (1-3) from last week's two golden boards.
// One device = one account: the device key is a hash of the game's device fingerprint and the caller's IP.

const crypto = require('crypto');

// Names against Vietnamese fine customs (thuần phong mỹ tục): vulgar and sexual words, insults, leaders' names.
// BAD_SUB is matched inside the name with diacritics, spaces and punctuation removed ("Đ.ị.t", "d i t m e", "ditttme").
// BAD_TOK is matched as a whole word with diacritics kept, so "đĩ" is caught but "Đi", "Đàm" or "Các" are not.
const BAD_SUB=['dmc','dml','dmvl','dcmm','dmay','ditme','ditmia','ditcu','ditbo','ditnhau','dmm','dcm','dkm','dkmm','dmcs','cmnr','vcl','vkl','vailon','lonme','concac','cucac','caicac','daubuoi','duongvat','memay','chomay','occho','occac','sucvat','thangngu','conngu','dongu','dodiem','didiem','phodi','gaigoi','thangcho','hiepdam','loanluan','khieudam','damduc','fuck','fuk','shit','bitch','pussy','cunt','nigg','porn','hentai','asshole','bastard','motherf','dick','penis','vagina','xxx','sex','hochiminh','nguyenphutrong','phandong'];
const BAD_PHRASE=['bác hồ','bac ho','cụ hồ','chủ tịch hồ'];
const BAD_TOK=['địt','đỵt','đĩ','cặc','lồn','buồi','đéo','đụ','dâm','ngu','đm','đcm','đkm','cl','clm','cc','cmm','cmn','vl','vcl','ml','clgt','loz','djt','dit','cac','lon','cak','dm','dcm','vkl'];
function badName(s){
  const low=String(s||'').normalize('NFC').toLowerCase();
  const plain=low.normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/đ/g,'d')
    .replace(/[0@4]/g,m=>({'0':'o','@':'a','4':'a'})[m]).replace(/[1!|]/g,'i').replace(/3/g,'e').replace(/[5$]/g,'s');
  const compact=plain.replace(/[^a-z]/g,''), squeezed=compact.replace(/(.)\1+/g,'$1');
  if(BAD_SUB.some(w=>compact.includes(w)||squeezed.includes(w))) return true;
  const toks=low.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(t=>t.replace(/(.)\1+/gu,'$1'));
  if(toks.some(t=>BAD_TOK.includes(t))) return true;
  const spaced=' '+toks.join(' ')+' ';
  if(BAD_PHRASE.some(p=>spaced.includes(' '+p+' '))) return true;
  // short words typed with gaps, e.g. "đ m" or "c.l"
  const joined=toks.join('');
  return joined.length<=4 && BAD_TOK.includes(joined);
}

const LEVEL_IDS = ['hsk1', 'hsk2', 'hsk3', 'hsk4', 'hsk5', 'hsk6', 'en1', 'en2', 'en3'];
const BOARDS = ['zh', 'en', 'all', ...LEVEL_IDS];
const MODES = ['easy', 'normal', 'hard'];
const MAX_SCORE = 3000; // one round can't reach this (18 chickens x 30 points x 2.6 at HSK 6)
const REWARD = { 1: 100, 2: 60, 3: 40 };
const TOP = 50;

// The Vercel integration may add a custom prefix (e.g. STORAGE_KV_REST_API_URL), so match by suffix.
function envBySuffix(suffixes) {
  for (const suf of suffixes) {
    if (process.env[suf]) return process.env[suf];
    const k = Object.keys(process.env).find((name) => name.endsWith('_' + suf));
    if (k) return process.env[k];
  }
  return '';
}
const URL_ = envBySuffix(['KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL']);
const TOKEN = envBySuffix(['KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN']);

async function redis(cmds) {
  const r = await fetch(URL_.replace(/\/$/, '') + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  const out = await r.json();
  return out.map((x) => {
    if (x.error) throw new Error(x.error);
    return x.result;
  });
}

// Weeks run Monday 00:00 to Sunday 24:00 Vietnam time (UTC+7), counted from Monday 2024-01-01.
// The game uses the same formula to pick the week's exams.
function weekId(ms = Date.now()) {
  const d = new Date(ms + 7 * 3600e3);
  const day = (d.getUTCDay() + 6) % 7;
  const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
  return Math.round((monday - Date.UTC(2024, 0, 1)) / (7 * 864e5));
}

const key = (b) => 'xx:lb:' + b;
// Golden boards are separate: HSK (Chinese) keeps the original keys, TOEIC (English) adds "En".
const sfx = (lang) => (lang === 'en' ? 'En' : '');
const gold = (w, lang = 'zh') => 'xx:gold' + sfx(lang) + ':' + w;
const EXAM = { zh: { max: 300, pass: 180 }, en: { max: 990, pass: 600 } };
const langOf = (q) => (q === 'en' ? 'en' : 'zh');
const validId = (s) => typeof s === 'string' && /^[a-z0-9]{6,32}$/.test(s);
const cleanName = (s) =>
  String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
// Names containing "Chen" / "Chiến" (any spacing, accents, symbols or look-alike digits) belong to the
// game's owner only. The owner proves it once per device with the owner code; only its hash lives here.
const OWNER_HASH = 'ece32034ac4abbdbbd30902d82594eec406d7ff607868a0fc295e8e59602949f';
function reservedName(s) {
  const k = String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd')
    .replace(/[0@4]/g, (m) => ({ 0: 'o', '@': 'a', 4: 'a' })[m]).replace(/[1!|j]/g, 'i').replace(/3/g, 'e')
    .replace(/[^a-z]/g, '').replace(/(.)\1+/g, '$1');
  return k.includes('chen') || k.includes('chien');
}
let OWNERS = new Set();
const shown = (n, id) => (n && (badName(n) || (reservedName(n) && !OWNERS.has(id))) ? 'Người chơi' : n || '');
const devKey = (req, fp) => {
  const ip = String(req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  return 'xx:dev:' + crypto.createHash('sha256').update(String(fp).slice(0, 64) + '|' + ip).digest('hex').slice(0, 32);
};
const validFp = (s) => typeof s === 'string' && /^[0-9a-z]{6,64}$/.test(s);
const num = (x) => Math.round(Number(x) * 10) / 10;

function pairs(flat) {
  const ids = [];
  const scores = [];
  for (let i = 0; i < flat.length; i += 2) {
    ids.push(flat[i]);
    scores.push(Number(flat[i + 1]));
  }
  return { ids, scores };
}

// Last week's golden board top 3: they hold the titles this week.
async function honors(week, lang = 'zh') {
  const [flat] = await redis([['ZRANGE', gold(week - 1, lang), '0', '2', 'REV', 'WITHSCORES']]);
  const { ids, scores } = pairs(flat);
  const names = ids.length ? (await redis([['HMGET', 'xx:names', ...ids]]))[0] : [];
  return { week: week - 1, lang, top: ids.map((id, i) => ({ id, name: shown(names[i], id), score: num(scores[i]), rank: i + 1 })) };
}
// A player on both boards shows their better title
function titleMap(...hs) {
  const t = {};
  for (const h of hs) for (const r of h.top) t[r.id] = Math.min(t[r.id] || 9, r.rank);
  return t;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_ || !TOKEN) return res.status(503).json({ error: 'leaderboard database not connected' });
  const week = weekId();
  try {
    OWNERS = new Set((await redis([['SMEMBERS', 'xx:owners']]))[0] || []);
  } catch (e) {
    OWNERS = new Set();
  }

  try {
    if (req.method === 'GET' && req.query.device) {
      if (!validFp(req.query.device)) return res.status(400).json({ error: 'bad request' });
      const [id] = await redis([['GET', devKey(req, req.query.device)]]);
      if (!id) return res.status(200).json({});
      const [name] = await redis([['HGET', 'xx:names', id]]);
      return res.status(200).json({ id, name: shown(name, id) });
    }

    if (req.method === 'GET') {
      const me = validId(req.query.me) ? req.query.me : null;
      const hz = await honors(week, 'zh');
      const he = await honors(week, 'en');
      const titles = titleMap(hz, he);

      if (req.query.gold) {
        // gold=1|zh → HSK board, gold=en → TOEIC board
        const lang = langOf(req.query.gold);
        const h = lang === 'en' ? he : hz;
        const cnt_ = 'xx:gcnt' + sfx(lang) + ':' + week;
        const cmds = [['ZRANGE', gold(week, lang), '0', String(TOP - 1), 'REV', 'WITHSCORES']];
        if (me) cmds.push(['ZREVRANK', gold(week, lang), me], ['ZSCORE', gold(week, lang), me], ['HGET', cnt_, me]);
        const [flat, rank, score, cnt] = await redis(cmds);
        const { ids, scores } = pairs(flat);
        const [names, counts] = ids.length
          ? await redis([['HMGET', 'xx:names', ...ids], ['HMGET', cnt_, ...ids]])
          : [[], []];
        const top = ids.map((id, i) => ({ id, name: shown(names[i], id), score: num(scores[i]), n: Number(counts[i] || 0), t: titles[id] || 0 }));
        const meOut = me && rank !== null && rank !== undefined ? { rank: rank + 1, score: num(score), n: Number(cnt || 0) } : null;
        return res.status(200).json({ week, lang, top, me: meOut, honors: h, other: lang === 'en' ? hz : he });
      }

      const board = BOARDS.includes(req.query.board) ? req.query.board : 'zh';
      const cmds = [['ZRANGE', key(board), '0', String(TOP - 1), 'REV', 'WITHSCORES']];
      if (me) cmds.push(['ZREVRANK', key(board), me], ['ZSCORE', key(board), me]);
      const [flat, rank, score] = await redis(cmds);
      const { ids, scores } = pairs(flat);
      const names = ids.length ? (await redis([['HMGET', 'xx:names', ...ids]]))[0] : [];
      const top = ids.map((id, i) => ({ id, name: shown(names[i], id), score: Math.round(scores[i]), t: titles[id] || 0 }));
      const meOut = me && rank !== null && rank !== undefined ? { rank: rank + 1, score: Math.round(Number(score)) } : null;
      return res.status(200).json({ board, top, me: meOut, honors: hz, other: he });
    }

    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      const name = cleanName(b.name);
      if (name && badName(name)) return res.status(400).json({ error: 'bad name' });

      if (b.action === 'owner') {
        const ok = validId(b.id) && crypto.createHash('sha256').update(String(b.code || '').trim().toUpperCase()).digest('hex') === OWNER_HASH;
        if (ok) {
          await redis([['SADD', 'xx:owners', b.id]]);
          OWNERS.add(b.id);
        }
        return res.status(ok ? 200 : 403).json({ ok });
      }
      if (name && reservedName(name) && !OWNERS.has(b.id)) return res.status(400).json({ error: 'reserved name' });

      if (b.action === 'device') {
        if (!validId(b.id) || !validFp(b.fp)) return res.status(400).json({ error: 'bad request' });
        const k = devKey(req, b.fp);
        const [, id] = await redis([['SET', k, b.id, 'NX'], ['GET', k]]);
        if (id === b.id && name) await redis([['HSETNX', 'xx:names', id, name]]);
        const [nm] = await redis([['HGET', 'xx:names', id]]);
        return res.status(200).json({ id, name: shown(nm, id) });
      }

      if (b.action === 'rename') {
        if (!validId(b.id) || !name) return res.status(400).json({ error: 'bad request' });
        const [known] = await redis([['HEXISTS', 'xx:names', b.id]]);
        if (known) await redis([['HSET', 'xx:names', b.id, name]]);
        return res.status(200).json({ ok: true });
      }

      if (b.action === 'exam') {
        // exam id = "<week>-<level>-<n>"; this week's or last week's (a test finished just after midnight Sunday)
        const m = /^(\d{1,5})-(hsk[1-6]|en[1-3])-([0-2])$/.exec(String(b.exam || ''));
        const lang = m && m[2].startsWith('en') ? 'en' : 'zh';
        const sx = sfx(lang);
        const score = Math.floor(Number(b.score));
        if (!validId(b.id) || !name || !m || !(score >= 0 && score <= EXAM[lang].max)) return res.status(400).json({ error: 'bad request' });
        const w = Number(m[1]);
        if (w !== week && w !== week - 1) return res.status(400).json({ error: 'old exam' });
        const [fresh] = await redis([['HSETNX', 'xx:exams:' + b.id, b.exam, String(score)]]);
        await redis([['HSET', 'xx:names', b.id, name]]);
        if (!fresh) return res.status(200).json({ ok: true, dup: true });
        const cmds = [
          ['HINCRBY', 'xx:gsum' + sx + ':' + w, b.id, String(score)],
          ['HINCRBY', 'xx:gcnt' + sx + ':' + w, b.id, '1'],
        ];
        if (score >= EXAM[lang].pass) cmds.push(['SADD', 'xx:gpass' + sx + ':' + w, b.id]);
        cmds.push(['SISMEMBER', 'xx:gpass' + sx + ':' + w, b.id]);
        const out = await redis(cmds);
        const sum = Number(out[0]);
        const n = Number(out[1]);
        const passed = Number(out[out.length - 1]) === 1;
        const avg = Math.round((sum / n) * 10) / 10;
        let rank = null;
        if (passed) {
          const [, r] = await redis([['ZADD', gold(w, lang), String(avg), b.id], ['ZREVRANK', gold(w, lang), b.id]]);
          rank = r + 1;
        }
        return res.status(200).json({ ok: true, lang, avg, n, passed, rank });
      }

      if (b.action === 'claim') {
        if (!validId(b.id)) return res.status(400).json({ error: 'bad request' });
        const lang = langOf(b.lang);
        const h = await honors(week, lang);
        const mine = h.top.find((r) => r.id === b.id);
        if (!mine) return res.status(200).json({ ok: false, lang, week: h.week });
        const [fresh] = await redis([['HSETNX', 'xx:claim' + sfx(lang) + ':' + h.week, b.id, '1']]);
        return res.status(200).json({ ok: !!fresh, lang, rank: mine.rank, gems: REWARD[mine.rank], week: h.week });
      }

      const score = Math.floor(Number(b.score));
      if (!validId(b.id) || !name || !LEVEL_IDS.includes(b.level) || !MODES.includes(b.mode))
        return res.status(400).json({ error: 'bad request' });
      if (!(score > 0 && score <= MAX_SCORE)) return res.status(400).json({ error: 'bad score' });
      const lang = b.level.startsWith('hsk') ? 'zh' : 'en';

      const [, total, , rankLang, rankLevel, best] = await redis([
        ['HSET', 'xx:names', b.id, name],
        ['ZINCRBY', key(lang), String(score), b.id],
        ['ZADD', key(b.level), 'GT', String(score), b.id],
        ['ZREVRANK', key(lang), b.id],
        ['ZREVRANK', key(b.level), b.id],
        ['ZSCORE', key(b.level), b.id],
      ]);
      return res.status(200).json({
        rankLang: rankLang + 1,
        rankAll: rankLang + 1,
        rankLevel: rankLevel + 1,
        total: Math.round(Number(total)),
        best: Math.round(Number(best)),
      });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'server error' });
  }
};
