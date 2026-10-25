// Скин «pirate» (Пират): корабль, якорь и попугай. Звуки и декор — из общих помощников Skins.kit / Skins.fx (js/skins.js).
Skins.register("pirate", {
  sound: Skins.kit({w: "triangle", f: 196, iv: [1, 1.5, 2, 1.5], d: 0.13, v: 0.1, lp: 1500, nz: 600}),
  haptic: { tap: [14,50] },
  deco: (layer, o) => Skins.fx(layer, o, [{"g":["⛵"],"m":"drift","n":1,"s":[26,26],"o":[0.35,0.5],"t":[44,44],"y":[84,84]},{"g":["⚓","🦜","🧭","💰"],"m":"bob","n":4,"s":[20,26],"o":[0.25,0.4],"t":[4,7],"y":[20,80]}]),
});
