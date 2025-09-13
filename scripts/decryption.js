// decrypt-wallet.js
import crypto from "crypto";

// === Put your values here ===
const ENCRYPTED_PRIVATE_KEY =
  "e423b641cf829a7f15d60e5e65b09654:99feb2188f5dd866c111f15b4418175ecce2458521a933ae6a42aa83196869f57b8356014e0c794d791a3c8c0283e852720f5f07d9c9230fc0df95b2dceedabda8af101f1e9dfed88a9322e43741d55f0cc9dca0da19ab7003d3ee386fd6ec38"; // your stored encrypted key
const ENCRYPTION_KEY_HEX =
  "42b8382c153d2d7f312983a98ae1385111d763a0049d6dbd8959531971efb9a7"; // 32-byte hex string (64 chars)
// =============================

function decryptWallet(encrypted, encryptionKeyHex) {
  if (!encryptionKeyHex || encryptionKeyHex.length !== 64) {
    throw new Error("Encryption key must be 64 hex characters (32 bytes).");
  }

  const key = Buffer.from(encryptionKeyHex, "hex");
  const [ivHex, dataHex] = encrypted.split(":");
  if (!ivHex || !dataHex) {
    throw new Error("Invalid encrypted format. Expected ivHex:dataHex");
  }

  const iv = Buffer.from(ivHex, "hex");
  const data = Buffer.from(dataHex, "hex");

  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);

  return decrypted.toString("utf8"); // Base58 private key
}

// Run
const privateKeyBase58 = decryptWallet(
  ENCRYPTED_PRIVATE_KEY,
  ENCRYPTION_KEY_HEX
);
console.log("Decrypted Private Key (Base58):", privateKeyBase58);
