import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import HomeScreen from '../screens/HomeScreen';
import ChatScreen from '../screens/ChatScreen';
import DevicesScreen from '../screens/DevicesScreen';

const Stack = createStackNavigator();

const AppNavigator = () => {
  return (
    <NavigationContainer>
      <Stack.Navigator
        initialRouteName="Home"
        screenOptions={{
          headerStyle: {
            backgroundColor: '#007AFF',
          },
          headerTintColor: '#fff',
          headerTitleStyle: {
            fontWeight: 'bold',
          },
          headerBackTitle: 'Back',
        }}
      >
        <Stack.Screen 
          name="Home" 
          component={HomeScreen}
          options={{ title: 'PeerReach' }}
        />
        <Stack.Screen 
          name="Chat" 
          component={ChatScreen}
          options={({ route }) => ({ title: route.params.deviceName })}
        />
        <Stack.Screen 
          name="Devices" 
          component={DevicesScreen}
          options={{ title: 'Select Device' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
};

export default AppNavigator;