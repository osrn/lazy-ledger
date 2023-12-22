import { Utils } from "@solar-network/crypto";

// Deprecated. Use @solar-crypto/Utils/formatSatoshi instead
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

/**
 * Convert milliseconds to human readable string in h:m:s:ms format
 * @param ms 
 * @returns h:m:s:ms
 */
export function msToHuman(ms: number): string {
    let sec = Math.floor(ms / 1000);
    let min = Math.floor(sec / 60);
    let hr = Math.floor(min / 60);
    
    ms = ms % 1000;
    sec = sec % 60;
    min = min % 60;
    
    return `${hr}h:${padToNDigits(min,2)}m:${padToNDigits(sec,2)}s:${padToNDigits(ms,3)}ms`;
}

/**
 * Calculates the sum of values in an object array grouped by specified keys
 * @param object_array 
 * @param group_by_keys ['property1', 'property2']
 * @param sum_keys ['property3', 'property4']
 * @returns [{},]
 */
export function objArrayPivotSum(object_array, group_by_keys: string[], sum_keys: string[]) {
    return Object.values(
        object_array.reduce((acc, curr) => {
            const group = group_by_keys.map(k => curr[k]).join('-');
            acc[group] = acc[group] || Object.fromEntries(group_by_keys.map(k => [k, curr[k]]).concat(sum_keys.map(k => [k, 0])));
            // sum_keys.forEach(k => acc[group][k] += curr[k]);
            sum_keys.forEach(k => acc[group][k] = Utils.BigNumber.make(acc[group][k]).plus(curr[k]));
            return acc;
        }, {})
    );
}
