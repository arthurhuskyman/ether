// Кубик. Права: только chat.post — результат уходит в чат лишь по кнопке, и хост каждый раз спрашивает подтверждение. Случайность — crypto.getRandomValues без смещения (rejection sampling).
(function () {
  "use strict";
  var TX = { roll: { en: "Roll", ru: "Бросить" }, send: { en: "Send to chat", ru: "Отправить в чат" }, res: { en: "rolled", ru: "выпало" } };
  var FACES = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"], sides = 6, last = null, hist = [];
  var $ = function (id) { return document.getElementById(id); };
  function rnd(n) { var max = Math.floor(0x100000000 / n) * n, a = new Uint32Array(1); do { crypto.getRandomValues(a); } while (a[0] >= max); return (a[0] % n) + 1; }
  function show() { $("die").textContent = last == null ? "🎲" : (sides === 6 ? FACES[last] + " " : "") + last; $("hist").textContent = hist.slice(-10).join(" · "); $("send").disabled = last == null; }
  EtherMini.ready(function () {
    $("roll").textContent = EtherMini.t(TX.roll); $("send").textContent = EtherMini.t(TX.send);
    [4, 6, 8, 10, 12, 20].forEach(function (n) {
      var b = document.createElement("button"); b.type = "button"; b.className = "alt"; b.textContent = "d" + n; b.onclick = function () { sides = n; last = null; hist = []; show(); }; $("sides").appendChild(b);
    });
    $("roll").onclick = function () { last = rnd(sides); hist.push(last); show(); };
    $("send").onclick = function () { if (last != null) EtherMini.call("chat.post", { text: "🎲 d" + sides + " — " + EtherMini.t(TX.res) + " " + last }).catch(function () {}); };
    show();
  });
})();
