// Сценарии sender keys / админ-инструментов / каналов / поиска, прогнанные на коде из js/bundle.core.js (см. cov80-bundle-loader.js).
require("./cov80-bundle-loader").install();
for (const f of ["fix80-groupkeys-crypto", "fix80-admin-logic", "fix80-channels-crypto", "fix80-search-engine"]) require("./" + f + ".test.js");
