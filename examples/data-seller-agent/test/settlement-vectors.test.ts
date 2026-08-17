/**
 * Replays the published `settlement` vector set — struct hashes, digests and
 * recoverable signatures for all eight §4.4 structs under both EIP-712
 * domains — against this example's `settlement.ts`.
 *
 * "An implementation that reproduces them can settle; one that cannot has
 * diverged from the vault, whatever else it passes." (§4.4)
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toHex } from "../src/signing.js";
import {
  digest,
  recoverStruct,
  signingPreimage,
  structHash,
  TYPE_STRINGS,
  usdcBaseUnits,
} from "../src/settlement.js";

const VECTORS = fileURLToPath(new URL("../../../vectors/v1/settlement/", import.meta.url));

type Json = Record<string, any>;
const read = (name: string, file: string): Json =>
  JSON.parse(readFileSync(join(VECTORS, name, file), "utf8"));

describe("settlement vectors", () => {
  const names = readdirSync(VECTORS).filter((d) => !d.startsWith("."));
  const structsSeen = new Set<string>();

  for (const name of names) {
    it(name, () => {
      const input = read(name, "input.json");
      const expected = read(name, "expected.json");
      const structName = String(input.typeString).slice(0, String(input.typeString).indexOf("("));
      structsSeen.add(structName);

      // The type string is data in the vector but FROZEN in the spec — a
      // vector using a spelling this implementation does not carry verbatim
      // would mean one of the two has drifted.
      expect(TYPE_STRINGS[structName as keyof typeof TYPE_STRINGS]).toEqual(input.typeString);

      const sh = structHash(input.typeString, input.struct);
      expect("0x" + toHex(sh)).toEqual(expected.structHash);
      expect("0x" + toHex(digest(input.domain, input.typeString, input.struct))).toEqual(expected.digest);

      if (input.signature !== undefined) {
        const recovered = recoverStruct(
          input.signature,
          input.domain,
          input.typeString,
          input.struct,
        );
        expect(recovered !== null && (expected.recoveredAddress === undefined || recovered === expected.recoveredAddress)).toBe(
          expected.valid,
        );
        if (expected.recoveredAddress !== undefined && recovered !== null) {
          expect(recovered).toEqual(expected.recoveredAddress);
        }
      }

      // Pinned derivations the vector carries alongside the struct.
      if (input.struct.amountBaseUnits !== undefined && String(input.struct.amount).includes(".")) {
        expect(usdcBaseUnits(input.struct.amount).toString()).toEqual(input.struct.amountBaseUnits);
      }
      void signingPreimage; // exercised via digest()
    });
  }

  it("covers all eight §4.4 structs", () => {
    expect([...structsSeen].sort()).toEqual(Object.keys(TYPE_STRINGS).sort());
  });

  it('an integer-form contract amount ("25") digests identically to its decimal form ("25.00")', () => {
    // The DealContract schema permits both spellings of one decimal value;
    // the §4.4 conversion happens once and unconditionally, so the Agreement
    // digest must not depend on how the contract spelled it.
    const domain = { name: "KiteFulfill", version: "1", chainId: 2368 };
    const base = {
      agreementId: "deal_0123456789ab",
      termsHash: "sha256:feba188b56c1e0deba060f0284f9e26772f20802a8e95578a3a52d028e6308d4",
      buyerAgent: "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a",
      sellerAgent: "0x1563915e194d8cfba1943570603f7606a3115508",
    };
    const integerForm = digest(domain, TYPE_STRINGS.Agreement, { ...base, amount: "25" });
    const decimalForm = digest(domain, TYPE_STRINGS.Agreement, { ...base, amount: "25.00" });
    expect(toHex(integerForm)).toEqual(toHex(decimalForm));
    // And both equal the vector-pinned base-units encoding.
    const pinned = digest(domain, TYPE_STRINGS.Agreement, { ...base, amount: "25.00", amountBaseUnits: "25000000" });
    expect(toHex(integerForm)).toEqual(toHex(pinned));
  });
});
