// Скин «medieval» (Замок): искры факелов и дракон. Звуки и декор — из общих помощников Skins.kit / Skins.fx (js/skins.js).
Skins.register("medieval", {
  sound: Skins.kit({w: "sawtooth", f: 220, iv: [1, 1.5, 2], d: 0.16, v: 0.05, lp: 1400, nz: 800}),
  haptic: { tap: [16,40,16] },
  deco: (layer, o) => Skins.fx(layer, o, [{"g":["✦","✧"],"m":"rise","n":8,"s":[8,14],"o":[0.3,0.6],"t":[9,16],"c":{"light":["#b86a10"],"dark":["#ffb24a","#ff8a2a"]}},{"g":["🐉"],"m":"drift","n":1,"s":[28,28],"o":[0.3,0.4],"t":[48,48],"y":[16,16]}]),
});
