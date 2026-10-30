// ==UserScript==
// @name         The White Castle – Live Score
// @name:zh-CN   姬路城 实时计分
// @namespace    https://github.com/Dark-Outlaws/thewhitecastle-scorer
// @version      5.4
// @description  九项终局预估分，一列一位玩家，界面仿官方结算表
// @description:zh-CN 在 BGA 姬路城对局中实时显示九项终局预估分
// @author       Dark-Outlaws
// @homepage     https://github.com/Dark-Outlaws/thewhitecastle-scorer
// @supportURL   https://github.com/Dark-Outlaws/thewhitecastle-scorer/issues
// @updateURL    https://raw.githubusercontent.com/Dark-Outlaws/thewhitecastle-scorer/main/thewhitecastle-scorer.user.js
// @downloadURL  https://raw.githubusercontent.com/Dark-Outlaws/thewhitecastle-scorer/main/thewhitecastle-scorer.user.js
// @match        https://*.boardgamearena.com/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const RESPECT_HIDDEN = false;

  const S = { pieces: {}, res: {}, coin: {}, seal: {}, track: {} };
  const pid = x => String(x);
  const SKIP = /^(heron|influence|dice|die|token|lantern)/;
  const esc = s => String(s == null ? '' : s)
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const isHidden = gd => RESPECT_HIDDEN && gd.liveScoring === false;

  function isThisGame(gui) {
    try {
      const gd = gui && gui.gamedatas;
      return !!(gd && (gd.castleRooms || gd.trainingYards) && gd.players);
    } catch (e) { return false; }
  }

  function gameWindow() {
    if (isThisGame(window.gameui)) return window;
    const fr = document.querySelectorAll('iframe');
    for (let i = 0; i < fr.length; i++) {
      try {
        const w = fr[i].contentWindow;
        if (w && isThisGame(w.gameui)) return w;
      } catch (e) {}
    }
    return null;
  }

  /* 棋子入库的唯一入口：absorb 和 seed 共用，避免两处判断走偏 */
  function putPiece(o) {
    if (o && o.id != null && o.playerId != null && o.location && !SKIP.test(o.type || '')) {
      S.pieces[o.id] = { type: o.type, pid: pid(o.playerId), loc: o.location, arg: o.locationArg };
      return true;
    }
    return false;
  }

  function absorb(o) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(absorb); return; }

    putPiece(o);
    if (o.playerId != null) {
      const p = pid(o.playerId);
      if (o.resource && o.resourceValue != null)
        (S.res[p] = S.res[p] || {})[o.resource] = Number(o.resourceValue);
      if (o.numberOfCoins != null && o.coinValue != null) S.coin[p] = Number(o.coinValue);
      if (o.numberOfSeals != null && o.sealValue != null) S.seal[p] = Number(o.sealValue);
      if (Array.isArray(o.influenceMarkers)) o.influenceMarkers.forEach(m => {
        if (m.playerId != null && m.location) S.track[pid(m.playerId)] = m.location;
      });
    }
    Object.keys(o).forEach(k => { if (o[k] && typeof o[k] === 'object') absorb(o[k]); });
  }

  function seed(gd) {
    const put = arr => (arr || []).forEach(putPiece);

    (gd.castleRooms || []).forEach(r => put(r.courtiers));
    put(gd.daimyoCard && gd.daimyoCard.courtiers);
    ((gd.matcha && gd.matcha.geishaLocations) || []).forEach(g => put(g.geishas));
    (gd.trainingYards || []).forEach(y => put(y.warriors));
    (gd.gardenCards || []).forEach(c => put(c.gardeners));

    (gd.influenceMarkers || []).forEach(m => {
      if (m.playerId) S.track[pid(m.playerId)] = m.location;
    });

    Object.keys(gd.players || {}).forEach(k => {
      const p = gd.players[k], id = pid(p.id != null ? p.id : k);
      put(p.courtiers); put(p.warriors); put(p.gardeners); put(p.geishas);
      if (p.extra) {
        S.res[id] = {
          food: p.extra.food | 0, iron: p.extra.iron | 0,
          pearl: p.extra.pearl | 0, chasen: p.extra.chasen | 0,
        };
        S.coin[id] = p.extra.coin | 0;
        S.seal[id] = p.extra.seal | 0;
      }
    });
  }

  /* ============================================================
     官方结算表（#twc-scoresheet）→ 读一次存下来
     它是弹窗，关掉 DOM 就没了，所以缓存是必需的。
     放行条件必须同时满足：桌号相同 + 玩家名集合相同。
     桌号读不到就不认缓存——宁可多算一遍，也不展示过期数据。
     ============================================================ */
  function tableKey(doc) {
    try {
      const m = /[?&]table=(\d+)/.exec((doc.location && doc.location.search) || '');
      if (m) return m[1];
    } catch (e) {}
    try {
      const m = /[?&]table=(\d+)/.exec(location.search || '');
      if (m) return m[1];
    } catch (e) {}
    return '';
  }

  function samePlayers(cache, gd) {
    try {
      const a = (cache.names || []).map(n => String(n.name || '').trim()).sort().join('|');
      const b = Object.keys(gd.players || {}).map(k => String(gd.players[k].name || '').trim()).sort().join('|');
      return a !== '' && a === b;
    } catch (e) { return false; }
  }

  const SHEET_KEYS = ['vpDuringTheGame', 'coinsAndSeals', 'food', 'iron', 'pearl',
                      'passageOfTime', 'courtiers', 'warriors', 'gardeners'];

  function parseSheet(sheet, tbl) {
    const thead = sheet.querySelector('thead tr');
    if (!thead) return null;

    const names = Array.prototype.slice.call(thead.querySelectorAll('th')).slice(1).map(th => ({
      name: String(th.textContent || '').trim(),
      color: ((th.getAttribute('style') || '').match(/#[0-9a-f]{6}/i) || [])[0] || null,
    }));
    if (!names.length) return null;

    const data = {};
    Array.prototype.forEach.call(sheet.querySelectorAll('tbody tr'), tr => {
      const type = tr.getAttribute('data-scoring-type');
      if (!type) return;
      const tds = Array.prototype.slice.call(tr.querySelectorAll('td')).slice(1);
      data[type] = tds.map(td => {
        const n = Number(String(td.textContent || '').replace(/[^\d.-]/g, ''));
        return isNaN(n) ? 0 : n;
      });
    });

    if (!data.total) return null;

    /* 自洽校验：总分必须 > 0，九项之和不能超过它 */
    for (let i = 0; i < names.length; i++) {
      let sum = 0;
      SHEET_KEYS.forEach(k => { sum += (data[k] && data[k][i]) || 0; });
      const t = data.total[i] || 0;
      if (t <= 0) return null;
      if (sum > t) return null;
    }

    return { table: tbl || '', names, data, at: Date.now() };
  }

  /* 缓存只放内存，不落盘。
     效果：刷新页面就重算；弹窗关掉仍能继续用。 */
  let sheetCache = null;

  function readScoresheet(doc, gd) {
    const tbl = tableKey(doc);

    let sheet = null;
    try { sheet = doc.getElementById('twc-scoresheet'); } catch (e) {}

    // 1. DOM 里有表：解析并记住
    if (sheet) {
      const parsed = parseSheet(sheet, tbl);
      if (parsed) { sheetCache = parsed; return sheetCache; }
    }

    // 2. 表没了：用内存里的，桌号与玩家都得对得上
    if (sheetCache && tbl && sheetCache.table === tbl && samePlayers(sheetCache, gd)) {
      return sheetCache;
    }
    return null;
  }

  function rowFromSheet(sheet, p, id) {
    const idx = sheet.names.findIndex(n => n.name === String(p.name || '').trim());
    if (idx < 0) return null;
    const g = t => {
      const arr = sheet.data[t];
      return (arr && arr[idx] != null) ? (Number(arr[idx]) | 0) : 0;
    };
    return {
      id, name: p.name, seat: +(p.playerNo || 0),
      color: sheet.names[idx].color ? sheet.names[idx].color.replace('#', '') : String(p.color || '888888'),
      fan:     g('vpDuringTheGame'),
      coins:   g('coinsAndSeals'),
      food:    g('food'),
      iron:    g('iron'),
      pearl:   g('pearl'),
      track:   g('passageOfTime'),
      court:   g('courtiers'),
      warrior: g('warriors'),
      garden:  g('gardeners'),
      total:   g('total'),
      /* 读表路线不走自算，这两项没有过程值 */
      inside:  null,
      wValue:  null,
      fromSheet: true,
    };
  }

  /* ------------------------------------------------------------ */
  function scoreCtrlOf(gui, id) {
    const s = gui.scoreCtrl && gui.scoreCtrl[id];
    if (!s) return null;
    const t = Number(s.target_value);
    if (!isNaN(t)) return t;
    try { const v = Number(s.getValue()); return isNaN(v) ? null : v; } catch (e) { return null; }
  }

  function fanStored(gd, id) {
    const ps = gd.players || {};
    const p = ps[id] || Object.keys(ps).map(k => ps[k]).find(x => String(x.id) === id);
    if (!p) return null;
    const v = Number(p.score);
    return isNaN(v) ? null : v;
  }

  const byId = (list, loc) => loc ? (list || []).find(x => String(x.id) === String(loc)) : null;
  const byArg = (list, arg) => (arg == null) ? null
    : (list || []).find(x => String(x.id) === String(arg)) || null;

  function trackScore(loc) {
    const m = /influence-(\d+)/.exec(loc || '');
    if (!m) return 0;
    const n = +m[1];
    if (n <= 5) return 0;
    if (n <= 10) return 3;
    if (n <= 14) return 6;
    return n - 5;
  }

  const resVP = n => (n >= 7 ? 2 : n >= 3 ? 1 : 0);

  /* 大名卡牌上的家臣，location 是卡牌自己的 id（daimyo-card），
     而房间表里对应的条目是 main-board-daimyo（10 分）。
     不补这层映射，这枚家臣会被当成「位置对不上」而记 0 分。 */
  const ROOM_ALIAS = { 'daimyo-card': 'main-board-daimyo' };

  function compute(gui) {
    const gd = gui.gamedatas;
    const doc = gui.document || document;
    const sheet = readScoresheet(doc, gd);

    const rooms = gd.castleRooms || [];
    const yards = gd.trainingYards || [];
    const cards = gd.gardenCards || [];
    const all = Object.keys(S.pieces).map(k => S.pieces[k]);

    const rows = Object.keys(gd.players || {}).map(key => {
      const p = gd.players[key];
      const id = pid(p.id != null ? p.id : key);

      if (sheet) {
        const r = rowFromSheet(sheet, p, id);
        if (r) { r.cnt = { c: 0, w: 0, g: 0, gei: 0 }; return r; }
      }

      let court = 0, wValue = 0, garden = 0, inside = 0;
      let nC = 0, nW = 0, nG = 0, nGei = 0;

      all.forEach(x => {
        if (x.pid !== id) return;
        const loc = String(x.loc || '');
        const t = String(x.type || '');
        if (t === 'courtier') {
          nC++;
          const r = byId(rooms, ROOM_ALIAS[loc] || loc);
          if (r) {
            court += Number(r.pointValue || 0);
            /* 大名卡牌上的家臣同样计入「城堡内」。
               依据：i say 武士实得 20、插件算出 15，面值和为 5，
               差 5 正好是 inside 少算一人（3 → 4）。 */
            if (r.id !== 'main-board-gate') inside++;
          }
        } else if (t === 'warrior') {
          nW++;
          if (loc === 'yard') {
            const y = byArg(yards, x.arg);
            if (y) wValue += Number(y.pointValue || 0);
          }
        } else if (t === 'gardener') {
          nG++;
          if (loc === 'garden') {
            const c = byArg(cards, x.arg);
            if (c) garden += Number(c.pointValue || 0);
          }
        } else if (t === 'geisha') { nGei++; }
      });

      const res = S.res[id] || {};
      const coins = Math.floor(((S.coin[id] | 0) + (S.seal[id] | 0)) / 5);
      const food  = resVP(res.food | 0);
      const iron  = resVP(res.iron | 0);
      const pearl = resVP(res.pearl | 0);
      const track = trackScore(S.track[id]);
      const warrior = wValue * inside;
      const rest = coins + food + iron + pearl + track + court + warrior + garden;

      const ctrl = scoreCtrlOf(gui, id);
      let fan;
      if (ctrl != null) fan = ctrl;
      else { const s = fanStored(gd, id); fan = s == null ? 0 : s; }

      return {
        id, name: p.name, color: String(p.color || '888888'), seat: +(p.playerNo || 0),
        fan, coins, food, iron, pearl, track, court, warrior, garden,
        total: fan + rest,
        cnt: { c: nC, w: nW, g: nG, gei: nGei },
        /* 武士分的两个乘数，诊断时直接看这两项对不对 */
        inside: inside,
        wValue: wValue,
        fromSheet: false,
      };
    }).sort((a, b) => a.seat - b.seat);

    rows.fromSheet = !!sheet;
    return rows;
  }

  /* ============================================================
     面板
     ============================================================ */

  const ICON_COL = 112;
  const PLAYER_COL = 74;
  const BALL = 52;

  const END_VP = 'vp';

  const RULE_LINE = '*如若平局，回合顺位靠前的玩家获胜';

  const CSS = `
  #twc-live{position:fixed;left:12px;bottom:12px;z-index:99999;
    background:linear-gradient(168deg,#dde7f0 0%,#eef3f8 42%,#e3ebf3 100%);
    border-radius:10px;
    box-shadow:0 10px 30px rgba(0,0,0,.30), 0 1px 0 rgba(255,255,255,.7) inset;
    border:1px solid rgba(120,150,180,.35);
    color:#12141a;
    font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans CJK SC",sans-serif;
    overflow:hidden;user-select:none}

  #twc-live .hd{display:flex;justify-content:space-between;align-items:center;
    padding:7px 10px 6px;cursor:grab;touch-action:none;
    background:linear-gradient(180deg,rgba(255,255,255,.55),rgba(255,255,255,0))}
  #twc-live .hd b{font-weight:600;font-size:11px;letter-spacing:.06em;color:#26303c}
  #twc-live .x{width:16px;height:16px;border-radius:50%;background:#3c4a58;color:#fff;
    font-size:11px;line-height:16px;text-align:center;margin-left:10px;cursor:pointer;
    opacity:.7;flex:none}
  #twc-live .x:hover{opacity:1}

  #twc-live.dragging{opacity:.94;box-shadow:0 14px 38px rgba(0,0,0,.38)}
  #twc-live.dragging .hd{cursor:grabbing}

  #twc-live .tbl{display:grid;align-items:stretch;
    border-top:1px solid rgba(120,150,180,.42)}
  #twc-live .cell{display:flex;align-items:center;justify-content:center;
    padding:5px 4px;font-variant-numeric:tabular-nums;font-size:13px;
    border-bottom:1px solid rgba(120,150,180,.26)}
  #twc-live .cell.v{border-left:1px solid rgba(120,150,180,.26)}

  #twc-live .ic{justify-content:center;gap:3px;padding-left:6px;padding-right:6px}
  #twc-live .ic .twc-icon-art{flex:none;display:inline-block;vertical-align:middle}
  #twc-live .ic .tail{font-size:10px;color:#2f3a48;margin-left:2px}

  #twc-live .hd2{font-size:11.5px;font-weight:600;padding:6px 3px 7px;
    border-bottom:1px solid rgba(120,150,180,.42);
    overflow:hidden;white-space:nowrap;letter-spacing:.01em;
    flex-direction:column;gap:1px}
  #twc-live .hd2 span{overflow:hidden;text-overflow:ellipsis}
  #twc-live .elo{display:block;font-size:10px;font-style:normal;color:#5a6a7a;
    margin-top:1px;letter-spacing:0;font-weight:400}

  #twc-live .num{font-weight:500;color:#12141a}
  #twc-live .num.z{color:#9aa7b4;font-weight:400}

  #twc-live .lab.sum{justify-content:flex-end;padding-right:9px;
    font-size:11.5px;font-weight:700;color:#26303c}
  #twc-live .num.sum{font-size:15px;font-weight:700;color:#12141a}
  #twc-live .cell.sum{background:rgba(255,255,255,.45);
    border-bottom:1px solid rgba(120,150,180,.42)}

  #twc-live .ft{padding:6px 10px 7px;font-size:10px;color:#3a4553;
    line-height:1.6;border-top:1px solid rgba(120,150,180,.32)}
  #twc-live .warn{color:#a8663f}

  #twc-live .hl{padding:20px 14px;text-align:center;font-size:12px;color:#3a4553;line-height:1.6}
  #twc-live .hl em{display:block;font-style:normal;font-size:10.5px;opacity:.8;margin-top:4px}

  #twc-live.collapsed{width:${BALL}px !important;height:${BALL}px;border-radius:50%;
    display:flex;align-items:center;justify-content:center;cursor:pointer}
  #twc-live.collapsed .tbl,
  #twc-live.collapsed .ft,
  #twc-live.collapsed .hd b,
  #twc-live.collapsed .hd .x{display:none}
  #twc-live.collapsed .hd{width:100%;height:100%;padding:0;justify-content:center;
    background:none;border:none;cursor:pointer}
  #twc-live.collapsed .hd::after{
    content:"姬";font-size:21px;font-weight:600;color:#1b2430;letter-spacing:0;line-height:1}
  `;

  const FIELDS = [
    ['fan',     [END_VP],                    ''],
    ['coins',   ['coin', 'seal'],            '/5'],
    ['food',    ['food'],                    ''],
    ['iron',    ['iron'],                    ''],
    ['pearl',   ['pearl'],                   ''],
    ['track',   ['action-passage-of-time'],  ''],
    ['court',   ['action-courtier'],         ''],
    ['warrior', ['action-warrior'],          ''],
    ['garden',  ['action-gardener'],         ''],
  ];

  const iconHTML = types => types.map(t =>
    '<span class="twc-icon-art game-log" data-type="' + t + '"></span>'
  ).join('');

  function panel() {
    let b = document.getElementById('twc-live');
    if (b) return b;

    if (!document.getElementById('twc-live-style')) {
      const s = document.createElement('style');
      s.id = 'twc-live-style';
      s.textContent = CSS;
      (document.head || document.body).appendChild(s);
    }

    b = document.createElement('div');
    b.id = 'twc-live';
    b.innerHTML =
      '<div class="hd"><b>终局计分</b><span class="x" title="折叠">×</span></div>' +
      '<div class="rows"></div><div class="ft"></div>';
    document.body.appendChild(b);

    b.querySelector('.x').addEventListener('click', e => {
      e.stopPropagation();
      setFolded(b, true);
    });
    restorePos(b);
    makeDraggable(b);
    return b;
  }

  /* 游戏界面自己会渲染 ELO：<span id="player_elo_<玩家id>">745</span>。
     一局只读一次：首次读到数字就存住，之后不再查 DOM、也不再更新。
     元素还没渲染时返回 null，下次 tick 再试。 */
  const eloSeen = {};

  function eloOf(id) {
    if (eloSeen[id] != null) return eloSeen[id];
    try {
      const el = document.getElementById('player_elo_' + id);
      if (!el) return null;
      const t = String(el.textContent || '').trim();
      if (!t) return null;
      eloSeen[id] = t;
      return t;
    } catch (e) { return null; }
  }

  function getPos() {
    try { return JSON.parse(localStorage.getItem('twc-pos') || 'null'); } catch (e) { return null; }
  }

  /* 把记住的位置写回元素。setFolded 和 restorePos 共用，避免两份实现走偏。
     返回 true 表示用的是记住的位置。 */
  function applyPos(box) {
    const p = getPos();
    if (p && typeof p.left === 'number') {
      box.style.left = Math.max(0, Math.min(window.innerWidth - 80, p.left)) + 'px';
      box.style.top = Math.max(0, Math.min(window.innerHeight - 40, p.top)) + 'px';
      box.style.bottom = 'auto';
      return true;
    }
    return false;
  }

  function setFolded(box, on) {
    box.classList.toggle('collapsed', on);
    if (on) {
      box.style.left = 'auto';
      box.style.top = 'auto';
      box.style.right = '14px';
      box.style.bottom = '14px';
    } else {
      box.style.right = 'auto';
      if (!applyPos(box)) {
        box.style.left = '12px';
        box.style.top = 'auto';
        box.style.bottom = '12px';
      }
      box.style.width = box.dataset.w || '';
    }
  }

  function restorePos(box) {
    try { applyPos(box); } catch (e) {}
  }

  function savePos(box) {
    try {
      const r = box.getBoundingClientRect();
      localStorage.setItem('twc-pos', JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) }));
    } catch (e) {}
  }

  function makeDraggable(box) {
    const hd = box.querySelector('.hd');
    let drag = null;

    hd.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.classList.contains('x')) return;
      const r = box.getBoundingClientRect();
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.right = 'auto';
      box.style.bottom = 'auto';
      box.classList.add('dragging');
      try { hd.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    });

    hd.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (!drag.moved) return;
      box.style.left = Math.max(0, Math.min(window.innerWidth - 60, drag.ox + dx)) + 'px';
      box.style.top = Math.max(0, Math.min(window.innerHeight - 36, drag.oy + dy)) + 'px';
    });

    const end = () => {
      if (!drag) return;
      try { hd.releasePointerCapture(drag.id); } catch (err) {}
      const moved = drag.moved;
      drag = null;
      box.classList.remove('dragging');

      if (box.classList.contains('collapsed')) {
        if (moved) setFolded(box, true);
        else setFolded(box, false);
      } else if (moved) {
        savePos(box);
      }
    };
    hd.addEventListener('pointerup', end);
    hd.addEventListener('pointercancel', end);
  }

  let lastSig = '';

  function paintHidden() {
    const box = panel();
    lastSig = 'hidden';
    box.querySelector('.rows').innerHTML =
      '<div class="hl">本桌隐藏实时得分<em>RESPECT_HIDDEN 已开启</em></div>';
    box.querySelector('.ft').textContent = RULE_LINE;
  }

  function paint(rows, gd) {
    const box = panel();
    const host = box.querySelector('.rows');
    const n = rows.length || 1;

    const w = (ICON_COL + n * PLAYER_COL) + 'px';
    box.dataset.w = w;
    if (!box.classList.contains('collapsed')) box.style.width = w;

    const cols = ICON_COL + 'px repeat(' + n + ',minmax(60px,1fr))';
    let html = '<div class="tbl" style="grid-template-columns:' + cols + '">';

    html += '<div class="cell"></div>';
    rows.forEach(r => {
      html += '<div class="cell hd2 v" title="' + esc(r.name) + '">' +
        '<span style="color:' + readable(r.color) + '">' + esc(r.name) + '</span>' +
        (r.elo ? '<em class="elo">ELO ' + esc(r.elo) + '</em>' : '') +
        '</div>';
    });

    html += '<div class="cell lab sum">总分:</div>';
    rows.forEach(r => {
      html += '<div class="cell v num sum">' + (r.total | 0) + '</div>';
    });

    FIELDS.forEach(([key, icons, tail]) => {
      html += '<div class="cell ic">' + iconHTML(icons) +
        (tail ? '<span class="tail">' + tail + '</span>' : '') + '</div>';
      rows.forEach(r => {
        const v = r[key] | 0;
        html += '<div class="cell v num' + (v === 0 ? ' z' : '') + '">' + v + '</div>';
      });
    });

    html += '</div>';
    host.innerHTML = html;

    const notes = [];
    {
      const all = Object.keys(S.pieces).map(k => S.pieces[k]);
      const expect = n * 15;
      if (all.length > 0 && Math.abs(all.length - expect) > n) {
        notes.push('棋子 ' + all.length + ' / 应 ' + expect);
      }
    }
    if (gd.matcha && (gd.matcha.geishaLocations || []).length) notes.push('未含茶扩艺妓分');

    box.querySelector('.ft').innerHTML =
      (notes.length ? '<span class="warn">' + notes.join('<br>') + '</span><br>' : '') +
      RULE_LINE;
  }

  function readable(hex) {
    const h = String(hex).replace('#', '');
    const r = parseInt(h.slice(0, 2), 16) || 0;
    const g = parseInt(h.slice(2, 4), 16) || 0;
    const b = parseInt(h.slice(4, 6), 16) || 0;
    const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    if (lum <= 0.62) return '#' + h;
    return '#' + [r, g, b].map(v => Math.round(v * 0.55).toString(16).padStart(2, '0')).join('');
  }

  /* ---------- 启动 ---------- */
  let raf = 0;

  function tick() {
    const gui = window.gameui;
    if (!isThisGame(gui)) return;
    const gd = gui.gamedatas;

    if (isHidden(gd)) { if (lastSig !== 'hidden') paintHidden(); return; }

    let rows;
    try { rows = compute(gui); } catch (e) { console.error('[twc]', e); return; }
    /* ELO 是 DOM 里的活值，放进 rows 一并参与变动检测，变了才会重绘 */
    rows.forEach(r => { r.elo = eloOf(r.id); });

    const sig = JSON.stringify(rows);
    if (sig === lastSig) return;
    lastSig = sig;
    paint(rows, gd);
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; tick(); });
  }

  function hook(target, onChange) {
    if (!target) return 0;
    let n = 0;
    const scan = obj => {
      Object.getOwnPropertyNames(obj)
        .filter(k => k.indexOf('notif_') === 0 && typeof target[k] === 'function')
        .forEach(k => {
          const orig = target[k];
          if (orig.__twc) return;
          const f = function () {
            const r = orig.apply(this, arguments);
            try { Array.prototype.forEach.call(arguments, absorb); onChange(); } catch (e) {}
            return r;
          };
          f.__twc = true;
          try { target[k] = f; n++; } catch (e) {}
        });
    };
    scan(target);
    for (let p = Object.getPrototypeOf(target); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) scan(p);
    return n;
  }

  function boot(tries) {
    tries = tries || 0;

    const W = gameWindow();
    if (!W) {
      if (tries < 200) setTimeout(() => boot(tries + 1), 400);
      else console.log('[twc] 找不到白城堡的游戏窗口，退出');
      return;
    }
    if (W !== window) { console.log('[twc] 游戏在子 frame 里，交由那一层处理'); return; }

    const gui = W.gameui;
    const gd = gui.gamedatas;
    seed(gd);

    const nm = gui.notificationManager;
    let hooked = hook(nm, schedule);
    if (!hooked) hooked = hook(gui, schedule);

    panel();

    /* 诊断出口：控制台跑 __twc() 就能看到插件内存里的实时状态。
       主要用来查「某个棋子到底被记到哪去了」。 */
    window.__twc = function () {
      const rows = (function () { try { return compute(gui); } catch (e) { return String(e); } })();
      const all = Object.keys(S.pieces).map(k => S.pieces[k]);
      return {
        pieces: all.length,
        courtiers: all.filter(p => p.type === 'courtier'),
        warriors: all.filter(p => p.type === 'warrior'),
        gardeners: all.filter(p => p.type === 'gardener'),
        yards: (gd.trainingYards || []).map(y => ({ id: y.id, pointValue: y.pointValue })),
        roomIds: (gd.castleRooms || []).map(r => ({ id: r.id, pointValue: r.pointValue })),
        daimyoCard: gd.daimyoCard,
        rows: rows,
        sheet: sheetCache,
      };
    };

    setInterval(tick, 700);
    tick();

    console.log('[twc] 已启动 v4.4 · 通知钩子 ' + hooked + ' 个 · 玩家 ' +
      Object.keys(gui.gamedatas.players || {}).length +
      (nm ? '' : ' · 无通知管理器，走轮询'));
  }

  boot(0);
})();
