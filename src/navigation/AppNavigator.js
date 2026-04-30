import React from 'react';
import { TouchableOpacity, StyleSheet, useColorScheme } from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import { NavigationContainer, DarkTheme, DefaultTheme } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { useThemeCtx } from '../theme';
import HomeScreen from '../screens/HomeScreen';
import ChatScreen from '../screens/ChatScreen';
import DevicesScreen from '../screens/DevicesScreen';
import MeshQueryScreen from '../screens/MeshQueryScreen';
import MediaGalleryScreen from '../screens/MediaGalleryScreen';
import LogsScreen from '../screens/LogsScreen';
import SettingsScreen from '../screens/SettingsScreen';
import FindDeviceScreen from '../screens/FindDeviceScreen';
import OnboardingScreen from '../screens/OnboardingScreen';

const Stack = createStackNavigator();

const LightNavTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary:    '#007AFF',
    background: '#F5F5F5',
    card:       '#007AFF',
    text:       '#FFFFFF',
    border:     '#0062CC',
  },
};

const DarkNavTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    primary:    '#0A84FF',
    background: '#000000',
    card:       '#1C1C1E',
    text:       '#FFFFFF',
    border:     '#38383A',
  },
};

const AppNavigator = () => {
  const { themePref } = useThemeCtx();
  const systemScheme  = useColorScheme();
  const isDark        = themePref === 'dark' || (themePref === 'system' && systemScheme === 'dark');
  const navTheme  = isDark ? DarkNavTheme : LightNavTheme;

  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator
        initialRouteName="Onboarding"
        screenOptions={({ navigation }) => ({
          headerTintColor: '#FFFFFF',
          headerTitleStyle: { fontWeight: 'bold', color: '#FFFFFF' },
          headerStyle: {
            backgroundColor: isDark ? '#1C1C1E' : '#007AFF',
            elevation: 0,
            shadowOpacity: 0,
          },
          headerBackTitle: 'Back',
          headerRight: () => (
            <TouchableOpacity
              style={styles.settingsBtn}
              onPress={() => navigation.navigate('Settings')}
            >
              <Icon name="settings" size={22} color="#FFFFFF" />
            </TouchableOpacity>
          ),
        })}
      >
        <Stack.Screen
          name="Onboarding"
          component={OnboardingScreen}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="Home"
          component={HomeScreen}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="Chat"
          component={ChatScreen}
          options={({ route }) => ({ title: route.params?.deviceName || 'Chat' })}
        />
        <Stack.Screen
          name="Devices"
          component={DevicesScreen}
          options={{ title: 'Select Device' }}
        />
        <Stack.Screen
          name="MeshQuery"
          component={MeshQueryScreen}
          options={{ title: 'Ask the Mesh' }}
        />
        <Stack.Screen
          name="MediaGallery"
          component={MediaGalleryScreen}
          options={({ route }) => ({ title: route.params?.conversationName ? `${route.params.conversationName} · Media` : 'Media' })}
        />
        <Stack.Screen
          name="Logs"
          component={LogsScreen}
          options={{ title: 'Debug Logs' }}
        />
        <Stack.Screen
          name="Settings"
          component={SettingsScreen}
          options={{ title: 'Settings', headerRight: () => null }}
        />
        <Stack.Screen
          name="FindDevice"
          component={FindDeviceScreen}
          options={{ headerShown: false }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
};

const styles = StyleSheet.create({
  settingsBtn: { marginRight: 8, padding: 4 },
});

export default AppNavigator;
