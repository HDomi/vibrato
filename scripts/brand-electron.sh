#!/bin/zsh
# Brand the unpackaged Electron.app in node_modules so the menu bar, Dock and
# macOS privacy prompts say "Vibrato" instead of "Electron".
# Re-run after `npm install` (postinstall does this automatically).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/node_modules/electron/dist/Electron.app"
PLIST="$APP/Contents/Info.plist"
NAME="Vibrato"
BUNDLE_ID="com.hdomi.vibrato"
ICON="$ROOT/assets/icon.icns"

[ -f "$PLIST" ] || { echo "Electron.app not found; run npm install first"; exit 0; }

PB=/usr/libexec/PlistBuddy
$PB -c "Set :CFBundleName $NAME" "$PLIST"
$PB -c "Set :CFBundleDisplayName $NAME" "$PLIST" 2>/dev/null || $PB -c "Add :CFBundleDisplayName string $NAME" "$PLIST"
$PB -c "Set :CFBundleIdentifier $BUNDLE_ID" "$PLIST"
# Approval notifications carry buttons, so default to the "alert" style that stays on screen until dismissed.
$PB -c "Set :NSUserNotificationAlertStyle alert" "$PLIST" 2>/dev/null || $PB -c "Add :NSUserNotificationAlertStyle string alert" "$PLIST"
# Prompt texts for the privacy permissions agents may need (Settings > Permissions requests them).
$PB -c "Set :NSPhotoLibraryUsageDescription Vibrato lets agents read photos you choose to work with." "$PLIST" 2>/dev/null || $PB -c "Add :NSPhotoLibraryUsageDescription string Vibrato lets agents read photos you choose to work with." "$PLIST"
$PB -c "Set :NSDesktopFolderUsageDescription Vibrato and its agents work on projects in your Desktop folder." "$PLIST" 2>/dev/null || $PB -c "Add :NSDesktopFolderUsageDescription string Vibrato and its agents work on projects in your Desktop folder." "$PLIST"
$PB -c "Set :NSDocumentsFolderUsageDescription Vibrato and its agents work on projects in your Documents folder." "$PLIST" 2>/dev/null || $PB -c "Add :NSDocumentsFolderUsageDescription string Vibrato and its agents work on projects in your Documents folder." "$PLIST"
$PB -c "Set :NSDownloadsFolderUsageDescription Vibrato and its agents read files from your Downloads folder." "$PLIST" 2>/dev/null || $PB -c "Add :NSDownloadsFolderUsageDescription string Vibrato and its agents read files from your Downloads folder." "$PLIST"
$PB -c "Set :NSRemovableVolumesUsageDescription Vibrato and its agents work on projects on removable drives." "$PLIST" 2>/dev/null || $PB -c "Add :NSRemovableVolumesUsageDescription string Vibrato and its agents work on projects on removable drives." "$PLIST"
$PB -c "Set :NSNetworkVolumesUsageDescription Vibrato and its agents work on projects on network drives." "$PLIST" 2>/dev/null || $PB -c "Add :NSNetworkVolumesUsageDescription string Vibrato and its agents work on projects on network drives." "$PLIST"
$PB -c "Set :NSAppleEventsUsageDescription Agents running in Vibrato can automate other apps when you allow it." "$PLIST" 2>/dev/null || $PB -c "Add :NSAppleEventsUsageDescription string Agents running in Vibrato can automate other apps when you allow it." "$PLIST"
if [ -f "$ICON" ]; then
  cp "$ICON" "$APP/Contents/Resources/electron.icns"
fi
# Info.plist is part of the sealed bundle; re-sign ad hoc so macOS keeps launching it.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1
# Make Finder/Dock pick up the new name and icon.
touch "$APP"
echo "branded: $APP -> $NAME ($BUNDLE_ID)"
