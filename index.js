/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';
import LogService from './src/services/LogService';

// Must be first — intercepts console before any other module runs
LogService.init();

// Catch any unhandled fatal JS error (including module-load crashes)
// and persist it so it shows in the Logs screen on next open
const _origHandler = ErrorUtils.getGlobalHandler();
ErrorUtils.setGlobalHandler((error, isFatal) => {
  const tag = isFatal ? 'FATAL' : 'UNCAUGHT';
  console.error(`[${tag}] ${error?.name}: ${error?.message}\n${error?.stack || ''}`);
  _origHandler(error, isFatal);
});

AppRegistry.registerComponent(appName, () => App);
