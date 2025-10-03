// decrypt-wallet.js
import crypto from "crypto";

// === Put your values here ===
const ENCRYPTED_PRIVATE_KEY =
  "9f0f1029bb5a4e040c86a07d6f584efb:827398116f788bc3bf0df9f783242607cf3b982c9d21ef1a5b9970435dcc2acb1a161e4e708060b0ba99271a24984f359f594ec4aa153c7dfb4a3ab225ef5f596703e7866ad7322dc059dfffa202210665cd1b1fa3275da40fdfc4b5ecd4102a"; // your stored encrypted key
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
