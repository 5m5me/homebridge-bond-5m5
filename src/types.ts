export type BondState = Record<string, unknown>;

export interface BondDevice {
  id: string;
  name: string;
  type: string;
  location?: string;
  template?: string;
  actions: string[];
  properties: Record<string, unknown>;
  state: BondState;
  hash?: string;
}

export interface BondAction {
  name: string;
  argument?: number;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}
