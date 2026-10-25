// Мост для мини-приложения (код внутри <iframe sandbox="allow-scripts">, непрозрачное происхождение: нет доступа к localStorage/cookie/DOM приложения).
// Рукопожатие: iframe -> parent {ether:"miniapp-hello"}; хост отвечает {ether:"miniapp-init"} и передаёт MessagePort. Дальше только порт.
//   EtherMini.ready((init) => ...)            init = {app, lang, state, inbox, perms}
//   EtherMini.call("state.set", {state})      -> Promise; методы и права: js/miniapps.js (BRIDGE_METHODS)
//   EtherMini.on("remote", (msg) => ...)      обновление от собеседника: {st, from}
(function () {
  "use strict";
  var port = null, seq = 0, pending = {}, handlers = {}, readyCbs = [], initData = null;
  function onPort(ev) {
    var m = ev.data || {};
    if (m.t === "res" && pending[m.id]) { var p = pending[m.id]; delete pending[m.id]; m.ok ? p.res(m.r) : p.rej(new Error(m.err || "error")); return; }
    if (m.t && handlers[m.t]) handlers[m.t].forEach(function (f) { try { f(m); } catch (e) {} });
  }
  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (port || !d || d.ether !== "miniapp-init" || !ev.ports || !ev.ports[0]) return;
    port = ev.ports[0]; port.onmessage = onPort; initData = d;
    readyCbs.forEach(function (f) { f(d); }); readyCbs = [];
  });
  window.EtherMini = {
    ready: function (f) { if (initData) f(initData); else readyCbs.push(f); },
    on: function (t, f) { (handlers[t] = handlers[t] || []).push(f); },
    call: function (method, args) {
      return new Promise(function (res, rej) {
        if (!port) return rej(new Error("not-ready"));
        var id = ++seq; pending[id] = { res: res, rej: rej };
        port.postMessage({ id: id, m: method, a: args || {} });
      });
    },
    t: function (table) { var l = (initData && initData.lang) || "en"; return table[l] || table.en; },
  };
  parent.postMessage({ ether: "miniapp-hello", v: 1 }, "*");
})();
