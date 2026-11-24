import { DeviceCore } from './deviceCore';

/** A device as shown in Apple Home through one connection type. */
export interface Published {
  /** The device changed in the Bond app. Rebuild what is shown. */
  reconfigure(): Promise<void>;
  remove(): Promise<void>;
}

/** Shows devices over one connection type (HomeKit or Matter). */
export interface Publisher {
  readonly label: string;
  publish(bondId: string, core: DeviceCore): Promise<Published>;
  /** Removes remembered tiles of this bridge whose device no longer exists. */
  removeStale(bondId: string, liveDeviceIds: string[]): Promise<void>;
  /** Removes remembered tiles that belong to a bridge not in the list. */
  removeOrphans(bondIds: string[]): Promise<void>;
  /** Removes everything this publisher ever showed. Used when the other connection type is chosen. */
  removeAll(): Promise<number>;
}
