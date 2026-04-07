export const REACHABILITY_COPY = Object.freeze({
  chatsSectionTitle: 'Chats',
  refreshLabel: 'Refresh',
  devicePickerHint: 'Make sure other devices have PeerReach running.',
  emptyStateHint: 'Messages will appear here once the conversation starts.',
  textOnlyTitle: 'Text only right now',
  textOnlyPhotoBody: 'Photo sharing is unavailable in this chat right now.',
  textOnlyLocationBody: 'Location sharing is unavailable in this chat right now.',
  sosWarning: 'This will broadcast an emergency alert with your location.',
});

export const getAttachmentRestrictionCopy = (kind) => {
  if (kind === 'photo') {
    return {
      title: REACHABILITY_COPY.textOnlyTitle,
      message: REACHABILITY_COPY.textOnlyPhotoBody,
    };
  }

  return {
    title: REACHABILITY_COPY.textOnlyTitle,
    message: REACHABILITY_COPY.textOnlyLocationBody,
  };
};

export const getChatEmptyStateSubtext = () => REACHABILITY_COPY.emptyStateHint;
