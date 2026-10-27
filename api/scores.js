// Shared leaderboard for Xingxing, stored in Upstash Redis (Vercel Storage → Upstash for Redis).
// GET  /api/scores?board=all|hsk1..hsk6|en1..en3&me=<playerId>  → { top:[{id,name,score}], me:{rank,score}|null }
// POST /api/scores {id,name,level,mode,score}                    → { rankAll, rankLevel, total, best }

const BOARDS = ['all', 'hsk1', 'hsk2', 'hsk3', 'hsk4', 'hsk5', 'hsk6', 'en1', 'en2', 'en3'];
const MODES = ['easy', 'normal', 'hard'];
const MAX_SCORE = 1000; // one round can't reach this (18 chickens x 30 points max)
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

const key = (b) => 'xx:lb:' + b;
const validId = (s) => typeof s === 'string' && /^[a-z0-9]{6,32}$/.test(s);
const cleanName = (s) =>
  String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_ || !TOKEN) return res.status(503).json({ error: 'leaderboard database not connected' });

  try {
    if (req.method === 'GET') {
      const board = BOARDS.includes(req.query.board) ? req.query.board : 'all';
      const me = validId(req.query.me) ? req.query.me : null;
      const cmds = [['ZRANGE', key(board), '0', String(TOP - 1), 'REV', 'WITHSCORES']];
      if (me) cmds.push(['ZREVRANK', key(board), me], ['ZSCORE', key(board), me]);
      const [flat, rank, score] = await redis(cmds);
      const ids = [];
      const scores = [];
      for (let i = 0; i < flat.length; i += 2) {
        ids.push(flat[i]);
        scores.push(Math.round(Number(flat[i + 1])));
      }
      const names = ids.length ? (await redis([['HMGET', 'xx:names', ...ids]]))[0] : [];
      const top = ids.map((id, i) => ({ id, name: names[i] || '', score: scores[i] }));
      const meOut = me && rank !== null && rank !== undefined ? { rank: rank + 1, score: Math.round(Number(score)) } : null;
      return res.status(200).json({ board, top, me: meOut });
    }

    if (req.method === 'POST') {
      const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
      const name = cleanName(b.name);
      const score = Math.floor(Number(b.score));
      if (!validId(b.id) || !name || !BOARDS.includes(b.level) || b.level === 'all' || !MODES.includes(b.mode))
        return res.status(400).json({ error: 'bad request' });
      if (!(score > 0 && score <= MAX_SCORE)) return res.status(400).json({ error: 'bad score' });

      const [, total, , rankAll, rankLevel, best] = await redis([
        ['HSET', 'xx:names', b.id, name],
        ['ZINCRBY', key('all'), String(score), b.id],
        ['ZADD', key(b.level), 'GT', String(score), b.id],
        ['ZREVRANK', key('all'), b.id],
        ['ZREVRANK', key(b.level), b.id],
        ['ZSCORE', key(b.level), b.id],
      ]);
      return res.status(200).json({
        rankAll: rankAll + 1,
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
