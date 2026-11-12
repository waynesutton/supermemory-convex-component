// Prints JWT_PRIVATE_KEY and JWKS for Convex Auth. Same approach as the
// Convex Auth manual setup docs. Pipe into `npx convex env set`, never commit.
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";

const keys = await generateKeyPair("RS256", { extractable: true });
const privateKey = await exportPKCS8(keys.privateKey);
const publicKey = await exportJWK(keys.publicKey);
const jwks = JSON.stringify({ keys: [{ use: "sig", ...publicKey }] });

if (process.argv.includes("--json")) {
  process.stdout.write(
    JSON.stringify({
      JWT_PRIVATE_KEY: privateKey.trimEnd().replace(/\n/g, " "),
      JWKS: jwks,
    }),
  );
} else {
  process.stdout.write(
    `JWT_PRIVATE_KEY="${privateKey.trimEnd().replace(/\n/g, " ")}"\nJWKS=${jwks}\n`,
  );
}
