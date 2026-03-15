// src/screens/MeshQueryScreen.js
import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHeaderHeight } from '@react-navigation/elements';
import gatewayService from '../services/GatewayService';
import { useTheme } from '../theme';

const STATUS = {
  IDLE:         'idle',
  CHECKING:     'checking',
  SEARCHING:    'searching',
  WAITING_MESH: 'waiting_mesh',
  DONE:         'done',
  ERROR:        'error',
};

const MeshQueryScreen = ({ navigation }) => {
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();

  const [query, setQuery]             = useState('');
  const [status, setStatus]           = useState(STATUS.IDLE);
  const [results, setResults]         = useState([]);
  const [isGateway, setIsGateway]     = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    navigation.setOptions({ title: 'Ask the Mesh' });

    gatewayService.checkInternet()
      .then(setIsGateway)
      .catch(err => { console.error('Failed to check internet:', err); setIsGateway(false); });

    gatewayService.getCacheHistory()
      .then(history => {
        setResults(history.map(h => ({
          query: h.query, result: h.result,
          source: 'cache', timestamp: h.timestamp,
        })));
      })
      .catch(err => console.error('Failed to load cache history:', err));

    gatewayService.setOnQueryResultCallback(({ result, query: q, delayed }) => {
      if (delayed) {
        setResults(prev => [
          { query: q, result, source: 'mesh (delayed)', timestamp: Date.now() },
          ...prev,
        ]);
        setPendingCount(gatewayService.getPendingQueueCount());
        Alert.alert(
          'Delayed Response',
          `Your queued query "${q}" was answered:\n\n${result}`,
          [{ text: 'OK' }]
        );
      }
    });

    return () => { gatewayService.setOnQueryResultCallback(null); };
  }, [navigation]);

  const handleSend = async () => {
    const q = query.trim();
    if (!q || status === STATUS.SEARCHING || status === STATUS.WAITING_MESH) return;

    setStatus(STATUS.CHECKING);
    try {
      const { result, source } = await gatewayService.sendQuery(q, (hasInternet) => {
        setIsGateway(hasInternet);
        setStatus(hasInternet ? STATUS.SEARCHING : STATUS.WAITING_MESH);
      });
      setResults(prev => [{ query: q, result, source, timestamp: Date.now() }, ...prev]);
      setQuery('');
      setStatus(STATUS.DONE);
    } catch (err) {
      if (err.message === 'NO_GATEWAY_NEARBY') {
        setPendingCount(gatewayService.getPendingQueueCount());
        setResults(prev => [{
          query: q,
          result: 'No gateway found nearby. Your request has been queued and will be answered automatically when a device with internet comes into range.',
          source: 'queued',
          timestamp: Date.now(),
        }, ...prev]);
        setQuery('');
        setStatus(STATUS.DONE);
      } else {
        setStatus(STATUS.ERROR);
        Alert.alert('Error', err.message || 'Query failed');
      }
    }
  };

  const getStatusText = () => {
    switch (status) {
      case STATUS.CHECKING:     return 'Checking connectivity...';
      case STATUS.SEARCHING:    return 'Searching the internet...';
      case STATUS.WAITING_MESH: return 'Broadcasting through mesh... waiting for a gateway...';
      case STATUS.ERROR:        return 'Something went wrong';
      default:                  return '';
    }
  };

  const getSourceBadge = (source) => {
    switch (source) {
      case 'internet':       return { label: 'Internet',       color: colors.success };
      case 'cache':          return { label: 'Cached',         color: colors.primary };
      case 'mesh':           return { label: 'Via Mesh',       color: colors.warning };
      case 'mesh (delayed)': return { label: 'Mesh (delayed)', color: colors.warning };
      case 'queued':         return { label: 'Queued',         color: colors.textMuted };
      default:               return { label: source,           color: colors.textMuted };
    }
  };

  const isLoading =
    status === STATUS.CHECKING ||
    status === STATUS.SEARCHING ||
    status === STATUS.WAITING_MESH;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior="padding"
      keyboardVerticalOffset={headerHeight}
    >
      <SafeAreaView style={styles.safe} edges={['top']}>
        {/* Status bar */}
        <View style={[styles.statusBar, isGateway ? styles.statusBarGateway : styles.statusBarRelay]}>
          <View style={styles.statusBarLeft}>
            <View style={[styles.statusDot, isGateway ? styles.dotGateway : styles.dotRelay]} />
            <Text style={styles.statusBarText}>
              {isGateway ? 'Gateway — you have internet' : 'Relay — using mesh to reach internet'}
            </Text>
          </View>
          {pendingCount > 0 && (
            <Text style={styles.pendingText}>{pendingCount} queued</Text>
          )}
        </View>

        {/* Results */}
        <ScrollView
          style={styles.results}
          contentContainerStyle={styles.resultsContent}
          keyboardShouldPersistTaps="handled"
        >
          {isLoading && (
            <View style={styles.loadingCard}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={styles.loadingText}>{getStatusText()}</Text>
            </View>
          )}

          {results.length === 0 && !isLoading && (
            <View style={styles.emptyState}>
              <View style={styles.emptyIconCircle} />
              <Text style={styles.emptyTitle}>Ask anything</Text>
              <Text style={styles.emptySubtitle}>
                {isGateway
                  ? 'You have internet — queries run directly.'
                  : 'No internet? Nearby devices with internet will answer your query through the mesh.'}
              </Text>
              <Text style={styles.exampleLabel}>Example queries:</Text>
              {['capital of france', 'weather bangalore', 'speed of light', 'what is bitcoin'].map(ex => (
                <TouchableOpacity key={ex} onPress={() => setQuery(ex)}>
                  <Text style={styles.exampleItem}>- {ex}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {results.map((item, index) => {
            const badge = getSourceBadge(item.source);
            return (
              <View key={`${item.timestamp}_${index}`} style={styles.resultCard}>
                <View style={styles.resultHeader}>
                  <Text style={styles.resultQuery} numberOfLines={2}>{item.query}</Text>
                  <View style={[styles.sourceBadge, { backgroundColor: badge.color }]}>
                    <Text style={styles.sourceBadgeText}>{badge.label}</Text>
                  </View>
                </View>
                <Text style={styles.resultText}>{item.result}</Text>
                <Text style={styles.resultTime}>
                  {new Date(item.timestamp).toLocaleTimeString([], {
                    hour: '2-digit', minute: '2-digit', hour12: true,
                  })}
                </Text>
              </View>
            );
          })}
        </ScrollView>

        {/* Input bar */}
        <View style={[styles.inputBar, { paddingBottom: Math.max(insets.bottom, 8) }]}>
          <TextInput
            ref={inputRef}
            style={styles.input}
            placeholder="Ask anything..."
            placeholderTextColor={colors.placeholder}
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={handleSend}
            returnKeyType="search"
            editable={!isLoading}
            maxLength={200}
          />
          <TouchableOpacity
            style={[styles.sendBtn, (!query.trim() || isLoading) && styles.sendBtnDisabled]}
            onPress={handleSend}
            disabled={!query.trim() || isLoading}
          >
            {isLoading
              ? <ActivityIndicator size="small" color={colors.onColor} />
              : <Text style={styles.sendBtnText}>Ask</Text>
            }
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
};

// ─── Styles (theme-aware) ────────────────────────────────────────────────────
const makeStyles = (colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  safe:      { flex: 1 },

  statusBar: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', paddingHorizontal: 16, paddingVertical: 8,
  },
  statusBarGateway: { backgroundColor: colors.statusBarGateway },
  statusBarRelay:   { backgroundColor: colors.statusBarRelay },
  statusBarLeft:    { flexDirection: 'row', alignItems: 'center' },
  statusDot:        { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  dotGateway:       { backgroundColor: colors.success },
  dotRelay:         { backgroundColor: colors.warning },
  statusBarText:    { fontSize: 13, fontWeight: '500', color: colors.statusBarText },
  pendingText:      { fontSize: 12, color: colors.warning, fontWeight: '600' },

  results:        { flex: 1 },
  resultsContent: { padding: 16, paddingBottom: 8 },

  loadingCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 12, padding: 16, marginBottom: 12, gap: 10,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08, shadowRadius: 3, elevation: 2,
  },
  loadingText: { fontSize: 14, color: colors.textSecondary, flex: 1 },

  emptyState:    { alignItems: 'center', paddingVertical: 40 },
  emptyIconCircle: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: colors.emptyCircle, marginBottom: 12,
  },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: colors.text, marginBottom: 8 },
  emptySubtitle: {
    fontSize: 14, color: colors.textMuted, textAlign: 'center',
    lineHeight: 20, marginBottom: 24, paddingHorizontal: 20,
  },
  exampleLabel: { fontSize: 13, color: colors.textMuted, marginBottom: 8, fontWeight: '600' },
  exampleItem:  { fontSize: 14, color: colors.primary, marginBottom: 6 },

  resultCard: {
    backgroundColor: colors.surface,
    borderRadius: 12, padding: 16, marginBottom: 12,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08, shadowRadius: 3, elevation: 2,
  },
  resultHeader: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'flex-start', marginBottom: 8,
  },
  resultQuery: { fontSize: 14, fontWeight: '700', color: colors.text, flex: 1, marginRight: 8 },
  sourceBadge: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  sourceBadgeText: { color: colors.onColor, fontSize: 11, fontWeight: '600' },
  resultText: { fontSize: 15, color: colors.textSecondary, lineHeight: 22 },
  resultTime: { fontSize: 11, color: colors.textMuted, marginTop: 8, textAlign: 'right' },

  inputBar: {
    flexDirection: 'row', padding: 12,
    backgroundColor: colors.surface,
    borderTopWidth: 1, borderTopColor: colors.border,
    alignItems: 'center',
  },
  input: {
    flex: 1, backgroundColor: colors.surfaceVariant,
    borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10,
    fontSize: 15, marginRight: 8, minHeight: 40,
    color: colors.text,
  },
  sendBtn: {
    backgroundColor: colors.primary,
    borderRadius: 20, paddingHorizontal: 20, paddingVertical: 10,
    minWidth: 56, alignItems: 'center', justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: colors.border },
  sendBtnText:     { color: colors.onColor, fontWeight: '700', fontSize: 15 },
});

export default MeshQueryScreen;
