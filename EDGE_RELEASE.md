# Microsoft Edge Release and Rollout Runbook

This runbook covers the Microsoft Edge Add-ons submission and a managed rollout to 700+ users. Replace every `YOUR_*` placeholder before production deployment.

## 1. Build and verify

```bash
npm ci
npm test -- --runInBand
npm run build:edge
unzip -t dist/loose-lips-sink-ships-edge-v4.3.0.zip
```

The Edge build uses the shared extension source and a store-specific description override. The packaging validator fails on unsupported Edge API namespaces, missing manifest resources, remote scripts, `update_url`, development files, unexpected manifest drift, and invalid package structure.

## 2. Manual acceptance in Microsoft Edge

1. Unzip the Edge package into a temporary folder.
2. Open `edge://extensions`, enable Developer mode, choose **Load unpacked**, and select that folder.
3. Run the default local-regex test from the certification notes in `EDGE_STORE_LISTING.md`.
4. Verify popup status, options, text redaction, submit interception, upload interception, standalone file redaction, PDF/image OCR, managed-setting locks, and Microsoft Entra sign-in where configured.
5. Test both Microsoft Edge Stable (the 700-user baseline) and the organisation's next update channel.
6. If on-device AI is part of acceptance, test Edge Dev/Canary separately. Edge's Prompt API and local Web Speech features remain capability-detected previews; lack of either API must leave regex, document protection, and configured providers operational.

## 3. Partner Center submission

1. Register or use an organisation-owned Microsoft Edge extension developer account.
2. Create a new extension in Partner Center and upload `dist/loose-lips-sink-ships-edge-v4.3.0.zip`.
3. Complete listing, privacy, permission justification, asset, and certification-note fields using `EDGE_STORE_LISTING.md`.
4. Use `https://llss.blackmountainai.com.au/privacy` as the privacy policy and `https://llss.blackmountainai.com.au/support` for support.
5. Submit for certification. Record the Edge Add-ons extension ID when assigned; it will differ from the Chrome Web Store ID.

## 4. Identity and policy preparation

- Add `https://<EDGE_EXTENSION_ID>.chromiumapp.org/` as an SPA redirect URI to the Microsoft Entra app registration used for enterprise sign-in. Keep the Chrome extension redirect URI if both stores remain deployed.
- Replace `YOUR_EDGE_ADDONS_EXTENSION_ID` in `enterprise/edge-intune-policy.json`.
- Keep the Microsoft Edge Add-ons update URL exactly as `https://edge.microsoft.com/extensionwebstorebase/v1/crx`.
- Validate the managed configuration against `managed_schema.json` and replace all tenant, client, endpoint, and storage placeholders.
- Decide whether a user migrating from Chrome should run both extensions temporarily. Do not leave both protecting the same sites beyond the migration window because each will intercept the same submissions and uploads.

## 5. Phased rollout

| Ring | Suggested size | Exit criteria |
|---|---:|---|
| Engineering | 10–20 | No service-worker errors; text, upload, OCR, auth, and policy checks pass. |
| Pilot | 50–75 | At least five business days; no confirmed redaction bypass or material site incompatibility. |
| Broad | 200–250 | Help-desk volume and false-positive rate are acceptable; rollback policy is verified. |
| Production | Remaining users | Edge Add-ons version, policy version, and minimum version are monitored. |

Use Edge's `ExtensionSettings` policy with `installation_mode: force_installed`, the Edge Add-ons update URL, `minimum_version_required: 4.3.0`, and `toolbar_state: force_shown`. For Windows managed storage, write configuration beneath:

```text
HKLM\SOFTWARE\Policies\Microsoft\Edge\3rdparty\extensions\<EDGE_EXTENSION_ID>\policy
```

Check `edge://policy` after policy refresh and confirm locked settings show the Admin badge in the extension.

## 6. Rollback and operations

- To stop expansion, remove new device groups from assignment while leaving existing pilot groups intact for diagnosis.
- To disable a defective release immediately, change its per-ID `installation_mode` to `removed` or remove it from the force-install policy after confirming the intended impact.
- To roll forward, publish a higher version in Microsoft Edge Add-ons; never reuse a version number.
- Monitor certification status, extension install/version inventory, policy application, service-worker errors, support reports, and false-positive reports. The extension itself sends no telemetry.
- Treat any reproducible PII bypass, recoverable redaction, credential exposure, or unexpected cloud transmission as a release blocker.
