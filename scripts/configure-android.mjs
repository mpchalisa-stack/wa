import fs from 'fs';
import path from 'path';

const androidRoot = path.resolve(process.cwd(), 'android');
const rootBuildGradlePath = path.join(androidRoot, 'build.gradle');
const appBuildGradlePath = path.join(androidRoot, 'app', 'build.gradle');
const manifestPath = path.join(androidRoot, 'app', 'src', 'main', 'AndroidManifest.xml');
const rootGoogleServices = path.resolve(process.cwd(), 'google-services.json');
const targetGoogleServices = path.join(androidRoot, 'app', 'google-services.json');
const publicIconPath = path.resolve(process.cwd(), 'public', 'icon-512.png');

if (!fs.existsSync(manifestPath)) {
  console.log('[configure-android] android/ folder not found yet. Run `npx cap add android` first.');
  process.exit(0);
}

// 1. Copy root google-services.json into android/app/google-services.json if not already copied
if (fs.existsSync(rootGoogleServices) && !fs.existsSync(targetGoogleServices)) {
  fs.copyFileSync(rootGoogleServices, targetGoogleServices);
  console.log('[configure-android] Copied google-services.json to android/app/google-services.json.');
}

// 2. Ensure classpath 'com.google.gms:google-services:4.4.2' is present in android/build.gradle
if (fs.existsSync(rootBuildGradlePath)) {
  let rootGradle = fs.readFileSync(rootBuildGradlePath, 'utf8');
  if (!rootGradle.includes('com.google.gms:google-services')) {
    const depAnchor = /(dependencies\s*\{)/;
    if (depAnchor.test(rootGradle)) {
      rootGradle = rootGradle.replace(
        depAnchor,
        "$1\n        classpath 'com.google.gms:google-services:4.4.2'"
      );
      fs.writeFileSync(rootBuildGradlePath, rootGradle, 'utf8');
      console.log("[configure-android] Injected classpath 'com.google.gms:google-services:4.4.2' into android/build.gradle.");
    }
  } else {
    console.log('[configure-android] com.google.gms:google-services classpath already present in android/build.gradle.');
  }
}

// 3. Ensure apply plugin: 'com.google.gms.google-services' is present in android/app/build.gradle when google-services.json exists
const hasGoogleServicesJson = fs.existsSync(targetGoogleServices);
if (hasGoogleServicesJson && fs.existsSync(appBuildGradlePath)) {
  let appGradle = fs.readFileSync(appBuildGradlePath, 'utf8');
  if (!appGradle.includes("com.google.gms.google-services")) {
    appGradle = `${appGradle.trimEnd()}\n\napply plugin: 'com.google.gms.google-services'\n`;
    fs.writeFileSync(appBuildGradlePath, appGradle, 'utf8');
    console.log("[configure-android] Appended apply plugin: 'com.google.gms.google-services' to android/app/build.gradle.");
  } else {
    console.log('[configure-android] google-services plugin already configured in android/app/build.gradle.');
  }
} else {
  console.log('[configure-android] google-services.json not present in android/app/; skipping google-services plugin injection.');
}

// 4. Inject safe Android permissions into AndroidManifest.xml (avoiding broken custom drawable refs)
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

if (!manifest.includes('android:showWhenLocked="true"')) {
  manifest = manifest.replace(
    'android:name=".MainActivity"',
    'android:name=".MainActivity"\n            android:showWhenLocked="true"\n            android:turnScreenOn="true"'
  );
}

fs.writeFileSync(manifestPath, manifest, 'utf8');
console.log(`[configure-android] Updated AndroidManifest.xml (+${addedCount} permissions).`);

// 5. Remove any stale custom ic_stat_icon_config_sample drawable if present
const staleStatIconPath = path.join(
  androidRoot,
  'app',
  'src',
  'main',
  'res',
  'drawable',
  'ic_stat_icon_config_sample.xml'
);
if (fs.existsSync(staleStatIconPath)) {
  fs.unlinkSync(staleStatIconPath);
}

// 6. Safely copy public/icon-512.png into mipmap-xxxhdpi/ic_launcher.png (if directory exists)
if (fs.existsSync(publicIconPath)) {
  const xxxhdpiDir = path.join(androidRoot, 'app', 'src', 'main', 'res', 'mipmap-xxxhdpi');
  if (fs.existsSync(xxxhdpiDir)) {
    fs.copyFileSync(publicIconPath, path.join(xxxhdpiDir, 'ic_launcher.png'));
    console.log('[configure-android] Copied public/icon-512.png to mipmap-xxxhdpi/ic_launcher.png.');
  }
}
