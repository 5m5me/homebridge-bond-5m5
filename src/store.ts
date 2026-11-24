import fs from 'node:fs';

export interface BridgeRecord {
  bondId: string;
  lastHost: string;
}

/** Remembers each bridge's Bond ID and last working address between restarts. */
export class BridgeStore {
  private data: Record<string, BridgeRecord> = {};

  constructor(private readonly file: string) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, BridgeRecord>;
      if (raw && typeof raw === 'object') {
        this.data = raw;
      }
    } catch {
      // No file yet, or it is unreadable. Start empty.
    }
  }

  get(configHost: string): BridgeRecord | undefined {
    const r = this.data[configHost];
    return r && typeof r.bondId === 'string' && typeof r.lastHost === 'string' ? r : undefined;
  }

  /** Writes to disk only when something changed. */
  set(configHost: string, record: BridgeRecord): void {
    const old = this.data[configHost];
    if (old && old.bondId === record.bondId && old.lastHost === record.lastHost) {
      return;
    }
    this.data[configHost] = record;
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch {
      // Not fatal: the plugin still works, it just will not remember the address.
    }
  }
}
