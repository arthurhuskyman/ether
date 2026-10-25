// Скин «vampire» (Вампир): летучие мыши и кровавые капли. Звуки и декор — из общих помощников Skins.kit / Skins.fx (js/skins.js).
Skins.register("vampire", {
  sound: Skins.kit({w: "sine", f: 196, iv: [1, 1.19, 1.5], d: 0.2, v: 0.09, lp: 900, nz: 700}),
  haptic: { tap: [14,60,18] },
  deco: (layer, o) => Skins.fx(layer, o, [{"g":["🦇"],"m":"drift","n":5,"s":[16,28],"o":[0.22,0.45],"t":[22,38],"y":[4,60]},{"g":["🩸"],"m":"fall","n":4,"s":[10,15],"o":[0.2,0.4],"t":[16,26]}]),
});
