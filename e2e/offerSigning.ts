import { OFFER_FILL_TEMPLATE } from "@arkade-os/swap";
import {
    signJointGraphForOwner as signCore,
    prepareJointSubmission as prepareCore,
    providerCosignerKey as providerCore,
    submitJointFill as submitCore,
} from "@arkade-taxi/client";
export const signJointGraphForOwner = (args: Omit<Parameters<typeof signCore>[0], "template">) =>
    signCore({ ...args, template: OFFER_FILL_TEMPLATE });
export const prepareJointSubmission = (args: Omit<Parameters<typeof prepareCore>[0], "template">) =>
    prepareCore({ ...args, template: OFFER_FILL_TEMPLATE });
export const providerCosignerKey = (args: Omit<Parameters<typeof providerCore>[0], "template">) =>
    providerCore({ ...args, template: OFFER_FILL_TEMPLATE });
export const submitJointFill = (args: Omit<Parameters<typeof submitCore>[0], "template">) =>
    submitCore({ ...args, template: OFFER_FILL_TEMPLATE });
