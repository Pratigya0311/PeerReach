import React, { useMemo, useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useTheme, useThemeCtx } from '../theme';
import BridgefyService from '../services/BridgefyService';
import { DISPLAY_NAME_KEY, SHOW_SOS_FINDME_KEY } from '../constants/storageKeys';

const THEME_OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light',  label: 'Light' },
  { value: 'dark',   label: 'Dark' },
];

const SettingsScreen = () => {
  const colors = useTheme();
  const { themePref, setThemePref } = useThemeCtx();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [displayName, setDisplayName]       = useState('');
  const [saving, setSaving]                 = useState(false);
  const [showSosFindMe, setShowSosFindMe]   = useState(true);

  useEffect(() => {
    setDisplayName(BridgefyService.getDisplayName() || '');
    AsyncStorage.getItem(SHOW_SOS_FINDME_KEY).then(val => {
      if (val !== null) setShowSosFindMe(val !== 'false');
    }).catch(() => {});
  }, []);

  const saveDisplayName = async () => {
    const trimmed = displayName.trim();
    if (!trimmed) { Alert.alert('Name required', 'Please enter a display name.'); return; }
    setSaving(true);
    try {
      await BridgefyService.setDisplayName(trimmed);
      Alert.alert('Saved', 'Your display name has been updated.');
    } catch (_e) {
      Alert.alert('Error', 'Could not save display name.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">

        {/* Display name */}
        <Text style={styles.sectionHeader}>Profile</Text>
        <View style={styles.card}>
          <Text style={styles.rowLabel}>Display name</Text>
          <Text style={styles.rowHint}>This is how you appear to other devices on the mesh.</Text>
          <TextInput
            style={styles.nameInput}
            value={displayName}
            onChangeText={setDisplayName}
            placeholder="Enter your display name"
            placeholderTextColor={colors.placeholder}
            maxLength={32}
            returnKeyType="done"
            onSubmitEditing={saveDisplayName}
          />
          <TouchableOpacity
            style={[styles.saveBtn, (!displayName.trim() || saving) && styles.saveBtnDisabled]}
            onPress={saveDisplayName}
            disabled={!displayName.trim() || saving}
          >
            {saving
              ? <ActivityIndicator size="small" color="#fff" />
              : <Text style={styles.saveBtnText}>Save</Text>
            }
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.resetBtn}
            onPress={() =>
              Alert.alert('Reset display name', 'This will clear your saved name and ask again on the next app open.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Reset', style: 'destructive', onPress: async () => {
                  await AsyncStorage.removeItem(DISPLAY_NAME_KEY);
                  setDisplayName('');
                  Alert.alert('Done', 'Display name cleared. Re-open the app to set a new name.');
                }},
              ])
            }
          >
            <Text style={styles.resetBtnText}>Reset display name</Text>
          </TouchableOpacity>
        </View>

        {/* Privacy */}
        <Text style={styles.sectionHeader}>Privacy</Text>
        <View style={styles.card}>
          <View style={styles.switchRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowLabel}>Show SOS & Find Me</Text>
              <Text style={styles.rowHint}>Show emergency SOS and Find Me buttons in the chat attach menu.</Text>
            </View>
            <Switch
              value={showSosFindMe}
              onValueChange={val => {
                setShowSosFindMe(val);
                AsyncStorage.setItem(SHOW_SOS_FINDME_KEY, val ? 'true' : 'false').catch(() => {});
              }}
              trackColor={{ false: colors.border, true: colors.primary }}
              thumbColor="#fff"
            />
          </View>
        </View>

        {/* Theme */}
        <Text style={styles.sectionHeader}>Appearance</Text>
        <View style={styles.card}>
          <Text style={styles.rowLabel}>Theme</Text>
          <View style={styles.optionRow}>
            {THEME_OPTIONS.map(opt => {
              const selected = themePref === opt.value;
              return (
                <TouchableOpacity
                  key={opt.value}
                  style={[styles.optionBtn, selected && styles.optionBtnSelected]}
                  onPress={() => setThemePref(opt.value)}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.optionText, selected && styles.optionTextSelected]}>
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

      </ScrollView>
    </SafeAreaView>
  );
};

const makeStyles = (colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content:   { padding: 16 },

  sectionHeader: {
    fontSize: 13, fontWeight: '600', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.5,
    marginBottom: 8, marginLeft: 4,
  },

  card: {
    backgroundColor: colors.surface, borderRadius: 12,
    padding: 16, marginBottom: 24,
    borderWidth: 1, borderColor: colors.border,
  },

  rowLabel: { fontSize: 15, fontWeight: '600', color: colors.text, marginBottom: 4 },
  rowHint:  { fontSize: 13, color: colors.textMuted, marginBottom: 12, lineHeight: 18 },

  nameInput: {
    backgroundColor: colors.surfaceVariant,
    borderRadius: 8, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 15, color: colors.text, marginBottom: 12,
  },

  saveBtn: {
    backgroundColor: colors.primary, borderRadius: 8,
    paddingVertical: 11, alignItems: 'center',
  },
  saveBtnDisabled: { backgroundColor: colors.border },
  saveBtnText: { color: '#fff', fontWeight: '600', fontSize: 15 },

  resetBtn:     { marginTop: 10, alignItems: 'center', paddingVertical: 8 },
  resetBtnText: { color: colors.error, fontSize: 13, fontWeight: '500' },

  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },

  optionRow: { flexDirection: 'row', gap: 8 },
  optionBtn: {
    flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: 'center',
    backgroundColor: colors.surfaceVariant,
    borderWidth: 1, borderColor: colors.border,
  },
  optionBtnSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  optionText:         { fontSize: 13, fontWeight: '500', color: colors.textSecondary },
  optionTextSelected: { color: '#FFFFFF', fontWeight: '600' },
});

export default SettingsScreen;
