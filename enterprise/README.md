# Enterprise Deployment Guide

Deploy and configure Loose Lips Sink Ships across your organisation.

## Deployment Scenarios

| Scenario | Mechanism | Config Delivery |
|----------|-----------|-----------------|
| **Large enterprise** (Intune, GPO) | Force-install + chrome.storage.managed | Windows Registry / Intune profile |
| **Google Workspace** | Admin Console force-install | Managed configuration JSON |
| **Small business** (no MDM) | Manual install + remote config URL | Hosted JSON file |

## Configuration Overview

The extension supports a `_locked` map that prevents users from changing specific settings. Admin values always override user settings.

### Merge Precedence

```
Managed Storage (GPO/Intune)  ← highest priority, read-only
        ↓
Remote Config (hosted JSON)
        ↓
Local Storage (user settings)
        ↓
Defaults (code)               ← lowest priority
```

### Lock Granularity

Lock individual settings or entire sections:

```json
{
  "_locked": {
    "detectionMode": true,
    "aiChatGuard": true,
    "aiChatGuard.enabled": true,
    "providers.azure_pii": true,
    "submitGuard.enabled": true
  }
}
```

- `"aiChatGuard": true` — locks the entire AI Chat Guard section (all sub-settings)
- `"aiChatGuard.enabled": true` — locks only the enable toggle; users can still adjust sub-settings
- `"providers.azure_pii": true` — locks the entire Azure config (endpoint, key, etc.)

Locked settings appear in the options page as disabled with an **Admin** badge.

---

## Scenario 1: Microsoft Intune

### Force-install the extension

1. Intune Admin Center → Devices → Configuration → Create profile
2. Platform: Windows 10 and later
3. Profile type: Templates → Administrative Templates
4. Setting: `Google Chrome > Extensions > Configure the list of force-installed apps and extensions`
5. Value: `YOUR_EXTENSION_ID;https://clients2.google.com/service/update2/crx`

### Push managed configuration

1. Create a custom OMA-URI profile
2. OMA-URI: `./Vendor/MSFT/Policy/Config/Chrome~Policy~googlechrome~Extensions/ExtensionSettings`
3. Data type: String
4. Value: JSON containing your extension ID and the configuration from `intune-policy.json`

See `intune-policy.json` for the full template.

### macOS via Intune

1. Create a custom Configuration Profile
2. Payload: `com.google.Chrome.extensions.YOUR_EXTENSION_ID`
3. Use plist keys matching the `managed_schema.json` properties

---

## Scenario 2: Google Workspace Admin Console

### Force-install

1. Google Admin Console → Devices → Chrome → Apps & extensions → Users & browsers
2. Click **+** → Add from Chrome Web Store (or Add by ID for self-hosted)
3. Set installation policy to **Force install**

### Push managed configuration

1. After adding the extension, click it to open settings
2. Expand **Managed Configuration**
3. Paste the JSON from `workspace-config.json` (customise values first)
4. Save

The configuration is pushed to all managed Chrome browsers on next policy sync.

---

## Scenario 3: Windows Group Policy (GPO)

### Force-install

Registry key:
```
HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist
1 = "YOUR_EXTENSION_ID;https://clients2.google.com/service/update2/crx"
```

### Push managed configuration

Registry path:
```
HKLM\SOFTWARE\Policies\Google\Chrome\3rdparty\extensions\YOUR_EXTENSION_ID\policy
```

Each top-level key becomes a registry value. Nested objects are JSON-encoded REG_SZ values:

```
"detectionMode" = "cloud_only"                    (REG_SZ)
"_policyVersion" = 1                               (REG_DWORD)
"_locked" = "{\"detectionMode\":true, ...}"        (REG_SZ, JSON)
"providers" = "{\"azure_pii\":{...}}"              (REG_SZ, JSON)
"aiChatGuard" = "{\"enabled\":true, ...}"          (REG_SZ, JSON)
```

---

## Scenario 4: Small Business (No MDM)

For organisations without GPO, Intune, or Google Workspace admin:

### 1. Host a configuration file

Create a JSON file based on `small-business-config.json` and host it at a stable URL:
- GitHub Pages: `https://yourorg.github.io/config/llss.json`
- S3 bucket: `https://s3.ap-southeast-2.amazonaws.com/yourorg-config/llss.json`
- Internal web server: `https://intranet.yourorg.com/llss-config.json`

### 2. Share the URL with users

Users install the extension, then:
1. Click the extension icon → **Settings**
2. Scroll to **Remote Configuration**
3. Paste the URL
4. Click **Fetch Now** to verify
5. Save settings

The extension refreshes the remote config every 6 hours automatically.

### 3. Update configuration

Edit the hosted JSON file. All users pick up changes within 6 hours (or immediately if they click "Fetch Now").

### Limitations

- Less secure than managed storage (users could clear local storage via DevTools)
- Requires HTTPS for the config URL
- Users must manually enter the URL once (cannot be pre-configured without MDM)

---

## Configuration Reference

See `managed_schema.json` in the extension root for the full schema of all configurable settings. Key sections:

| Section | Description |
|---------|-------------|
| `detectionMode` | `auto`, `ai_only`, `regex_only`, `cloud_only` |
| `providers.azure_pii` | Azure AI Language PII endpoint and credentials |
| `providers.purview` | Microsoft Purview DLP configuration |
| `providers.hosted[]` | Organisation-hosted model endpoints |
| `aiChatGuard` | AI chat service protection settings |
| `submitGuard` | Form submission interception |
| `uploadGuard` | File upload interception |
| `siteFilter` | Whitelist/blacklist site filtering |
| `autoRedact` | Auto-redact on type/paste |

---

## Security Notes

- **API keys in managed storage**: `chrome.storage.managed` is read-only to the extension and invisible to web pages. For higher security, consider using Azure Managed Identity instead of API keys.
- **Remote config**: Always use HTTPS. The config is cached in `chrome.storage.local` — a user with DevTools access could read it.
- **Lock enforcement**: Even if a user modifies local storage directly, managed values always win at merge time (managed storage overlays last). `saveSettings()` also strips locked keys before persisting.
