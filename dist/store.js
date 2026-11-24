"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.BridgeStore = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
/** Remembers each bridge's Bond ID and last working address between restarts. */
class BridgeStore {
    file;
    data = {};
    constructor(file) {
        this.file = file;
        try {
            const raw = JSON.parse(node_fs_1.default.readFileSync(file, 'utf8'));
            if (raw && typeof raw === 'object') {
                this.data = raw;
            }
        }
        catch {
            // No file yet, or it is unreadable. Start empty.
        }
    }
    get(configHost) {
        const r = this.data[configHost];
        return r && typeof r.bondId === 'string' && typeof r.lastHost === 'string' ? r : undefined;
    }
    /** Writes to disk only when something changed. */
    set(configHost, record) {
        const old = this.data[configHost];
        if (old && old.bondId === record.bondId && old.lastHost === record.lastHost) {
            return;
        }
        this.data[configHost] = record;
        try {
            node_fs_1.default.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
        }
        catch {
            // Not fatal: the plugin still works, it just will not remember the address.
        }
    }
}
exports.BridgeStore = BridgeStore;
