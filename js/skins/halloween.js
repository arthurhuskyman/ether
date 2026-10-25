// Скин «halloween» (Хэллоуин): тыквы, призраки и мыши. Звуки и декор — из общих помощников Skins.kit / Skins.fx (js/skins.js).
Skins.register("halloween", {
  sound: Skins.kit({w: "triangle", f: 247, iv: [1, 1.19, 1.41, 1.68], d: 0.14, v: 0.08, lp: 1800, nz: 1200}),
  haptic: { tap: [10,50,10] },
  deco: (layer, o) => Skins.fx(layer, o, [{"g":["🦇"],"m":"drift","n":4,"s":[16,26],"o":[0.3,0.5],"t":[20,34],"y":[4,50]},{"g":["👻","🎃","🕸️"],"m":"bob","n":4,"s":[22,30],"o":[0.28,0.45],"t":[4,7],"y":[60,90]}]),
});
