// Сценарии звонков / больших файлов / списка серверов на коде из js/bundle.core.js (см. cov80-bundle-loader.js).
require("./cov80-bundle-loader").install();
for (const f of ["fix80-callquality-sdp", "fix80-callquality-control", "fix80-bigfile-hostile", "fix80-bigfile-transfer", "fix80-multiserver-core", "fix80-multiserver-mirror"]) require("./" + f + ".test.js");
