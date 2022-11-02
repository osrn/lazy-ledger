// import { Constants, Utils } from "@solar-network/crypto";

// Deprecated. User @solar-crypto/Utils/formatSatoshi instead
// export function toSXP(from: Utils.BigNumber): string {
//     const integral = from.dividedBy(Constants.SATOSHI);
//     let fraction = from.minus(integral.times(Constants.SATOSHI));
//     let sign = "";
//     if (fraction.isNegative) {
//         sign = "-";
//         fraction = fraction.times(-1);
//     }

//     return sign + integral.toFixed() + '.' + padToNDigits(fraction.toFixed(), 8);
// }

export function padToNDigits(num: number, n: number): string {
    return num.toString().padStart(n, '0');
}
  
export function msToHuman(ms: number): string {
    let sec = Math.floor(ms / 1000);
    let min = Math.floor(sec / 60);
    let hr = Math.floor(min / 60);
    
    ms = ms % 1000;
    sec = sec % 60;
    min = min % 60;
    
    return `${hr}h:${padToNDigits(min,2)}m:${padToNDigits(sec,2)}s:${padToNDigits(ms,3)}ms`;
}
