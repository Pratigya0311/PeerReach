import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import BridgefyService from '../services/BridgefyService';

const ChatScreen = ({ route, navigation }) => {
  const { deviceId, deviceName, isBroadcast = false } = route.params;
  const isMesh = !isBroadcast && !BridgefyService.isDirectDevice(deviceId);
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const flatListRef = useRef(null);

  useFocusEffect(
    useCallback(() => {
      BridgefyService.setCurrentChat(deviceId);

      BridgefyService.markAsRead(deviceId, isBroadcast);
      
      return () => {
        BridgefyService.setCurrentChat(null);
      };
    }, [deviceId, isBroadcast])
  );

  useEffect(() => {
    console.log('💬 ChatScreen opened for:', { deviceId, deviceName, isBroadcast });
    
    navigation.setOptions({
      title: deviceName,
      headerBackTitle: 'Back',
    });

    loadStoredMessages();

    BridgefyService.setMessageListener(handleNewMessage);

    BridgefyService.markAsRead(deviceId, isBroadcast);

    return () => {
      BridgefyService.setMessageListener(null);
    };
  }, [deviceId, deviceName, isBroadcast, navigation]);

  const loadStoredMessages = async () => {
    try {
      setIsLoading(true);
      const storedMessages = await BridgefyService.getMessages(deviceId, isBroadcast, 200);

      if (storedMessages.length === 0 && !isBroadcast) {
        const welcomeMessage = {
          id: `welcome_${Date.now()}`,
          text: `You are now chatting with ${deviceName}. Messages are end-to-end encrypted.`,
          senderName: 'System',
          timestamp: Date.now(),
          isMine: false,
          isBroadcast: false,
          type: 'system',
          read: true
        };
        setMessages([welcomeMessage]);
      } else {
        setMessages(storedMessages);
      }
      
      setIsLoading(false);

      setTimeout(() => {
        if (flatListRef.current && storedMessages.length > 0) {
          flatListRef.current.scrollToEnd({ animated: false });
        }
      }, 100);
      
    } catch (error) {
      console.error('Error loading messages:', error);
      setIsLoading(false);
    }
  };

  const handleNewMessage = (message) => {
    console.log('💬 New message in chat:', message);

    const isForThisChat = isBroadcast ? 
      message.isBroadcast === true : 
      (!message.isBroadcast && message.senderId === deviceId);
    
    if (isForThisChat) {
      addMessage(message);

      message.read = true;
    }
  };

  const addMessage = (message) => {
    setMessages(prev => {
      if (prev.some(m => m.id === message.id)) {
        return prev;
      }
      return [...prev, message];
    });

    setTimeout(() => {
      if (flatListRef.current) {
        flatListRef.current.scrollToEnd({ animated: true });
      }
    }, 100);
  };

  const sendMessage = async () => {
    const text = inputText.trim();
    if (!text || isSending) return;

    try {
      setIsSending(true);
      
      let sentMessage;
      
      if (isBroadcast) {
        sentMessage = await BridgefyService.sendBroadcast(text);
      } else if (isMesh) {
        sentMessage = await BridgefyService.sendMeshMessage(deviceId, text);
      } else {
        sentMessage = await BridgefyService.sendMessage(deviceId, text);
      }

      addMessage(sentMessage);

      setInputText('');
      
    } catch (error) {
      console.error('Send failed:', error);
      alert(`Failed to send: ${error.message || 'Unknown error'}`);
    } finally {
      setIsSending(false);
    }
  };

  const renderMessage = ({ item }) => {
    const isMyMessage = item.isMine;
    const isSystem = item.type === 'system';
    
    if (isSystem) {
      return (
        <View style={styles.systemMessage}>
          <Text style={styles.systemText}>{item.text}</Text>
        </View>
      );
    }
    
    return (
      <View
        style={[
          styles.messageContainer,
          isMyMessage ? styles.myMessage : styles.theirMessage,
        ]}
      >
        {!isMyMessage && !isBroadcast && (
          <Text style={styles.senderName}>
            {item.senderName || 'Unknown'}
          </Text>
        )}
        
        {!isMyMessage && isBroadcast && (
          <Text style={styles.broadcastSenderName}>
            📢 {item.senderName || 'Broadcast'}
          </Text>
        )}
        
        <View
          style={[
            styles.messageBubble,
            isMyMessage ? styles.myBubble : styles.theirBubble,
            isBroadcast && !isMyMessage && styles.broadcastBubble,
          ]}
        >
          <Text
            style={[
              styles.messageText,
              isMyMessage ? styles.myMessageText : styles.theirMessageText,
            ]}
          >
            {item.text}
          </Text>
          
          <View style={styles.messageFooter}>
            {isMyMessage && (
              <Text style={styles.messageStatus}>
                {isSending ? '🕐' : '✓'}
              </Text>
            )}
            <Text
              style={[
                styles.timestamp,
                isMyMessage ? styles.myTimestamp : styles.theirTimestamp,
              ]}
            >
              {formatTime(item.timestamp)}
            </Text>
          </View>
        </View>
      </View>
    );
  };

  const formatTime = (timestamp) => {
    if (!timestamp) return '';
    try {
      const date = new Date(timestamp);
      return date.toLocaleTimeString([], { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true 
      }).toLowerCase();
    } catch (e) {
      return '';
    }
  };

  if (isLoading) {
    return (
      <SafeAreaView style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
        <Text style={styles.loadingText}>Loading messages...</Text>
      </SafeAreaView>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      <SafeAreaView style={styles.safeArea}>
        {/* Messages List */}
        <FlatList
          ref={flatListRef}
          data={messages}
          renderItem={renderMessage}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.messagesList}
          onContentSizeChange={() => {
            if (messages.length > 0 && flatListRef.current) {
              flatListRef.current.scrollToEnd({ animated: false });
            }
          }}
          onLayout={() => {
            if (messages.length > 0 && flatListRef.current) {
              flatListRef.current.scrollToEnd({ animated: false });
            }
          }}
          showsVerticalScrollIndicator={true}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyIcon}>
                {isBroadcast ? '📢' : '💬'}
              </Text>
              <Text style={styles.emptyText}>
                {isBroadcast 
                  ? 'No broadcast messages yet' 
                  : `Start chatting with ${deviceName}`}
              </Text>
              <Text style={styles.emptySubtext}>
                {isBroadcast
                  ? 'Messages will be sent to all nearby devices'
                  : 'Your messages are end-to-end encrypted'}
              </Text>
            </View>
          }
        />

        {/* Input Bar */}
        <View style={styles.inputContainer}>
          <TextInput
            style={styles.input}
            placeholder={
              isBroadcast ? 'Type broadcast message...' : 'Type a message...'
            }
            placeholderTextColor="#999"
            value={inputText}
            onChangeText={setInputText}
            multiline
            maxLength={1000}
            onSubmitEditing={sendMessage}
            blurOnSubmit={false}
            editable={!isSending}
          />
          <TouchableOpacity
            style={[
              styles.sendButton,
              (!inputText.trim() || isSending) && styles.sendButtonDisabled,
            ]}
            onPress={sendMessage}
            disabled={!inputText.trim() || isSending}
          >
            {isSending ? (
              <ActivityIndicator size="small" color="white" />
            ) : (
              <Text style={styles.sendButtonText}>
                {isBroadcast ? '📢' : '➤'}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
  },
  safeArea: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#F5F5F5',
  },
  loadingText: {
    fontSize: 16,
    color: '#666',
    marginTop: 12,
  },
  messagesList: {
    padding: 16,
    paddingBottom: 8,
    flexGrow: 1,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  emptyIcon: {
    fontSize: 64,
    marginBottom: 16,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#333',
    marginBottom: 8,
    textAlign: 'center',
  },
  emptySubtext: {
    fontSize: 14,
    color: '#999',
    textAlign: 'center',
    lineHeight: 20,
  },
  systemMessage: {
    backgroundColor: '#E3F2FD',
    borderRadius: 12,
    padding: 12,
    marginVertical: 8,
    alignSelf: 'center',
    maxWidth: '90%',
  },
  systemText: {
    color: '#1976D2',
    fontSize: 14,
    textAlign: 'center',
  },
  messageContainer: {
    marginBottom: 16,
    maxWidth: '85%',
  },
  myMessage: {
    alignSelf: 'flex-end',
  },
  theirMessage: {
    alignSelf: 'flex-start',
  },
  senderName: {
    fontSize: 12,
    color: '#666',
    marginBottom: 4,
    marginLeft: 12,
  },
  broadcastSenderName: {
    fontSize: 12,
    color: '#FF9500',
    fontWeight: '500',
    marginBottom: 4,
    marginLeft: 12,
  },
  messageBubble: {
    borderRadius: 18,
    paddingHorizontal: 16,
    paddingVertical: 12,
    maxWidth: '100%',
  },
  myBubble: {
    backgroundColor: '#007AFF',
  },
  theirBubble: {
    backgroundColor: 'white',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  broadcastBubble: {
    backgroundColor: '#FFF3E0',
    borderWidth: 1,
    borderColor: '#FFE0B2',
  },
  messageText: {
    fontSize: 16,
    lineHeight: 20,
  },
  myMessageText: {
    color: 'white',
  },
  theirMessageText: {
    color: '#333',
  },
  messageFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    marginTop: 4,
  },
  messageStatus: {
    fontSize: 12,
    marginRight: 4,
    opacity: 0.7,
  },
  timestamp: {
    fontSize: 11,
    opacity: 0.7,
  },
  myTimestamp: {
    color: 'rgba(255,255,255,0.7)',
  },
  theirTimestamp: {
    color: '#666',
  },
  inputContainer: {
    flexDirection: 'row',
    padding: 12,
    backgroundColor: 'white',
    borderTopWidth: 1,
    borderTopColor: '#E0E0E0',
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    backgroundColor: '#F5F5F5',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 16,
    maxHeight: 100,
    marginRight: 8,
    minHeight: 40,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
    elevation: 2,
  },
  sendButtonDisabled: {
    backgroundColor: '#CCC',
    shadowOpacity: 0,
    elevation: 0,
  },
  sendButtonText: {
    fontSize: 20,
    color: 'white',
  },
});

export default ChatScreen;
