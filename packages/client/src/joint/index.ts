export {
    assertDefaultTapScriptSigs,
    assertSameUnsignedTx,
    assertUnsignedPsbt,
    setTapScriptSigEntries,
    tapLeavesOfInput,
    tapScriptSigEntries,
    unsignedPsbtBytes,
    type TapLeafRef,
    type TapScriptSigEntry,
} from "./arkTransaction.js";
export { deepFreeze, digestJointGraph, verifyJointGraph, type JointGraph } from "./jointGraph.js";
// The generic signer takes an explicit template; offerFillSigning binds ours.
export {
    JointSigningError,
    JointSubmissionAmbiguousError,
    type JointPins,
    type JointSignerBinding,
    type PreparedJointSubmission,
    type SubmittedJointFill,
} from "./jointSigning.js";
export {
    prepareJointSubmission,
    providerCosignerKey,
    signJointGraphForOwner,
    submitJointFill,
    type JointFundingOwner,
    type JointOwnerKeys,
} from "./offerFillSigning.js";
export {
    buildOfferFillPlan,
    verifyOfferFillPlan,
    OFFER_FILL_OWNERS,
    OFFER_FILL_TEMPLATE,
    type BuildOfferFillPlanOpts,
    type FillSponsor,
    type FillSponsorFare,
} from "./offerFillPlan.js";
