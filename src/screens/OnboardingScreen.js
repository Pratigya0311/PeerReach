// src/screens/OnboardingScreen.js
import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity,
  StyleSheet, Keyboard, ActivityIndicator, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Icon from 'react-native-vector-icons/MaterialIcons';
import BridgefyService from '../services/BridgefyService';
import { useTheme } from '../theme';
import { DISPLAY_NAME_KEY } from '../constants/storageKeys';

const OnboardingScreen = ({ navigation }) => {
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [nameInput, setNameInput]   = useState('');
  const [checking, setChecking]     = useState(true);
  const [kbHeight, setKbHeight]     = useState(0);

  // If a name is already saved, skip straight to Home
  useEffect(() => {
    AsyncStorage.getItem(DISPLAY_NAME_KEY).then(saved => {
      if (saved && saved.trim()) {
        navigation.replace('Home');
      } else {
        setChecking(false);
      }
    }).catch(() => setChecking(false));
  }, [navigation]);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', e => setKbHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKbHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  const handleContinue = async () => {
    const trimmed = nameInput.trim();
    if (!trimmed) return;
    try {
      await BridgefyService.setDisplayName(trimmed);
      navigation.replace('Home');
    } catch (err) {
      Alert.alert('Error', 'Could not save your name. Please try again.');
    }
  };

  if (checking) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { paddingBottom: kbHeight }]}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.content}>
          {/* Logo area */}
          <View style={styles.logoArea}>
            <View style={styles.logoCircle}>
              <Icon name="hub" size={48} color="#fff" />
            </View>
            <Text style={styles.appName}>PeerReach</Text>
            <Text style={styles.tagline}>Mesh communication, no internet needed</Text>
          </View>

          {/* Card */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>What's your name?</Text>
            <Text style={styles.cardSubtitle}>
              This is how other devices on the mesh will see you.
            </Text>
            <TextInput
              style={styles.input}
              placeholder="Enter your name"
              placeholderTextColor={colors.placeholder}
              value={nameInput}
              onChangeText={setNameInput}
              maxLength={32}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={handleContinue}
            />
            <TouchableOpacity
              style={[styles.btn, !nameInput.trim() && styles.btnDisabled]}
              onPress={handleContinue}
              disabled={!nameInput.trim()}
            >
              <Text style={styles.btnText}>Get Started</Text>
            </TouchableOpacity>
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
};

const makeStyles = (colors) => StyleSheet.create({
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background },
  container:        { flex: 1, backgroundColor: colors.background },
  safe:             { flex: 1 },
  content: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 32,
  },

  logoArea:   { alignItems: 'center', gap: 12 },
  logoCircle: {
    width: 88, height: 88, borderRadius: 44,
    backgroundColor: colors.primary,
    justifyContent: 'center', alignItems: 'center',
    shadowColor: colors.primary, shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35, shadowRadius: 12, elevation: 8,
  },
  appName:  { fontSize: 30, fontWeight: '800', color: colors.text, letterSpacing: -0.5 },
  tagline:  { fontSize: 14, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },

  card: {
    backgroundColor: colors.surface,
    borderRadius: 16, padding: 24,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08, shadowRadius: 8, elevation: 3,
  },
  cardTitle:    { fontSize: 20, fontWeight: '700', color: colors.text, marginBottom: 6 },
  cardSubtitle: { fontSize: 14, color: colors.textMuted, marginBottom: 20, lineHeight: 20 },

  input: {
    backgroundColor: colors.surfaceVariant,
    borderRadius: 8, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 16, color: colors.text, marginBottom: 16,
  },
  btn: {
    backgroundColor: colors.primary,
    borderRadius: 8, paddingVertical: 13, alignItems: 'center',
  },
  btnDisabled: { backgroundColor: colors.border },
  btnText:     { color: '#fff', fontWeight: '700', fontSize: 16 },
});

export default OnboardingScreen;
