// Сценарии храповика / ML-KEM / linkauth / rich / иконок на коде из js/bundle.core.js (см. cov80-bundle-loader.js).
require("./cov80-bundle-loader").install();
for (const f of ["ratchet", "ratchet-pq", "fix77-ratchet", "fix80-fuzz-ratchet", "hardening-features", "stage2", "linkauth", "rich", "icons"]) require("./" + f + ".test.js");
