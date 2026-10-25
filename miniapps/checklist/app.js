// Общий чек-лист. Состояние: {items:{<id>:{t:текст, d:0|1, ts:время правки, x:1 если удалён}}}. Слияние — по каждой строке «последняя правка побеждает» (CRDT-подобный LWW-register map),
// поэтому одновременные правки разных строк у двух людей не теряются. Права: storage (хранить локально в этом чате), sync (отправлять состояние участникам чата).
(function () {
  "use strict";
  var S = { items: {} };
  var TX = { add: { en: "Add", ru: "Добавить" }, ph: { en: "New item", ru: "Новый пункт" }, empty: { en: "Nothing here yet", ru: "Пока пусто" }, del: { en: "Delete", ru: "Удалить" } };
  var $ = function (id) { return document.getElementById(id); };
  function merge(a, b) {
    var out = {}; [a, b].forEach(function (src) {
      Object.keys((src && src.items) || {}).forEach(function (k) {
        var it = src.items[k]; if (!it || typeof it.t !== "string" || !Number.isFinite(it.ts)) return;
        var cur = out[k]; if (!cur || it.ts > cur.ts) out[k] = { t: it.t.slice(0, 120), d: it.d ? 1 : 0, ts: it.ts, x: it.x ? 1 : 0 };
      });
    });
    var keys = Object.keys(out).sort(function (x, y) { return out[x].ts - out[y].ts; }).slice(-200);
    var items = {}; keys.forEach(function (k) { items[k] = out[k]; });
    return { items: items };
  }
  function render() {
    var ul = $("l"); ul.textContent = "";
    var ids = Object.keys(S.items).filter(function (k) { return !S.items[k].x; }).sort(function (a, b) { return S.items[a].ts - S.items[b].ts; });
    $("empty").textContent = ids.length ? "" : EtherMini.t(TX.empty);
    ids.forEach(function (k) {
      var it = S.items[k], li = document.createElement("li"); if (it.d) li.className = "done";
      var cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = !!it.d; cb.onchange = function () { edit(k, { d: cb.checked ? 1 : 0 }); };
      var sp = document.createElement("span"); sp.textContent = it.t;
      var rm = document.createElement("button"); rm.type = "button"; rm.textContent = "✕"; rm.title = EtherMini.t(TX.del); rm.onclick = function () { edit(k, { x: 1 }); };
      li.appendChild(cb); li.appendChild(sp); li.appendChild(rm); ul.appendChild(li);
    });
  }
  function save() { render(); return EtherMini.call("state.set", { state: S }).then(function () { return EtherMini.call("share", { state: S }); }).catch(function () {}); }
  function edit(k, patch) { var it = S.items[k]; if (!it) return; S.items[k] = Object.assign({}, it, patch, { ts: Math.max(Date.now(), it.ts + 1) }); save(); }
  EtherMini.ready(function (init) {
    $("add").textContent = EtherMini.t(TX.add); $("t").placeholder = EtherMini.t(TX.ph);
    S = merge(init.state, { items: {} });
    (init.inbox || []).forEach(function (r) { S = merge(S, r.st); });
    render();
    function add() { // без <form>: в песочнице нет allow-forms
      var v = $("t").value.trim(); if (!v) return;
      var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      S.items[id] = { t: v.slice(0, 120), d: 0, ts: Date.now(), x: 0 }; $("t").value = ""; save();
    }
    $("add").onclick = add;
    $("t").onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); add(); } };
    EtherMini.on("remote", function (m) { var before = JSON.stringify(S); S = merge(S, m.st); if (JSON.stringify(S) !== before) { render(); EtherMini.call("state.set", { state: S }).catch(function () {}); } });
  });
})();
