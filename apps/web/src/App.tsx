import type { CollaboratorProfile } from '@whiteboard/shared';
import React, { useState } from 'react';
import { COLLABORATOR_COLORS, RoomLobby } from './components/RoomLobby';
import { WhiteboardWorkspace } from './components/WhiteboardWorkspace';

const SESSION_PROFILE_KEY = 'wb_tab_profile_v1';

const DEFAULT_NAMES = [
  '设计师林溪',
  '架构师陈默',
  '产品周航',
  '前端苏哲',
  '算法夏岚',
  '全栈陆远',
];

function loadOrCreateTabProfile(): CollaboratorProfile {
  try {
    const raw = sessionStorage.getItem(SESSION_PROFILE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as CollaboratorProfile;
      if (parsed?.clientId && parsed?.name && parsed?.color) {
        return parsed;
      }
    }
  } catch {
    // ignore
  }

  const randIdx = Math.floor(Math.random() * DEFAULT_NAMES.length);
  const colorIdx = Math.floor(Math.random() * COLLABORATOR_COLORS.length);
  const clientId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? `u_${crypto.randomUUID().slice(0, 8)}`
      : `u_${Math.random().toString(36).slice(2, 10)}`;

  const created: CollaboratorProfile = {
    clientId,
    name: `${DEFAULT_NAMES[randIdx]}-${clientId.slice(-3)}`,
    color: COLLABORATOR_COLORS[colorIdx],
  };

  try {
    sessionStorage.setItem(SESSION_PROFILE_KEY, JSON.stringify(created));
  } catch {
    // ignore
  }
  return created;
}

export const App: React.FC = () => {
  const initialParams = new URLSearchParams(window.location.search);
  const urlRoom = initialParams.get('room')?.trim() ?? '';
  const autoEnter = initialParams.has('peer') && urlRoom.length > 0;

  const [profile, setProfile] = useState<CollaboratorProfile>(() => loadOrCreateTabProfile());
  const [joinedRoomId, setJoinedRoomId] = useState<string | null>(() =>
    autoEnter ? urlRoom : null,
  );

  const handleJoinRoom = (roomId: string, updatedProfile: CollaboratorProfile) => {
    setProfile(updatedProfile);
    try {
      sessionStorage.setItem(SESSION_PROFILE_KEY, JSON.stringify(updatedProfile));
    } catch {
      // ignore
    }

    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('room', roomId);
    nextUrl.searchParams.delete('peer');
    window.history.replaceState({}, '', nextUrl.toString());

    setJoinedRoomId(roomId);
  };

  const handleLeaveRoom = () => {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.delete('peer');
    window.history.replaceState({}, '', nextUrl.toString());
    setJoinedRoomId(null);
  };

  if (!joinedRoomId) {
    return (
      <RoomLobby
        initialRoomId={urlRoom || 'design-review'}
        profile={profile}
        onJoinRoom={handleJoinRoom}
      />
    );
  }

  return (
    <WhiteboardWorkspace
      roomId={joinedRoomId}
      user={profile}
      onLeaveRoom={handleLeaveRoom}
    />
  );
};
