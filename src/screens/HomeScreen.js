import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  PermissionsAndroid,
  Platform,
  RefreshControl,
  Modal,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import BridgefyService from '../services/BridgefyService';
import { useTheme } from '../theme';

const DISPLAY_NAME_KEY = '@peerreach_display_name';

const SEARCH_DEBOUNCE_MS = 300;

const HomeScreen = ({ navigation }) => {
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [conversations, setConversations]     = useState([]);
  const [isLoading, setIsLoading]             = useState(true);
  const [myDeviceId, setMyDeviceId]           = useState('');
  const [myDeviceName, setMyDeviceName]       = useState('');
  const [unreadCounts, setUnreadCounts]       = useState({ total: 0, broadcast: 0, direct: 0 });
  const [refreshing, setRefreshing]           = useState(false);
  const [bridgefyStatus, setBridgefyStatus]   = useState('initializing');

  // Search state
  const [searchQuery, setSearchQuery]   = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching]   = useState(false);
  const [namePromptVisible, setNamePromptVisible] = useState(false);
  const [nameInput, setNameInput]       = useState('');
  const searchTimerRef  = useRef(null);
  const navTimerRef     = useRef(null);

  useFocusEffect(
    useCallback(() => {
      loadData().catch(console.error);
      // Refresh display name in case user changed it in Settings
      const name = BridgefyService.getDisplayName();
      if (name) setMyDeviceName(name);
    }, [])
  );

  useEffect(() => {
    console.log('🏠 HomeScreen mounted');
    BridgefyService.setOnNewMessageHandler(handleNewMessage);
    BridgefyService.setOnReadyHandler(handleBridgefyReady);
    BridgefyService.setOnErrorHandler(handleBridgefyError);
    BridgefyService.setOnUnreadUpdatedHandler(handleUnreadUpdated);

    requestPermissions().then((granted) => {
      if (granted) {
        initializeBridgefy();
      } else {
        setIsLoading(false);
        Alert.alert(
          'Permissions Required',
          'Location and Bluetooth permissions are required for PeerReach to work.',
          [{ text: 'OK' }]
        );
      }
    });

    return () => {
      BridgefyService.setOnNewMessageHandler(null);
      BridgefyService.setOnReadyHandler(null);
      BridgefyService.setOnErrorHandler(null);
      BridgefyService.setOnUnreadUpdatedHandler(null);
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      if (navTimerRef.current) clearTimeout(navTimerRef.current);
    };
  }, []);

  // Show name prompt if no custom display name has ever been saved
  useEffect(() => {
    AsyncStorage.getItem(DISPLAY_NAME_KEY).then(saved => {
      if (!saved || !saved.trim()) setNamePromptVisible(true);
    }).catch(() => {});
  }, []);

  // ─── Permissions ──────────────────────────────────────────────────────────
  const requestPermissions = async () => {
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
          result['android.permission.BLUETOOTH_SCAN'] === 'granted' &&
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
  };

  // ─── Init ─────────────────────────────────────────────────────────────────
  const initializeBridgefy = async () => {
    try {
      setBridgefyStatus('initializing');
      console.log('🚀 Initializing Bridgefy...');
      const API_KEY = process.env.GROQ_API_KEY;
      if (!API_KEY || API_KEY.length < 36) {
        Alert.alert('Invalid API Key', 'Please check your Bridgefy API key configuration.');
        setIsLoading(false);
        setBridgefyStatus('error');
        return;
      }
      // initialize() fires-and-forgets on the native side (no Promise).
      // Actual readiness is signalled by onRegistrationSuccessful → handleBridgefyReady.
      // We just add a safety timeout so the loading screen doesn't hang forever.
      BridgefyService.initialize(API_KEY);
      navTimerRef.current = setTimeout(() => {
        setIsLoading(prev => {
          if (prev) {
            setBridgefyStatus('error');
            Alert.alert(
              'Initialization Timeout',
              'Could not start mesh network. Please check Bluetooth is enabled and permissions are granted.',
              [{ text: 'OK' }]
            );
          }
          return false;
        });
      }, 20000);
    } catch (error) {
      console.error('❌ Bridgefy initialization failed:', error);
      setBridgefyStatus('error');
      setIsLoading(false);
      Alert.alert(
        'Initialization Failed',
        `Could not start Bridgefy: ${error.message || 'Unknown error'}\n\nPlease check:\n1. Your API key\n2. Bluetooth is enabled\n3. Location permission is granted`,
        [{ text: 'OK' }]
      );
    }
  };

  const loadData = async () => {
    try {
      setRefreshing(true);
      await BridgefyService.getConnectedDevices();
      const convos  = await BridgefyService.getConversations();
      const counts  = await BridgefyService.getUnreadCounts();
      setConversations(convos);
      setUnreadCounts(counts);
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setRefreshing(false);
    }
  };

  // ─── Event handlers ───────────────────────────────────────────────────────
  const handleNewMessage     = ()      => { console.log('📨 New message received in HomeScreen'); loadData().catch(console.error); };
  const handleBridgefyReady  = (data)  => {
    console.log('✅ Bridgefy ready:', data);
    if (navTimerRef.current) clearTimeout(navTimerRef.current);
    setMyDeviceId(data.deviceId);
    setMyDeviceName(data.deviceName);
    setBridgefyStatus('ready');
    setIsLoading(false);
    loadData().catch(err => console.error('Error loading data on ready:', err));
  };
  const handleBridgefyError  = (error) => {
    console.warn('⚠️ Bridgefy error:', error);
    if (navTimerRef.current) clearTimeout(navTimerRef.current);
    setBridgefyStatus('error');
    setIsLoading(false);
  };
  const handleUnreadUpdated  = (counts) => setUnreadCounts(counts);

  // ─── Navigation ───────────────────────────────────────────────────────────
  const openChat = async (conversation) => {
    try {
      await BridgefyService.markAsRead(conversation.id, conversation.isBroadcast);
    } catch (err) {
      console.error('markAsRead failed:', err);
    }
    BridgefyService.setCurrentChat(conversation.id);
    navigation.navigate('Chat', {
      deviceId:   conversation.id,
      deviceName: conversation.name,
      isBroadcast: conversation.isBroadcast,
    });
    navTimerRef.current = setTimeout(() => { loadData().catch(console.error); }, 500);
  };

  // ─── Search ───────────────────────────────────────────────────────────────
  const handleSearchChange = (text) => {
    setSearchQuery(text);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);

    if (text.length < 2) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    searchTimerRef.current = setTimeout(async () => {
      try {
        const results = await BridgefyService.searchMessages(text);
        setSearchResults(results);
      } catch (_e) {
        setSearchResults([]);
      } finally {
        setIsSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
  };

  const confirmDisplayName = async () => {
    const trimmed = nameInput.trim();
    if (!trimmed) { Alert.alert('Name required', 'Please enter a display name.'); return; }
    await BridgefyService.setDisplayName(trimmed);
    setMyDeviceName(trimmed);
    setNamePromptVisible(false);
  };

  const clearSearch = () => {
    setSearchQuery('');
    setSearchResults([]);
    setIsSearching(false);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
  };

  const inSearchMode = searchQuery.length >= 2;

  // ─── Helpers ──────────────────────────────────────────────────────────────
  const formatTimeAgo = (timestamp) => {
    if (!timestamp) return '';
    const diff    = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours   = Math.floor(diff / 3600000);
    const days    = Math.floor(diff / 86400000);
    if (minutes < 1)  return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24)   return `${hours}h ago`;
    if (days < 7)     return `${days}d ago`;
    return new Date(timestamp).toLocaleDateString();
  };

  // ─── Render: conversation row ─────────────────────────────────────────────
  const renderConversation = ({ item }) => (
    <TouchableOpacity
      style={[styles.conversationCard, item.unreadCount > 0 && styles.unreadConversation]}
      onPress={() => openChat(item)}
    >
      <View style={[styles.avatar, item.isBroadcast ? styles.avatarBroadcast : styles.avatarDirect]}>
        <Text style={styles.avatarText}>
          {item.isBroadcast ? 'BC' : (item.name || '?')[0].toUpperCase()}
        </Text>
        {item.unreadCount > 0 && (
          <View style={styles.avatarBadge}>
            <Text style={styles.avatarBadgeText}>
              {item.unreadCount > 9 ? '9+' : item.unreadCount}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.conversationInfo}>
        <View style={styles.conversationHeader}>
          <Text style={styles.conversationName} numberOfLines={1}>{item.name}</Text>
          <Text style={styles.conversationTime}>{formatTimeAgo(item.timestamp)}</Text>
        </View>
        <Text
          style={[styles.lastMessage, item.unreadCount > 0 && styles.unreadLastMessage]}
          numberOfLines={2}
        >
          {item.isBroadcast ? `${item.senderName}: ` : ''}{item.lastMessage}
        </Text>
      </View>
    </TouchableOpacity>
  );

  // ─── Render: search result row ────────────────────────────────────────────
  const renderSearchResult = ({ item }) => {
    const isPhoto    = item.contentType === 'photo';
    const isLocation = item.contentType === 'location';
    const preview    = isPhoto ? '[Photo]' : isLocation ? '[Location]' : (item.text || '');
    const snippet    = preview.length > 90 ? preview.substring(0, 90) + '…' : preview;

    let convName, convId, isBroadcast;
    if (item.isBroadcast) {
      convName    = 'Broadcast to All';
      convId      = 'broadcast';
      isBroadcast = true;
    } else if (item.isMine) {
      convId      = item.receiverId || null;
      const conv  = conversations.find(c => c.id === convId);
      convName    = conv?.name || (convId ? `Device ${convId.substring(0, 8)}` : 'Unknown');
      isBroadcast = false;
    } else {
      convName    = item.senderName || 'Unknown';
      convId      = item.senderId || null;
      isBroadcast = false;
    }

    return (
      <TouchableOpacity
        style={styles.searchResultCard}
        onPress={() => { if (convId) openChat({ id: convId, name: convName, isBroadcast }); }}
      >
        <View style={styles.searchResultHeader}>
          <Text style={styles.searchResultFrom} numberOfLines={1}>{convName}</Text>
          <Text style={styles.searchResultTime}>{formatTimeAgo(item.timestamp)}</Text>
        </View>
        <Text style={styles.searchResultText} numberOfLines={2}>{snippet}</Text>
      </TouchableOpacity>
    );
  };

  // ─── Loading state ────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <SafeAreaView style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>Starting PeerReach...</Text>
        <Text style={styles.loadingSubtext}>
          {bridgefyStatus === 'initializing' && 'Initializing mesh network...'}
          {bridgefyStatus === 'error'        && 'Failed to start. Please check permissions.'}
        </Text>
      </SafeAreaView>
    );
  }

  // ─── Main render ──────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.container}>

      {/* First-launch display name prompt */}
      <Modal visible={namePromptVisible} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>What's your name?</Text>
            <Text style={styles.modalSubtitle}>
              This is how you appear to other devices on the mesh.
            </Text>
            <TextInput
              style={styles.modalInput}
              placeholder="Enter display name"
              placeholderTextColor="#999"
              value={nameInput}
              onChangeText={setNameInput}
              maxLength={32}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={confirmDisplayName}
            />
            <TouchableOpacity
              style={[styles.modalBtn, !nameInput.trim() && styles.modalBtnDisabled]}
              onPress={confirmDisplayName}
              disabled={!nameInput.trim()}
            >
              <Text style={styles.modalBtnText}>Continue</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerTop}>
          <View style={styles.headerTitleGroup}>
            <Text style={styles.title}>PeerReach</Text>
            {unreadCounts.total > 0 && (
              <View style={styles.headerBadge}>
                <Text style={styles.headerBadgeText}>{unreadCounts.total}</Text>
              </View>
            )}
          </View>
          <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.logsBtn}
              onPress={() => navigation.navigate('Logs')}
            >
              <Text style={styles.logsBtnText}>Logs</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.settingsBtn}
              onPress={() => navigation.navigate('Settings')}
            >
              <Text style={styles.settingsIcon}>{'\ue8b8'}</Text>
            </TouchableOpacity>
          </View>
        </View>
        <Text style={styles.subtitle}>
          {myDeviceName} · {myDeviceId ? myDeviceId.substring(0, 8) + '...' : 'Unknown'}
        </Text>
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, bridgefyStatus === 'ready' ? styles.dotOnline : styles.dotOffline]} />
          <Text style={styles.status}>
            {bridgefyStatus === 'ready' ? 'Online' : 'Offline'}
            {conversations.length > 0 && ` · ${conversations.length} conversation${conversations.length !== 1 ? 's' : ''}`}
          </Text>
        </View>
      </View>

      {/* Action Buttons */}
      <View style={styles.actionButtons}>
        <TouchableOpacity
          style={[styles.actionButton, styles.broadcastButton]}
          onPress={() => openChat({
            id: 'broadcast', name: 'Broadcast to All',
            isBroadcast: true, timestamp: Date.now(),
            lastMessage: 'Send messages to all nearby devices',
          })}
        >
          <Text style={styles.actionButtonText}>Broadcast</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionButton, styles.newChatButton]}
          onPress={() => navigation.navigate('Devices')}
        >
          <Text style={styles.actionButtonText}>+ New Chat</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionButton, styles.askMeshButton]}
          onPress={() => navigation.navigate('MeshQuery')}
        >
          <Text style={styles.actionButtonText}>Ask Mesh</Text>
        </TouchableOpacity>
      </View>

      {/* Search bar */}
      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          placeholder="Search messages..."
          placeholderTextColor={colors.placeholder}
          value={searchQuery}
          onChangeText={handleSearchChange}
          returnKeyType="search"
          autoCorrect={false}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity style={styles.searchClearBtn} onPress={clearSearch}>
            <Text style={styles.searchClearText}>{'\u00D7'}</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* List — conversations OR search results */}
      {inSearchMode && isSearching ? (
        <View style={styles.searchLoadingRow}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={styles.searchLoadingText}>Searching...</Text>
        </View>
      ) : (
        <FlatList
          data={inSearchMode ? searchResults : conversations}
          renderItem={inSearchMode ? renderSearchResult : renderConversation}
          keyExtractor={(item) =>
            inSearchMode ? `sr_${item.id}` : item.id
          }
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            !inSearchMode ? (
              <RefreshControl
                refreshing={refreshing}
                onRefresh={loadData}
                colors={[colors.primary]}
              tintColor={colors.primary}
              />
            ) : undefined
          }
          ListEmptyComponent={
            inSearchMode ? (
              <View style={styles.emptyState}>
                <View style={styles.emptyIconCircle} />
                <Text style={styles.emptyText}>No results found</Text>
                <Text style={styles.emptySubtext}>Try a different search term</Text>
              </View>
            ) : (
              <View style={styles.emptyState}>
                <View style={styles.emptyIconCircle} />
                <Text style={styles.emptyText}>No conversations yet</Text>
                <Text style={styles.emptySubtext}>
                  Start a broadcast or chat with nearby devices
                </Text>
                <TouchableOpacity
                  style={styles.emptyButton}
                  onPress={() => BridgefyService.getConnectedDevices().then(loadData)}
                >
                  <Text style={styles.emptyButtonText}>Refresh Devices</Text>
                </TouchableOpacity>
              </View>
            )
          }
        />
      )}
    </SafeAreaView>
  );
};

