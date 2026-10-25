// Скин «retro» (Ретро 70-х): ромашки и ноты. Звуки и декор — из общих помощников Skins.kit / Skins.fx (js/skins.js).
Skins.register("retro", {
  sound: Skins.kit({w: "triangle", f: 294, iv: [1, 1.25, 1.5, 1.88], d: 0.12, v: 0.09, lp: 2600}),
  haptic: { tap: [9] },
  deco: (layer, o) => Skins.fx(layer, o, [{"g":["🌼","♪","☮","✿","♫"],"cls":"sk-ret","m":"rise","n":10,"s":[14,24],"o":[0.3,0.55],"t":[15,26],"c":{"light":["#c8601a","#1f6f62","#d79b00"],"dark":["#f2a33a","#4fc0ad","#ffd27a"]}}]),
});
