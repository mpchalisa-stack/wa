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

// 1. Always sync root google-services.json into android/app/google-services.json
// (unless CI already decoded GOOGLE_SERVICES_JSON_BASE64 into android/app/google-services.json)
if (!process.env.GOOGLE_SERVICES_JSON_BASE64 && fs.existsSync(rootGoogleServices)) {
  fs.copyFileSync(rootGoogleServices, targetGoogleServices);
  console.log('[configure-android] Copied root google-services.json to android/app/google-services.json.');
} else if (fs.existsSync(targetGoogleServices)) {
  console.log('[configure-android] Using existing android/app/google-services.json.');
} else {
  console.warn('[configure-android] WARNING: google-services.json not found in root or android/app/.');
}

// 2. Ensure classpath 'com.google.gms:google-services:4.4.2' is present in android/build.gradle buildscript.dependencies
if (fs.existsSync(rootBuildGradlePath)) {
  let rootGradle = fs.readFileSync(rootBuildGradlePath, 'utf8');
  const existingGmsRegex = /classpath\s+['"]com\.google\.gms:google-services:[^'"]+['"]/;
  if (existingGmsRegex.test(rootGradle)) {
    const updated = rootGradle.replace(
      existingGmsRegex,
      "classpath 'com.google.gms:google-services:4.4.2'"
    );
    if (updated !== rootGradle) {
      fs.writeFileSync(rootBuildGradlePath, updated, 'utf8');
      console.log("[configure-android] Set classpath 'com.google.gms:google-services:4.4.2' in android/build.gradle.");
    } else {
      console.log("[configure-android] classpath 'com.google.gms:google-services:4.4.2' already set in android/build.gradle.");
    }
  } else {
    const depAnchor = /(buildscript\s*\{[\s\S]*?dependencies\s*\{)/;
    if (depAnchor.test(rootGradle)) {
      rootGradle = rootGradle.replace(
        depAnchor,
        "$1\n        classpath 'com.google.gms:google-services:4.4.2'"
      );
      fs.writeFileSync(rootBuildGradlePath, rootGradle, 'utf8');
      console.log("[configure-android] Injected classpath 'com.google.gms:google-services:4.4.2' into android/build.gradle.");
    }
  }
}

// 3. Explicitly apply plugin 'com.google.gms.google-services' at the bottom of android/app/build.gradle
const hasGoogleServicesJson = fs.existsSync(targetGoogleServices);
if (hasGoogleServicesJson && fs.existsSync(appBuildGradlePath)) {
  let appGradle = fs.readFileSync(appBuildGradlePath, 'utf8');

  // Replace Capacitor's silent try/catch wrapper so Google Services plugin is guaranteed to run cleanly
  const silentTryCatchRegex = /try\s*\{\s*def\s+servicesJSON\s*=\s*file\(['"]google-services\.json['"]\)[\s\S]*?catch\s*\([^)]*\)\s*\{[\s\S]*?\}/m;
  if (silentTryCatchRegex.test(appGradle)) {
    appGradle = appGradle.replace(silentTryCatchRegex, '').trimEnd();
  }

  // Remove any duplicate standalone apply lines before appending cleanly at the bottom
  appGradle = appGradle
    .replace(/\n*apply\s+plugin:\s*['"]com\.google\.gms\.google-services['"]\s*/g, '\n')
    .trimEnd();

  appGradle = `${appGradle}\n\napply plugin: 'com.google.gms.google-services'\n`;
  fs.writeFileSync(appBuildGradlePath, appGradle, 'utf8');
  console.log("[configure-android] Applied plugin 'com.google.gms.google-services' at bottom of android/app/build.gradle.");
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
