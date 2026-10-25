// Скин «ocean» (Океан): пузыри и рыбки. Звуки и декор — из общих помощников Skins.kit / Skins.fx (js/skins.js).
Skins.register("ocean", {
  sound: Skins.kit({w: "sine", f: 330, iv: [1, 1.33, 1.67], d: 0.18, v: 0.08, lp: 1400}),
  haptic: { tap: [12] },
  deco: (layer, o) => Skins.fx(layer, o, [{"g":["","",""],"cls":"sk-bub","m":"rise","n":14,"s":[8,22],"o":[0.3,0.6],"t":[11,22],"c":{"light":["#0a6a93"],"dark":["#8fe6ff"]}},{"g":["🐠","🐟","🐡"],"m":"drift","n":3,"s":[20,28],"o":[0.3,0.5],"t":[30,48],"y":[30,80]}]),
});
