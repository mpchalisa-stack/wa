import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import {
  LocalNotifications,
  ActionPerformed as LocalNotificationActionPerformed,
} from '@capacitor/local-notifications';
import {
  PushNotifications,
  Token as PushToken,
  PushNotificationSchema,
  ActionPerformed as PushActionPerformed,
} from '@capacitor/push-notifications';
import { KeepAwake } from '@capacitor-community/keep-awake';

export const ANDROID_CALL_CHANNEL_ID = 'wattapps_calls';
export const ANDROID_MSG_CHANNEL_ID = 'wattapps_messages';
export const CALL_ACTION_TYPE_ID = 'WATTAPPS_CALL_ACTIONS';
export const CHAT_ACTION_TYPE_ID = 'WATTAPPS_CHAT_ACTIONS';

export interface NativeNotificationActionEvent {
  actionId: 'reject_call' | 'accept_call' | 'open_chat' | 'tap';
  kind: 'call' | 'message';
  callerId?: string;
  callerName?: string;
  callId?: string;
  callType?: 'audio' | 'video';
  isVideo?: boolean;
  chatId?: string;
}

export function isNativeAndroid(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
}

export function isNativeCapacitor(): boolean {
  return Capacitor.isNativePlatform();
}

export function getDevicePlatform(): 'android' | 'ios' | 'web' {
  if (!Capacitor.isNativePlatform()) return 'web';
  const platform = Capacitor.getPlatform();
  if (platform === 'android') return 'android';
  if (platform === 'ios') return 'ios';
  return 'web';
}

let cachedNativeFcmToken = '';

export function getCachedNativeFcmToken(): string {
  return cachedNativeFcmToken;
}

/**
 * Creates high-priority WhatsApp-style Android notification channels & action buttons
 * (Tolak / Jawab for incoming calls, Balas / Buka Chat for messages).
 */
export async function setupNativeNotificationChannelsAndActions(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  try {
    const perm = await LocalNotifications.checkPermissions();
    if (perm.display !== 'granted') {
      await LocalNotifications.requestPermissions();
    }

    if (Capacitor.getPlatform() === 'android') {
      await LocalNotifications.createChannel({
        id: ANDROID_CALL_CHANNEL_ID,
        name: 'Panggilan Masuk WattappsAU',
        description: 'Notifikasi panggilan suara & video berprioritas tinggi di layar kunci',
        importance: 5, // IMPORTANCE_HIGH / MAX heads-up on lock screen
        visibility: 1, // VISIBILITY_PUBLIC
        vibration: true,
        lights: true,
        lightColor: '#00a884',
      });

      await LocalNotifications.createChannel({
        id: ANDROID_MSG_CHANNEL_ID,
        name: 'Pesan WattappsAU',
        description: 'Notifikasi pesan taktis masuk WattappsAU',
        importance: 4, // IMPORTANCE_HIGH
        visibility: 1,
        vibration: true,
        lights: true,
        lightColor: '#00a884',
      });
    }

    await LocalNotifications.registerActionTypes({
      types: [
        {
          id: CALL_ACTION_TYPE_ID,
          actions: [
            {
              id: 'reject_call',
              title: 'Tolak',
              destructive: true,
              foreground: false,
            },
            {
              id: 'accept_call',
              title: 'Jawab',
              foreground: true,
            },
          ],
        },
        {
          id: CHAT_ACTION_TYPE_ID,
          actions: [
            {
              id: 'open_chat',
              title: 'Balas / Buka Chat',
              foreground: true,
            },
          ],
        },
      ],
    });
  } catch (err) {
    console.warn('[WattappsAU Native] Failed to setup notification channels:', err);
  }
}

/**
 * Schedules a high-priority native Android lock-screen notification via Capacitor LocalNotifications.
 * Returns true if dispatched natively, false on web so caller can fall back to Service Worker Notification.
 */
