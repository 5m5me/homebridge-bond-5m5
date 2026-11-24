"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.probeBondId = void 0;
exports.isPrivateIPv4 = isPrivateIPv4;
exports.scanTargets = scanTargets;
exports.locateBridge = locateBridge;
const bondClient_1 = require("./bondClient");
function isPrivateIPv4(ip) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
    if (!m) {
        return false;
    }
    const [a, b] = [Number(m[1]), Number(m[2])];
    if ([1, 2, 3, 4].some(i => Number(m[i]) > 255)) {
        return false;
    }
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
/** Every address in the /24 of a private IPv4 address. Empty for anything else. */
function scanTargets(lastHost) {
    const { hostname } = (0, bondClient_1.splitHost)(lastHost);
    if (!isPrivateIPv4(hostname)) {
        return [];
    }
    const prefix = hostname.split('.').slice(0, 3).join('.');
    const out = [];
    for (let i = 1; i <= 254; i++) {
        out.push(`${prefix}.${i}`);
    }
    return out;
}
/** Asks a host for its Bond ID. Needs no token. */
const probeBondId = async (host) => {
    try {
        const v = await (0, bondClient_1.rawRequest)(host, 'GET', '/v2/sys/version', undefined, undefined, 1200);
        return typeof v.bondid === 'string' ? v.bondid : undefined;
    }
    catch {
        return undefined;
    }
};
exports.probeBondId = probeBondId;
/**
 * Finds where a bridge with this Bond ID is answering now.
 * Tries the likely addresses first, then every address on the last known /24 network.
 */
async function locateBridge(bondId, likely, lastHost, probe = exports.probeBondId, parallel = 32) {
    const same = (id) => !!id && id.toLowerCase() === bondId.toLowerCase();
    const seen = new Set();
    for (const host of likely) {
        if (host && !seen.has(host)) {
            seen.add(host);
            if (same(await probe(host))) {
                return host;
            }
        }
    }
    const targets = scanTargets(lastHost).filter(h => !seen.has(h));
    let found;
    let next = 0;
    const worker = async () => {
        while (found === undefined && next < targets.length) {
            const host = targets[next++];
            if (same(await probe(host))) {
                found = host;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, targets.length) }, worker));
    return found;
}
