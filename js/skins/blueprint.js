// Скин «blueprint» (Чертёж): перекрестия-метки. Звуки и декор — из общих помощников Skins.kit / Skins.fx (js/skins.js).
Skins.register("blueprint", {
  sound: Skins.kit({w: "square", f: 1046, iv: [1, 1.5, 2], d: 0.05, v: 0.035, lp: 5000}),
  haptic: { tap: [4] },
  deco: (layer, o) => Skins.fx(layer, o, [{"g":["+","+","◌","⊕"],"cls":"sk-cx","m":"twinkle","n":12,"s":[12,22],"o":[0.3,0.6],"t":[4,9],"c":{"light":["#0b5ea8"],"dark":["#9fdcff"]}}]),
});
