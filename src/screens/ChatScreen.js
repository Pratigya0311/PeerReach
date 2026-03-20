import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Keyboard,
  ActivityIndicator,
  Image,
  Modal,
  Dimensions,
  Linking,
  Alert,
  Share,
  Vibration,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { launchImageLibrary } from 'react-native-image-picker';
import Geolocation from 'react-native-geolocation-service';
import Icon from 'react-native-vector-icons/MaterialIcons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import BridgefyService from '../services/BridgefyService';
import { useTheme } from '../theme';
import { formatTime, formatDateTime, formatElapsed } from '../utils/timeFormat';
import { requestLocationPermission } from '../utils/permissions';
import LoadingScreen from '../components/LoadingScreen';
import { SHOW_SOS_FINDME_KEY } from '../constants/storageKeys';

// Max base64 length (~45 KB raw image → ~60 KB base64) to stay within Bridgefy's 64 KB limit
const MAX_BASE64_LENGTH = 61440;

// Max base64 for file transfers (~30 KB raw)
const MAX_FILE_BASE64 = 40960;

// Conditionally import document picker (install: npm install react-native-document-picker)
let DocumentPicker = null;
try { DocumentPicker = require('react-native-document-picker').default; } catch (_e) { /* not installed */ }

// Module-level so it isn't recreated on every render
const URL_REGEX = /https?:\/\/[^\s]+/gi;

