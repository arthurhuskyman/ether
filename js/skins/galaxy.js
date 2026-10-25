// Скин «galaxy» (Галактика): звёзды и комета. Звуки и декор — из общих помощников Skins.kit / Skins.fx (js/skins.js).
Skins.register("galaxy", {
  sound: Skins.kit({w: "sine", f: 440, iv: [1, 1.5, 2, 3], d: 0.16, v: 0.07, lp: 3000}),
  haptic: { tap: [8] },
  deco: (layer, o) => Skins.fx(layer, o, [{"g":["✦","✧","·","✶"],"cls":"sk-star","m":"twinkle","n":20,"s":[7,14],"o":[0.4,0.9],"t":[2.5,6],"c":{"light":["#5a36d0","#a1157f"],"dark":["#ffffff","#d9ccff","#ffd6f0"]}},{"g":["🪐"],"m":"bob","n":1,"s":[34,34],"o":[0.4,0.55],"t":[8,8],"y":[62,62]},{"g":["☄️"],"m":"drift","n":1,"s":[22,22],"o":[0.5,0.6],"t":[34,34],"y":[18,18]}]),
});
