// Скин «pixel» (8-бит): мигающие пиксели. Звуки и декор — из общих помощников Skins.kit / Skins.fx (js/skins.js).
Skins.register("pixel", {
  sound: Skins.kit({w: "square", f: 523, iv: [1, 1.26, 1.5, 2], d: 0.07, v: 0.05, lp: 4000}),
  haptic: { tap: [8,30,8] },
  deco: (layer, o) => Skins.fx(layer, o, [{"g":["","",""],"cls":"sk-pix","m":"blink","n":18,"s":[6,12],"o":[0.3,0.7],"t":[1.6,3.6],"c":{"light":["#2a7a2a","#c1214c","#d79b00"],"dark":["#ffd23f","#ff5a8a","#4fe3c1","#9b7bff"]}},{"g":["👾"],"m":"bob","n":2,"s":[20,26],"o":[0.3,0.45],"t":[3,4],"y":[70,90]}]),
});
