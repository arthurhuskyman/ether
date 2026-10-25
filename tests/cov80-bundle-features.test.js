// Сценарии стикеров / сертификатов устройств / переноса на устройство на коде из js/bundle.features.js (см. cov80-bundle-loader.js).
require("./cov80-bundle-loader").install();
for (const f of ["devicelink-protocol", "devicelink-cert", "fix77-m-stickers-devices", "stickers"]) require("./" + f + ".test.js");
