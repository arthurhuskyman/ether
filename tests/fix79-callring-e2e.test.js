// V.79: те же сценарии link-call, но против НАСТОЯЩЕГО signaling-server (spawn server.js), WebRTC настоящий (wrtc).
process.env.LINKCALL_REAL = "1";
require("./fix79-callring-link.test.js");
