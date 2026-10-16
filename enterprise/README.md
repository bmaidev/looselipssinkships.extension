# Enterprise Deployment Guide

Deploy and configure Loose Lips Sink Ships across your organisation.

## Deployment Scenarios

| Scenario | Mechanism | Config Delivery |
|----------|-----------|-----------------|
| **Microsoft Edge enterprise** (Intune, GPO, Edge management) | Edge Add-ons force-install + managed storage | Edge policy / Windows Registry |
| **Google Chrome enterprise** (Intune, GPO) | Chrome Web Store force-install + managed storage | Chrome policy / Windows Registry |
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
- `"providers.azure_pii": true` — locks the entire Azure config (endpoint, auth, storage, etc.)

Locked settings appear in the options page as disabled with an **Admin** badge.

---

## Authentication Modes

The Azure PII provider supports two connection modes:

### Direct Mode (API Key)

Simple setup for dev/test and small deployments:
- API key stored in settings (managed storage or local)
- SAS tokens required for native document blob storage
- No Azure AD integration needed

### Enterprise Mode (Azure AD OAuth2 PKCE)

Secure, credential-free setup for production enterprise:
- Users sign in via Azure AD popup (MFA, Conditional Access apply)
- Short-lived Bearer tokens (1hr), auto-refreshed
- No API keys stored anywhere
- Native document storage uses managed identity (no SAS tokens)
- Per-user audit trail via Azure AD logs

**Enterprise mode requires an Azure AD App Registration:**

1. Azure Portal → Microsoft Entra ID → App Registrations → New
2. **Redirect URI**: `https://<extension-id>.chromiumapp.org/` (type: SPA)
3. **API permissions**:
   - `Azure Cognitive Services` → `user_impersonation`
   - `Azure Storage` → `user_impersonation` (if using native document redaction)
4. **Authentication** → Enable public client flows: **Yes**
5. **Supported account types**: Single tenant (or multi-tenant for cross-org)

The extension ID is visible at `chrome://extensions` or `edge://extensions` after installation. Chrome Web Store and Microsoft Edge Add-ons assign different IDs, so register both redirect URIs when both browser versions are deployed.

---

## Native Document Redaction (Server-Side)

Azure's native document API processes PDF, DOCX, and TXT files entirely server-side — no local OCR or rendering needed. Returns a redacted document file.

### Storage Setup

| Mode | Source Container | Target Container | Language Resource → Storage |
|------|---|---|---|
| **Direct** | URL with SAS token (read + list) | URL with SAS token (write + list) | SAS tokens in job URLs |
| **Enterprise** | Plain URL (no SAS) | Plain URL (no SAS) | Language resource managed identity |

### Enterprise Storage Setup (Managed Identity)

1. Azure Portal → Language Resource → Identity → System assigned → **On**
2. Copy the Language resource's Object ID
3. Storage Account → Access Control (IAM) → Add role assignment:
   - **Storage Blob Data Reader** → assign to the Language resource's managed identity → scope: source container
   - **Storage Blob Data Contributor** → assign to the Language resource's managed identity → scope: target container
4. Provide plain container URLs in the extension config (no SAS tokens needed):
   - Source: `https://youraccount.blob.core.windows.net/llss-source`
   - Target: `https://youraccount.blob.core.windows.net/llss-target`

### Direct Storage Setup (SAS Tokens)

1. Azure Portal → Storage Account → Shared access signature
2. Generate a SAS token for the **source container** with **Read + Write + List** permissions (extension uploads the file, Language API reads it)
3. Generate a SAS token for the **target container** with **Read + Write + List** permissions (Language API writes results, extension downloads them)
4. Paste the full URLs (including `?sv=...` SAS query string) into the extension settings

### Supported Formats

| Format | Extension | Notes |
|--------|-----------|-------|
| PDF | `.pdf` | Text-based PDFs. Scanned PDFs are not supported by the native API. |
| Word | `.docx` | Full document redaction with formatting preserved. |
| Text | `.txt` | Plain text files. |

For scanned PDFs and images, the extension falls back to local OCR (Tesseract.js + pdf.js).

---

## Scenario 1: Microsoft Edge (Intune, Edge Management, or GPO)

Use the Edge Add-ons package for a first-class Edge deployment. The Edge store assigns its own extension ID after the first Partner Center submission.

### Force-install from Microsoft Edge Add-ons

Configure the Microsoft Edge `ExtensionSettings` policy through the Microsoft Edge management service, Intune Settings Catalog, or Group Policy:

```json
{
  "YOUR_EDGE_ADDONS_EXTENSION_ID": {
    "installation_mode": "force_installed",
    "update_url": "https://edge.microsoft.com/extensionwebstorebase/v1/crx",
    "minimum_version_required": "4.3.0",
    "toolbar_state": "force_shown"
  }
}
```

In Group Policy, this is **Administrative Templates > Microsoft Edge > Extensions > Configure extension management settings**. The equivalent Windows policy location is `HKLM\SOFTWARE\Policies\Microsoft\Edge`, value `ExtensionSettings` (`REG_SZ`).

### Push managed configuration

Write the settings beneath the Edge extension's third-party policy key:

