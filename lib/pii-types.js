// lib/pii-types.js — Default PII type definitions with regex patterns.
// Each type has: id, name, description, token, enabled, regex (string), and flags.
// Users can add/modify types via the options page; stored in chrome.storage.local.

const DEFAULT_PII_TYPES = [
  {
    id: "email",
    name: "Email Address",
    description: "Standard email addresses (user@domain.tld)",
    token: "[REDACTED_EMAIL]",
    enabled: true,
    regex: "[a-zA-Z0-9._%+\\-]+@[a-zA-Z0-9.\\-]+\\.[a-zA-Z]{2,}",
    flags: "gi",
    category: "contact",
  },
  {
    id: "phone_au",
    name: "Phone Number (AU)",
    description: "Australian phone numbers: 04xx, (0x) xxxx xxxx, +61",
    token: "[REDACTED_PHONE]",
    enabled: true,
    regex: "(?:\\+61|0061)[\\s\\-]?[2-478](?:[\\s\\-]?\\d){8}|(?:\\(0[2-478]\\)|0[2-478])[\\s\\-]?\\d{4}[\\s\\-]?\\d{4}|04\\d{2}[\\s\\-]?\\d{3}[\\s\\-]?\\d{3}",
    flags: "g",
    category: "contact",
  },
  {
    id: "phone_intl",
    name: "Phone Number (International)",
    description: "International phone numbers with country code",
    token: "[REDACTED_PHONE]",
    enabled: true,
    regex: "\\+[1-9]\\d{0,2}[\\s\\-]?(?:\\(?\\d{1,4}\\)?[\\s\\-]?)?(?:\\d[\\s\\-]?){6,12}\\d",
    flags: "g",
    category: "contact",
  },
  {
    id: "tfn",
    name: "Tax File Number (TFN)",
    description: "Australian 8-9 digit tax file number",
    token: "[REDACTED_TFN]",
    enabled: true,
    regex: "\\b\\d{3}[\\s\\-]?\\d{3}[\\s\\-]?\\d{2,3}\\b",
    flags: "g",
    category: "financial",
    priority: 10, // higher priority = matched first
  },
  {
    id: "abn",
    name: "Australian Business Number (ABN)",
    description: "11-digit ABN",
    token: "[REDACTED_ABN]",
    enabled: true,
    regex: "\\b\\d{2}[\\s\\-]?\\d{3}[\\s\\-]?\\d{3}[\\s\\-]?\\d{3}\\b",
    flags: "g",
    category: "financial",
  },
  {
    id: "acn",
    name: "Australian Company Number (ACN)",
    description: "9-digit ACN",
    token: "[REDACTED_ACN]",
    enabled: true,
    regex: "(?:ACN[:\\s]*)\\d{3}[\\s\\-]?\\d{3}[\\s\\-]?\\d{3}",
    flags: "gi",
    category: "financial",
  },
  {
    id: "medicare",
    name: "Medicare Number",
    description: "Australian Medicare card number (10-11 digits)",
    token: "[REDACTED_MEDICARE]",
    enabled: true,
    regex: "\\b\\d{4}[\\s\\-]?\\d{5}[\\s\\-]?\\d[\\s\\-]?\\d?\\b",
    flags: "g",
    category: "health",
  },
  {
    id: "credit_card",
    name: "Credit Card Number",
    description: "Visa, Mastercard, Amex card numbers",
    token: "[REDACTED_CARD]",
    enabled: true,
    regex: "\\b(?:4\\d{3}|5[1-5]\\d{2}|3[47]\\d{2}|6(?:011|5\\d{2}))[\\s\\-]?\\d{4}[\\s\\-]?\\d{4}[\\s\\-]?\\d{1,4}\\b",
    flags: "g",
    category: "financial",
  },
  {
    id: "bsb",
    name: "BSB Number",
    description: "Australian bank state branch number (6 digits with dash)",
    token: "[REDACTED_BSB]",
    enabled: true,
    regex: "\\bBSB[:\\s]*\\d{3}[\\-]?\\d{3}\\b|\\b\\d{3}\\-\\d{3}\\b",
    flags: "gi",
    category: "financial",
  },
  {
    id: "bank_account",
    name: "Bank Account Number",
    description: "Australian bank account numbers (6-10 digits following BSB context)",
    token: "[REDACTED_ACCOUNT]",
    enabled: true,
    regex: "(?:account|acct|a\\/c)[:\\s#]*\\d{6,10}",
    flags: "gi",
    category: "financial",
  },
  {
    id: "passport",
    name: "Passport Number",
    description: "Australian passport (letter + 7 digits) and common formats",
    token: "[REDACTED_PASSPORT]",
    enabled: true,
    regex: "(?:passport[:\\s#]*)([A-Z]{1,2}\\d{6,9})",
    flags: "gi",
    category: "identity",
  },
  {
    id: "drivers_licence",
    name: "Driver Licence Number",
    description: "Australian driver licence numbers (varies by state)",
    token: "[REDACTED_LICENCE]",
    enabled: true,
    regex: "(?:licence|license|DL)[:\\s#]*\\d{5,10}",
    flags: "gi",
    category: "identity",
  },
  {
    id: "dob",
    name: "Date of Birth",
    description: "Common date formats (DD/MM/YYYY, YYYY-MM-DD, etc.)",
    token: "[REDACTED_DOB]",
    enabled: true,
    regex: "(?:DOB|date of birth|born|d\\.o\\.b\\.?)[:\\s]*(?:\\d{1,2}[/\\-\\.]\\d{1,2}[/\\-\\.]\\d{2,4}|\\d{4}[/\\-\\.]\\d{1,2}[/\\-\\.]\\d{1,2})",
    flags: "gi",
    category: "identity",
  },
  {
    id: "street_address",
    name: "Street Address",
    description: "Australian-style street addresses (number + street name + type)",
    token: "[REDACTED_ADDRESS]",
    enabled: true,
    regex: "\\b\\d{1,5}[/\\-]?\\d{0,5}\\s+[A-Z][a-zA-Z'\\-]+(?:\\s+[A-Z][a-zA-Z'\\-]+)*\\s+(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Court|Ct|Place|Pl|Terrace|Tce|Crescent|Cres|Boulevard|Blvd|Lane|Ln|Way|Circuit|Cct|Highway|Hwy|Parade|Pde)\\b\\.?",
    flags: "gi",
    category: "contact",
  },
  {
    id: "postcode_au",
    name: "Australian Postcode (in context)",
    description: "4-digit postcode when preceded by state abbreviation",
    token: "[REDACTED_POSTCODE]",
    enabled: true,
    regex: "\\b(?:NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\\s+\\d{4}\\b",
    flags: "g",
    category: "contact",
  },
  {
    id: "ip_address",
    name: "IP Address",
    description: "IPv4 addresses",
    token: "[REDACTED_IP]",
    enabled: true,
    regex: "\\b(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\b",
    flags: "g",
    category: "technical",
  },
  {
    id: "ipv6_address",
    name: "IPv6 Address",
    description: "IPv6 addresses",
    token: "[REDACTED_IP]",
    enabled: true,
    regex: "(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|::(?:[0-9a-fA-F]{1,4}:){0,5}[0-9a-fA-F]{1,4}",
    flags: "g",
    category: "technical",
  },
];

