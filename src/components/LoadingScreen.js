// src/components/LoadingScreen.js
// Shared full-screen loading indicator used by HomeScreen, ChatScreen, DevicesScreen, etc.

import React from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme';

export default function LoadingScreen({ message = 'Loading...', subMessage }) {
  const colors = useTheme();
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <ActivityIndicator size="large" color={colors.primary} />
      <Text style={[styles.text, { color: colors.textSecondary }]}>{message}</Text>
      {subMessage ? (
        <Text style={[styles.subText, { color: colors.textMuted }]}>{subMessage}</Text>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  text:      { fontSize: 16, marginTop: 12 },
  subText:   { fontSize: 13, marginTop: 6, textAlign: 'center', paddingHorizontal: 24 },
});
