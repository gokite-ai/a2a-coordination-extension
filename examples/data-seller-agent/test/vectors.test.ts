/**
 * Replays the published coordination-layer vector sets — `canonical`,
 * `signing`, `commands`, `errors`, `funding`, `receipts` — against this
 * example's own implementations. Everything a PARTY implementation can
 * recompute is asserted; expected members that describe Runtime behaviour
 * (`outcome`, `currentRevision`, `errorCode`) or are advisory prose are
 * deliberately not, and an expected member this harness does not recognize
 * fails the run so new vector semantics cannot slip past unreplayed.
 *
 * The `proofs` set is not replayed here: reading the Runtime's proof chain is
 * outside this example's scope (same boundary as `seller-agent/`), and the
 * bundle's `conformance/run.py` already replays it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  commandSigningBytes,
  jcs,
  payloadHashOf,
  receiptSignedPreimage,
  receiptSigningBytes,
  recover,
  sha256Ref,
  toHex,
  utf8,
} from "../src/signing.js";
import { decisionIdWord, reasonHashWord } from "../src/settlement.js";

const VECTORS = fileURLToPath(new URL("../../../vectors/v1/", import.meta.url));
const SCHEMAS = fileURLToPath(new URL("../../../schemas/v1/", import.meta.url));

type Json = Record<string, any>;
const read = (...p: string[]): Json => JSON.parse(readFileSync(join(VECTORS, ...p), "utf8"));
const cases = (set: string): string[] => readdirSync(join(VECTORS, set)).filter((d) => !d.startsWith("."));

const index = read("index.json");
/** address → fixture role, from the published fixture keys. */
const ROLE_OF_ADDRESS: Record<string, string> = Object.fromEntries(
  Object.entries(index.keys as Record<string, { address: string }>).map(([role, k]) => [k.address, role]),
);
/** `jkt:…` thumbprint → address, standing in for §8 key resolution. */
const ADDRESS_OF_THUMBPRINT: Record<string, string> = Object.fromEntries(
  Object.entries(index.keys as Record<string, { address: string; thumbprint: string }>).map(([, k]) => [
    k.thumbprint,
    k.address,
  ]),
);

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const schema = (file: string) => JSON.parse(readFileSync(join(SCHEMAS, file), "utf8"));
const validateCommand = ajv.compile(schema("agreement-command.schema.json"));
const validateReceipt = ajv.compile(schema("transition-receipt.schema.json"));
const validateDomainError = ajv.compile(schema("domain-error.schema.json"));
const fundingSchema = schema("funding-submission.schema.json");
const validateFundingByRole = {
  buyer: ajv.compile({ ...fundingSchema.$defs.buyerSubmission, $defs: fundingSchema.$defs }),
  seller: ajv.compile({ ...fundingSchema.$defs.sellerSubmission, $defs: fundingSchema.$defs }),
};
const errorCatalog = JSON.parse(readFileSync(join(SCHEMAS, "error-catalog.json"), "utf8"));

const text = (b: Uint8Array) => new TextDecoder().decode(b);

/**
 * Assert every member of `expected` that this harness can recompute, skip the
 * listed advisory members, and fail on anything else.
 */
function check(expected: Json, actual: Json, advisory: string[]): void {
  for (const [key, value] of Object.entries(expected)) {
    if (advisory.includes(key)) continue;
    expect(actual, `expected member "${key}" is not computed by this harness`).toHaveProperty(key);
    expect(actual[key], key).toEqual(value);
  }
}

describe("canonical vectors", () => {
  for (const name of cases("canonical")) {
    it(name, () => {
      const input = read("canonical", name, "input.json");
      const expected = read("canonical", name, "expected.json");
      // Contract: strip `signatures` AND any declared derived `termsHash`.
      // Command: strip `signature` only — its `termsHash` is a signed member.
      const isContract = String(input.schema).includes("deal-contract");
      const { signatures: _s, signature: _sig, ...rest } = input;
      if (isContract) delete rest.termsHash;
      const canonical = text(jcs(rest));
      const actual: Json = {
        member: expected.member, // names which derived member the hash feeds; not itself derivable
        canonical,
        hash: sha256Ref(utf8(canonical)),
        ...(input.payload !== undefined ? { commandPayloadHash: payloadHashOf(input.payload) } : {}),
      };
      check(expected, actual, ["note", "sameAs"]);
      if (expected.sameAs) {
        const [otherSet, otherName] = String(expected.sameAs).split("/");
        expect(expected.hash).toEqual(read(otherSet!, otherName!, "expected.json").hash);
      }
    });
  }
});

describe("signing vectors", () => {
  for (const name of cases("signing")) {
    it(name, () => {
      const input = read("signing", name, "input.json");
      const expected = read("signing", name, "expected.json");
      // Reconstruct the preimage from the INPUT's own claim of what was
      // signed; the domain tag comes from the input too, so the cross-tag
      // vectors exercise exactly the substitution they describe.
      const body =
        input.signedValue !== undefined
          ? utf8(String(input.signedValue))
          : (({ signature: _s, ...rest }) => jcs(rest))(input.signedObject as Json);
      const preimage = new Uint8Array([...utf8(String(input.domainTag)), ...body]);
      const recovered = recover(String(input.signature), preimage);
      const actual: Json = {
        valid: recovered !== null && recovered === String(input.claimedSigner).toLowerCase(),
        ...(recovered !== null ? { recoveredAddress: recovered } : {}),
      };
      check(expected, actual, ["note", "reason"]);
    });
  }
});

