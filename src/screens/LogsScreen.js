// src/screens/LogsScreen.js
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import LogService from '../services/LogService';
import { useTheme } from '../theme';

const LogsScreen = () => {
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [logs, setLogs]     = useState([]);
  const [filter, setFilter] = useState('ALL'); // ALL | ERR | WRN | SYS
  const listRef = useRef(null);

  const reload = useCallback(() => {
    setLogs(LogService.getLogs());
  }, []);

  useFocusEffect(useCallback(() => { reload(); }, [reload]));

  // Auto-refresh every 2 s while screen is open
  useEffect(() => {
    const t = setInterval(reload, 2000);
    return () => clearInterval(t);
  }, [reload]);

  const filtered = useMemo(() => {
    if (filter === 'ALL') return logs;
    return logs.filter(l => l.includes(`] ${filter} `));
  }, [logs, filter]);

  const levelColor = (line) => {
    if (line.includes('] ERR ')) return colors.error;
    if (line.includes('] WRN ')) return colors.warning;
    if (line.includes('] SYS ')) return colors.primary;
    return colors.text;
  };

  const handleShare = async () => {
    try {
      await LogService.shareLogs();
    } catch (e) {
      Alert.alert('Share failed', e?.message || 'Could not share logs.');
    }
  };

  const handleClear = () => {
    Alert.alert('Clear Logs', 'Delete all saved logs?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: async () => {
        await LogService.clearLogs();
        setLogs([]);
      }},
    ]);
  };

  const FILTERS = ['ALL', 'ERR', 'WRN', 'LOG', 'SYS'];

  return (
    <SafeAreaView style={styles.container}>
      {/* Filter tabs */}
      <View style={styles.filterRow}>
        {FILTERS.map(f => (
          <TouchableOpacity
            key={f}
            style={[styles.filterBtn, filter === f && styles.filterBtnActive]}
            onPress={() => setFilter(f)}
          >
            <Text style={[styles.filterText, filter === f && styles.filterTextActive]}>{f}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Log list */}
      <FlatList
        ref={listRef}
        data={filtered}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={styles.list}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        renderItem={({ item }) => (
          <Text style={[styles.logLine, { color: levelColor(item) }]} selectable>
            {item}
          </Text>
        )}
        ListEmptyComponent={
          <Text style={styles.empty}>No logs yet.</Text>
        }
      />

      {/* Bottom actions */}
      <View style={styles.actions}>
        <TouchableOpacity style={[styles.btn, styles.btnRefresh]} onPress={reload}>
          <Text style={styles.btnText}>Refresh</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.btn, styles.btnShare]} onPress={handleShare}>
          <Text style={styles.btnText}>Share</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.btn, styles.btnClear]} onPress={handleClear}>
          <Text style={styles.btnText}>Clear</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
};

const makeStyles = (colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  filterRow: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  filterBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    marginRight: 6,
    backgroundColor: colors.surfaceVariant,
  },
  filterBtnActive: { backgroundColor: colors.primary },
  filterText: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  filterTextActive: { color: colors.onColor },

  list: { padding: 10 },
  logLine: {
    fontFamily: Platform.select({ ios: 'Courier', android: 'monospace', default: 'monospace' }),
    fontSize: 11,
    lineHeight: 16,
    marginBottom: 2,
  },
  empty: { fontSize: 14, color: colors.textMuted, textAlign: 'center', marginTop: 40 },

  actions: {
    flexDirection: 'row',
    padding: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    gap: 8,
  },
  btn: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: 'center' },
  btnRefresh: { backgroundColor: colors.primary },
  btnShare:   { backgroundColor: colors.success },
  btnClear:   { backgroundColor: colors.error },
  btnText:    { color: colors.onColor, fontSize: 14, fontWeight: '600' },
});

export default LogsScreen;
