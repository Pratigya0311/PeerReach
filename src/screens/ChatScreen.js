import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Image,
  Modal,
  Dimensions,
  Linking,
  PermissionsAndroid,
  Alert,
  Share,
  Vibration,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { useHeaderHeight } from '@react-navigation/elements';
import { launchImageLibrary } from 'react-native-image-picker';
import Geolocation from 'react-native-geolocation-service';
import Icon from 'react-native-vector-icons/MaterialIcons';
import BridgefyService from '../services/BridgefyService';
import { useTheme } from '../theme';

// Max base64 length (~45 KB raw image → ~60 KB base64) to stay within Bridgefy's 64 KB limit
const MAX_BASE64_LENGTH = 61440;

// Module-level so it isn't recreated on every render
const URL_REGEX = /https?:\/\/[^\s]+/gi;

const ChatScreen = ({ route, navigation }) => {
  const { deviceId, deviceName, isBroadcast = false } = route.params || {};
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();

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

  const flatListRef      = useRef(null);
  const isMountedRef     = useRef(true);
  const typingTimerRef   = useRef(null);   // clears typing indicator after 4s
  const typingSentRef    = useRef(0);      // timestamp of last typing packet sent

  useFocusEffect(
    useCallback(() => {
      BridgefyService.setCurrentChat(deviceId);
      BridgefyService.markAsRead(deviceId, isBroadcast);
      return () => { BridgefyService.setCurrentChat(null); };
    }, [deviceId, isBroadcast])
  );

  useEffect(() => {
    isMountedRef.current = true; // Ensure it's true if effect re-runs after cleanup
    navigation.setOptions({
      title: deviceName,
      headerBackTitle: 'Back',
      headerRight: () => (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginRight: 8 }}>
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
    loadStoredMessages();
    loadPinnedMessages();
    BridgefyService.setMessageListener(handleNewMessage);
    BridgefyService.setOnTypingHandler(handleTyping);
    BridgefyService.markAsRead(deviceId, isBroadcast);

    // Track whether the target device is reachable
    const checkOnline = () => {
      if (!isBroadcast && deviceId) {
        BridgefyService.getConnectedDevices().then(list => {
          if (isMountedRef.current)
            setIsDeviceOnline(list.some(d => d.id === deviceId));
        }).catch(() => {});
      }
    };
    checkOnline();
    const onlineTimer = setInterval(checkOnline, 5000);

    return () => {
      isMountedRef.current = false;
      BridgefyService.setMessageListener(null);
      BridgefyService.setOnTypingHandler(null);
      clearInterval(onlineTimer);
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, [deviceId, deviceName, isBroadcast, navigation]);

  const loadStoredMessages = async () => {
    try {
      setIsLoading(true);
      const stored = await BridgefyService.getMessages(deviceId, isBroadcast, 200);
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
      if (Platform.OS === 'android') {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          {
            title: 'Location Permission',
            message: 'PeerReach needs location access to share your position.',
            buttonPositive: 'Allow',
          }
        );
        if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
          Alert.alert('Permission denied', 'Location permission is required to share your location.');
          return;
        }
      }
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

  const renderMessage = ({ item }) => {
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
            {isMyMessage && (
              <Text style={[styles.messageStatus, styles.messageStatusMine]}>
                {isSending ? '\u00B7\u00B7\u00B7' : '\u2713'}
              </Text>
            )}
            <Text style={[styles.timestamp, isMyMessage ? styles.myTimestamp : styles.theirTimestamp]}>
              {formatTime(item.timestamp)}
            </Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    try {
      return new Date(timestamp).toLocaleTimeString([], {
        hour: '2-digit', minute: '2-digit', hour12: true,
      }).toLowerCase();
    } catch (_e) { return ''; }
  };

  // ─── Loading state ────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <SafeAreaView style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={styles.loadingText}>Loading messages...</Text>
      </SafeAreaView>
    );
  }

  // ─── Main render ──────────────────────────────────────────────────────────
  const screenW = Dimensions.get('window').width;
  const screenH = Dimensions.get('window').height;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior="padding"
      keyboardVerticalOffset={headerHeight}
    >
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

        {/* Input bar */}
        <View style={[styles.inputContainer, { paddingBottom: Math.max(insets.bottom, 8) }]}>
          <TouchableOpacity
            style={styles.attachBtn}
            onPress={pickAndSendPhoto}
            disabled={isSending}
          >
            <Icon name="image" size={22} color={isSending ? colors.border : colors.primary} />
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.attachBtn}
            onPress={shareLocation}
            disabled={isSending}
          >
            <Icon name="place" size={22} color={isSending ? colors.border : colors.primary} />
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
            blurOnSubmit={false}
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
    </KeyboardAvoidingView>
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

  messageText:      { fontSize: 16, lineHeight: 20 },
  myMessageText:    { color: colors.myBubbleText },
  theirMessageText: { color: colors.theirBubbleText },

  messageFooter: {
    flexDirection: 'row', justifyContent: 'flex-end',
    alignItems: 'center', marginTop: 4, paddingHorizontal: 4,
  },
  messageStatus:     { fontSize: 12, marginRight: 4, opacity: 0.7 },
  messageStatusMine: { color: colors.onBubble },
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