// Categories for grouping in the UI.
const PII_CATEGORIES = {
  contact: { name: "Contact Information", order: 1 },
  financial: { name: "Financial Data", order: 2 },
  health: { name: "Health Information", order: 3 },
  identity: { name: "Identity Documents", order: 4 },
  technical: { name: "Technical Identifiers", order: 5 },
  custom: { name: "Custom Rules", order: 6 },
};

// Validate a PII type definition before saving.
function validatePiiType(piiType) {
  const errors = [];
  if (!piiType.id || typeof piiType.id !== "string") {
    errors.push("ID is required and must be a string.");
  }
  if (!piiType.name || typeof piiType.name !== "string") {
    errors.push("Name is required.");
  }
  if (!piiType.token || !/^\[.+\]$/.test(piiType.token)) {
    errors.push("Token must be in [BRACKETS].");
  }
  if (piiType.regex) {
    try {
      new RegExp(piiType.regex, piiType.flags || "g");
    } catch (e) {
      errors.push(`Invalid regex: ${e.message}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

// Generate a unique ID for custom PII types.
function generatePiiTypeId(name) {
  return "custom_" + name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/_+$/, "");
}

// For service worker (non-module) compatibility, attach to globalThis.
if (typeof globalThis !== "undefined") {
  globalThis.LLSS_PII_TYPES = DEFAULT_PII_TYPES;
  globalThis.LLSS_PII_CATEGORIES = PII_CATEGORIES;
  globalThis.LLSS_validatePiiType = validatePiiType;
  globalThis.LLSS_generatePiiTypeId = generatePiiTypeId;
}

// For testing with Node.js / Jest
if (typeof module !== "undefined" && module.exports) {
  module.exports = { DEFAULT_PII_TYPES, PII_CATEGORIES, validatePiiType, generatePiiTypeId };
}
