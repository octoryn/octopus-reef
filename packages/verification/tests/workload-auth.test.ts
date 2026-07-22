import assert from "node:assert/strict";
import {
  generateKeyPairSync,
  sign as signValue,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import test from "node:test";
import {
  JwksVerificationWorkloadAuthenticator,
  VerificationAuthenticationError,
  VerificationAuthorizationError,
  authorizeVerificationWorkload,
} from "../src/index.js";

const NOW = 2_000_000_000;
const ISSUER = "https://identity.octopus.invalid/";
const AUDIENCE = "reef-verification";
const KEY_ID = "verification-release-key";

test("offline JWKS authentication verifies and tenant-binds a workload principal", async () => {
  const fixture = signingFixture();
  const authenticator = new JwksVerificationWorkloadAuthenticator({
    jwks: { keys: [fixture.publicJwk] },
    issuer: ISSUER,
    audience: AUDIENCE,
    now: () => NOW,
    clockSkewSeconds: 0,
  });
  const principal = await authenticator.authenticate(
    `Bearer ${fixture.token({
      sub: "workload:builder-staging",
      iss: ISSUER,
      aud: AUDIENCE,
      iat: NOW - 1,
      nbf: NOW - 1,
      exp: NOW + 60,
      reef_verification: {
        organisationRef: "organisation:acme",
        projectRefs: ["project:reef"],
        permissions: ["verification:create", "verification:read"],
      },
    })}`,
  );

  assert.deepEqual(principal, {
    subject: "workload:builder-staging",
    organisationRef: "organisation:acme",
    projectRefs: ["project:reef"],
    permissions: ["verification:create", "verification:read"],
  });
  assert.doesNotThrow(() =>
    authorizeVerificationWorkload(
      principal,
      { organisationRef: "organisation:acme", projectRef: "project:reef" },
      "verification:create",
    ),
  );
  assert.throws(
    () =>
      authorizeVerificationWorkload(
        principal,
        { organisationRef: "organisation:other", projectRef: "project:reef" },
        "verification:read",
      ),
    VerificationAuthorizationError,
  );
  assert.throws(
    () =>
      authorizeVerificationWorkload(
        principal,
        { organisationRef: "organisation:acme", projectRef: "project:reef" },
        "verification:cancel",
      ),
    VerificationAuthorizationError,
  );
});

test("workload authentication rejects tampered, expired and algorithm-confused JWTs", async () => {
  const fixture = signingFixture();
  const authenticator = new JwksVerificationWorkloadAuthenticator({
    jwks: { keys: [fixture.publicJwk] },
    issuer: ISSUER,
    audience: AUDIENCE,
    now: () => NOW,
    clockSkewSeconds: 0,
  });
  const claims = {
    sub: "workload:builder",
    iss: ISSUER,
    aud: AUDIENCE,
    exp: NOW + 60,
    reef_verification: {
      organisationRef: "organisation:acme",
      projectRefs: ["project:reef"],
      permissions: ["verification:read"],
    },
  };
  const valid = fixture.token(claims);
  const [header, payload, encodedSignature] = valid.split(".");
  const signature = Buffer.from(encodedSignature!, "base64url");
  signature[0] = signature[0]! ^ 0x01;
  const tampered = `${header}.${payload}.${signature.toString("base64url")}`;
  const expired = fixture.token({ ...claims, exp: NOW });
  const confused = fixture.token(claims, {
    alg: "none",
    kid: KEY_ID,
    typ: "JWT",
  });

  for (const token of [tampered, expired, confused]) {
    await assert.rejects(
      authenticator.authenticate(`Bearer ${token}`),
      (error) => {
        assert.ok(error instanceof VerificationAuthenticationError);
        assert.equal(
          error.message,
          "verification workload authentication failed",
        );
        assert.equal(error.message.includes(token), false);
        return true;
      },
    );
  }
});

function signingFixture(): {
  readonly publicJwk: Record<string, unknown>;
  readonly token: (
    claims: Record<string, unknown>,
    header?: Record<string, unknown>,
  ) => string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  const publicJwk = publicKey.export({ format: "jwk" }) as JsonWebKey &
    Record<string, unknown>;
  publicJwk.kid = KEY_ID;
  publicJwk.use = "sig";
  publicJwk.alg = "RS256";
  return {
    publicJwk,
    token: (claims, header = { alg: "RS256", kid: KEY_ID, typ: "JWT" }) =>
      signJwt(privateKey, header, claims),
  };
}

function signJwt(
  privateKey: KeyObject,
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): string {
  const encodedHeader = Buffer.from(JSON.stringify(header), "utf8").toString(
    "base64url",
  );
  const encodedClaims = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  const input = `${encodedHeader}.${encodedClaims}`;
  const signature = signValue(
    "RSA-SHA256",
    Buffer.from(input, "ascii"),
    privateKey,
  );
  return `${input}.${signature.toString("base64url")}`;
}
