import { rawRequest, splitHost } from './bondClient';

export function isPrivateIPv4(ip: string): boolean {
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
export function scanTargets(lastHost: string): string[] {
  const { hostname } = splitHost(lastHost);
  if (!isPrivateIPv4(hostname)) {
    return [];
  }
  const prefix = hostname.split('.').slice(0, 3).join('.');
  const out: string[] = [];
  for (let i = 1; i <= 254; i++) {
    out.push(`${prefix}.${i}`);
  }
  return out;
}

export type Probe = (host: string) => Promise<string | undefined>;

/** Asks a host for its Bond ID. Needs no token. */
export const probeBondId: Probe = async host => {
  try {
    const v = await rawRequest(host, 'GET', '/v2/sys/version', undefined, undefined, 1200) as Record<string, unknown>;
    return typeof v.bondid === 'string' ? v.bondid : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Finds where a bridge with this Bond ID is answering now.
 * Tries the likely addresses first, then every address on the last known /24 network.
 */
export async function locateBridge(
  bondId: string, likely: string[], lastHost: string, probe: Probe = probeBondId, parallel = 32,
): Promise<string | undefined> {
  const same = (id: string | undefined): boolean => !!id && id.toLowerCase() === bondId.toLowerCase();
  const seen = new Set<string>();
  for (const host of likely) {
    if (host && !seen.has(host)) {
      seen.add(host);
      if (same(await probe(host))) {
        return host;
      }
    }
  }
  const targets = scanTargets(lastHost).filter(h => !seen.has(h));
  let found: string | undefined;
  let next = 0;
  const worker = async (): Promise<void> => {
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
