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
  RefreshControl,
  Modal,
  ScrollView,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import MCIcon from 'react-native-vector-icons/MaterialCommunityIcons';
import BridgefyService from '../services/BridgefyService';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { BRIDGEFY_EVER_INIT_KEY } from '../constants/storageKeys';
let NetInfo = null;
try {
  NetInfo = require('@react-native-community/netinfo').default || require('@react-native-community/netinfo');
} catch (_e) {
  NetInfo = null;
}
import weatherService, { wmoInfo } from '../services/WeatherService';
import { useTheme } from '../theme';
import { formatTimeAgo } from '../utils/timeFormat';
import { requestBridgefyPermissions } from '../utils/permissions';
import LoadingScreen from '../components/LoadingScreen';

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
  const [weather, setWeather]                 = useState(null);
  const [showWeatherModal, setShowWeatherModal] = useState(false);
  const [myLocation, setMyLocation]           = useState(null);
  const [showLocationModal, setShowLocationModal] = useState(false);
  const [nearbyPeers, setNearbyPeers]         = useState([]);
  const [myBattery, setMyBattery]             = useState(null);
  const [permissionsGranted, setPermissionsGranted] = useState(false);
  const [firstRunPending, setFirstRunPending] = useState(true);
  const [hasNetwork, setHasNetwork]           = useState(true);
  const networkAlertedRef = useRef(false);
  const [showDebug, setShowDebug]             = useState(false);
  const [debugLog, setDebugLog]               = useState([]);

  // Search state
  const [searchQuery, setSearchQuery]         = useState('');
  const [deviceResults, setDeviceResults]     = useState([]);
  const [messageResults, setMessageResults]   = useState([]);
  const [isSearching, setIsSearching]         = useState(false);
  const searchTimerRef  = useRef(null);
  const navTimerRef     = useRef(null);
  const infoIntervalRef = useRef(null);   // nearby peers — every 2 min
  const batteryTimerRef = useRef(null);   // battery — every 5 min



  useFocusEffect(
    useCallback(() => {
      loadData().catch(console.error);
      // Refresh display name in case user changed it in Settings
      const name = BridgefyService.getDisplayName();
      if (name) setMyDeviceName(name);
    }, [])
  );

  // Read battery immediately on mount — independent of Bridgefy
  useEffect(() => {
    BridgefyService.getMyBattery().then(b => { if (b != null) setMyBattery(b); }).catch(() => {});
  }, []);

  useEffect(() => {
    console.log('🏠 HomeScreen mounted');
    BridgefyService.setOnNewMessageHandler(handleNewMessage);
    BridgefyService.setOnReadyHandler(handleBridgefyReady);
    BridgefyService.setOnErrorHandler(handleBridgefyError);
    BridgefyService.setOnUnreadUpdatedHandler(handleUnreadUpdated);
    // Refresh conversation names when a device announces their display name
    BridgefyService.setOnDeviceListUpdatedHandler(() => loadData().catch(console.error));

    requestPermissions().then((granted) => {
      setPermissionsGranted(granted);
      if (!granted) {
        setIsLoading(false);
        Alert.alert(
          'Permissions Required',
          'Location and Bluetooth permissions are required for PeerReach to work.',
          [{ text: 'OK' }]
        );
      }
    }).catch((err) => {
      console.error('Permission request failed:', err);
      setIsLoading(false);
    });

    return () => {
      BridgefyService.setOnNewMessageHandler(null);
      BridgefyService.setOnReadyHandler(null);
      BridgefyService.setOnErrorHandler(null);
      BridgefyService.setOnUnreadUpdatedHandler(null);
      BridgefyService.setOnDeviceListUpdatedHandler(null);
      weatherService.setOnWeatherUpdated(null);
      BridgefyService.setOnLocationUpdated(null);
      if (batteryTimerRef.current) clearInterval(batteryTimerRef.current);
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      if (navTimerRef.current) clearTimeout(navTimerRef.current);
      if (infoIntervalRef.current) clearInterval(infoIntervalRef.current);
    };
  }, []);

  useEffect(() => {
    AsyncStorage.getItem('@peerreach_first_run_done')
      .then((value) => setFirstRunPending(!value))
      .catch(() => setFirstRunPending(true));
  }, []);

  useEffect(() => {
    if (!NetInfo) return;
    const unsubscribe = NetInfo.addEventListener((state) => {
      const connected = !!state.isConnected;
      setHasNetwork(connected);
      if (firstRunPending && !connected && !networkAlertedRef.current) {
        networkAlertedRef.current = true;
        Alert.alert(
          'Internet Required',
          'Internet connectivity is required only for first-time activation. Please connect and we will continue automatically.'
        );
        setIsLoading(false);
        setBridgefyStatus('error');
      }
      if (connected) {
        networkAlertedRef.current = false;
      }
    });
    return () => unsubscribe();
  }, [firstRunPending]);

  useEffect(() => {
    if (!permissionsGranted) return;
    if (firstRunPending && !hasNetwork) return;
    initializeBridgefy();
  }, [permissionsGranted, firstRunPending, hasNetwork]);

  // Light debug log refresh (no heavy logging)
  useEffect(() => {
    if (!showDebug) return;
    const t = setInterval(() => {
      if (BridgefyService.getDebugLog) {
        setDebugLog(BridgefyService.getDebugLog());
      }
    }, 1000);
    return () => clearInterval(t);
  }, [showDebug]);


  // ─── Permissions ──────────────────────────────────────────────────────────
  const requestPermissions = requestBridgefyPermissions;

  // ─── Init ─────────────────────────────────────────────────────────────────
  const getBridgefyKey = () => 'b6cbd7cb-5e22-491a-8bde-137d61a2050e';

  const initializeBridgefy = async () => {
    try {
      setBridgefyStatus('initializing');
      console.log('🚀 Initializing Bridgefy...');
      const API_KEY = getBridgefyKey();
      if (!API_KEY || API_KEY.length < 36) {
        Alert.alert('Invalid API Key', 'Please check your Bridgefy API key configuration.');
        setIsLoading(false);
        setBridgefyStatus('error');
        return;
      }
      // initialize() fires-and-forgets on the native side (no Promise).
      // Actual readiness is signalled by onRegistrationSuccessful → handleBridgefyReady.
      BridgefyService.initialize(API_KEY);
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

  // Internet/Bluetooth gating removed (back to main behavior)

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
    AsyncStorage.setItem('@peerreach_first_run_done', '1').catch(() => {});
    AsyncStorage.setItem(BRIDGEFY_EVER_INIT_KEY, '1').catch(() => {});
    loadData().catch(err => console.error('Error loading data on ready:', err));
    // Show cached weather immediately, then get live updates via WeatherService
    const cached = weatherService.getData();
    if (cached) setWeather(cached);
    weatherService.setOnWeatherUpdated((wd) => setWeather(wd));
    // Update location immediately whenever GPS fires (no waiting for poll interval)
    BridgefyService.setOnLocationUpdated((loc) => setMyLocation(loc));
    // Seed from cache in case callback already fired before we registered
    const cachedLoc = BridgefyService.getMyLocation();
    if (cachedLoc) setMyLocation(cachedLoc);

    // Battery: read once now, then every 5 minutes (changes slowly)
    const refreshBattery = () => {
      BridgefyService.getMyBattery().then(b => { if (b != null) setMyBattery(b); }).catch(() => {});
    };
    refreshBattery();
    if (batteryTimerRef.current) clearInterval(batteryTimerRef.current);
    batteryTimerRef.current = setInterval(refreshBattery, 5 * 60 * 1000);

    // Nearby peers: refresh every 2 minutes (peer connections change more often)
    const refreshPeers = () => {
      BridgefyService.getConnectedDevices().then(devs => setNearbyPeers(devs)).catch(() => {});
    };
    refreshPeers();
    if (infoIntervalRef.current) clearInterval(infoIntervalRef.current);
    infoIntervalRef.current = setInterval(refreshPeers, 2 * 60 * 1000);
  };
  const handleBridgefyError  = (error) => {
    console.warn('⚠️ Bridgefy error:', error);
    if (navTimerRef.current) clearTimeout(navTimerRef.current);
    setBridgefyStatus('error');
    setIsLoading(false);
    const msg = error?.error || error?.message || '';
    if (msg.toLowerCase().includes('location')) {
      Alert.alert(
        'Location Services Off',
        'Bridgefy requires Location to be enabled (not just permitted) for BLE scanning on Android 6+.\n\nGo to Settings → Location and turn it on.',
        [
          { text: 'Open Settings', onPress: () => Linking.sendIntent('android.settings.LOCATION_SOURCE_SETTINGS') },
          { text: 'Dismiss', style: 'cancel' },
        ]
      );
    }
    // No forced timeout or retry here — initialization can take time.
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
      setDeviceResults([]);
      setMessageResults([]);
      setIsSearching(false);
      return;
    }

    // Device results are instant — filter conversations by name
    const lower = text.toLowerCase();
    const matchedDevices = conversations.filter(c =>
      c.name?.toLowerCase().includes(lower)
    );
    setDeviceResults(matchedDevices);

    setIsSearching(true);
    searchTimerRef.current = setTimeout(async () => {
      try {
        const allMessages = await BridgefyService.searchMessages(text);
        // Exclude messages already surfaced by a matched device conversation
        const matchedIds = new Set(matchedDevices.map(c => c.id));
        const extra = allMessages.filter(m => {
          const convId = m.isBroadcast ? 'broadcast' : (m.isMine ? m.receiverId : m.senderId);
          return !matchedIds.has(convId);
        });
        setMessageResults(extra);
      } catch (_e) {
        setMessageResults([]);
      } finally {
        setIsSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
  };

  const clearSearch = () => {
    setSearchQuery('');
    setDeviceResults([]);
    setMessageResults([]);
    setIsSearching(false);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
  };

  const inSearchMode = searchQuery.length >= 2;

  // ─── Helpers ──────────────────────────────────────────────────────────────

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
          {item.lastMessage}
        </Text>
      </View>
    </TouchableOpacity>
  );

  // ─── Render: search results (device section + message section) ──────────────
  const renderSearchResults = () => {
    const hasDevices  = deviceResults.length > 0;
    const hasMessages = messageResults.length > 0;
    if (!hasDevices && !hasMessages) {
      return (
        <View style={styles.emptyState}>
          <View style={styles.emptyIconCircle} />
          <Text style={styles.emptyText}>No results found</Text>
          <Text style={styles.emptySubtext}>Try a different search term</Text>
        </View>
      );
    }
    return (
      <>
        {hasDevices && (
          <>
            <Text style={styles.searchSectionLabel}>Conversations</Text>
            {deviceResults.map(item => (
              <TouchableOpacity
                key={item.id}
                style={styles.conversationCard}
                onPress={() => openChat(item)}
              >
                <View style={[styles.avatar, item.isBroadcast ? styles.avatarBroadcast : styles.avatarDirect]}>
                  <Text style={styles.avatarText}>
                    {item.isBroadcast ? 'BC' : (item.name || '?')[0].toUpperCase()}
                  </Text>
                </View>
                <View style={styles.conversationInfo}>
                  <View style={styles.conversationHeader}>
                    <Text style={styles.conversationName} numberOfLines={1}>{item.name}</Text>
                    <Text style={styles.conversationTime}>{formatTimeAgo(item.timestamp)}</Text>
                  </View>
                  <Text style={styles.lastMessage} numberOfLines={1}>{item.lastMessage}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </>
        )}

        {hasMessages && (
          <>
            <Text style={styles.searchSectionLabel}>Messages</Text>
            {messageResults.map(item => {
              const isPhoto    = item.contentType === 'photo';
              const isLocation = item.contentType === 'location';
              const preview    = isPhoto ? '[Photo]' : isLocation ? '[Location]' : (item.text || '');
              const snippet    = preview.length > 90 ? preview.substring(0, 90) + '…' : preview;
              let convId, convName, isBroadcast;
              if (item.isBroadcast) {
                convId = 'broadcast'; convName = 'Broadcast to All'; isBroadcast = true;
              } else if (item.isMine) {
                convId = item.receiverId || null;
                const conv = conversations.find(c => c.id === convId);
                convName = conv?.name || (convId ? `Device ${convId.substring(0, 8)}` : 'Unknown');
                isBroadcast = false;
              } else {
                convId = item.senderId || null;
                const conv = conversations.find(c => c.id === convId);
                convName = conv?.name || item.senderName || (convId ? `Device ${convId.substring(0, 8)}` : 'Unknown');
                isBroadcast = false;
              }
              return (
                <TouchableOpacity
                  key={item.id}
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
            })}
          </>
        )}
      </>
    );
  };

  // ─── Loading state ────────────────────────────────────────────────────────
  if (isLoading) {
    const sub = bridgefyStatus === 'error' ? 'Failed to start. Please check permissions.' : 'Initializing mesh network...';
    return (
      <LoadingScreen
        message="Starting PeerReach..."
        subMessage={sub}
        actionLabel="Retry Init"
        onActionPress={async () => {
          try {
            setBridgefyStatus('initializing');
            await BridgefyService.forceReinitialize(getBridgefyKey());
          } catch (_e) {
            // keep loading screen, debug panel will show details
          }
        }}
        secondaryActionLabel="Debug"
        onSecondaryActionPress={() => setShowDebug(true)}
      />
    );
  }

  // ─── Main render ──────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.container}>
      {/* Debug modal */}
      <Modal visible={showDebug} transparent animationType="slide" onRequestClose={() => setShowDebug(false)}>
        <View style={styles.debugOverlay}>
          <View style={styles.debugCard}>
            <View style={styles.debugHeader}>
              <Text style={styles.debugTitle}>Bridgefy Debug</Text>
              <TouchableOpacity onPress={() => setShowDebug(false)}>
                <Icon name="close" size={20} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.debugBody}>
              {debugLog.length === 0 ? (
                <Text style={styles.debugLine}>No debug events yet.</Text>
              ) : (
                debugLog.map((e, idx) => (
                  <Text key={`${e.ts}_${idx}`} style={styles.debugLine}>
                    [{new Date(e.ts).toLocaleTimeString()}] {e.event} {e.data ? JSON.stringify(e.data) : ''}
                  </Text>
                ))
              )}
            </ScrollView>
            <TouchableOpacity
              style={styles.debugBtn}
              onPress={async () => {
                try {
                  setBridgefyStatus('initializing');
                  await BridgefyService.forceReinitialize(getBridgefyKey());
                } catch (_e) {}
              }}
            >
              <Text style={styles.debugBtnText}>Retry Init</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Weather report modal */}
      <Modal visible={showWeatherModal} transparent animationType="slide" onRequestClose={() => setShowWeatherModal(false)}>
        <View style={styles.wModalOverlay}>
          <View style={styles.wModalCard}>
            {/* Handle bar */}
            <View style={styles.wModalHandle} />

            {weather?.current ? (() => {
              const info = wmoInfo(weather.current.code);
              const source = weatherService.source;
              const age = weather.timestamp ? Math.round((Date.now() - weather.timestamp) / 60000) : null;
              return (
                <>
                  {/* City + close */}
                  <View style={styles.wModalTopRow}>
                    <Text style={styles.wModalCity}>{weather.city || 'Unknown location'}</Text>
                    <TouchableOpacity onPress={() => setShowWeatherModal(false)}>
                      <Icon name="close" size={22} color={colors.textMuted} />
                    </TouchableOpacity>
                  </View>

                  {/* Big icon + temp */}
                  <View style={styles.wModalHero}>
                    <MCIcon name={info.icon} size={64} color={info.color} />
                    <Text style={styles.wModalTemp}>{weather.current.temp}°C</Text>
                    <Text style={styles.wModalDesc}>{info.desc}</Text>
                  </View>

                  {/* Details row */}
                  <View style={styles.wDetailsRow}>
                    {weather.current.feelsLike != null && (
                      <View style={styles.wDetailItem}>
                        <MCIcon name="thermometer" size={16} color={colors.textMuted} />
                        <Text style={styles.wDetailLabel}>Feels like</Text>
                        <Text style={styles.wDetailValue}>{weather.current.feelsLike}°</Text>
                      </View>
                    )}
                    {weather.current.humidity != null && (
                      <View style={styles.wDetailItem}>
                        <MCIcon name="water-percent" size={16} color={colors.textMuted} />
                        <Text style={styles.wDetailLabel}>Humidity</Text>
                        <Text style={styles.wDetailValue}>{weather.current.humidity}%</Text>
                      </View>
                    )}
                    {weather.current.windSpeed != null && (
                      <View style={styles.wDetailItem}>
                        <MCIcon name="weather-windy" size={16} color={colors.textMuted} />
                        <Text style={styles.wDetailLabel}>Wind</Text>
                        <Text style={styles.wDetailValue}>{weather.current.windSpeed} km/h</Text>
                      </View>
                    )}
                  </View>

                  {/* Hourly strip */}
                  {weather.hourly?.length > 0 && (
                    <>
                      <Text style={styles.wSectionLabel}>Next 6 hours</Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.wHourlyScroll}>
                        {weather.hourly.map((h, i) => {
                          const hi = wmoInfo(h.code);
                          return (
                            <View key={i} style={styles.wHourlyItem}>
                              <Text style={styles.wHourlyTime}>{h.time}</Text>
                              <MCIcon name={hi.icon} size={20} color={hi.color} />
                              <Text style={styles.wHourlyTemp}>{h.temp}°</Text>
                              {h.precipChance > 0 && (
                                <Text style={styles.wHourlyPrecip}>{h.precipChance}%</Text>
                              )}
                            </View>
                          );
                        })}
                      </ScrollView>
                    </>
                  )}

                  {/* Daily forecast */}
                  {weather.daily?.length > 0 && (
                    <>
                      <Text style={styles.wSectionLabel}>3-day forecast</Text>
                      {weather.daily.map((d, i) => {
                        const di = wmoInfo(d.code);
                        return (
                          <View key={i} style={styles.wDailyRow}>
                            <Text style={styles.wDailyLabel}>{d.label}</Text>
                            <MCIcon name={di.icon} size={18} color={di.color} />
                            <Text style={styles.wDailyDesc}>{di.desc}</Text>
                            <View style={styles.wDailyTemps}>
                              <Text style={styles.wDailyHigh}>{d.high}°</Text>
                              <Text style={styles.wDailyLow}>{d.low}°</Text>
                            </View>
                          </View>
                        );
                      })}
                    </>
                  )}

                  {/* Source + age */}
                  <View style={styles.wFooter}>
                    <View style={[styles.wSourceBadge, source === 'gps' ? styles.wSourceGps : source === 'mesh' ? styles.wSourceMesh : styles.wSourceCache]}>
                      <Text style={styles.wSourceText}>{source === 'gps' ? 'GPS' : source === 'mesh' ? 'Mesh' : 'Cache'}</Text>
                    </View>
                    {age != null && <Text style={styles.wAgeText}>Updated {age < 1 ? 'just now' : age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`}</Text>}
                    {weather.isStale && (
                      <View style={styles.wStaleBadge}>
                        <MCIcon name="alert-outline" size={12} color="#E65100" />
                        <Text style={styles.wStaleText}>May be outdated</Text>
                      </View>
                    )}
                  </View>
                </>
              );
            })() : (
              <View style={{ alignItems: 'center', padding: 32 }}>
                <Text style={{ color: colors.textMuted }}>No weather data available</Text>
              </View>
            )}
          </View>
        </View>
      </Modal>

      {/* Location modal */}
      <Modal visible={showLocationModal} transparent animationType="slide" onRequestClose={() => setShowLocationModal(false)}>
        <View style={styles.wModalOverlay}>
          <View style={styles.wModalCard}>
            <View style={styles.wModalHandle} />
            <View style={styles.wModalTopRow}>
              <Text style={styles.wModalTitle}>
                {myLocation ? 'My Last Known Location' : 'Nearby Devices'}
              </Text>
              <TouchableOpacity onPress={() => setShowLocationModal(false)}>
                <Icon name="close" size={22} color={colors.textMuted} />
              </TouchableOpacity>
            </View>
            {myLocation ? (() => {
              const ageMins = Math.floor((Date.now() - myLocation.ts) / 60000);
              const ageStr  = ageMins === 0 ? 'Just now' : `${ageMins} min ago`;
              return (
                <>
                  <View style={styles.locRow}>
                    <Text style={styles.locLabel}>Latitude</Text>
                    <Text style={styles.locValue}>{myLocation.lat.toFixed(6)}</Text>
                  </View>
                  <View style={styles.locRow}>
                    <Text style={styles.locLabel}>Longitude</Text>
                    <Text style={styles.locValue}>{myLocation.lng.toFixed(6)}</Text>
                  </View>
                  <View style={styles.wFooter}>
                    <View style={[styles.wSourceBadge, styles.wSourceGps]}>
                      <Text style={styles.wSourceText}>GPS</Text>
                    </View>
                    <Text style={styles.wAgeText}>Fixed {ageStr}</Text>
                  </View>
                  <Text style={styles.locPrivacyNote}>
                    This location is stored only on your device and is never shared automatically.
                  </Text>
                </>
              );
            })() : nearbyPeers.length > 0 ? (
              <>
                <Text style={[styles.locLabel, { marginBottom: 12 }]}>
                  No GPS fix yet — showing nearby mesh devices:
                </Text>
                {nearbyPeers.map(peer => (
                  <View key={peer.id} style={styles.locRow}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                      <Icon name="person" size={16} color={colors.primary} />
                      <Text style={styles.locValue}>{peer.name}</Text>
                    </View>
                    {peer.battery != null && (
                      <Text style={styles.locLabel}>{peer.battery}%</Text>
                    )}
                  </View>
                ))}
                <Text style={styles.locPrivacyNote}>
                  These are devices connected to you on the mesh right now.
                </Text>
              </>
            ) : (
              <View style={{ alignItems: 'center', padding: 32 }}>
                <Icon name="location-off" size={36} color={colors.textMuted} />
                <Text style={{ color: colors.textMuted, marginTop: 8 }}>No GPS fix and no nearby devices</Text>
              </View>
            )}
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
              <Icon name="settings" size={20} color="#FFFFFF" />
            </TouchableOpacity>
          </View>
        </View>
        <Text style={styles.subtitle}>
          {myDeviceName} · {myDeviceId ? myDeviceId.substring(0, 8) + '...' : 'Unknown'}
        </Text>
        {/* Status + info row — all indicators aligned on one line */}
        <View style={styles.statusRow}>
          {/* Online/Offline */}
          <View style={[
            styles.statusDot,
            bridgefyStatus === 'ready' ? styles.dotOnline :
            bridgefyStatus === 'initializing' ? styles.dotConnecting :
            styles.dotOffline,
          ]} />
          {bridgefyStatus === 'error' ? (
            <TouchableOpacity onPress={initializeBridgefy}>
              <Text style={[styles.status, { color: '#FF5252' }]}>Offline — Tap to retry</Text>
            </TouchableOpacity>
          ) : (
            <Text style={styles.status}>
              {bridgefyStatus === 'ready'
                ? nearbyPeers.length > 0 ? `Online · ${nearbyPeers.length} peer${nearbyPeers.length > 1 ? 's' : ''}` : 'Online · no peers'
                : 'Connecting'}
            </Text>
          )}

          {/* Battery */}
          {myBattery != null && (
            <>
              <Text style={styles.statusSep}>·</Text>
              <View style={styles.statusPill}>
                <Icon
                  name={myBattery > 60 ? 'battery-std' : myBattery > 15 ? 'battery-2-bar' : 'battery-alert'}
                  size={13}
                  color={myBattery <= 15 ? '#FF5252' : colors.headerStatusText}
                />
                <Text style={[styles.statusPillText, myBattery <= 15 && { color: '#FF5252' }]}>
                  {myBattery}%
                </Text>
              </View>
            </>
          )}

          {/* Weather */}
          {weather?.current && (() => {
            const wi = wmoInfo(weather.current.code);
            return (
              <>
                <Text style={styles.statusSep}>·</Text>
                <TouchableOpacity style={styles.statusPill} onPress={() => setShowWeatherModal(true)}>
                  <MCIcon name={wi.icon} size={13} color={wi.color} />
                  <Text style={styles.statusPillText}>
                    {weather.current.temp}°  {weather.city || 'Unknown'}
                  </Text>
                </TouchableOpacity>
              </>
            );
          })()}

          {/* Location */}
          <Text style={styles.statusSep}>·</Text>
          <TouchableOpacity style={styles.statusPill} onPress={() => setShowLocationModal(true)}>
            <Icon
              name={myLocation ? 'my-location' : nearbyPeers.length > 0 ? 'people' : 'location-off'}
              size={13}
              color={myLocation ? '#81D4FA' : colors.headerStatusText}
            />
            <Text style={styles.statusPillText}>
              {myLocation
                ? `${myLocation.lat.toFixed(3)}, ${myLocation.lng.toFixed(3)}`
                : nearbyPeers.length > 0
                  ? `${nearbyPeers.length} nearby`
                  : 'No location'}
            </Text>
          </TouchableOpacity>
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
          <Icon name="cell-tower" size={16} color="#fff" style={styles.actionBtnIcon} />
          <Text style={styles.actionButtonText}>Broadcast</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionButton, styles.newChatButton]}
          onPress={() => navigation.navigate('Devices')}
        >
          <Icon name="add-comment" size={16} color="#fff" style={styles.actionBtnIcon} />
          <Text style={styles.actionButtonText}>New Chat</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionButton, styles.askMeshButton]}
          onPress={() => navigation.navigate('MeshQuery')}
        >
          <Icon name="hub" size={16} color="#fff" style={styles.actionBtnIcon} />
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
      {inSearchMode ? (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
        >
          {isSearching ? (
            <View style={styles.searchLoadingRow}>
              <ActivityIndicator size="small" color={colors.primary} />
              <Text style={styles.searchLoadingText}>Searching...</Text>
            </View>
          ) : renderSearchResults()}
        </ScrollView>
      ) : (
        <FlatList
          data={conversations}
          renderItem={renderConversation}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={loadData}
              colors={[colors.primary]}
              tintColor={colors.primary}
            />
          }
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <View style={styles.emptyIconCircle} />
              <Text style={styles.emptyText}>No conversations yet</Text>
              <Text style={styles.emptySubtext}>
                Start a broadcast or chat with nearby devices
              </Text>
              <TouchableOpacity style={styles.emptyButton} onPress={loadData}>
                <Text style={styles.emptyButtonText}>Refresh Devices</Text>
              </TouchableOpacity>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
};

// ─── Styles (theme-aware) ────────────────────────────────────────────────────
const makeStyles = (colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

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
  statusRow:     { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginBottom: 4, gap: 4 },
  statusDot:     { width: 8, height: 8, borderRadius: 8, overflow: 'hidden' },
  dotOnline:      { backgroundColor: colors.success },
  dotConnecting:  { backgroundColor: colors.warning },
  dotOffline:     { backgroundColor: colors.error },
  status:        { fontSize: 12, color: colors.headerStatusText },
  statusSep:     { fontSize: 12, color: colors.headerStatusText, opacity: 0.5, marginHorizontal: 1 },
  statusPill:    { flexDirection: 'row', alignItems: 'center', gap: 3 },
  statusPillText:{ fontSize: 12, color: colors.headerStatusText },

  // Action buttons
  actionButtons: {
    flexDirection: 'row',
    padding: 12,
    backgroundColor: colors.actionRowBg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  actionButton: { flex: 1, padding: 12, borderRadius: 10, alignItems: 'center', marginHorizontal: 4, flexDirection: 'row', justifyContent: 'center', gap: 6 },
  actionBtnIcon: { marginTop: 1 },
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

  searchSectionLabel: {
    fontSize: 11, fontWeight: '700', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 0.5,
    marginBottom: 8, marginTop: 4,
  },

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

  // Debug modal
  debugOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'center', alignItems: 'center',
    padding: 20,
  },
  debugCard: {
    width: '100%', maxHeight: '80%',
    backgroundColor: colors.surface,
    borderRadius: 12, padding: 16,
  },
  debugHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  debugTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  debugBody: { maxHeight: 360 },
  debugLine: { fontSize: 12, color: colors.textSecondary, marginBottom: 6 },
  debugBtn: { marginTop: 12, backgroundColor: colors.primary, paddingVertical: 10, borderRadius: 8, alignItems: 'center' },
  debugBtnText: { color: colors.onColor, fontSize: 14, fontWeight: '600' },


  // Weather report modal
  wModalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  wModalCard: {
    backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, paddingBottom: 36, maxHeight: '85%',
  },
  wModalHandle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: colors.border, alignSelf: 'center', marginBottom: 16,
  },
  wModalTopRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  wModalCity:   { fontSize: 16, fontWeight: '600', color: colors.text, flex: 1 },
  wModalHero:   { alignItems: 'center', marginVertical: 12 },
  wModalTemp:   { fontSize: 56, fontWeight: '200', color: colors.text, marginTop: 8 },
  wModalDesc:   { fontSize: 16, color: colors.textSecondary, marginTop: 4 },

  wDetailsRow:  { flexDirection: 'row', justifyContent: 'space-around', marginVertical: 16,
                  backgroundColor: colors.surfaceVariant, borderRadius: 12, padding: 12 },
  wDetailItem:  { alignItems: 'center', gap: 4 },
  wDetailLabel: { fontSize: 11, color: colors.textMuted },
  wDetailValue: { fontSize: 14, fontWeight: '600', color: colors.text },

  wSectionLabel: { fontSize: 12, fontWeight: '600', color: colors.textMuted,
                   textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginTop: 4 },

  wHourlyScroll: { marginBottom: 12 },
  wHourlyItem:   { alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8,
                   backgroundColor: colors.surfaceVariant, borderRadius: 10, marginRight: 8, minWidth: 56 },
  wHourlyTime:   { fontSize: 11, color: colors.textMuted, marginBottom: 4 },
  wHourlyTemp:   { fontSize: 14, fontWeight: '600', color: colors.text, marginTop: 4 },
  wHourlyPrecip: { fontSize: 10, color: '#42A5F5', marginTop: 2 },

  wDailyRow:    { flexDirection: 'row', alignItems: 'center', paddingVertical: 10,
                  borderTopWidth: 1, borderTopColor: colors.border },
  wDailyLabel:  { width: 52, fontSize: 14, fontWeight: '500', color: colors.text },
  wDailyDesc:   { flex: 1, fontSize: 13, color: colors.textSecondary, marginLeft: 8 },
  wDailyTemps:  { flexDirection: 'row', gap: 8 },
  wDailyHigh:   { fontSize: 14, fontWeight: '600', color: colors.text },
  wDailyLow:    { fontSize: 14, color: colors.textMuted },

  wFooter:      { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 16 },
  wSourceBadge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 12 },
  wSourceGps:   { backgroundColor: colors.success + '30' },
  wSourceMesh:  { backgroundColor: colors.primary + '30' },
  wSourceCache: { backgroundColor: colors.border },
  wSourceText:  { fontSize: 11, fontWeight: '700', color: colors.text },
  wAgeText:     { fontSize: 12, color: colors.textMuted },
  wStaleBadge:  { flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: '#E6510020', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  wStaleText:   { fontSize: 11, color: '#E65100', fontWeight: '500' },
  wModalTitle:  { fontSize: 17, fontWeight: '700', color: colors.text },

  // Location pill styles
  locRow:         { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  locLabel:       { fontSize: 13, color: colors.textMuted },
  locValue:       { fontSize: 15, fontWeight: '600', color: colors.text, fontVariant: ['tabular-nums'] },
  locPrivacyNote: { fontSize: 12, color: colors.textMuted, marginTop: 16, lineHeight: 17, fontStyle: 'italic' },
});

export default HomeScreen;
