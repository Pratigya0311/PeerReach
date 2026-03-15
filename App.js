import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import AppNavigator from './src/navigation/AppNavigator';
import { ThemeProvider } from './src/theme';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('💥 Uncaught error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.errorContainer}>
          <Text style={styles.errorTitle}>Something went wrong</Text>
          <Text style={styles.errorMsg}>{this.state.error?.message || 'Unknown error'}</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  errorContainer: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    padding: 32, backgroundColor: '#000',
  },
  errorTitle: { fontSize: 20, fontWeight: 'bold', color: '#FF3B30', marginBottom: 12 },
  errorMsg:   { fontSize: 14, color: '#999', textAlign: 'center' },
});

const App = () => (
  <ErrorBoundary>
    <ThemeProvider>
      <AppNavigator />
    </ThemeProvider>
  </ErrorBoundary>
);

export default App;
