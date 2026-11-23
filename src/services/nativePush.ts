import {
  NativeNotificationActionEvent,
  initNativePushNotifications,
  isNativeCapacitor,
  listenNativeLocalNotificationActions,
  registerNativeAppStateListener,
  setNativeKeepAwake,
  setupNativeNotificationChannelsAndActions,
} from '../lib/nativeAndroid';

export interface SafeNativeBootstrapOptions {
  standbyEnabled: boolean;
  onToken: (token: string) => void;
  onNotificationAction: (event: NativeNotificationActionEvent) => void;
  onPushReceived: (event: NativeNotificationActionEvent) => void;
  onAppStateChange: (isActive: boolean) => void;
}

/**
 * Safe, non-blocking native bootstrapper for Android 14/15/16 (Capacitor).
 * Runs strictly after React renders inside useEffect, defers permission dialogs
 * sequentially so Android never collides on concurrent permission prompts, and wraps
 * every plugin call (LocalNotifications, PushNotifications, KeepAwake, CapApp) in try/catch.
 */
export function startSafeNativePushAndServices(
  options: SafeNativeBootstrapOptions
): () => void {
  if (!isNativeCapacitor()) {
    return () => {};
  }

  let disposed = false;
  const cleanups: Array<() => void> = [];

  // Defer native plugin setup briefly until after the first React paint completes
  const timerId = window.setTimeout(() => {
    void (async () => {
      try {
        if (disposed) return;

        // 1. Setup LocalNotifications channels & actions first (sequential before FCM permissions)
        try {
          await setupNativeNotificationChannelsAndActions();
        } catch (err) {
          console.error('[nativePush] setupNativeNotificationChannelsAndActions error:', err);
        }
        if (disposed) return;

        // 2. Attach LocalNotifications action listener (Tolak / Jawab / Balas)
        try {
          const stopLocalActions = await listenNativeLocalNotificationActions((ev) => {
            try {
              options.onNotificationAction(ev);
            } catch (err) {
              console.error('[nativePush] onNotificationAction error:', err);
            }
          });
          if (disposed) {
            stopLocalActions();
          } else {
            cleanups.push(stopLocalActions);
          }
        } catch (err) {
          console.error('[nativePush] listenNativeLocalNotificationActions error:', err);
        }
        if (disposed) return;

        // 3. Register FCM PushNotifications safely (non-blocking if google-services is absent)
        try {
          const stopPush = await initNativePushNotifications({
            onToken: (token) => {
              try {
                if (!disposed) options.onToken(token);
              } catch (err) {
                console.error('[nativePush] onToken error:', err);
              }
            },
            onPushReceived: (payload) => {
              try {
                if (!disposed) options.onPushReceived(payload);
              } catch (err) {
                console.error('[nativePush] onPushReceived error:', err);
              }
            },
            onPushAction: (payload) => {
              try {
                if (!disposed) options.onNotificationAction(payload);
              } catch (err) {
                console.error('[nativePush] onPushAction error:', err);
              }
            },
          });
          if (disposed) {
            stopPush();
          } else {
            cleanups.push(stopPush);
          }
        } catch (err) {
          console.error('[nativePush] initNativePushNotifications error:', err);
        }
        if (disposed) return;

        // 4. Attach CapApp foreground/background resume listener
        try {
          const stopAppState = await registerNativeAppStateListener((isActive) => {
            try {
              if (!disposed) options.onAppStateChange(isActive);
            } catch (err) {
              console.error('[nativePush] onAppStateChange error:', err);
            }
          });
          if (disposed) {
            stopAppState();
          } else {
            cleanups.push(stopAppState);
          }
        } catch (err) {
          console.error('[nativePush] registerNativeAppStateListener error:', err);
        }
        if (disposed) return;

        // 5. Sync KeepAwake safely if Mode Siaga is enabled
        if (options.standbyEnabled) {
          try {
            await setNativeKeepAwake(true);
          } catch (err) {
            console.error('[nativePush] KeepAwake error:', err);
          }
        }
      } catch (err) {
        console.error('[nativePush] Unexpected native bootstrap error:', err);
      }
    })();
  }, 500);

  return () => {
    disposed = true;
    window.clearTimeout(timerId);
    cleanups.forEach((fn) => {
      try {
        fn();
      } catch (err) {
        console.error('[nativePush] Cleanup error:', err);
      }
    });
  };
}
