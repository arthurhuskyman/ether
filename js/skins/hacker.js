// Скин «hacker» (Терминал): дождь из символов. Звуки и декор — из общих помощников Skins.kit / Skins.fx (js/skins.js).
Skins.register("hacker", {
  sound: Skins.kit({w: "square", f: 880, iv: [1, 1.5, 2], d: 0.06, v: 0.045, lp: 3200}),
  haptic: { tap: [4] },
  deco: (layer, o) => Skins.fx(layer, o, [{"g":["0","1","ア","ﾊ","7","ｿ","$","ﾘ","{","9"],"cls":"sk-glyph","m":"fall","n":16,"s":[12,16],"o":[0.18,0.42],"t":[9,18],"c":{"light":["#0b6b2e"],"dark":["#39ff7a"]}}]),
});
