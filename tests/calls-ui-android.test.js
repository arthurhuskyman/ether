// Тесты звонков calls-ui.test.js для платформы android — отдельным процессом (укладываются в --test-timeout).
process.env.CALLS_UI_ONLY = "android";
require("./calls-ui.test.js");