const ChatScreen = ({ route, navigation }) => {
  const { deviceId, deviceName, isBroadcast = false } = route.params || {};
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();

  const [messages, setMessages]             = useState([]);
  const [pinnedMessages, setPinnedMessages] = useState([]);
  const [inputText, setInputText]           = useState('');
  const [isLoading, setIsLoading]           = useState(true);
  const [isSending, setIsSending]           = useState(false);
  const [replyTo, setReplyTo]               = useState(null);   // { id, text, senderName }
  const [fullscreenPhoto, setFullscreenPhoto] = useState(null); // base64 string or null
  const [typingUser, setTypingUser]         = useState(null);   // senderName string
  const [showScrollBtn, setShowScrollBtn]   = useState(false);
  const [isDeviceOnline, setIsDeviceOnline] = useState(true);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [peerBattery, setPeerBattery]       = useState(null);
  const [msgInfo, setMsgInfo]               = useState(null); // message whose delivery info panel is open
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [showSosFindMe, setShowSosFindMe]   = useState(true);

  const flatListRef      = useRef(null);
  const isMountedRef     = useRef(true);
  const typingTimerRef   = useRef(null);   // clears typing indicator after 4s
  const typingSentRef    = useRef(0);      // timestamp of last typing packet sent

  // Manual keyboard handling — adjustNothing in manifest means Android won't resize,
  // so we shift the entire screen up by exactly the keyboard height ourselves.
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', e => setKeyboardHeight(e.endCoordinates.height));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
    return () => { show.remove(); hide.remove(); };
  }, []);

  useFocusEffect(
    useCallback(() => {
      BridgefyService.setCurrentChat(deviceId);
      BridgefyService.markAsRead(deviceId, isBroadcast);
      AsyncStorage.getItem(SHOW_SOS_FINDME_KEY).then(val => {
        if (val !== null) setShowSosFindMe(val !== 'false');
      }).catch(() => {});
      return () => { BridgefyService.setCurrentChat(null); };
    }, [deviceId, isBroadcast])
  );

  useEffect(() => {
    isMountedRef.current = true; // Ensure it's true if effect re-runs after cleanup
    navigation.setOptions({
      title: deviceName,
      headerBackTitle: 'Back',
      headerRight: () => (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginRight: 8, gap: 4 }}>
          {!isBroadcast && peerBattery != null && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, marginRight: 4 }}>
              <Icon
                name={peerBattery > 20 ? 'battery-std' : 'battery-alert'}
                size={16}
                color={peerBattery <= 20 ? '#FF5252' : '#FFFFFF'}
              />
              <Text style={{ color: peerBattery <= 20 ? '#FF5252' : '#FFFFFF', fontSize: 12, fontWeight: '600' }}>
                {peerBattery}%
              </Text>
            </View>
          )}
          <TouchableOpacity
            onPress={() => navigation.navigate('MediaGallery', {
              conversationId: deviceId,
              conversationName: deviceName,
              isBroadcast,
            })}
            style={{ padding: 6 }}
          >
            <Icon name="perm-media" size={22} color="#FFFFFF" />
          </TouchableOpacity>
          <TouchableOpacity onPress={confirmClearHistory} style={{ padding: 6 }}>
            <Icon name="delete-sweep" size={22} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
      ),
    });
    // Seed peer battery from in-memory map
    const initialBat = BridgefyService.getDeviceBattery(deviceId);
    if (initialBat != null) setPeerBattery(initialBat);

    loadStoredMessages();
    loadPinnedMessages();
    BridgefyService.setMessageListener(handleNewMessage);
    BridgefyService.setOnTypingHandler(handleTyping);
    BridgefyService.markAsRead(deviceId, isBroadcast);
    BridgefyService.setOnMessageStatusUpdatedHandler(({ messageId, status, deliveredAt, readAt }) => {
      if (!isMountedRef.current) return;
      setMessages(prev => prev.map(m => {
        if (m.id !== messageId) return m;
        return {
          ...m,
          deliveryStatus: status,
          ...(deliveredAt != null && { deliveredAt }),
          ...(readAt      != null && { readAt }),
        };
      }));
    });

    // Track whether the target device is reachable (event-driven, no polling)
    if (!isBroadcast && deviceId) {
      BridgefyService.getConnectedDevices().then(list => {
        if (isMountedRef.current) setIsDeviceOnline(list.some(d => d.id === deviceId));
      }).catch(() => {});
    }
    BridgefyService.setDeviceListListener((data) => {
      if (!isMountedRef.current || isBroadcast) return;
      // Only update online status when we get a real device list (not announce events which have no devices array)
      if (data?.devices && Array.isArray(data.devices)) {
        setIsDeviceOnline(data.devices.some(d => d.id === deviceId));
      }
      // If this device announced an updated display name or battery, refresh
      if (data?.deviceId === deviceId) {
        if (data?.name) navigation.setOptions({ title: data.name });
        const freshBat = BridgefyService.getDeviceBattery(deviceId);
        if (freshBat != null) setPeerBattery(freshBat);
      }
    });

    return () => {
      isMountedRef.current = false;
      BridgefyService.setMessageListener(null);
      BridgefyService.setOnTypingHandler(null);
      BridgefyService.setDeviceListListener(null);
      BridgefyService.setOnMessageStatusUpdatedHandler(null);
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, [deviceId, deviceName, isBroadcast, navigation]);

  // Re-render header when peer battery updates
  useEffect(() => {
    if (isBroadcast) return;
    navigation.setOptions({
      headerRight: () => (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginRight: 8, gap: 4 }}>
          {peerBattery != null && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, marginRight: 4 }}>
              <Icon
                name={peerBattery > 20 ? 'battery-std' : 'battery-alert'}
                size={16}
                color={peerBattery <= 20 ? '#FF5252' : '#FFFFFF'}
              />
              <Text style={{ color: peerBattery <= 20 ? '#FF5252' : '#FFFFFF', fontSize: 12, fontWeight: '600' }}>
                {peerBattery}%
              </Text>
            </View>
          )}
          <TouchableOpacity
            onPress={() => navigation.navigate('MediaGallery', {
              conversationId: deviceId,
              conversationName: deviceName,
              isBroadcast,
            })}
            style={{ padding: 6 }}
          >
            <Icon name="perm-media" size={22} color="#FFFFFF" />
          </TouchableOpacity>
          <TouchableOpacity onPress={confirmClearHistory} style={{ padding: 6 }}>
            <Icon name="delete-sweep" size={22} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
      ),
    });
  }, [peerBattery, isBroadcast, navigation, deviceId, deviceName]);

  const loadStoredMessages = async () => {
    try {
      setIsLoading(true);
      const stored = await BridgefyService.getMessages(deviceId, isBroadcast, 200);
      if (!isMountedRef.current) return;
      if (stored.length === 0 && !isBroadcast) {
        setMessages([{
          id: `welcome_${Date.now()}`,
          text: `You are now chatting with ${deviceName}. Messages are end-to-end encrypted.`,
          senderName: 'System',
          timestamp: Date.now(),
          isMine: false, isBroadcast: false,
          contentType: 'text', mediaData: null,
          type: 'system', read: true,
        }]);
      } else {
        setMessages(stored);
      }
      setIsLoading(false);
      setTimeout(() => {
        if (isMountedRef.current && flatListRef.current && stored.length > 0)
          flatListRef.current.scrollToEnd({ animated: false });
      }, 100);
    } catch (error) {
      if (!isMountedRef.current) return;
      console.error('Error loading messages:', error);
      setIsLoading(false);
    }
  };

  const loadPinnedMessages = async () => {
    try {
      const pinned = await BridgefyService.getPinnedMessages(deviceId, isBroadcast);
      if (isMountedRef.current) setPinnedMessages(pinned);
    } catch (err) {
      console.error('Failed to load pinned messages:', err);
    }
  };

  // ─── Typing indicator ─────────────────────────────────────────────────────
  const handleTyping = ({ senderId, senderName, isBroadcast: isBc }) => {
    const isForThisChat = isBc ? isBroadcast : (senderId === deviceId);
    if (!isForThisChat || !isMountedRef.current) return;
    setTypingUser(senderName);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      if (isMountedRef.current) setTypingUser(null);
    }, 4000);
  };

  const onInputChange = (text) => {
    setInputText(text);
    // Throttle: send typing packet at most once every 3 seconds
    const now = Date.now();
    if (text.length > 0 && now - typingSentRef.current > 3000) {
      typingSentRef.current = now;
      BridgefyService.sendTypingIndicator(deviceId, isBroadcast);
    }
  };

  // ─── Clear history ────────────────────────────────────────────────────────
  const confirmClearHistory = () => {
    Alert.alert(
      'Clear chat history',
      'All messages in this chat will be deleted for you only.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear', style: 'destructive',
          onPress: async () => {
            try {
              await BridgefyService.clearChat(isBroadcast ? 'broadcast' : deviceId, isBroadcast);
              if (isMountedRef.current) {
                setMessages([]);
                setPinnedMessages([]);
              }
            } catch (err) {
              Alert.alert('Error', 'Could not clear history.');
            }
          },
        },
      ]
    );
  };

  const handleLongPress = (item) => {
    if (item.type === 'system') return;
    const isPinned = item.isPinned;
    const isText = item.contentType === 'text';
    const options = [
      { text: 'Reply', onPress: () => setReplyTo({
          id: item.id,
          senderName: item.isMine ? 'You' : (item.senderName || 'Unknown'),
          text: isText ? (item.text || '').substring(0, 80) : `[${item.contentType}]`,
        })
      },
      ...(isText ? [{ text: 'Copy', onPress: () => Share.share({ message: item.text || '' }) }] : []),
      { text: isPinned ? 'Unpin' : 'Pin', onPress: () => togglePin(item) },
      { text: 'Delete for me', style: 'destructive', onPress: () => confirmDelete(item) },
      { text: 'Cancel', style: 'cancel' },
    ];
    Alert.alert('Message', undefined, options);
  };

  const togglePin = async (item) => {
    try {
      const newPinned = !item.isPinned;
      await BridgefyService.pinMessage(item.id, newPinned);
      setMessages(prev => prev.map(m => m.id === item.id ? { ...m, isPinned: newPinned } : m));
      await loadPinnedMessages();
    } catch (err) {
      Alert.alert('Error', 'Could not pin message.');
    }
  };

  const confirmDelete = (item) => {
    Alert.alert(
      'Delete message',
      'This will remove the message for you only.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: async () => {
            try {
              await BridgefyService.deleteMessage(item.id);
              setMessages(prev => prev.filter(m => m.id !== item.id));
              setPinnedMessages(prev => prev.filter(m => m.id !== item.id));
            } catch (err) {
              Alert.alert('Error', 'Could not delete message.');
            }
          },
        },
      ]
    );
  };

  const handleNewMessage = (message) => {
    const isForThisChat = isBroadcast
      ? message.isBroadcast === true
      : (!message.isBroadcast && message.senderId === deviceId);
    if (isForThisChat) {
      addMessage({ ...message, read: true });
      Vibration.vibrate(80);          // short 80ms haptic
      setTypingUser(null);            // clear typing indicator when message arrives
    }
  };

  const addMessage = (message) => {
    setMessages(prev => {
      if (prev.some(m => m.id === message.id)) return prev;
      return [...prev, message];
    });
    setTimeout(() => {
      if (isMountedRef.current) flatListRef.current?.scrollToEnd({ animated: true });
    }, 100);
  };

  // ─── Send text ────────────────────────────────────────────────────────────
  const sendMessage = async () => {
    const text = inputText.trim();
    if (!text || isSending) return;
    const currentReply = replyTo;
    try {
      setIsSending(true);
      setReplyTo(null);
      const sent = isBroadcast
        ? await BridgefyService.sendBroadcast(text, currentReply)
        : await BridgefyService.sendMessage(deviceId, text, currentReply);
      addMessage(sent);
      setInputText('');
    } catch (error) {
      Alert.alert('Send failed', error.message || 'Unknown error');
    } finally {
      setIsSending(false);
    }
  };

  // ─── Send file ────────────────────────────────────────────────────────────
  const pickAndSendFile = async () => {
    if (isSending) return;
    if (!DocumentPicker) {
      Alert.alert(
        'File sharing unavailable',
        'The document picker package is not compatible with this React Native version yet.'
      );
      return;
    }
    try {
      const result = await DocumentPicker.pickSingle({ type: [DocumentPicker.types.allFiles] });
      const { uri, name: fileName, size: fileSize, type: mimeType } = result;
      // Read file as base64 via XHR
      const base64 = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.onload = () => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result.split(',')[1]);
          reader.onerror  = reject;
          reader.readAsDataURL(xhr.response);
        };
        xhr.onerror = reject;
        xhr.open('GET', uri);
        xhr.responseType = 'blob';
        xhr.send();
      });
      if (base64.length > MAX_FILE_BASE64) {
        Alert.alert('File too large', `Max ~30 KB. This file is ~${Math.round(base64.length * 0.75 / 1024)} KB.`);
        return;
      }
      setIsSending(true);
      const sent = isBroadcast
        ? await BridgefyService.sendBroadcastFile(fileName, mimeType, base64, fileSize)
        : await BridgefyService.sendFile(deviceId, fileName, mimeType, base64, fileSize);
      addMessage(sent);
    } catch (err) {
      if (DocumentPicker.isCancel(err)) return; // user cancelled
      Alert.alert('File send failed', err.message || 'Unknown error');
    } finally {
      setIsSending(false);
    }
  };

  // ─── Send SOS (always broadcasts to all nearby devices) ──────────────────
  const sendSOS = () => {
    Alert.alert(
      'Send SOS',
      'This will broadcast an emergency alert with your location to all nearby devices.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Send SOS',
          style: 'destructive',
          onPress: async () => {
            if (isSending) return;
            try {
              if (!await requestLocationPermission('Location is required for SOS.')) return;
              setIsSending(true);
              Geolocation.getCurrentPosition(
                async (pos) => {
                  if (!isMountedRef.current) return;
                  try {
                    const { latitude: lat, longitude: lng } = pos.coords;
                    const sent = await BridgefyService.sendSOS(lat, lng);
                    if (isMountedRef.current) addMessage(sent);
                  } catch (e) {
                    if (isMountedRef.current) Alert.alert('SOS failed', e.message);
                  } finally {
                    if (isMountedRef.current) setIsSending(false);
                  }
                },
                (err) => {
                  if (!isMountedRef.current) return;
                  setIsSending(false);
                  Alert.alert('Location error', err.message);
                },
                { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
              );
            } catch (err) {
              if (isMountedRef.current) {
                setIsSending(false);
                Alert.alert('SOS failed', err.message);
              }
            }
          },
        },
      ]
    );
  };

  // ─── Send Find Me request ─────────────────────────────────────────────────
  const sendFindMe = async () => {
    if (isSending) return;
    try {
      if (!await requestLocationPermission('Location is required to share your position.')) return;
      setIsSending(true);
      Geolocation.getCurrentPosition(
        async (pos) => {
          if (!isMountedRef.current) return;
          try {
            const { latitude: lat, longitude: lng } = pos.coords;
            const sent = await BridgefyService.sendFindMeRequest(deviceId, lat, lng, isBroadcast);
            if (isMountedRef.current) addMessage(sent);
          } catch (e) {
            if (isMountedRef.current) Alert.alert('Find Me failed', e.message);
          } finally {
            if (isMountedRef.current) setIsSending(false);
          }
        },
        (err) => {
          if (!isMountedRef.current) return;
          setIsSending(false);
          Alert.alert('Location error', err.message);
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
      );
    } catch (err) {
      if (isMountedRef.current) {
        setIsSending(false);
        Alert.alert('Find Me failed', err.message);
      }
    }
  };

  // ─── Send photo ───────────────────────────────────────────────────────────
  const pickAndSendPhoto = async () => {
    if (isSending) return;
    try {
      const result = await launchImageLibrary({
        mediaType: 'photo', maxWidth: 600, maxHeight: 600,
        quality: 0.5, includeBase64: true,
      });
      if (result.didCancel || !result.assets?.[0]) return;
      const { base64, width = 1, height = 1 } = result.assets[0];
      if (!base64) { Alert.alert('Error', 'Could not read image data.'); return; }
      if (base64.length > MAX_BASE64_LENGTH) {
        Alert.alert('Image too large', 'Please choose a smaller image (max ~45 KB).');
        return;
      }
      setIsSending(true);
      const sent = isBroadcast
        ? await BridgefyService.sendBroadcastPhoto(base64, width, height)
        : await BridgefyService.sendPhoto(deviceId, base64, width, height);
      addMessage(sent);
    } catch (error) {
      Alert.alert('Photo send failed', error.message || 'Unknown error');
    } finally {
      setIsSending(false);
    }
  };

  // ─── Send location ────────────────────────────────────────────────────────
  const shareLocation = async () => {
    if (isSending) return;
    try {
      if (!await requestLocationPermission('Location permission is required to share your location.')) return;
      setIsSending(true);
      Geolocation.getCurrentPosition(
        async (position) => {
          if (!isMountedRef.current) return;
          try {
            const { latitude: lat, longitude: lng } = position.coords;
            const sent = isBroadcast
              ? await BridgefyService.sendBroadcastLocation(lat, lng)
              : await BridgefyService.sendLocation(deviceId, lat, lng);
            if (isMountedRef.current) addMessage(sent);
          } catch (error) {
            if (isMountedRef.current)
              Alert.alert('Location send failed', error.message || 'Unknown error');
          } finally {
            if (isMountedRef.current) setIsSending(false);
          }
        },
        (error) => {
          if (!isMountedRef.current) return;
          setIsSending(false);
          Alert.alert('Location error', error.message || 'Could not get location.');
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 }
      );
    } catch (error) {
      if (isMountedRef.current) {
        setIsSending(false);
        Alert.alert('Location failed', error.message || 'Unknown error');
      }
    }
  };

  // ─── Date divider helpers ─────────────────────────────────────────────────
  const getDateLabel = (ts) => {
    if (!ts) return '';
    const d    = new Date(ts);
    const now  = new Date();
    const diff = Math.floor((now - d) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  };

  // Inject date-divider objects between messages when the date changes
  const messagesWithDividers = useMemo(() => {
    const result = [];
    let lastLabel = null;
    for (const msg of messages) {
      const label = getDateLabel(msg.timestamp);
      if (label && label !== lastLabel) {
        result.push({ _isDivider: true, id: `div_${msg.timestamp}`, label });
        lastLabel = label;
      }
      result.push(msg);
    }
    return result;
  }, [messages]);

  // ─── Render helpers ───────────────────────────────────────────────────────
  const openMap = (lat, lng) =>
    Linking.openURL(`https://maps.google.com/?q=${lat},${lng}`).catch(console.error);

  // Detect URLs and render them as tappable links
  const renderTextWithLinks = (text, isMyMessage) => {
    if (!text) return null;
    const parts = text.split(URL_REGEX);
    const urls  = text.match(URL_REGEX) || [];
    const result = [];
    parts.forEach((part, i) => {
      if (part) result.push(
        <Text key={`t${i}`} style={[styles.messageText, isMyMessage ? styles.myMessageText : styles.theirMessageText]}>
          {part}
        </Text>
      );
      if (urls[i]) result.push(
        <Text
          key={`u${i}`}
          style={[styles.messageText, styles.linkText]}
          onPress={() => Linking.openURL(urls[i]).catch(console.error)}
        >
          {urls[i]}
        </Text>
      );
    });
    return <Text>{result}</Text>;
  };

  const renderReplyQuote = (item) => {
    if (!item.replyPreview) return null;
    return (
      <View style={[styles.replyQuote, item.isMine && styles.replyQuoteMine]}>
        <View style={[styles.replyBar, item.isMine && styles.replyBarMine]} />
        <Text style={[styles.replyText, item.isMine && styles.replyTextMine]} numberOfLines={2}>
          {item.replyPreview}
        </Text>
      </View>
    );
  };

  const renderContent = (item) => {
    const isMyMessage = item.isMine;

    if (item.contentType === 'photo' && item.mediaData?.data) {
      const { data } = item.mediaData;
      return (
        <TouchableOpacity onPress={() => setFullscreenPhoto(data)} activeOpacity={0.85}>
          <Image
            source={{ uri: `data:image/jpeg;base64,${data}` }}
            style={styles.photoThumbnail}
            resizeMode="cover"
            resizeMethod="resize"
            onError={() => {}}
          />
          <View style={styles.photoTapHint}>
            <Text style={styles.photoTapHintText}>Tap to expand</Text>
          </View>
        </TouchableOpacity>
      );
    }

    if (item.contentType === 'location' && item.mediaData) {
      const { lat, lng } = item.mediaData;
      return (
        <TouchableOpacity style={styles.locationCard} onPress={() => openMap(lat, lng)}>
          <View style={styles.locationIconRow}>
            <Icon name="place" size={18} color={isMyMessage ? 'rgba(255,255,255,0.9)' : colors.primary} />
            <Text style={[styles.locationLabel, isMyMessage && styles.locationLabelMine]}>
              Location
            </Text>
          </View>
          <Text style={[styles.locationCoords, isMyMessage && styles.locationCoordsMine]}>
            {lat?.toFixed(5)}, {lng?.toFixed(5)}
          </Text>
          <Text style={[styles.locationTap, isMyMessage && styles.locationTapMine]}>
            Tap to open in Maps
          </Text>
        </TouchableOpacity>
      );
    }

    // ─── SOS ──────────────────────────────────────────────────────────────────
    if (item.contentType === 'sos' && item.mediaData) {
      const { lat, lng, senderName } = item.mediaData;
      return (
        <View style={styles.sosCard}>
          <View style={styles.sosHeader}>
            <Icon name="warning" size={20} color="#fff" />
            <Text style={styles.sosTitle}> SOS — Emergency</Text>
          </View>
          {!isMyMessage && (
            <Text style={styles.sosSender}>{senderName} needs help</Text>
          )}
          {lat != null && (
            <TouchableOpacity onPress={() => openMap(lat, lng)} style={styles.sosMapBtn}>
              <Icon name="place" size={14} color="#fff" />
              <Text style={styles.sosMapText}>
                {lat.toFixed(5)}, {lng.toFixed(5)} — Tap for map
              </Text>
            </TouchableOpacity>
          )}
          {!isMyMessage && lat != null && (
            <TouchableOpacity
              style={styles.sosFindBtn}
              onPress={() => navigation.navigate('FindDevice', {
                targetDeviceId: item.senderId,
                targetDeviceName: senderName || item.senderName,
                targetLat: lat,
                targetLng: lng,
                requestId: `sos_${item.id}`,
              })}
            >
              <Icon name="navigation" size={14} color="#fff" />
              <Text style={styles.sosFindText}> Navigate to them</Text>
            </TouchableOpacity>
          )}
        </View>
      );
    }

    // ─── File ─────────────────────────────────────────────────────────────────
    if (item.contentType === 'file' && item.mediaData) {
      const { fileName, fileSize, mimeType, base64 } = item.mediaData;
      const sizeLabel = fileSize ? ` · ${Math.round(fileSize / 1024)} KB` : '';
      const handleOpenFile = () => {
        if (base64 && mimeType) {
          Share.share({ message: `${fileName || 'file'}\n\ndata:${mimeType};base64,${base64}` }).catch(() => {});
        } else {
          Alert.alert('Cannot open', 'File data is unavailable.');
        }
      };
      return (
        <TouchableOpacity style={styles.fileCard} onPress={handleOpenFile} activeOpacity={0.75}>
          <Icon name="insert-drive-file" size={28} color={isMyMessage ? 'rgba(255,255,255,0.85)' : colors.primary} />
          <View style={styles.fileInfo}>
            <Text style={[styles.fileName, isMyMessage && styles.fileNameMine]} numberOfLines={1}>
              {fileName || 'File'}
            </Text>
            <Text style={[styles.fileMeta, isMyMessage && styles.fileMetaMine]}>
              {mimeType || 'file'}{sizeLabel}
            </Text>
          </View>
          <Icon name="share" size={18} color={isMyMessage ? 'rgba(255,255,255,0.7)' : colors.textSecondary} />
        </TouchableOpacity>
      );
    }

    // ─── Find Me Request ──────────────────────────────────────────────────────
    if (item.contentType === 'find_me_request' && item.mediaData) {
      const { lat, lng, requestId: rid, senderName } = item.mediaData;
      if (isMyMessage) {
        return (
          <View style={styles.findMeCard}>
            <Icon name="my-location" size={18} color={colors.primary} />
            <Text style={styles.findMeText}> You shared your location — waiting for them to find you</Text>
          </View>
        );
      }
      return (
        <View style={styles.findMeCard}>
          <Icon name="location-on" size={18} color={colors.primary} />
          <Text style={styles.findMeText}> {senderName || item.senderName} wants you to find them</Text>
          <TouchableOpacity
            style={styles.findMeBtn}
            onPress={() => navigation.navigate('FindDevice', {
              targetDeviceId: item.senderId,
              targetDeviceName: senderName || item.senderName,
              targetLat: lat,
              targetLng: lng,
              requestId: rid,
              wasBroadcast: isBroadcast || !item.mediaData?.targetDeviceId,
            })}
          >
            <Icon name="navigation" size={14} color="#fff" />
            <Text style={styles.findMeBtnText}> Open Compass</Text>
          </TouchableOpacity>
        </View>
      );
    }

    // ─── Find Me Response ─────────────────────────────────────────────────────
    if (item.contentType === 'find_me_response' && item.mediaData) {
      const { lat, lng, requestId: rid, senderName } = item.mediaData;
      if (isMyMessage) {
        return (
          <View style={styles.findMeCard}>
            <Icon name="share-location" size={18} color={colors.primary} />
            <Text style={styles.findMeText}> You shared your location back</Text>
          </View>
        );
      }
      return (
        <View style={styles.findMeCard}>
          <Icon name="share-location" size={18} color={colors.primary} />
          <Text style={styles.findMeText}> {senderName || item.senderName} shared their location</Text>
          <TouchableOpacity
            style={styles.findMeBtn}
            onPress={() => navigation.navigate('FindDevice', {
              targetDeviceId: item.senderId,
              targetDeviceName: senderName || item.senderName,
              targetLat: lat,
              targetLng: lng,
              requestId: rid,
            })}
          >
            <Icon name="navigation" size={14} color="#fff" />
            <Text style={styles.findMeBtnText}> Open Compass</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return renderTextWithLinks(item.text, isMyMessage);
  };

  // ─── Pinned messages banner ───────────────────────────────────────────────
  const renderPinnedBanner = () => {
    if (pinnedMessages.length === 0) return null;
    const latest = pinnedMessages[pinnedMessages.length - 1];
    const preview = latest.contentType === 'photo' ? '[Photo]'
      : latest.contentType === 'location' ? '[Location]'
      : (latest.text || '').substring(0, 60);
    return (
      <View style={styles.pinnedBanner}>
        <Icon name="push-pin" size={14} color={colors.primary} style={styles.pinnedIcon} />
        <View style={styles.pinnedContent}>
          <Text style={styles.pinnedLabel}>
            {pinnedMessages.length} pinned{pinnedMessages.length > 1 ? ' messages' : ' message'}
          </Text>
          <Text style={styles.pinnedPreview} numberOfLines={1}>{preview}</Text>
        </View>
        <TouchableOpacity onPress={() => togglePin(latest)} style={styles.pinnedUnpin}>
          <Icon name="close" size={16} color={colors.textMuted} />
        </TouchableOpacity>
      </View>
    );
  };

  const renderMessage = useCallback(({ item }) => {
    // ── Date divider ──────────────────────────────────────────────────────────
    if (item._isDivider) {
      return (
        <View style={styles.dateDivider}>
          <View style={styles.dateDividerLine} />
          <Text style={styles.dateDividerLabel}>{item.label}</Text>
          <View style={styles.dateDividerLine} />
        </View>
      );
    }

    const isMyMessage = item.isMine;
    const isSystem    = item.type === 'system';

    if (isSystem) {
      return (
        <View style={styles.systemMessage}>
          <Text style={styles.systemText}>{item.text}</Text>
        </View>
      );
    }

    return (
      <TouchableOpacity
        activeOpacity={1}
        onLongPress={() => handleLongPress(item)}
        style={[styles.messageContainer, isMyMessage ? styles.myMessage : styles.theirMessage]}
      >
        {item.isPinned && (
          <View style={styles.pinnedIndicatorRow}>
            <Icon name="push-pin" size={10} color={colors.primary} />
            <Text style={styles.pinnedIndicatorText}>Pinned</Text>
          </View>
        )}
        {!isMyMessage && !isBroadcast && (
          <Text style={styles.senderName}>{item.senderName || 'Unknown'}</Text>
        )}
        {!isMyMessage && isBroadcast && (
          <Text style={styles.broadcastSenderName}>{item.senderName || 'Broadcast'}</Text>
        )}

        <View style={[
          styles.messageBubble,
          isMyMessage ? styles.myBubble : styles.theirBubble,
          isBroadcast && !isMyMessage && styles.broadcastBubble,
          item.contentType === 'photo' && styles.photoBubble,
          item.isPinned && styles.pinnedBubble,
        ]}>
          {renderReplyQuote(item)}
          {renderContent(item)}
          <View style={styles.messageFooter}>
            {isMyMessage && (() => {
              const ds = item.deliveryStatus;
              if (isSending || ds === 'sending')
                return <Text style={[styles.tickText, { opacity: 0.5 }]}>···</Text>;
              const tickEl = ds === 'read'
                ? <Text style={[styles.tickText, { color: '#64B5F6' }]}>✓✓</Text>
                : ds === 'delivered'
                  ? <Text style={[styles.tickText, { opacity: 0.75 }]}>✓✓</Text>
                  : <Text style={[styles.tickText, { opacity: 0.75 }]}>✓</Text>;
              return (
                <TouchableOpacity onPress={() => setMsgInfo(item)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  {tickEl}
                </TouchableOpacity>
              );
            })()}
            <Text style={[styles.timestamp, isMyMessage ? styles.myTimestamp : styles.theirTimestamp]}>
              {formatTime(item.timestamp)}
            </Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, styles, colors, deviceId, msgInfo]);


  // ─── Loading state ────────────────────────────────────────────────────────
  if (isLoading) {
    return <LoadingScreen message="Loading messages..." />;
  }

  // ─── Main render ──────────────────────────────────────────────────────────
  const screenW = Dimensions.get('window').width;
  const screenH = Dimensions.get('window').height;

  return (
    <View style={[styles.container, { paddingBottom: keyboardHeight }]}>
      {/* Fullscreen photo viewer */}
      <Modal
        visible={!!fullscreenPhoto}
        transparent
        animationType="fade"
        onRequestClose={() => setFullscreenPhoto(null)}
      >
        <TouchableOpacity
          style={styles.fullscreenOverlay}
          activeOpacity={1}
          onPress={() => setFullscreenPhoto(null)}
        >
          {fullscreenPhoto && (
            <Image
              source={{ uri: `data:image/jpeg;base64,${fullscreenPhoto}` }}
              style={{ width: screenW, height: screenH }}
              resizeMode="contain"
              resizeMethod="resize"
            />
          )}
          <Text style={styles.fullscreenClose}>✕  Tap anywhere to close</Text>
        </TouchableOpacity>
      </Modal>

      {/* Message delivery info panel */}
      <Modal
        visible={!!msgInfo}
        transparent
        animationType="slide"
        onRequestClose={() => setMsgInfo(null)}
      >
        <TouchableOpacity
          style={styles.infoOverlay}
          activeOpacity={1}
          onPress={() => setMsgInfo(null)}
        >
          <TouchableOpacity activeOpacity={1} style={styles.infoSheet} onPress={() => {}}>
            <View style={styles.infoHandle} />
            <Text style={styles.infoTitle}>Message Info</Text>

            {msgInfo && (() => {
              return (
                <>
                  <View style={styles.infoRow}>
                    <Icon name="send" size={18} color="#4CAF50" />
                    <View style={styles.infoRowText}>
                      <Text style={styles.infoLabel}>Sent</Text>
                      <Text style={styles.infoValue}>{formatDateTime(msgInfo.timestamp)}</Text>
                    </View>
                  </View>

                  <View style={styles.infoRow}>
                    <Icon name="done-all" size={18} color={msgInfo.deliveredAt ? '#9E9E9E' : '#ccc'} />
                    <View style={styles.infoRowText}>
                      <Text style={styles.infoLabel}>Delivered</Text>
                      <Text style={styles.infoValue}>{formatDateTime(msgInfo.deliveredAt) || '—'}</Text>
                    </View>
                  </View>

                  <View style={styles.infoRow}>
                    <Icon name="done-all" size={18} color={msgInfo.readAt ? '#64B5F6' : '#ccc'} />
                    <View style={styles.infoRowText}>
                      <Text style={styles.infoLabel}>Read</Text>
                      <Text style={styles.infoValue}>{formatDateTime(msgInfo.readAt) || '—'}</Text>
                    </View>
                  </View>

                  {msgInfo.deliveredAt && msgInfo.timestamp && (
                    <View style={styles.infoRow}>
                      <Icon name="timer" size={18} color="#9E9E9E" />
                      <View style={styles.infoRowText}>
                        <Text style={styles.infoLabel}>Delivery time</Text>
                        <Text style={styles.infoValue}>
                          {formatElapsed(msgInfo.timestamp, msgInfo.deliveredAt)}
                        </Text>
                      </View>
                    </View>
                  )}
                </>
              );
            })()}

            <TouchableOpacity style={styles.infoCloseBtn} onPress={() => setMsgInfo(null)}>
              <Text style={styles.infoCloseTxt}>Close</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>

      <SafeAreaView style={styles.safeArea} edges={['top']}>
        {/* Offline banner — only for direct chats when peer is not reachable */}
        {!isBroadcast && !isDeviceOnline && (
          <View style={styles.offlineBanner}>
            <Icon name="wifi-off" size={14} color="#856404" style={{ marginRight: 6 }} />
            <Text style={styles.offlineBannerText}>
              {deviceName} is out of range — messages will be queued
            </Text>
          </View>
        )}

        {renderPinnedBanner()}

        <View style={{ flex: 1 }}>
          <FlatList
            ref={flatListRef}
            data={messagesWithDividers}
            renderItem={renderMessage}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.messagesList}
            removeClippedSubviews
            maxToRenderPerBatch={10}
            windowSize={10}
            onScrollBeginDrag={() => showAttachMenu && setShowAttachMenu(false)}
            onScroll={(e) => {
              const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
              const distFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
              setShowScrollBtn(distFromBottom > 120);
            }}
            scrollEventThrottle={100}
            onContentSizeChange={() => {
              if (isMountedRef.current && !showScrollBtn)
                flatListRef.current?.scrollToEnd({ animated: false });
            }}
            onLayout={() => {
              if (isMountedRef.current && messages.length > 0)
                flatListRef.current?.scrollToEnd({ animated: false });
            }}
            showsVerticalScrollIndicator
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <View style={styles.emptyIconCircle} />
                <Text style={styles.emptyText}>
                  {isBroadcast ? 'No broadcast messages yet' : `Start chatting with ${deviceName}`}
                </Text>
                <Text style={styles.emptySubtext}>
                  {isBroadcast
                    ? 'Messages will be sent to all nearby devices'
                    : 'Your messages are end-to-end encrypted'}
                </Text>
              </View>
            }
            ListFooterComponent={
              typingUser ? (
                <View style={styles.typingBubble}>
                  <Text style={styles.typingText}>{typingUser} is typing</Text>
                  <Text style={styles.typingDots}> •••</Text>
                </View>
              ) : null
            }
          />

          {/* Scroll-to-bottom FAB */}
          {showScrollBtn && (
            <TouchableOpacity
              style={styles.scrollBtn}
              onPress={() => {
                flatListRef.current?.scrollToEnd({ animated: true });
                setShowScrollBtn(false);
              }}
            >
              <Icon name="keyboard-arrow-down" size={24} color="#fff" />
            </TouchableOpacity>
          )}
        </View>

        {/* Reply strip above input */}
        {replyTo && (
          <View style={styles.replyStrip}>
            <Icon name="reply" size={16} color={colors.primary} style={{ marginRight: 6 }} />
            <View style={{ flex: 1 }}>
              <Text style={styles.replyStripSender}>{replyTo.senderName}</Text>
              <Text style={styles.replyStripText} numberOfLines={1}>{replyTo.text}</Text>
            </View>
            <TouchableOpacity onPress={() => setReplyTo(null)} style={{ padding: 4 }}>
              <Icon name="close" size={18} color={colors.textMuted} />
            </TouchableOpacity>
          </View>
        )}

        {/* Floating attach menu — vertical panel above + button */}
        {showAttachMenu && (
          <View style={styles.attachPanel} pointerEvents="box-none">
            {showSosFindMe && (
              <TouchableOpacity style={styles.attachPanelBtn} onPress={() => { setShowAttachMenu(false); sendSOS(); }}>
                <View style={[styles.attachPanelIcon, { backgroundColor: '#C62828' }]}><Icon name="warning" size={20} color="#fff" /></View>
                <Text style={styles.attachPanelLabel}>SOS</Text>
              </TouchableOpacity>
            )}
            {showSosFindMe && (
              <TouchableOpacity style={styles.attachPanelBtn} onPress={() => { setShowAttachMenu(false); sendFindMe(); }}>
                <View style={[styles.attachPanelIcon, { backgroundColor: '#6A1B9A' }]}><Icon name="my-location" size={20} color="#fff" /></View>
                <Text style={styles.attachPanelLabel}>Find Me</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.attachPanelBtn} onPress={() => { setShowAttachMenu(false); pickAndSendFile(); }}>
              <View style={[styles.attachPanelIcon, { backgroundColor: '#E65100' }]}><Icon name="attach-file" size={20} color="#fff" /></View>
              <Text style={styles.attachPanelLabel}>File</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.attachPanelBtn} onPress={() => { setShowAttachMenu(false); shareLocation(); }}>
              <View style={[styles.attachPanelIcon, { backgroundColor: '#2E7D32' }]}><Icon name="place" size={20} color="#fff" /></View>
              <Text style={styles.attachPanelLabel}>Location</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.attachPanelBtn} onPress={() => { setShowAttachMenu(false); pickAndSendPhoto(); }}>
              <View style={[styles.attachPanelIcon, { backgroundColor: '#1565C0' }]}><Icon name="image" size={20} color="#fff" /></View>
              <Text style={styles.attachPanelLabel}>Photo</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Input bar */}
        <View style={[styles.inputContainer, { paddingBottom: Math.max(insets.bottom, 14) }]}>
          {/* + toggle */}
          <TouchableOpacity
            style={styles.attachBtn}
            onPress={() => setShowAttachMenu(prev => !prev)}
            disabled={isSending}
          >
            <Icon name={showAttachMenu ? 'close' : 'add'} size={24} color={isSending ? colors.border : colors.primary} />
          </TouchableOpacity>

          <TextInput
            style={styles.input}
            placeholder={isBroadcast ? 'Type broadcast message...' : 'Type a message...'}
            placeholderTextColor={colors.placeholder}
            value={inputText}
            onChangeText={onInputChange}
            multiline
            maxLength={1000}
            onSubmitEditing={sendMessage}
            submitBehavior="newline"
            editable={!isSending}
          />

          <TouchableOpacity
            style={[styles.sendButton, (!inputText.trim() || isSending) && styles.sendButtonDisabled]}
            onPress={sendMessage}
            disabled={!inputText.trim() || isSending}
          >
            {isSending
              ? <ActivityIndicator size="small" color="white" />
              : <Icon name={isBroadcast ? 'campaign' : 'send'} size={20} color="white" />
            }
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </View>
  );
};

// ─── Styles (theme-aware) ────────────────────────────────────────────────────
const makeStyles = (colors) => StyleSheet.create({
  container:        { flex: 1, backgroundColor: colors.background },
  safeArea:         { flex: 1 },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background },
  loadingText:      { fontSize: 16, color: colors.textSecondary, marginTop: 12 },
  messagesList:     { padding: 16, paddingBottom: 8, flexGrow: 1 },

  emptyState:      { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 40 },
  emptyIconCircle: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.emptyCircle, marginBottom: 16 },
  emptyText:       { fontSize: 18, fontWeight: '600', color: colors.text, marginBottom: 8, textAlign: 'center' },
  emptySubtext:    { fontSize: 14, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },

  systemMessage: {
    backgroundColor: colors.systemMsg,
    borderRadius: 12, padding: 12,
    marginVertical: 8, alignSelf: 'center', maxWidth: '90%',
  },
  systemText: { color: colors.systemMsgText, fontSize: 14, textAlign: 'center' },

  messageContainer: { marginBottom: 16, maxWidth: '85%' },
  myMessage:        { alignSelf: 'flex-end' },
  theirMessage:     { alignSelf: 'flex-start' },

  senderName:          { fontSize: 12, color: colors.senderName, marginBottom: 4, marginLeft: 12 },
  broadcastSenderName: { fontSize: 12, color: colors.broadcastSenderName, fontWeight: '500', marginBottom: 4, marginLeft: 12 },

  messageBubble: { borderRadius: 18, paddingHorizontal: 16, paddingVertical: 12, maxWidth: '100%' },
  myBubble:    { backgroundColor: colors.myBubble },
  theirBubble: {
    backgroundColor: colors.theirBubble,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1, shadowRadius: 2, elevation: 2,
  },
  broadcastBubble: { backgroundColor: colors.broadcastBubble, borderWidth: 1, borderColor: colors.broadcastBubbleBorder },
  photoBubble:      { paddingHorizontal: 4, paddingVertical: 4 },
  photoThumbnail:   { width: 180, height: 180, borderRadius: 10 },
  photoTapHint:     { alignItems: 'center', marginTop: 3 },
  photoTapHintText: { fontSize: 10, color: 'rgba(255,255,255,0.6)' },
  fullscreenOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.95)',
    justifyContent: 'center', alignItems: 'center',
  },
  fullscreenClose: {
    position: 'absolute', bottom: 40,
    color: 'rgba(255,255,255,0.7)', fontSize: 13,
  },

  // Delivery info panel
  infoOverlay:  { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  infoSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, paddingBottom: 32,
    borderWidth: 1, borderColor: colors.border,
  },
  infoHandle:  { width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginBottom: 16 },
  infoTitle:   { fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 20 },
  infoRow:     { flexDirection: 'row', alignItems: 'center', marginBottom: 18, gap: 14 },
  infoRowText: { flex: 1 },
  infoLabel:   { fontSize: 12, color: colors.textMuted, marginBottom: 2 },
  infoValue:   { fontSize: 14, fontWeight: '600', color: colors.text },
  infoCloseBtn:  { marginTop: 8, alignItems: 'center', paddingVertical: 10 },
  infoCloseTxt:  { color: colors.primary, fontSize: 15, fontWeight: '600' },

  messageText:      { fontSize: 16, lineHeight: 20 },
  myMessageText:    { color: colors.myBubbleText },
  theirMessageText: { color: colors.theirBubbleText },

  messageFooter: {
    flexDirection: 'row', justifyContent: 'flex-end',
    alignItems: 'center', marginTop: 4, paddingHorizontal: 4,
  },
  messageStatus:     { fontSize: 12, marginRight: 4, opacity: 0.7 },
  messageStatusMine: { color: colors.onBubble },
  tickText:          { fontSize: 12, marginRight: 4, color: '#FFFFFF', fontWeight: '600' },
  timestamp:         { fontSize: 11, opacity: 0.7 },
  myTimestamp:       { color: colors.onBubble },
  theirTimestamp:    { color: colors.textMuted },

  photoImage: { borderRadius: 12 },

  linkText: { color: colors.primary, textDecorationLine: 'underline' },

  pinnedBubble: { borderWidth: 1, borderColor: colors.primary },
  pinnedIndicatorRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 2, marginLeft: 12 },
  pinnedIndicatorText: { fontSize: 10, color: colors.primary, marginLeft: 2 },

  pinnedBanner: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface,
    borderBottomWidth: 1, borderBottomColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 8,
  },
  pinnedIcon:    { marginRight: 6 },
  pinnedContent: { flex: 1 },
  pinnedLabel:   { fontSize: 11, fontWeight: '700', color: colors.primary, marginBottom: 1 },
  pinnedPreview: { fontSize: 12, color: colors.textSecondary },
  pinnedUnpin:   { padding: 4 },

  locationCard:    { minWidth: 180 },
  locationIconRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  locationLabel:      { fontSize: 14, fontWeight: '600', color: colors.theirBubbleText, marginLeft: 4 },
  locationLabelMine:  { color: colors.onColor },
  locationCoords:     { fontSize: 12, color: colors.textSecondary, marginBottom: 4 },
  locationCoordsMine: { color: colors.onBubble },
  locationTap:        { fontSize: 11, color: colors.primary, fontStyle: 'italic' },
  locationTapMine:    { color: colors.onBubble },

  inputContainer: {
    flexDirection: 'row',
    padding: 8,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    alignItems: 'flex-end',
  },
  attachBtn: { width: 36, height: 40, justifyContent: 'center', alignItems: 'center', marginRight: 2 },

  attachPanel: {
    position: 'absolute',
    bottom: 64,
    left: 8,
    backgroundColor: colors.surface,
    borderRadius: 16,
    paddingVertical: 8,
    paddingHorizontal: 4,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    zIndex: 100,
  },
  attachPanelBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    gap: 12,
  },
  attachPanelIcon: {
    width: 40, height: 40, borderRadius: 20,
    justifyContent: 'center', alignItems: 'center',
  },
  attachPanelLabel: {
    fontSize: 14, fontWeight: '500', color: colors.text,
  },
  input: {
    flex: 1,
    backgroundColor: colors.surfaceVariant,
    borderRadius: 20,
    paddingHorizontal: 16, paddingVertical: 10,
    fontSize: 16, maxHeight: 100, marginRight: 8, minHeight: 40,
    color: colors.text,
  },
  sendButton: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: colors.primary,
    justifyContent: 'center', alignItems: 'center', elevation: 2,
  },
  sendButtonDisabled: { backgroundColor: colors.border, elevation: 0 },

  // ── Date divider ──────────────────────────────────────────────────────────
  dateDivider: {
    flexDirection: 'row', alignItems: 'center',
    marginVertical: 12, paddingHorizontal: 8,
  },
  dateDividerLine: { flex: 1, height: 1, backgroundColor: colors.border },
  dateDividerLabel: {
    fontSize: 12, color: colors.textMuted, fontWeight: '500',
    marginHorizontal: 10,
  },

  // ── Reply quote inside bubble ──────────────────────────────────────────────
  replyQuote: {
    flexDirection: 'row', alignItems: 'stretch',
    backgroundColor: 'rgba(0,0,0,0.08)',
    borderRadius: 8, marginBottom: 6, overflow: 'hidden',
  },
  replyQuoteMine: { backgroundColor: 'rgba(255,255,255,0.2)' },
  replyBar:     { width: 3, backgroundColor: colors.textMuted },
  replyBarMine: { backgroundColor: 'rgba(255,255,255,0.7)' },
  replyText:     { flex: 1, fontSize: 12, color: colors.textSecondary, padding: 6 },
  replyTextMine: { color: 'rgba(255,255,255,0.85)' },

  // ── Reply strip above input ────────────────────────────────────────────────
  replyStrip: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface,
    borderTopWidth: 1, borderTopColor: colors.border,
    paddingHorizontal: 12, paddingVertical: 8,
  },
  replyStripSender: { fontSize: 12, fontWeight: '700', color: colors.primary, marginBottom: 1 },
  replyStripText:   { fontSize: 12, color: colors.textSecondary },

  // ── Typing indicator ─────────────────────────────────────────────────────
  typingBubble: {
    flexDirection: 'row', alignItems: 'center',
    alignSelf: 'flex-start', marginLeft: 16, marginBottom: 8,
    backgroundColor: colors.theirBubble,
    borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08, shadowRadius: 2, elevation: 1,
  },
  typingText: { fontSize: 13, color: colors.textSecondary },
  typingDots: { fontSize: 13, color: colors.primary, letterSpacing: 2 },

  // ── SOS bubble ────────────────────────────────────────────────────────────
  sosCard: {
    backgroundColor: '#C62828', borderRadius: 10, padding: 12, minWidth: 200,
  },
  sosHeader:  { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  sosTitle:   { color: '#fff', fontWeight: '800', fontSize: 15 },
  sosSender:  { color: 'rgba(255,255,255,0.85)', fontSize: 13, marginBottom: 6 },
  sosMapBtn:  { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  sosMapText: { color: 'rgba(255,255,255,0.8)', fontSize: 11, marginLeft: 2 },
  sosFindBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 8,
    paddingVertical: 8, paddingHorizontal: 12,
  },
  sosFindText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  sosBtnInput: { /* tint handled by icon color */ },

  // ── File bubble ───────────────────────────────────────────────────────────
  fileCard: {
    flexDirection: 'row', alignItems: 'center', minWidth: 160, paddingVertical: 4,
  },
  fileInfo:    { flex: 1, marginLeft: 10 },
  fileName:    { fontSize: 14, fontWeight: '600', color: colors.theirBubbleText },
  fileNameMine: { color: colors.onBubble },
  fileMeta:    { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  fileMetaMine: { color: 'rgba(255,255,255,0.7)' },

  // ── Find Me bubble ────────────────────────────────────────────────────────
  findMeCard: {
    minWidth: 180, paddingVertical: 4,
  },
  findMeText: { fontSize: 13, color: colors.theirBubbleText, marginTop: 4, marginBottom: 8, lineHeight: 18 },
  findMeBtn:  {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.primary, borderRadius: 8,
    paddingVertical: 8, paddingHorizontal: 12,
  },
  findMeBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },

  // ── Offline banner ────────────────────────────────────────────────────────
  offlineBanner: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff3cd',
    paddingHorizontal: 14, paddingVertical: 8,
    borderBottomWidth: 1, borderBottomColor: '#ffc107',
  },
  offlineBannerText: { fontSize: 12, color: '#856404', flex: 1 },

  // ── Scroll-to-bottom FAB ──────────────────────────────────────────────────
  scrollBtn: {
    position: 'absolute', bottom: 12, alignSelf: 'center',
    left: '50%', marginLeft: -20,
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: colors.primary,
    justifyContent: 'center', alignItems: 'center',
    elevation: 4,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2, shadowRadius: 3,
  },
});

export default ChatScreen;
