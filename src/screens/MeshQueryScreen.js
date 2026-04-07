// src/screens/MeshQueryScreen.js
import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Keyboard,
  Alert,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import gatewayService from '../services/GatewayService';
import BridgefyService from '../services/BridgefyService';
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
  const [query, setQuery]             = useState('');
  const [status, setStatus]           = useState(STATUS.IDLE);
  const [results, setResults]         = useState([]);
  const [isGateway, setIsGateway]     = useState(false);
  const [peerCount, setPeerCount]     = useState(() => BridgefyService.connectedDevices?.size ?? 0);
  const [pendingCount, setPendingCount] = useState(0);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', e => setKeyboardHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  useEffect(() => {
    navigation.setOptions({ title: 'Ask the Mesh' });

    const refreshStatus = () => {
      setPeerCount(BridgefyService.connectedDevices?.size ?? 0);
      setPendingCount(gatewayService.getPendingQueueCount());
      gatewayService.checkInternet()
        .then(setIsGateway)
        .catch(() => setIsGateway(false));
    };
    refreshStatus();
    const statusInterval = setInterval(refreshStatus, 10000);

    gatewayService.setOnQueryResultCallback(({ result, query: q, delayed }) => {
      if (delayed) {
        setResults(prev => {
          const next = [{ query: q, result, source: 'mesh (delayed)', timestamp: Date.now() }, ...prev];
          return next.length > 50 ? next.slice(0, 50) : next;
        });
        setPendingCount(gatewayService.getPendingQueueCount());
        Alert.alert(
          'Delayed Response',
          `Your queued query "${q}" was answered:\n\n${result}`,
          [{ text: 'OK' }]
        );
      }
    });

    return () => {
      clearInterval(statusInterval);
      gatewayService.setOnQueryResultCallback(null);
    };
  }, [navigation]);

  const handleSend = async () => {
    const q = query.trim();
    if (!q || status === STATUS.SEARCHING || status === STATUS.WAITING_MESH) return;

    setStatus(STATUS.CHECKING);
    try {
      const { result, source } = await gatewayService.sendQuery(q, (hasInternet) => {
        setIsGateway(hasInternet);
        setPeerCount(BridgefyService.connectedDevices?.size ?? 0);
        setStatus(hasInternet ? STATUS.SEARCHING : STATUS.WAITING_MESH);
      });
      setResults(prev => {
        const next = [{ query: q, result, source, timestamp: Date.now() }, ...prev];
        return next.length > 50 ? next.slice(0, 50) : next; // cap list at 50 items
      });
      setQuery('');
      setStatus(STATUS.DONE);
    } catch (err) {
      if (err.message === 'NO_GATEWAY_NEARBY') {
        setPendingCount(gatewayService.getPendingQueueCount());
        setResults(prev => {
          const next = [{
            query: q,
            result: 'No gateway found nearby. Your request has been queued and will be answered automatically when a device with internet comes into range.',
            source: 'queued',
            timestamp: Date.now(),
          }, ...prev];
          return next.length > 50 ? next.slice(0, 50) : next;
        });
        setQuery('');
        setStatus(STATUS.DONE);
      } else {
        // Reset to IDLE when user dismisses so they can retry immediately
        Alert.alert('Error', err.message || 'Query failed', [
          { text: 'OK', onPress: () => setStatus(STATUS.IDLE) },
        ]);
        setStatus(STATUS.ERROR);
      }
    }
  };

  // gateway = has internet, relay = no internet but has peers, offline = neither
  const gatewayMode = isGateway ? 'gateway' : peerCount > 0 ? 'relay' : 'offline';

  const getStatusText = () => {
    switch (status) {
      case STATUS.CHECKING:     return 'Checking connectivity...';
      case STATUS.SEARCHING:    return 'Searching the internet...';
      case STATUS.WAITING_MESH: return peerCount > 0
        ? `Broadcasting through ${peerCount} mesh peer${peerCount !== 1 ? 's' : ''}... waiting for a gateway...`
        : 'No mesh peers nearby — your request is queued';
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
    <View style={[styles.container, { paddingBottom: keyboardHeight }]}>
      <SafeAreaView style={styles.safe} edges={['top']}>
        {/* Status bar — 3 states: gateway / relay / offline */}
        <View style={[styles.statusBar, styles[`statusBar_${gatewayMode}`]]}>
          <View style={styles.statusBarLeft}>
            <View style={[styles.statusDot, styles[`dot_${gatewayMode}`]]} />
            <Text style={styles.statusBarText}>
              {gatewayMode === 'gateway'
                ? 'Gateway — you have internet'
                : gatewayMode === 'relay'
                  ? `Relay — ${peerCount} mesh peer${peerCount !== 1 ? 's' : ''} nearby`
                  : 'Offline — no internet or nearby peers'}
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
                {gatewayMode === 'gateway'
                  ? 'You have internet — queries run directly.'
                  : gatewayMode === 'relay'
                    ? `${peerCount} nearby device${peerCount !== 1 ? 's' : ''} may relay your query to the internet.`
                    : 'No internet or mesh peers. Queries are queued and answered when a connection is found.'}
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
    </View>
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
  statusBar_gateway: { backgroundColor: colors.statusBarGateway },
  statusBar_relay:   { backgroundColor: colors.statusBarRelay },
  statusBar_offline: { backgroundColor: colors.statusBarOffline },
  statusBarLeft:    { flexDirection: 'row', alignItems: 'center' },
  statusDot:        { width: 8, height: 8, borderRadius: 8, overflow: 'hidden', marginRight: 8 },
  dot_gateway:      { backgroundColor: colors.success },
  dot_relay:        { backgroundColor: colors.warning },
  dot_offline:      { backgroundColor: colors.error },
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
