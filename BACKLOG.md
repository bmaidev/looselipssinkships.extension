# Feature Backlog

## Revenue-Generating Features

### Compliance Dashboard
- Centralised web dashboard showing redaction activity across all managed users
- Aggregate stats: redactions by engine, PII type, document type, site, user
- Time-series charts (daily/weekly/monthly trends)
- Export to PDF/CSV for compliance reporting
- No PII content stored — only counts and metadata
- **Why it sells:** CISOs need visibility. "Show me every PII incident in the last 90 days."

### Audit Log Export
- Per-user audit trail of redaction events
- Fields: timestamp, engine, PII types detected, match count, document type, site URL (domain only), action taken (redacted/blocked/warned)
- Export to CSV, JSON, or SIEM-compatible format (CEF/Syslog)
- Retention policy configuration
- Integration with Azure Monitor / Sentinel
- **Why it sells:** Mandatory for government compliance reporting

### Policy-as-Code
- Define redaction rules in a central JSON/YAML policy file
- Push to all managed users via remote config or managed storage
- Version-controlled policies with rollback
- Policy templates for common frameworks (PSPF, Privacy Act, ISM)
- Conditional rules: "on AI sites, block OFFICIAL:Sensitive; on internal sites, allow"
- **Why it sells:** Scales governance across agencies without manual config

### Slack / Teams Alerting
- Webhook notifications when classification gate blocks a document
- Configurable alert channels per severity (blocked vs warned)
- Alert payload: file type, classification label, site URL, timestamp (no PII content)
- Integration with ServiceNow / Jira for incident creation
- **Why it sells:** Security teams need real-time awareness of policy violations

### Usage Analytics (Privacy-Preserving)
- Aggregate telemetry: how many redactions, which PII types, which AI sites, which file types
- Org-wide trends without any PII content
- Opt-in only, admin-controlled
- Data stays within the org's own analytics infrastructure
- **Why it sells:** Data-driven justification for security investment

---

## Technical Improvements

### Structured Output Validation
- Verify LLM entity positions against input text more robustly
- Confidence scoring for AI-detected entities
- Cross-validation: compare AI entities with regex results, flag discrepancies

### Belt-and-Suspenders Default
- Enable regex-after-AI by default in auto mode
- Deduplicate merged match lists properly
- Report both AI and regex findings separately in audit data

### Input Size Validation
- Check text length against model context limits before sending to LLM
- Chunking with entity position reassembly across chunks
- Progress reporting for large document chunked processing

### Scanned PDF Pixel Redaction
- Full render+OCR pipeline is working but needs more testing
- Performance optimisation for multi-page scanned documents
- Confidence threshold for OCR quality — skip pixel redaction if OCR is poor

### XLSX In-Place Redaction
- Currently converts to CSV. Could modify shared strings XML in-place (like DOCX redactor)
- Preserve formulas, charts, formatting
- Output as redacted .xlsx instead of .csv

### RTF Parsing
- Currently treated as plain text
- Proper RTF control code stripping for better PII detection
- Preserve RTF formatting in output

### Native Document API Expansion
- Support for Azure AI Document Intelligence (broader format support)
- Batch processing via Azure native API (multiple files per job)

---

## UX Improvements

### Onboarding Flow
- First-run wizard: detect available providers, suggest optimal mode
- "Test with sample PII" button to verify detection works
- Guided Azure/Purview setup with validation at each step

### Redaction Preview
- Show diff view before applying redaction (original vs redacted)
- Colour-coded PII categories in the preview
- Accept/reject individual redactions

### Browser Action Badge
- Show real-time count of PII detected on the current page
- Red badge when classification gate is active
- Green badge when page is clean

### Keyboard Shortcuts
- Ctrl+Shift+R to redact selected text
- Ctrl+Shift+D to open standalone redaction tool
- Configurable via Chrome shortcuts API

---

## Enterprise Features

### IRAP Assessment Support
- Documentation package for assessors
- Security control mapping (ISM controls → extension features)
- Data flow diagrams
- Threat model documentation

### Multi-Tenant Support
- Single extension deployment supporting multiple Azure tenants
- Per-tenant provider configuration
- Cross-tenant classification gate policies

### Offline Mode
- Graceful degradation when network is unavailable
- Queue cloud redaction requests for retry
- Local-only mode indicator

### Group Policy ADMX Template
- Pre-built ADMX/ADML files for Windows GPO
- Full documentation of registry keys
- Import-ready for Active Directory Group Policy Editor
