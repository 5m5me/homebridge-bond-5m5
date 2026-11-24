import type { API } from 'homebridge';
import { Bond5m5Platform } from './platform';
import { PLATFORM_NAME } from './settings';

export = (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, Bond5m5Platform);
};
