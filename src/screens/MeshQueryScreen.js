// src/screens/MeshQueryScreen.js
import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import gatewayService from '../services/GatewayService';

const STATUS = {
  IDLE: 'idle',
  CHECKING: 'checking',
  SEARCHING: 'searching',
  WAITING_MESH: 'waiting_mesh',
  DONE: 'done',
  ERROR: 'error',
};

const MeshQueryScreen = ({ navigation }) => {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState(STATUS.IDLE);
  const [results, setResults] = useState([]);  // list of { query, result, source, timestamp }
  const [isGateway, setIsGateway] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    navigation.setOptions({ title: 'Ask the Mesh' });

    // Check if this device is a gateway
    gatewayService.checkInternet().then(setIsGateway);

    // Load cache history to show previous results
    gatewayService.getCacheHistory().then(history => {
      const items = history.map(h => ({
        query: h.query,
        result: h.result,
        source: 'cache',
        timestamp: h.timestamp,
      }));
      setResults(items);
    });

    // Register callback for delayed mesh responses (store-and-forward delivery)
    gatewayService.setOnQueryResultCallback(({ request_id, result, query: q, delayed }) => {
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

    return () => {
      gatewayService.setOnQueryResultCallback(null);
    };
  }, [navigation]);

  const handleSend = async () => {
    const q = query.trim();
    if (!q || status === STATUS.SEARCHING || status === STATUS.WAITING_MESH) return;

    setStatus(STATUS.CHECKING);

    try {
      // onStatus fires once checkInternet() resolves inside sendQuery — avoids a double check
      const { result, source } = await gatewayService.sendQuery(q, (hasInternet) => {
        setIsGateway(hasInternet);
        setStatus(hasInternet ? STATUS.SEARCHING : STATUS.WAITING_MESH);
      });

      setResults(prev => [
        { query: q, result, source, timestamp: Date.now() },
        ...prev,
      ]);
      setQuery('');
      setStatus(STATUS.DONE);
    } catch (err) {
      if (err.message === 'NO_GATEWAY_NEARBY') {
        setPendingCount(gatewayService.getPendingQueueCount());
        setResults(prev => [
          {
            query: q,
            result: 'No gateway found nearby. Your request has been queued and will be answered automatically when a device with internet comes into range.',
            source: 'queued',
            timestamp: Date.now(),
          },
          ...prev,
        ]);
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
      case STATUS.CHECKING:      return 'Checking connectivity...';
      case STATUS.SEARCHING:     return 'Searching the internet...';
      case STATUS.WAITING_MESH:  return 'Broadcasting through mesh... waiting for a gateway...';
      case STATUS.DONE:          return '';
      case STATUS.ERROR:         return 'Something went wrong';
      default:                   return '';
    }
  };

  const getSourceBadge = (source) => {
    switch (source) {
      case 'internet': return { label: 'Internet', color: '#34C759' };
      case 'cache':    return { label: 'Cached',   color: '#007AFF' };
      case 'mesh':     return { label: 'Via Mesh', color: '#FF9500' };
      case 'mesh (delayed)': return { label: 'Mesh (delayed)', color: '#FF9500' };
      case 'queued':   return { label: 'Queued',   color: '#999' };
      default:         return { label: source,     color: '#666' };
    }
  };

  const isLoading =
    status === STATUS.CHECKING ||
    status === STATUS.SEARCHING ||
    status === STATUS.WAITING_MESH;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      <SafeAreaView style={styles.safe}>
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
              <ActivityIndicator size="small" color="#007AFF" />
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
                  <Text style={styles.exampleItem}>· {ex}</Text>
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
        <View style={styles.inputBar}>
          <TextInput
            ref={inputRef}
            style={styles.input}
            placeholder="Ask anything..."
            placeholderTextColor="#999"
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
              ? <ActivityIndicator size="small" color="white" />
              : <Text style={styles.sendBtnText}>Ask</Text>
            }
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F5F5' },
  safe: { flex: 1 },

  statusBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  statusBarGateway: { backgroundColor: '#D4EDDA' },
  statusBarRelay:   { backgroundColor: '#FFF3CD' },
  statusBarLeft: { flexDirection: 'row', alignItems: 'center' },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  dotGateway: { backgroundColor: '#34C759' },
  dotRelay:   { backgroundColor: '#FF9500' },
  statusBarText: { fontSize: 13, fontWeight: '500', color: '#333' },
  pendingText: { fontSize: 12, color: '#FF9500', fontWeight: '600' },

  results: { flex: 1 },
  resultsContent: { padding: 16, paddingBottom: 8 },

  loadingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'white',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    gap: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
    elevation: 2,
  },
  loadingText: { fontSize: 14, color: '#555', flex: 1 },

  emptyState: { alignItems: 'center', paddingVertical: 40 },
  emptyIconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#E0E0E0',
    marginBottom: 12,
  },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: '#333', marginBottom: 8 },
  emptySubtitle: {
    fontSize: 14, color: '#777', textAlign: 'center',
    lineHeight: 20, marginBottom: 24, paddingHorizontal: 20,
  },
  exampleLabel: { fontSize: 13, color: '#999', marginBottom: 8, fontWeight: '600' },
  exampleItem:  { fontSize: 14, color: '#007AFF', marginBottom: 6 },

  resultCard: {
    backgroundColor: 'white',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
    elevation: 2,
  },
  resultHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  resultQuery: {
    fontSize: 14,
    fontWeight: '700',
    color: '#333',
    flex: 1,
    marginRight: 8,
  },
  sourceBadge: {
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  sourceBadgeText: { color: 'white', fontSize: 11, fontWeight: '600' },
  resultText: { fontSize: 15, color: '#444', lineHeight: 22 },
  resultTime: { fontSize: 11, color: '#aaa', marginTop: 8, textAlign: 'right' },

  inputBar: {
    flexDirection: 'row',
    padding: 12,
    backgroundColor: 'white',
    borderTopWidth: 1,
    borderTopColor: '#E0E0E0',
    alignItems: 'center',
  },
  input: {
    flex: 1,
    backgroundColor: '#F5F5F5',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    marginRight: 8,
    minHeight: 40,
  },
  sendBtn: {
    backgroundColor: '#007AFF',
    borderRadius: 20,
    paddingHorizontal: 20,
    paddingVertical: 10,
    minWidth: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: { backgroundColor: '#CCC' },
  sendBtnText: { color: 'white', fontWeight: '700', fontSize: 15 },
});

export default MeshQueryScreen;