// ─── Styles (theme-aware) ────────────────────────────────────────────────────
const makeStyles = (colors) => StyleSheet.create({
  container:      { flex: 1, backgroundColor: colors.background },
  loadingContainer: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    backgroundColor: colors.background, padding: 20,
  },
  loadingText:    { fontSize: 18, fontWeight: '600', color: colors.text, marginTop: 20, marginBottom: 8 },
  loadingSubtext: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', paddingHorizontal: 40 },

  // Header
  header: {
    backgroundColor: colors.headerBg,
    padding: 20,
    paddingTop: 16,
  },
  headerTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
  headerTitleGroup: { flexDirection: 'row', alignItems: 'center' },
  settingsBtn: {
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 6,
    padding: 6,
  },
  settingsIcon: {
    fontFamily: 'MaterialIcons',
    fontSize: 20,
    color: '#FFFFFF',
  },
  headerActions: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
  },
  logsBtn: {
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  logsBtnText: { color: colors.onColor, fontSize: 12, fontWeight: '600' },
  title: { fontSize: 28, fontWeight: 'bold', color: colors.headerText },
  headerBadge: {
    backgroundColor: colors.error,
    borderRadius: 12, minWidth: 24, height: 24,
    justifyContent: 'center', alignItems: 'center',
    marginLeft: 10, paddingHorizontal: 6,
  },
  headerBadgeText: { color: colors.onColor, fontSize: 12, fontWeight: 'bold' },
  subtitle: { fontSize: 14, color: colors.headerSubtitle, marginBottom: 4 },
  statusRow: { flexDirection: 'row', alignItems: 'center' },
  statusDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  dotOnline:  { backgroundColor: colors.success },
  dotOffline: { backgroundColor: colors.error },
  status: { fontSize: 12, color: colors.headerStatusText },

  // Action buttons
  actionButtons: {
    flexDirection: 'row',
    padding: 12,
    backgroundColor: colors.actionRowBg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  actionButton: { flex: 1, padding: 12, borderRadius: 10, alignItems: 'center', marginHorizontal: 4 },
  broadcastButton: { backgroundColor: colors.warning },
  newChatButton:   { backgroundColor: colors.success },
  askMeshButton:   { backgroundColor: colors.accent },
  actionButtonText: { color: colors.onColor, fontSize: 14, fontWeight: '600' },

  // Search
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  searchInput: {
    flex: 1,
    backgroundColor: colors.surfaceVariant,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    fontSize: 15,
    color: colors.text,
  },
  searchClearBtn: { paddingHorizontal: 10, paddingVertical: 6 },
  searchClearText: { fontSize: 16, color: colors.textMuted },
  searchLoadingRow: {
    flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', padding: 20, gap: 10,
  },
  searchLoadingText: { fontSize: 14, color: colors.textSecondary },

  // Search result card
  searchResultCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07,
    shadowRadius: 3,
    elevation: 2,
  },
  searchResultHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  searchResultFrom: { fontSize: 13, fontWeight: '700', color: colors.primary, flex: 1 },
  searchResultTime: { fontSize: 11, color: colors.textMuted, marginLeft: 8 },
  searchResultText: { fontSize: 14, color: colors.textSecondary, lineHeight: 19 },

  // Conversation list
  list: { padding: 14, paddingBottom: 32 },
  conversationCard: {
    backgroundColor: colors.surface,
    borderRadius: 12, padding: 14,
    marginBottom: 10, flexDirection: 'row', alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08, shadowRadius: 3, elevation: 2,
  },
  unreadConversation: {
    backgroundColor: colors.unreadHighlight,
    borderLeftWidth: 4,
    borderLeftColor: colors.unreadBorder,
  },
  avatar: {
    width: 50, height: 50, borderRadius: 25,
    justifyContent: 'center', alignItems: 'center',
    marginRight: 12, position: 'relative',
  },
  avatarBroadcast: { backgroundColor: colors.avatarBroadcastBg },
  avatarDirect:    { backgroundColor: colors.avatarDirectBg },
  avatarText:      { fontSize: 16, fontWeight: '700', color: colors.onColor },
  avatarBadge: {
    position: 'absolute', top: -5, right: -5,
    backgroundColor: colors.error,
    borderRadius: 10, minWidth: 20, height: 20,
    justifyContent: 'center', alignItems: 'center',
  },
  avatarBadgeText: { color: colors.onColor, fontSize: 10, fontWeight: 'bold' },
  conversationInfo:   { flex: 1 },
  conversationHeader: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', marginBottom: 4,
  },
  conversationName: { fontSize: 16, fontWeight: '600', color: colors.text, flex: 1 },
  conversationTime: { fontSize: 12, color: colors.textMuted, marginLeft: 8 },
  lastMessage:      { fontSize: 14, color: colors.textSecondary, lineHeight: 18 },
  unreadLastMessage: { color: colors.text, fontWeight: '500' },

  // Empty state
  emptyState: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    padding: 40, marginTop: 60,
  },
  emptyIconCircle: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: colors.emptyCircle, marginBottom: 16,
  },
  emptyText:    { fontSize: 18, fontWeight: '600', color: colors.text, marginBottom: 8, textAlign: 'center' },
  emptySubtext: { fontSize: 14, color: colors.textMuted, textAlign: 'center', marginBottom: 24, lineHeight: 20 },
  emptyButton:  { backgroundColor: colors.primary, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 },
  emptyButtonText: { color: colors.onColor, fontSize: 16, fontWeight: '600' },

  // First-launch name modal
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center', alignItems: 'center', padding: 32,
  },
  modalCard: {
    width: '100%', backgroundColor: colors.surface,
    borderRadius: 16, padding: 24,
  },
  modalTitle:    { fontSize: 22, fontWeight: '700', color: colors.text, marginBottom: 8 },
  modalSubtitle: { fontSize: 14, color: colors.textMuted, marginBottom: 20, lineHeight: 20 },
  modalInput: {
    backgroundColor: colors.surfaceVariant,
    borderRadius: 8, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 16, color: colors.text, marginBottom: 16,
  },
  modalBtn: {
    backgroundColor: colors.primary, borderRadius: 8,
    paddingVertical: 13, alignItems: 'center',
  },
  modalBtnDisabled: { backgroundColor: colors.border },
  modalBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
});

export default HomeScreen;
