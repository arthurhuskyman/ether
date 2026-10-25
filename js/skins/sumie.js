// Скин «sumie» (Тушь): лепестки и силуэты гор. Звуки и декор — из общих помощников Skins.kit / Skins.fx (js/skins.js).
Skins.register("sumie", {
  sound: Skins.kit({w: "sine", f: 262, iv: [1, 1.5, 1.78], d: 0.28, v: 0.08, lp: 1800}),
  haptic: { tap: [10] },
  deco: (layer, o) => Skins.fx(layer, o, [{"g":["🌸","🍃"],"m":"fall","n":7,"s":[12,18],"o":[0.18,0.4],"t":[18,30]},{"g":["🐦"],"m":"drift","n":1,"s":[18,18],"o":[0.3,0.4],"t":[44,44],"y":[14,14]}]),
});