export async function scheduleNativeLocalNotification(options: {
  id?: number;
  title: string;
  body: string;
  isCall: boolean;
  callerId?: string;
  callerName?: string;
  callId?: string;
  callType?: 'audio' | 'video';
  chatId?: string;
}): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;

  try {
    const notifId =
      options.id ??
      (options.isCall
        ? 900001
        : Math.floor(100000 + (Date.now() % 799999)));

    await LocalNotifications.schedule({
      notifications: [
        {
          id: notifId,
          title: options.title,
          body: options.body,
          channelId: options.isCall ? ANDROID_CALL_CHANNEL_ID : ANDROID_MSG_CHANNEL_ID,
          actionTypeId: options.isCall ? CALL_ACTION_TYPE_ID : CHAT_ACTION_TYPE_ID,
          smallIcon: 'ic_stat_icon_config_sample',
          iconColor: '#00a884',
          ongoing: options.isCall,
          autoCancel: !options.isCall,
          extra: {
            kind: options.isCall ? 'call' : 'message',
            callerId: options.callerId || '',
            callerName: options.callerName || options.title,
            callId: options.callId || '',
            callType: options.callType || 'audio',
            isVideo: options.callType === 'video',
            chatId: options.chatId || options.callerId || '',
          },
        },
      ],
    });
    return true;
  } catch (err) {
    console.warn('[WattappsAU Native] LocalNotification schedule failed:', err);
    return false;
  }
}

export async function cancelNativeCallNotifications(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await LocalNotifications.cancel({ notifications: [{ id: 900001 }] });
  } catch {
    // ignore
  }
}

/**
 * Subscribes to Capacitor LocalNotifications action clicks (Tolak / Jawab / Balas / tap).
 */
export async function listenNativeLocalNotificationActions(
  onAction: (event: NativeNotificationActionEvent) => void
): Promise<() => void> {
  if (!Capacitor.isNativePlatform()) return () => {};

  const handle = await LocalNotifications.addListener(
    'localNotificationActionPerformed',
    (performed: LocalNotificationActionPerformed) => {
      const extra = (performed.notification.extra || {}) as Record<string, unknown>;
      const rawAction = performed.actionId || 'tap';
      const actionId: NativeNotificationActionEvent['actionId'] =
        rawAction === 'reject_call' ||
        rawAction === 'accept_call' ||
        rawAction === 'open_chat'
          ? rawAction
          : 'tap';

      const kind: 'call' | 'message' =
        extra.kind === 'call' || actionId === 'reject_call' || actionId === 'accept_call'
          ? 'call'
          : 'message';

      onAction({
        actionId,
        kind,
        callerId: typeof extra.callerId === 'string' ? extra.callerId : undefined,
        callerName: typeof extra.callerName === 'string' ? extra.callerName : undefined,
        callId: typeof extra.callId === 'string' ? extra.callId : undefined,
        callType: extra.callType === 'video' ? 'video' : 'audio',
        isVideo: Boolean(extra.isVideo || extra.callType === 'video'),
        chatId: typeof extra.chatId === 'string' ? extra.chatId : undefined,
      });
    }
  );

  return () => {
    void handle.remove();
  };
}

/**
 * Initializes Firebase Cloud Messaging (FCM) via @capacitor/push-notifications on Native Android.
 */
