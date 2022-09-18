import { Constants, Utils } from "@solar-network/crypto";

export function toSXP(from: Utils.BigNumber): string {
    const integral = from.dividedBy(Constants.SATOSHI);
    const fraction = from.minus(integral.times(Constants.SATOSHI));

    return integral.toFixed() + '.' + fraction.toFixed();
}
