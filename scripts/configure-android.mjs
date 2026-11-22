import fs from 'fs';
import path from 'path';

const androidRoot = path.resolve(process.cwd(), 'android');
const manifestPath = path.join(androidRoot, 'app', 'src', 'main', 'AndroidManifest.xml');
const resDrawableDir = path.join(androidRoot, 'app', 'src', 'main', 'res', 'drawable');
const publicIconPath = path.resolve(process.cwd(), 'public', 'icon-512.png');

if (!fs.existsSync(manifestPath)) {
  console.log('[configure-android] android/ folder not found yet. Run `npx cap add android` first.');
  process.exit(0);
}

// 1. Inject WhatsApp-grade Android permissions into AndroidManifest.xml
const REQUIRED_PERMISSIONS = [
  'android.permission.INTERNET',
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.CAMERA',
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.WAKE_LOCK',
  'android.permission.VIBRATE',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.USE_FULL_SCREEN_INTENT',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
  'android.permission.FOREGROUND_SERVICE_CAMERA',
];

let manifest = fs.readFileSync(manifestPath, 'utf8');
let addedCount = 0;

for (const perm of REQUIRED_PERMISSIONS) {
  if (!manifest.includes(perm)) {
    const tag = `    <uses-permission android:name="${perm}" />\n`;
    manifest = manifest.replace('<application', `${tag}<application`);
    addedCount++;
  }
}

// Enable cleartext & lock-screen wake attributes on MainActivity for incoming call modal
if (!manifest.includes('android:showWhenLocked="true"')) {
  manifest = manifest.replace(
    'android:name=".MainActivity"',
    'android:name=".MainActivity"\n            android:showWhenLocked="true"\n            android:turnScreenOn="true"'
  );
}

fs.writeFileSync(manifestPath, manifest, 'utf8');
console.log(`[configure-android] Updated AndroidManifest.xml (+${addedCount} permissions, showWhenLocked/turnScreenOn enabled).`);

// 2. Ensure ic_stat_icon_config_sample vector drawable exists for Capacitor LocalNotifications
fs.mkdirSync(resDrawableDir, { recursive: true });
const statIconPath = path.join(resDrawableDir, 'ic_stat_icon_config_sample.xml');
const statIconXml = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24"
    android:tint="#FFFFFF">
    <path
        android:fillColor="#FFFFFFFF"
        android:pathData="M12,2C6.48,2 2,6.48 2,12c0,1.85 0.5,3.58 1.37,5.07L2,22l5.09,-1.33C8.55,21.52 10.22,22 12,22c5.52,0 10,-4.48 10,-10S17.52,2 12,2zM12,16.5c-0.83,0 -1.5,-0.67 -1.5,-1.5s0.67,-1.5 1.5,-1.5 1.5,0.67 1.5,1.5 -0.67,1.5 -1.5,1.5zM15.5,12.5c-0.96,-0.96 -2.23,-1.5 -3.5,-1.5s-2.54,0.54 -3.5,1.5l-1.06,-1.06C8.69,10.19 10.29,9.5 12,9.5s3.31,0.69 4.56,1.94L15.5,12.5zM17.62,10.38C16.12,8.88 14.13,8 12,8s-4.12,0.88 -5.62,2.38L5.32,9.32C7.1,7.54 9.48,6.5 12,6.5s4.9,1.04 6.68,2.82L17.62,10.38z" />
</vector>
`;
fs.writeFileSync(statIconPath, statIconXml, 'utf8');
console.log('[configure-android] Generated res/drawable/ic_stat_icon_config_sample.xml.');

// 3. Copy WattappsAU 512px icon into mipmap launcher fallback if present
if (fs.existsSync(publicIconPath)) {
  const mipmapDirs = ['mipmap-hdpi', 'mipmap-mdpi', 'mipmap-xhdpi', 'mipmap-xxhdpi', 'mipmap-xxxhdpi'];
  for (const dirName of mipmapDirs) {
    const targetDir = path.join(androidRoot, 'app', 'src', 'main', 'res', dirName);
    if (fs.existsSync(targetDir)) {
      fs.copyFileSync(publicIconPath, path.join(targetDir, 'ic_launcher.png'));
      fs.copyFileSync(publicIconPath, path.join(targetDir, 'ic_launcher_round.png'));
      fs.copyFileSync(publicIconPath, path.join(targetDir, 'ic_launcher_foreground.png'));
    }
  }
  console.log('[configure-android] Synced WattappsAU app icons to Android mipmap directories.');
}

// 4. Copy root google-services.json into android/app/google-services.json for native FCM push
const rootGoogleServices = path.resolve(process.cwd(), 'google-services.json');
const targetGoogleServices = path.join(androidRoot, 'app', 'google-services.json');
if (fs.existsSync(rootGoogleServices)) {
  fs.copyFileSync(rootGoogleServices, targetGoogleServices);
  console.log('[configure-android] Copied google-services.json to android/app/google-services.json.');
}
