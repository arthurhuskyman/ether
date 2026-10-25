// ESM-обёртка над index.cjs (одна реализация, два формата).
import { createRequire } from "node:module";
const sdk = createRequire(import.meta.url)("./index.cjs");
export const { Client, generateIdentity, identityFromJSON, claimProof, PROTOCOL } = sdk;
export default sdk;
