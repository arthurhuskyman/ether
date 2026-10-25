// Скин «vaporwave» (Вейпорвейв): пальмы и мерцающие фигуры. Звуки и декор — из общих помощников Skins.kit / Skins.fx (js/skins.js).
Skins.register("vaporwave", {
  sound: Skins.kit({w: "triangle", f: 392, iv: [1, 1.25, 1.5, 1.88], d: 0.14, v: 0.08, lp: 2400}),
  haptic: { tap: [10] },
  deco: (layer, o) => Skins.fx(layer, o, [{"g":["✦","✧","△","○","◇"],"cls":"sk-v","m":"twinkle","n":14,"s":[10,20],"o":[0.35,0.7],"t":[3,7],"c":{"light":["#a1157f","#0a7ca6"],"dark":["#ff71ce","#01cdfe","#b967ff","#fffb96"]}},{"g":["🌴","🐬","💿"],"m":"bob","n":3,"s":[22,30],"o":[0.3,0.5],"t":[4,6],"y":[72,90]}]),
});
