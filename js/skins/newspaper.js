// Скин «newspaper» (Газета): бледные типографские знаки. Звуки и декор — из общих помощников Skins.kit / Skins.fx (js/skins.js).
Skins.register("newspaper", {
  sound: Skins.kit({w: "square", f: 330, iv: [1, 1.5, 2], d: 0.04, v: 0.04, lp: 2200, nz: 3000}),
  haptic: { tap: [4,20,4] },
  deco: (layer, o) => Skins.fx(layer, o, [{"g":["¶","§","❡","※","†"],"cls":"sk-ret","m":"twinkle","n":8,"s":[14,24],"o":[0.12,0.28],"t":[6,12],"c":{"light":["#151515"],"dark":["#ece6d6"]}}]),
});
