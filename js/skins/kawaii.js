// Скин «kawaii» (Конфетка): парящие сердечки. Звуки и декор — из общих помощников Skins.kit / Skins.fx (js/skins.js).
Skins.register("kawaii", {
  sound: Skins.kit({w: "sine", f: 659, iv: [1, 1.25, 1.5, 2], d: 0.09, v: 0.08, lp: 5000}),
  haptic: { tap: [6] },
  deco: (layer, o) => Skins.fx(layer, o, [{"g":["💗","✨","🍬","💖","⭐"],"m":"rise","n":12,"s":[12,20],"o":[0.35,0.65],"t":[14,26]}]),
});
