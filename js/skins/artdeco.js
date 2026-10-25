// Скин «artdeco» (Ар-деко): золотые искры. Звуки и декор — из общих помощников Skins.kit / Skins.fx (js/skins.js).
Skins.register("artdeco", {
  sound: Skins.kit({w: "triangle", f: 523, iv: [1, 1.25, 1.5, 2], d: 0.12, v: 0.07, lp: 3600}),
  haptic: { tap: [8,30] },
  deco: (layer, o) => Skins.fx(layer, o, [{"g":["✦","◆","✧"],"cls":"sk-gold","m":"twinkle","n":10,"s":[8,14],"o":[0.3,0.7],"t":[3,7],"c":{"light":["#9a7418"],"dark":["#e6c05a"]}}]),
});