describe("command vectors", () => {
  for (const name of cases("commands")) {
    it(name, () => {
      const input = read("commands", name, "input.json");
      const expected = read("commands", name, "expected.json");
      // The idempotency-conflict case carries TWO commands (same commandId,
      // divergent bytes); its outcome members are Runtime behaviour, but both
      // wires must still be schema-clean or the conflict never gets that far.
      const wires: Json[] = input.first !== undefined ? [input.first, input.second] : [input];
      const schemaValid = wires.every((w) => validateCommand(w) as boolean);
      const actual: Json = { schemaValid };
      if (schemaValid && wires.length === 1) {
        actual.payloadHash = payloadHashOf(input.payload);
        const recovered = recover(String(input.signature?.sig), commandSigningBytes(input));
        actual.signatureValid = recovered !== null;
        if (recovered !== null) {
          actual.recoveredAddress = recovered;
          actual.actorRole = ROLE_OF_ADDRESS[recovered];
        }
        // §4.2's normative settlement-anchor derivations: the wire keeps the
        // human-meaningful string, the vault receives its keccak256.
        const settlement: Json = {};
        if (input.payload.reasonCode !== undefined)
          settlement.reasonHash = "0x" + toHex(reasonHashWord(String(input.payload.reasonCode)));
        if (input.payload.decisionId !== undefined)
          settlement.decisionId32 = "0x" + toHex(decisionIdWord(String(input.payload.decisionId)));
        if (Object.keys(settlement).length > 0) actual.settlement = settlement;
      }
      check(expected, actual, [
        "note",
        "schemaErrors",
        "currentRevision",
        "outcome",
        "errorCode",
        "firstOutcome",
        "secondOutcome",
      ]);
    });
  }
});

describe("error vectors", () => {
  for (const name of cases("errors")) {
    it(name, () => {
      const input = read("errors", name, "input.json");
      const expected = read("errors", name, "expected.json");
      const schemaValid = validateDomainError(input) as boolean;
      const catalogEntry = (errorCatalog.errors as Json[]).find((e) => e.code === input.code);
      const actual: Json = {
        schemaValid,
        // The expected retriability is the CATALOG's, not the wire's echo —
        // reject-retriable-contradicts-catalog is exactly a wire that lies.
        ...(catalogEntry !== undefined
          ? {
              retriable: catalogEntry.retriable,
              wireMatchesCatalog: catalogEntry.retriable === input.retriable,
            }
          : {}),
      };
      check(expected, actual, ["note", "schemaErrors"]);
    });
  }
});

describe("funding vectors", () => {
  for (const name of cases("funding")) {
    it(name, () => {
      const input = read("funding", name, "input.json");
      const expected = read("funding", name, "expected.json");
      // The actor's role is context resolved from the enclosing envelope's
      // actorAgentId (§6.2.1), which a bare submission fixture does not carry
      // — so the vector's declared role selects the schema branch, and the
      // verdict under that branch is what this harness computes.
      const role = expected.role as "buyer" | "seller";
      const actual: Json = {
        schemaValid: validateFundingByRole[role](input) as boolean,
        role,
      };
      check(expected, actual, ["note", "schemaErrors"]);
    });
  }
});

describe("receipt vectors", () => {
  for (const name of cases("receipts")) {
    it(name, () => {
      const input = read("receipts", name, "input.json");
      const expected = read("receipts", name, "expected.json");
      const actual: Json = { schemaValid: validateReceipt(input) as boolean };
      if (input.runtimeSignature == null) {
        actual.signatureValid = false;
      } else {
        const recovered = recover(String(input.runtimeSignature.sig), receiptSigningBytes(input));
        // §8: the keyId names the only key allowed to have signed; the
        // published fixture index stands in for Identity resolution here.
        const jkt = String(input.runtimeSignature.keyId).split("#")[1] ?? "";
        const authorized = ADDRESS_OF_THUMBPRINT[jkt];
        actual.signatureValid = recovered !== null && recovered === authorized;
        if (recovered !== null) actual.recoveredAddress = recovered;
        if (authorized !== undefined) actual.expectedRuntimeAddress = authorized;
        actual.signedPreimage = text(receiptSignedPreimage(input));
        actual.auditStatusSigned = false; // §4.3: auditStatus is never among the nine signed members
      }
      check(expected, actual, ["note", "reason", "warning", "mustNotBePresentedAsProof", "sameSignatureAs"]);
      if (expected.sameSignatureAs) {
        const [otherSet, otherName] = String(expected.sameSignatureAs).split("/");
        expect(input.runtimeSignature.sig).toEqual(
          read(otherSet!, otherName!, "input.json").runtimeSignature.sig,
        );
      }
    });
  }
});
