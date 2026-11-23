/**
 * WattappsAU Firestore Rules Verification Suite (Dirty Dozen Reference Spec)
 * Run against Firebase Emulator with @firebase/rules-unit-testing when testing locally.
 */

export interface DirtyDozenCase {
  id: number;
  name: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  actor: { uid: string; emailVerified: boolean } | null;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_PAYLOADS: DirtyDozenCase[] = [
  {
    id: 1,
    name: 'Unauthenticated Device Read',
    operation: 'get',
    path: 'devices/userA',
    actor: null,
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Cross-User FCM Token Theft',
    operation: 'get',
    path: 'devices/userA',
    actor: { uid: 'userB', emailVerified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Shadow Field Injection on Device Create',
    operation: 'create',
    path: 'devices/userA',
    actor: { uid: 'userA', emailVerified: true },
    payload: {
      userId: 'userA',
      peerId: '123456',
      fcmToken: 'tok_123',
      platform: 'android',
      standbyEnabled: true,
      isAdmin: true,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Unverified Email Write',
    operation: 'create',
    path: 'devices/userUnverified',
    actor: { uid: 'userUnverified', emailVerified: false },
    payload: {
      userId: 'userUnverified',
      peerId: '654321',
      fcmToken: 'tok_456',
      platform: 'android',
      standbyEnabled: false,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Peer Directory Scraping (list)',
    operation: 'list',
    path: 'peerDirectory',
    actor: { uid: 'userB', emailVerified: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Peer ID Hijack via Update',
    operation: 'update',
    path: 'peerDirectory/123456',
    actor: { uid: 'userB', emailVerified: true },
    payload: { ownerUid: 'userB' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'ID Poisoning (>128 chars)',
    operation: 'create',
    path: `wakeSignals/${'a'.repeat(200)}`,
    actor: { uid: 'userA', emailVerified: true },
    payload: { signalId: 'a'.repeat(200) },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Sender Spoofing on WakeSignal',
    operation: 'create',
    path: 'wakeSignals/sig_spoof',
    actor: { uid: 'userB', emailVerified: true },
    payload: {
      signalId: 'sig_spoof',
      senderUid: 'userA',
      senderPeerId: '123456',
      senderName: 'Spoofer',
      recipientUid: 'userC',
      recipientPeerId: '777777',
      type: 'INCOMING_CALL',
      callType: 'audio',
      callId: 'call_1',
      status: 'pending',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Orphaned WakeSignal to Nonexistent Peer',
    operation: 'create',
    path: 'wakeSignals/sig_orphan',
    actor: { uid: 'userA', emailVerified: true },
    payload: {
      signalId: 'sig_orphan',
      senderUid: 'userA',
      senderPeerId: '123456',
      senderName: 'Alpha',
      recipientUid: 'ghostUid',
      recipientPeerId: '999999',
      type: 'NEW_MSG',
      callType: 'none',
      callId: '',
      status: 'pending',
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'Timestamp Forgery on WakeSignal',
    operation: 'create',
    path: 'wakeSignals/sig_time',
    actor: { uid: 'userA', emailVerified: true },
    payload: {
      signalId: 'sig_time',
      senderUid: 'userA',
      senderPeerId: '123456',
      senderName: 'Alpha',
      recipientUid: 'userB',
      recipientPeerId: '654321',
      type: 'PING',
      callType: 'none',
      callId: '',
      status: 'pending',
      createdAt: new Date(2020, 0, 1),
      updatedAt: new Date(2020, 0, 1),
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Terminal State Mutation on Acknowledged WakeSignal',
    operation: 'update',
    path: 'wakeSignals/sig_ack',
    actor: { uid: 'userB', emailVerified: true },
    payload: { status: 'pending' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Unauthorized WakeSignal List Query',
    operation: 'list',
    path: 'wakeSignals',
    actor: { uid: 'userB', emailVerified: true },
    expected: 'PERMISSION_DENIED',
  },
];
