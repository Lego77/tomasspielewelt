/* =========================================================
   Tomas Spielwelt – Spielstand-Synchronisation
   Wird in jedem Spiel GANZ OBEN im <head> eingebunden:
     <script src="sync.js"></script>
   Die Spiele speichern wie bisher mit localStorage.
   Dieses Script schickt jede Änderung zusätzlich ins Google Sheet
   und sorgt dafür, dass jedes Spiel mit dem aktuellen Stand startet.
   ========================================================= */
(function () {
  'use strict';

  // Web-App-Adresse aus Google Apps Script (dieselbe wie Besucherzähler und Gästebuch)
  var API_URL = 'https://script.google.com/macros/s/AKfycbxuAImhCrHj1O37Blx9YQvvoIEagahcMOn_XQK1oycI8UoU8IQQtg8mqbHxRNpq0qKLBg/exec';

  // Speicher-Namen der Spiele (alles, was so beginnt, wird gesichert)
  var PREFIXE = ['sprachheft2', 'stamm_', 'weltenbummler:', 'rechenheft-', 'flickshot_', 'freizeitpark_'];

  var FRISCH_MIN = 10;     // nach so vielen Minuten wird beim Spielstart neu geladen
  var WARTEN_MS = 2500;    // so lange nach der letzten Änderung wird gespeichert

  var me = document.currentScript;
  var istHub = !!(me && me.hasAttribute('data-hub'));
  var homePos = (me && me.getAttribute('data-home')) || 'ul';

  var LS, SS;
  try { LS = window.localStorage; SS = window.sessionStorage; } catch (e) { return; }
  var P = Storage.prototype, oSet = P.setItem, oDel = P.removeItem, oGet = P.getItem;

  function get(k) { try { return oGet.call(LS, k); } catch (e) { return null; } }
  function set(k, v) { try { oSet.call(LS, k, v); } catch (e) {} }
  function del(k) { try { oDel.call(LS, k); } catch (e) {} }
  function json(k, d) { try { var v = JSON.parse(get(k)); return v == null ? d : v; } catch (e) { return d; } }
  function istSpiel(k) {
    k = String(k);
    for (var i = 0; i < PREFIXE.length; i++) if (k.indexOf(PREFIXE[i]) === 0) return true;
    return false;
  }
  function spielKeys() {
    var r = [];
    for (var i = 0; i < LS.length; i++) { var k = LS.key(i); if (istSpiel(k)) r.push(k); }
    return r;
  }
  var verbunden = API_URL.indexOf('https://') === 0;

  /* ---------- Wer spielt? ---------- */
  function spieler() { return json('sw_spieler', null); }

  /* ---------- Offene Änderungen merken ---------- */
  var blockiert = false, timer = null, laeuft = false, nochmal = false;
  function offen() { return json('sw_offen', {}); }
  function merke(k) {
    if (blockiert || !spieler()) return;
    var o = offen(); o[k] = (o[k] || 0) + 1; set('sw_offen', JSON.stringify(o));
    status('wartet');
    clearTimeout(timer); timer = setTimeout(speichern, WARTEN_MS);
  }
  P.setItem = function (k, v) { oSet.call(this, k, v); if (this === LS && istSpiel(k)) merke(String(k)); };
  P.removeItem = function (k) { oDel.call(this, k); if (this === LS && istSpiel(k)) merke(String(k)); };

  /* ---------- Verbindung zum Google Sheet ---------- */
  function api(daten) {
    if (!verbunden) return Promise.reject(new Error('nicht verbunden'));
    return fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(daten),
      redirect: 'follow'
    }).then(function (r) { return r.json(); });
  }

  function paket() {
    var o = offen(), d = {}, n = 0;
    Object.keys(o).forEach(function (k) { d[k] = get(k); n++; });
    return { stand: o, daten: d, anzahl: n };
  }

  function speichern() {
    clearTimeout(timer);
    var s = spieler();
    if (!s) return Promise.resolve(true);
    if (laeuft) { nochmal = true; return Promise.resolve(false); }
    var p = paket();
    if (!p.anzahl) { status('ok'); return Promise.resolve(true); }
    laeuft = true; status('speichert');
    return api({ aktion: 'speichern', name: s.name, pin: s.pin, daten: p.daten })
      .then(function (r) {
        if (!r || !r.ok) throw new Error((r && r.fehler) || 'fehler');
        // nur Einträge abhaken, die sich währenddessen nicht wieder geändert haben
        var o = offen();
        Object.keys(p.stand).forEach(function (k) { if (o[k] === p.stand[k]) delete o[k]; });
        set('sw_offen', JSON.stringify(o));
        status(Object.keys(o).length ? 'wartet' : 'ok');
        return true;
      })
      .catch(function () { status('offline'); return false; })
      .then(function (ok) {
        laeuft = false;
        if (nochmal) { nochmal = false; timer = setTimeout(speichern, 500); }
        return ok;
      });
  }

  // Beim Schließen/Wegwechseln: schnell noch losschicken
  function notfall() {
    var s = spieler(); if (!s || !verbunden) return;
    var p = paket(); if (!p.anzahl) return;
    try {
      navigator.sendBeacon(API_URL, new Blob([JSON.stringify({ aktion: 'speichern', name: s.name, pin: s.pin, daten: p.daten })], { type: 'text/plain;charset=utf-8' }));
    } catch (e) {}
  }

  /* ---------- Daten vom Sheet übernehmen ---------- */
  function uebernehmen(daten) {
    spielKeys().forEach(del);
    Object.keys(daten || {}).forEach(function (k) { if (istSpiel(k) && daten[k] != null) set(k, String(daten[k])); });
    set('sw_offen', '{}');
    frischMarkieren();
  }
  function frischMarkieren() { try { SS.setItem('sw_frisch', String(Date.now())); } catch (e) {} }
  function istFrisch() {
    var t = 0; try { t = Number(SS.getItem('sw_frisch')) || 0; } catch (e) {}
    return Date.now() - t < FRISCH_MIN * 60000;
  }

  // Erst eigene offene Änderungen hochladen, dann alles neu laden
  function aktualisieren() {
    var s = spieler();
    if (!s) return Promise.reject(new Error('abgemeldet'));
    return speichern().then(function (ok) {
      if (!ok) throw new Error('offline');
      return api({ aktion: 'laden', name: s.name, pin: s.pin });
    }).then(function (r) {
      if (!r || !r.ok) { var e = new Error(r && r.fehler); e.code = r && r.fehler; throw e; }
      uebernehmen(r.daten);
      return r;
    });
  }

  /* ---------- Für die Startseite ---------- */
  window.Spielwelt = {
    verbunden: verbunden,
    spieler: spieler,
    anmelden: function (name, pin, neu, bild) {
      return api({ aktion: neu ? 'anlegen' : 'laden', name: name, pin: pin, bild: bild }).then(function (r) {
        if (!r || !r.ok) { var e = new Error(r && r.fehler); e.code = r && r.fehler; throw e; }
        set('sw_spieler', JSON.stringify({ name: r.name, pin: pin, bild: r.bild }));
        uebernehmen(r.daten);
        var z = json('sw_zuletzt', []).filter(function (x) { return x.name.toLowerCase() !== r.name.toLowerCase(); });
        z.unshift({ name: r.name, bild: r.bild }); set('sw_zuletzt', JSON.stringify(z.slice(0, 8)));
        return r;
      });
    },
    abmelden: function (trotzdem) {
      return speichern().then(function (ok) {
        if (!ok && !trotzdem) return false;
        spielKeys().forEach(del);
        del('sw_spieler'); del('sw_offen');
        try { SS.removeItem('sw_frisch'); } catch (e) {}
        return true;
      });
    },
    vergessen: function (name) {
      set('sw_zuletzt', JSON.stringify(json('sw_zuletzt', []).filter(function (x) { return x.name !== name; })));
    },
    zuletzt: function () { return json('sw_zuletzt', []); },
    aktualisieren: aktualisieren,
    speichern: speichern,
    offeneAnzahl: function () { return Object.keys(offen()).length; },
    offlineWeiter: frischMarkieren
  };

  /* ---------- Status-Anzeige ---------- */
  var statusEl = null, letzterStatus = 'ok';
  function status(s) {
    letzterStatus = s;
    if (statusEl) statusEl.setAttribute('data-s', s);
    try { window.dispatchEvent(new CustomEvent('spielwelt-status', { detail: s })); } catch (e) {}
  }

  window.addEventListener('pagehide', notfall);
  var versteckt = 0;
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { versteckt = Date.now(); notfall(); speichern(); return; }
    // Nach längerer Pause im Spiel: prüfen, ob woanders weitergespielt wurde
    if (!istHub && versteckt && Date.now() - versteckt > FRISCH_MIN * 60000 && spieler()) {
      var vorher = {}; spielKeys().forEach(function (k) { vorher[k] = get(k); });
      aktualisieren().then(function () {
        var nachher = spielKeys(), anders = nachher.length !== Object.keys(vorher).length;
        nachher.forEach(function (k) { if (vorher[k] !== get(k)) anders = true; });
        if (anders) location.reload();
      }).catch(function () {});
    }
  });

  if (istHub) return;

  /* ---------- Im Spiel: nur mit Anmeldung und frischem Stand ---------- */
  if (verbunden && (!spieler() || !istFrisch())) {
    blockiert = true;
    document.documentElement.style.visibility = 'hidden';
    var datei = location.pathname.split('/').pop() || '';
    location.replace('index.html?weiter=' + encodeURIComponent(datei));
    return;
  }

  // Haus-Knopf zurück zur Spielwelt
  function knopf() {
    if (window.self !== window.top) return;
    var css = document.createElement('style');
    css.textContent =
      '#sw-home{position:fixed;z-index:2147483000;width:44px;height:44px;border-radius:50%;border:0;' +
      'background:rgba(255,255,255,.92);box-shadow:0 3px 10px rgba(0,0,0,.25);font-size:22px;line-height:44px;' +
      'text-align:center;cursor:pointer;padding:0;-webkit-tap-highlight-color:transparent;opacity:.85}' +
      '#sw-home:active{transform:scale(.92)}' +
      '#sw-home::after{content:"";position:absolute;right:1px;top:1px;width:11px;height:11px;border-radius:50%;' +
      'border:2px solid #fff;background:#2fbf71}' +
      '#sw-home[data-s=wartet]::after,#sw-home[data-s=speichert]::after{background:#f5b301}' +
      '#sw-home[data-s=offline]::after{background:#e5484d}';
    document.head.appendChild(css);
    var b = document.createElement('button');
    b.id = 'sw-home'; b.type = 'button'; b.textContent = '🏠';
    b.title = 'Zurück zur Spielwelt';
    var abst = 'calc(10px + env(safe-area-inset-%s))';
    // Position: 1. Buchstabe o/m/u (oben, Mitte, unten), 2. Buchstabe l/m/r (links, Mitte, rechts)
    if (homePos.charAt(0) === 'm') { b.style.top = '50%'; b.style.marginTop = '-22px'; }
    else b.style[homePos.charAt(0) === 'o' ? 'top' : 'bottom'] = abst.replace('%s', homePos.charAt(0) === 'o' ? 'top' : 'bottom');
    if (homePos.charAt(1) === 'm') { b.style.left = '50%'; b.style.marginLeft = '-22px'; }
    else b.style[homePos.charAt(1) === 'l' ? 'left' : 'right'] = abst.replace('%s', homePos.charAt(1) === 'l' ? 'left' : 'right');
    b.setAttribute('data-s', letzterStatus);
    b.onclick = function () {
      b.disabled = true; b.textContent = '⏳';
      var weg = function () { location.href = 'index.html'; };
      Promise.race([speichern(), new Promise(function (r) { setTimeout(r, 4000); })]).then(weg, weg);
    };
    document.body.appendChild(b);
    statusEl = b;
  }
  if (document.body) knopf(); else document.addEventListener('DOMContentLoaded', knopf);
})();