export async function initNativePushNotifications(callbacks: {
  onToken: (token: string) => void;
  onPushReceived: (payload: NativeNotificationActionEvent) => void;
  onPushAction: (payload: NativeNotificationActionEvent) => void;
}): Promise<() => void> {
  if (!Capacitor.isNativePlatform()) return () => {};

  const cleanups: Array<() => Promise<void>> = [];

  try {
    let permStatus = await PushNotifications.checkPermissions();
    if (permStatus.receive === 'prompt') {
      permStatus = await PushNotifications.requestPermissions();
    }

    const regHandle = await PushNotifications.addListener(
      'registration',
      (token: PushToken) => {
        cachedNativeFcmToken = token.value;
        callbacks.onToken(token.value);
      }
    );
    cleanups.push(() => regHandle.remove());

    const regErrHandle = await PushNotifications.addListener(
      'registrationError',
      (err) => {
        console.warn('[WattappsAU FCM] Registration error:', err);
      }
    );
    cleanups.push(() => regErrHandle.remove());

    const parsePushData = (
      data: Record<string, unknown> | undefined,
      actionId: NativeNotificationActionEvent['actionId']
    ): NativeNotificationActionEvent => {
      const safe = data || {};
      const isCall =
        safe.kind === 'call' ||
        safe.type === 'INCOMING_CALL' ||
        safe.action === 'ANSWER_CALL';
      const isVideo = safe.callType === 'video' || safe.isVideo === true || safe.isVideo === 'true';
      return {
        actionId,
        kind: isCall ? 'call' : 'message',
        callerId:
          typeof safe.callerId === 'string'
            ? safe.callerId
            : typeof safe.fromId === 'string'
            ? safe.fromId
            : undefined,
        callerName:
          typeof safe.callerName === 'string'
            ? safe.callerName
            : typeof safe.fromName === 'string'
            ? safe.fromName
            : undefined,
        callId: typeof safe.callId === 'string' ? safe.callId : undefined,
        callType: isVideo ? 'video' : 'audio',
        isVideo,
        chatId: typeof safe.chatId === 'string' ? safe.chatId : undefined,
      };
    };

    const recvHandle = await PushNotifications.addListener(
      'pushNotificationReceived',
      (notification: PushNotificationSchema) => {
        callbacks.onPushReceived(
          parsePushData(notification.data as Record<string, unknown>, 'tap')
        );
      }
    );
    cleanups.push(() => recvHandle.remove());

    const actionHandle = await PushNotifications.addListener(
      'pushNotificationActionPerformed',
      (performed: PushActionPerformed) => {
        const rawAction = performed.actionId || 'tap';
        const actionId: NativeNotificationActionEvent['actionId'] =
          rawAction === 'reject_call' ||
          rawAction === 'accept_call' ||
          rawAction === 'open_chat'
            ? rawAction
            : 'tap';
        callbacks.onPushAction(
          parsePushData(
            performed.notification.data as Record<string, unknown>,
            actionId
          )
        );
      }
    );
    cleanups.push(() => actionHandle.remove());

    if (permStatus.receive === 'granted') {
      await PushNotifications.register();
    }
  } catch (err) {
    console.warn('[WattappsAU FCM] Push initialization skipped:', err);
  }

  return () => {
    cleanups.forEach((fn) => {
      void fn();
    });
  };
}

/**
 * Keeps CPU & screen awake on Android Native when Mode Siaga is enabled.
 */
export async function setNativeKeepAwake(enabled: boolean): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    if (enabled) {
      await KeepAwake.keepAwake();
    } else {
      await KeepAwake.allowSleep();
    }
  } catch {
    // ignore if unsupported
  }
}

/**
 * Intercepts Android hardware/gesture Back button via @capacitor/app.
 */
export async function registerNativeBackButtonHandler(
  handler: () => void
): Promise<() => void> {
  if (!Capacitor.isNativePlatform()) return () => {};
  try {
    const handle = await CapApp.addListener('backButton', () => {
      handler();
    });
    return () => {
      void handle.remove();
    };
  } catch {
    return () => {};
  }
}

/**
 * Listens for Android native app foreground/background transitions.
 */
export async function registerNativeAppStateListener(
  onStateChange: (isActive: boolean) => void
): Promise<() => void> {
  if (!Capacitor.isNativePlatform()) return () => {};
  try {
    const handle = await CapApp.addListener('appStateChange', ({ isActive }) => {
      onStateChange(isActive);
    });
    return () => {
      void handle.remove();
    };
  } catch {
    return () => {};
  }
}

/**
 * Sends Android app to background (like WhatsApp) without killing background standby services.
 */
export async function minimizeNativeApp(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    await CapApp.minimizeApp();
    return true;
  } catch {
    return false;
  }
}

/**
 * Cleanly terminates the Android Native app when the user chooses ⋮ > Exit.
 */
export async function exitNativeApp(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return false;
  try {
    await setNativeKeepAwake(false);
    await CapApp.exitApp();
    return true;
  } catch {
    return false;
  }
}
