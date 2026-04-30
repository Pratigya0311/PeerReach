// src/utils/permissions.js
// Shared permission helpers for Android runtime permissions.

import { Platform, PermissionsAndroid, Alert } from 'react-native';

/**
 * Requests ACCESS_FINE_LOCATION on Android.
 * On iOS always resolves true (permissions handled at OS level).
 * Shows an Alert with `deniedMessage` if the user denies.
 * Returns true if granted, false otherwise.
 */
export async function requestLocationPermission(deniedMessage = 'Location permission is required.') {
  if (Platform.OS !== 'android') return true;
  try {
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      {
        title: 'Location Permission',
        message: 'PeerReach needs location access to share your position.',
        buttonPositive: 'Allow',
        buttonNegative: 'Deny',
      }
    );
    if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
      Alert.alert('Permission denied', deniedMessage);
      return false;
    }
    return true;
  } catch (_e) {
    Alert.alert('Permission error', deniedMessage);
    return false;
  }
}

/**
 * Requests all Bluetooth + location permissions needed by Bridgefy on Android 12+.
 * Returns true only if every required permission is granted.
 */
export async function requestBridgefyPermissions() {
  if (Platform.OS !== 'android') return true;
  try {
    if (Platform.Version >= 31) {
      const result = await PermissionsAndroid.requestMultiple([
        'android.permission.BLUETOOTH_SCAN',
        'android.permission.BLUETOOTH_CONNECT',
        'android.permission.BLUETOOTH_ADVERTISE',
        'android.permission.ACCESS_FINE_LOCATION',
      ]);
      return (
        result['android.permission.BLUETOOTH_CONNECT'] === 'granted' &&
        result['android.permission.BLUETOOTH_SCAN']    === 'granted' &&
        result['android.permission.BLUETOOTH_ADVERTISE'] === 'granted' &&
        result['android.permission.ACCESS_FINE_LOCATION'] === 'granted'
      );
    }
    const granted = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
    );
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  } catch (_e) {
    return false;
  }
}
