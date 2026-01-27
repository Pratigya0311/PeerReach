import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import BridgefyService from '../services/BridgefyService';

const ChatScreen = ({ route, navigation }) => {
  const { deviceId, deviceName } = route.params;
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const flatListRef = useRef(null);
  const isBroadcast = deviceId === 'broadcast';

  useEffect(() => {
    console.log('ChatScreen: Opening chat with', { deviceId, deviceName, isBroadcast });
    navigation.setOptions({
      title: deviceName,
    });

    BridgefyService.setMessageListener((incomingMessage) => {
      console.log('ChatScreen: Received message', incomingMessage);

      let isForThisChat = false;
      
      if (isBroadcast) {
        isForThisChat = incomingMessage.isBroadcast === true;
      } else {
        const isDirectMessage = incomingMessage.isBroadcast === false;
        const isFromThisDevice = incomingMessage.senderId === deviceId;
        const isToThisDevice = incomingMessage.receiverId === deviceId;
        const isMyMessage = incomingMessage.isMine === true;
        
        isForThisChat = isDirectMessage && 
          (isFromThisDevice || isToThisDevice || 
           (isMyMessage && incomingMessage.receiverId === deviceId));
      }
      
      if (isForThisChat) {
        addMessage(incomingMessage);
      }
    });

    if (messages.length === 0) {
      const welcomeMessage = {
        id: 'welcome-' + Date.now(),
        text: isBroadcast 
          ? 'Welcome to broadcast chat! Messages here will be sent to all nearby devices.'
          : `You are now chatting with ${deviceName}.`,
        senderName: 'System',
        timestamp: Date.now(),
        isMine: false,
        isBroadcast: isBroadcast,
        type: 'system'
      };
      addMessage(welcomeMessage);
    }

    return () => {
      BridgefyService.setMessageListener(null);
    };
  }, [deviceId, deviceName, isBroadcast]);

  const addMessage = (message) => {
    setMessages((prevMessages) => {
      if (prevMessages.some(msg => msg.id === message.id)) {
        return prevMessages;
      }
      return [...prevMessages, message];
    });

    setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 100);
  };

  const sendMessage = async () => {
    const text = inputText.trim();
    if (!text) return;

    console.log('ChatScreen: Sending message', { text, isBroadcast, deviceId });
    
    try {
      let sentMessage;
      
      if (isBroadcast) {
        sentMessage = await BridgefyService.sendBroadcast(text);
      } else {
        sentMessage = await BridgefyService.sendMessage(deviceId, text);
      }
      
      console.log('ChatScreen: Message sent successfully', sentMessage);
      addMessage(sentMessage);
      setInputText('');
    } catch (error) {
      console.error('ChatScreen: Failed to send message:', error);
      alert(`Failed to send message: ${error.message || 'Unknown error'}`);
    }
  };

  const renderMessage = ({ item }) => {
    const isMyMessage = item.isMine;
    const isSystem = item.senderName === 'System';
    const isBroadcastMsg = item.isBroadcast;
    
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
        {/* Sender name for received messages */}
        {!isMyMessage && (
          <Text style={[
            styles.senderName,
            isBroadcastMsg ? styles.broadcastSenderName : styles.directSenderName
          ]}>
            {isBroadcastMsg ? `📢 ${item.senderName}` : item.senderName}
          </Text>
        )}
        
        {/* Message bubble */}
        <View
          style={[
            styles.messageBubble,
            isMyMessage ? styles.myBubble : styles.theirBubble,
            isBroadcastMsg && !isMyMessage ? styles.broadcastBubble : null
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
          
          {/* Message status and timestamp */}
          <View style={styles.messageFooter}>
            {isMyMessage && (
              <Text style={styles.messageStatus}>✓</Text>
            )}
            <Text
              style={[
                styles.timestamp,
                isMyMessage ? styles.myTimestamp : styles.theirTimestamp,
              ]}
            >
              {new Date(item.timestamp).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </Text>
          </View>
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      {/* Messages List */}
      {messages.length === 0 ? (
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
      ) : (
        <FlatList
          ref={flatListRef}
          data={messages}
          renderItem={renderMessage}
          keyExtractor={(item) => item.id || Math.random().toString()}
          contentContainerStyle={styles.messagesList}
          onContentSizeChange={() => {
            if (messages.length > 0) {
              flatListRef.current?.scrollToEnd({ animated: true });
            }
          }}
          showsVerticalScrollIndicator={false}
        />
      )}

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
          maxLength={500}
          onSubmitEditing={sendMessage}
          blurOnSubmit={false}
        />
        <TouchableOpacity
          style={[
            styles.sendButton,
            !inputText.trim() && styles.sendButtonDisabled,
          ]}
          onPress={sendMessage}
          disabled={!inputText.trim()}
        >
          <Text style={styles.sendButtonText}>
            {isBroadcast ? '📢' : '➤'}
          </Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F5F5',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
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
  messagesList: {
    padding: 16,
    paddingBottom: 8,
  },
  systemMessage: {
    backgroundColor: '#E3F2FD',
    borderRadius: 12,
    padding: 12,
    marginVertical: 8,
    marginHorizontal: 16,
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
    marginBottom: 4,
    marginLeft: 12,
    fontWeight: '500',
  },
  directSenderName: {
    color: '#666',
  },
  broadcastSenderName: {
    color: '#FF9500',
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
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    marginRight: 4,
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