```text
HKLM\SOFTWARE\Policies\Microsoft\Edge\3rdparty\extensions\YOUR_EDGE_ADDONS_EXTENSION_ID\policy
```

Each top-level key maps to a registry value. Nested objects are JSON-encoded `REG_SZ` values, matching the Chrome GPO example later in this document. Use [`edge-intune-policy.json`](edge-intune-policy.json) as the combined installation and configuration template.

After policy refresh, check `edge://policy`, confirm the extension version in `edge://extensions`, and verify locked settings show the **Admin** badge.

### Microsoft Entra application registration

Add this additional SPA redirect URI for the Edge listing:

```text
https://YOUR_EDGE_ADDONS_EXTENSION_ID.chromiumapp.org/
```

Do not remove the Chrome redirect URI until the Chrome deployment has been fully retired.

---

## Scenario 2: Google Chrome via Microsoft Intune

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

## Scenario 3: Google Workspace Admin Console

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

## Scenario 4: Google Chrome via Windows Group Policy (GPO)

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
"_policyVersion" = 2                               (REG_DWORD)
"_locked" = "{\"detectionMode\":true, ...}"        (REG_SZ, JSON)
"providers" = "{\"azure_pii\":{...}}"              (REG_SZ, JSON)
"aiChatGuard" = "{\"enabled\":true, ...}"          (REG_SZ, JSON)
```

---

## Scenario 5: Small Business (No MDM)

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

See `managed_schema.json` in the extension root for the full schema. Key sections:

| Section | Description |
|---------|-------------|
| `detectionMode` | `auto`, `ai_only`, `regex_only`, `cloud_only` |
| `providers.azure_pii.connectionMode` | `direct` (API key) or `enterprise` (Azure AD OAuth2) |
| `providers.azure_pii.nativeDocEnabled` | Enable server-side PDF/DOCX redaction |
| `providers.azure_pii.sourceContainerUrl` | Blob storage source (with SAS in direct, plain in enterprise) |
| `providers.azure_pii.targetContainerUrl` | Blob storage target (with SAS in direct, plain in enterprise) |
| `providers.azure_pii.redactionPolicy` | `entityMask`, `characterMask`, or `noMask` |
| `providers.purview` | Microsoft Purview DLP configuration |
| `providers.hosted[]` | Organisation-hosted model endpoints |
| `aiChatGuard` | AI chat service protection settings |
| `submitGuard` | Form submission interception |
| `uploadGuard` | File upload interception |
| `siteFilter` | Whitelist/blacklist site filtering |
| `autoRedact` | Auto-redact on type/paste |

---

## Classification Gate

The Purview classification gate blocks uploads of documents with restricted sensitivity labels **before any processing occurs**. This is a pre-upload check — blocked files never enter the redaction pipeline.

### How It Works

1. **Layer 1 (local, instant)**: Reads MSIP_Label_* metadata from DOCX/XLSX file custom properties. No API call needed.
2. **Layer 2 (optional, API)**: Evaluates classification via Microsoft Graph beta API for deeper policy checking.

If a document's label matches the `blockedLabels` list, the upload is blocked with a red "Upload Blocked" overlay showing the classification and reason. The user must dismiss the overlay — there is no skip option.

### Configuration

```json
{
  "providers": {
    "purview": {
      "gateEnabled": true,
      "blockedLabels": ["PROTECTED", "SECRET", "TOP SECRET"],
      "warnLabels": ["OFFICIAL: Sensitive"],
      "blockEncrypted": true,
      "checkViaApi": false
    }
  },
  "_locked": {
    "providers.purview.gateEnabled": true,
    "providers.purview.blockedLabels": true
  }
}
```

### Australian Government Classification Mapping

| Classification | Action | Rationale |
|---------------|--------|-----------|
| UNOFFICIAL | Allow | No restrictions |
| OFFICIAL | Allow | Standard business |
| OFFICIAL: Sensitive | Warn | Caution advised |
| PROTECTED | **Block** | Must not leave controlled environment |
| SECRET | **Block** | Classified material |
| TOP SECRET | **Block** | Classified material |

### Lock Recommendations

Lock `gateEnabled` and `blockedLabels` via managed policy so users cannot disable the classification gate or remove labels from the blocked list.

---

## Security Notes

- **Enterprise mode eliminates stored secrets.** No API keys or SAS tokens. Azure AD OAuth2 tokens are short-lived (1 hour) and stored in `chrome.storage.session` (memory-only, cleared on browser close). Managed identity handles Language-to-Storage authentication.
- **Direct mode API keys** in `chrome.storage.managed` are read-only to the extension and invisible to web pages. However, any user with DevTools access can view them. Use enterprise mode for production.
- **Remote config**: Always use HTTPS. The config is cached in `chrome.storage.local` — a user with DevTools access could read it.
- **Lock enforcement**: Even if a user modifies local storage directly, managed values always win at merge time (managed storage overlays last). `saveSettings()` also strips locked keys before persisting.
- **Per-user audit**: Enterprise mode provides per-user token-based authentication. Azure AD sign-in logs show who accessed the PII API and when. Conditional Access policies (MFA, device compliance, location) apply automatically.
