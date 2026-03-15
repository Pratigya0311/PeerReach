// src/screens/MediaGalleryScreen.js
import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  Image,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  ActivityIndicator,
  SafeAreaView,
  Linking,
} from 'react-native';
import Icon from 'react-native-vector-icons/MaterialIcons';
import BridgefyService from '../services/BridgefyService';
import { useTheme } from '../theme';

const SCREEN_WIDTH = Dimensions.get('window').width;
const PHOTO_SIZE   = Math.floor((SCREEN_WIDTH - 4) / 3); // 3-column grid, 2px gaps

const TABS = ['Photos', 'Locations'];

const MediaGalleryScreen = ({ route }) => {
  const { conversationId, conversationName, isBroadcast } = route.params || {};
  const colors = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [activeTab, setActiveTab]   = useState('Photos');
  const [photos, setPhotos]         = useState([]);
  const [locations, setLocations]   = useState([]);
  const [isLoading, setIsLoading]   = useState(true);

  useEffect(() => {
    loadMedia();
  }, []);

  const loadMedia = async () => {
    try {
      setIsLoading(true);
      const all = await BridgefyService.getMediaMessages(conversationId, isBroadcast);
      setPhotos(all.filter(m => m.contentType === 'photo'));
      setLocations(all.filter(m => m.contentType === 'location'));
    } catch (err) {
      console.error('Media load error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const openMap = (lat, lng) =>
    Linking.openURL(`https://maps.google.com/?q=${lat},${lng}`).catch(console.error);

  const formatDate = (ts) => {
    if (!ts) return '';
    return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const renderPhoto = ({ item }) => (
    <Image
      source={{ uri: `data:image/jpeg;base64,${item.mediaData?.data}` }}
      style={styles.photoThumb}
      resizeMode="cover"
    />
  );

  const renderLocation = ({ item }) => {
    const { lat, lng } = item.mediaData || {};
    return (
      <TouchableOpacity style={styles.locationRow} onPress={() => openMap(lat, lng)}>
        <View style={styles.locationIcon}>
          <Icon name="place" size={20} color={colors.onColor} />
        </View>
        <View style={styles.locationInfo}>
          <Text style={styles.locationCoords}>{lat?.toFixed(5)}, {lng?.toFixed(5)}</Text>
          <Text style={styles.locationMeta}>
            {item.isMine ? 'You' : item.senderName} · {formatDate(item.timestamp)}
          </Text>
        </View>
        <Text style={styles.locationArrow}>→</Text>
      </TouchableOpacity>
    );
  };

  const isEmpty = activeTab === 'Photos' ? photos.length === 0 : locations.length === 0;

  return (
    <SafeAreaView style={styles.container}>
      {/* Tabs */}
      <View style={styles.tabBar}>
        {TABS.map(tab => (
          <TouchableOpacity
            key={tab}
            style={[styles.tab, activeTab === tab && styles.tabActive]}
            onPress={() => setActiveTab(tab)}
          >
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
              {tab}
              {tab === 'Photos'    && photos.length    > 0 && ` (${photos.length})`}
              {tab === 'Locations' && locations.length > 0 && ` (${locations.length})`}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : isEmpty ? (
        <View style={styles.centered}>
          <View style={styles.emptyCircle} />
          <Text style={styles.emptyText}>
            No {activeTab.toLowerCase()} shared in this chat yet
          </Text>
        </View>
      ) : activeTab === 'Photos' ? (
        <FlatList
          data={photos}
          renderItem={renderPhoto}
          keyExtractor={(item) => item.id}
          numColumns={3}
          columnWrapperStyle={styles.photoRow}
          contentContainerStyle={styles.photoGrid}
        />
      ) : (
        <FlatList
          data={locations}
          renderItem={renderLocation}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.locationList}
        />
      )}
    </SafeAreaView>
  );
};

const makeStyles = (colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },

  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tab: {
    flex: 1, paddingVertical: 14, alignItems: 'center',
    borderBottomWidth: 2, borderBottomColor: 'transparent',
  },
  tabActive:     { borderBottomColor: colors.primary },
  tabText:       { fontSize: 14, fontWeight: '500', color: colors.textMuted },
  tabTextActive: { color: colors.primary, fontWeight: '700' },

  centered:   { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  emptyCircle:{ width: 56, height: 56, borderRadius: 28, backgroundColor: colors.emptyCircle, marginBottom: 12 },
  emptyText:  { fontSize: 15, color: colors.textMuted, textAlign: 'center' },

  photoGrid: { padding: 1 },
  photoRow:  { gap: 2 },
  photoThumb:{ width: PHOTO_SIZE, height: PHOTO_SIZE, backgroundColor: colors.border },

  locationList: { padding: 12 },
  locationRow: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 12, padding: 14, marginBottom: 10,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.07, shadowRadius: 2, elevation: 2,
  },
  locationIcon: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: colors.success,
    justifyContent: 'center', alignItems: 'center', marginRight: 12,
  },
  locationInfo:     { flex: 1 },
  locationCoords:   { fontSize: 14, fontWeight: '600', color: colors.text },
  locationMeta:     { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  locationArrow:    { color: colors.textMuted, fontSize: 18, marginLeft: 8 },
});

export default MediaGalleryScreen;
