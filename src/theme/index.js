// src/theme/index.js
import React, { createContext, useContext, useState, useEffect } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const THEME_KEY = '@peerreach_theme'; // 'light' | 'dark' | 'system'

// ─── Semantic colors — identical in both themes ───────────────────────────────
const semantic = {
  success:          '#34C759',
  error:            '#FF3B30',
  warning:          '#FF9500',
  accent:           '#5856D6',
  onColor:          '#FFFFFF',
  onBubble:         'rgba(255,255,255,0.75)',
  headerText:       '#FFFFFF',
  headerSubtitle:   'rgba(255,255,255,0.85)',
  headerStatusText: 'rgba(255,255,255,0.70)',
};

export const lightColors = {
  ...semantic,
  background:           '#F5F5F5',
  surface:              '#FFFFFF',
  surfaceVariant:       '#F5F5F5',
  primary:              '#007AFF',
  text:                 '#333333',
  textSecondary:        '#666666',
  textMuted:            '#999999',
  border:               '#E0E0E0',
  placeholder:          '#999999',
  myBubble:             '#007AFF',
  myBubbleText:         '#FFFFFF',
  theirBubble:          '#FFFFFF',
  theirBubbleText:      '#333333',
  broadcastBubble:      '#FFF3E0',
  broadcastBubbleBorder:'#FFE0B2',
  systemMsg:            '#E3F2FD',
  systemMsgText:        '#1976D2',
  statusBarGateway:     '#D4EDDA',
  statusBarRelay:       '#FFF3CD',
  statusBarOffline:     '#F5E6E6',
  statusBarText:        '#333333',
  headerBg:             '#007AFF',
  actionRowBg:          '#FFFFFF',
  unreadHighlight:      '#F0F8FF',
  unreadBorder:         '#007AFF',
  emptyCircle:          '#E0E0E0',
  senderName:           '#666666',
  broadcastSenderName:  '#FF9500',
  avatarBroadcastBg:    '#FF9500',
  avatarDirectBg:       '#007AFF',
  connectText:          '#007AFF',
};

export const darkColors = {
  ...semantic,
  background:           '#000000',
  surface:              '#1C1C1E',
  surfaceVariant:       '#2C2C2E',
  primary:              '#0A84FF',
  text:                 '#FFFFFF',
  textSecondary:        '#EBEBF5',
  textMuted:            '#8E8E93',
  border:               '#38383A',
  placeholder:          '#636366',
  myBubble:             '#0A84FF',
  myBubbleText:         '#FFFFFF',
  theirBubble:          '#2C2C2E',
  theirBubbleText:      '#FFFFFF',
  broadcastBubble:      '#2C1A00',
  broadcastBubbleBorder:'#5C3A00',
  systemMsg:            '#1A2A3A',
  systemMsgText:        '#4A9EFF',
  statusBarGateway:     '#1A3A1A',
  statusBarRelay:       '#3A2800',
  statusBarOffline:     '#3A1A1A',
  statusBarText:        '#EEEEEE',
  headerBg:             '#1C1C1E',
  actionRowBg:          '#1C1C1E',
  unreadHighlight:      '#0A1A2A',
  unreadBorder:         '#0A84FF',
  emptyCircle:          '#3A3A3C',
  senderName:           '#ABABAB',
  broadcastSenderName:  '#FF9500',
  avatarBroadcastBg:    '#FF9500',
  avatarDirectBg:       '#0A84FF',
  connectText:          '#0A84FF',
};

// ─── Context ──────────────────────────────────────────────────────────────────
export const ThemeContext = createContext({
  themePref: 'system',           // 'light' | 'dark' | 'system'
  setThemePref: () => {},
  colors: lightColors,
});

export const ThemeProvider = ({ children }) => {
  const systemScheme = useColorScheme();
  const [themePref, setThemePrefState] = useState('system');

  useEffect(() => {
    AsyncStorage.getItem(THEME_KEY).then(saved => {
      if (saved) setThemePrefState(saved);
    }).catch(() => {});
  }, []);

  const setThemePref = (pref) => {
    setThemePrefState(pref);
    AsyncStorage.setItem(THEME_KEY, pref).catch(() => {});
  };

  const resolved = themePref === 'system' ? systemScheme : themePref;
  const colors   = resolved === 'dark' ? darkColors : lightColors;

  return (
    <ThemeContext.Provider value={{ themePref, setThemePref, colors }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme    = () => useContext(ThemeContext).colors;
export const useThemeCtx = () => useContext(ThemeContext);
