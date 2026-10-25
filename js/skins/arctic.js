// Скин «arctic» (Арктика): снегопад и пингвин. Звуки и декор — из общих помощников Skins.kit / Skins.fx (js/skins.js).
Skins.register("arctic", {
  sound: Skins.kit({w: "sine", f: 784, iv: [1, 1.34, 1.5, 2], d: 0.1, v: 0.06, lp: 6000}),
  haptic: { tap: [5] },
  deco: (layer, o) => Skins.fx(layer, o, [{"g":["❄","❅","❆","•"],"cls":"sk-snow","m":"fall","n":16,"s":[8,20],"o":[0.3,0.7],"t":[12,24],"c":{"light":["#5aa9d0","#8fc5e0"],"dark":["#ffffff","#bfeaff"]}},{"g":["🐧"],"m":"bob","n":1,"s":[26,26],"o":[0.4,0.5],"t":[5,5],"y":[84,84]}]),
});
