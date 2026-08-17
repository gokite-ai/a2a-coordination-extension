/**
 * WHAT A BUYER MAY LOAD.
 *
 * A buyer's protection is arithmetic — the terms document pins the density
 * rule, the generator version and this file's own hash; the manifest
 * publishes the seed; and the corpus is a free public CDC release — so this
 * seller publishes the functions needed to reproduce a delivery, and a buyer
 * driver LOADS them at run time (`SELLER_VERIFIER`-style) after checking this
 * bundle's digest against the `verifierHash` the signed terms pinned. It does
 * not import them, because a buyer that imports one seller's generator can
 * verify one seller — and it never executes an unverified download.
 *
 * Each export is the SAME function the seller itself uses to produce and
 * attest, re-exported and never reimplemented: two implementations of a hash
 * agree until they don't, and the disagreement surfaces as a buyer being told
 * their correct file is wrong.
 *
 * The §4.2 delivery anchor (`deliveryHash` = sha256 of the registered
 * manifest bytes) is deliberately NOT here. Both parties compute it, so it is
 * the Extension's (spec §4.2/§4.4), not the counterparty's.
 */
export { deliverableHeader } from "./engine/synth.js";
export { verifyDelivery } from "./engine/deliver.js";
export { statsCommitment } from "./engine/places.js";
