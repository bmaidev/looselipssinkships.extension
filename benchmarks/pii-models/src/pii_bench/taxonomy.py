"""Canonical evaluation taxonomy and model-label normalization.

The benchmark distinguishes identity/contact data from sensitive attributes.  This
matters because a system that catches email addresses but leaks a named person's
medical condition must not receive a reassuring aggregate score.
"""

from __future__ import annotations

from dataclasses import dataclass
import re


@dataclass(frozen=True)
class LabelDefinition:
    label: str
    family: str
    risk: int
    description: str
    shipped: bool = False


_DEFINITIONS = [
    # Existing extension protection surface.
    LabelDefinition("EMAIL", "contact", 4, "Email address", True),
    LabelDefinition("PHONE", "contact", 4, "Telephone number", True),
    LabelDefinition("TFN", "government_id", 5, "Australian Tax File Number", True),
    LabelDefinition("ABN", "financial", 3, "Australian Business Number", True),
    LabelDefinition("ACN", "financial", 3, "Australian Company Number", True),
    LabelDefinition("MEDICARE", "health_id", 5, "Australian Medicare number", True),
    LabelDefinition("CREDIT_CARD", "financial", 5, "Payment-card number", True),
    LabelDefinition("BSB", "financial", 4, "Australian bank-state-branch number", True),
    LabelDefinition("BANK_ACCOUNT", "financial", 5, "Bank account number", True),
    LabelDefinition("PASSPORT", "government_id", 5, "Passport number", True),
    LabelDefinition("DRIVER_LICENCE", "government_id", 5, "Driver licence number", True),
    LabelDefinition("DATE_OF_BIRTH", "identity", 4, "Date of birth", True),
    LabelDefinition("STREET_ADDRESS", "contact", 4, "Street or postal address", True),
    LabelDefinition("POSTCODE", "contact", 2, "Postcode when identifying a person", True),
    LabelDefinition("IP_ADDRESS", "digital", 3, "IPv4 or IPv6 address", True),
    LabelDefinition("PERSON", "identity", 4, "Person name", True),
    # Extended contextual and digital PII.
    LabelDefinition("AGE", "identity", 2, "Age tied to an individual"),
    LabelDefinition("USERNAME", "digital", 3, "Username or social handle"),
    LabelDefinition("PASSWORD", "secret", 5, "Password or passphrase"),
    LabelDefinition("API_KEY", "secret", 5, "API key, session token, or bearer token"),
    LabelDefinition("MAC_ADDRESS", "digital", 3, "Network-interface address"),
    LabelDefinition("DEVICE_ID", "digital", 3, "Device or advertising identifier"),
    LabelDefinition("COORDINATES", "location", 4, "Precise geolocation"),
    LabelDefinition("VEHICLE_ID", "identity", 3, "Vehicle registration or VIN"),
    LabelDefinition("CUSTOMER_ID", "organisation_id", 3, "Customer, case, or membership ID"),
    LabelDefinition("EMPLOYEE_ID", "organisation_id", 3, "Employee identifier"),
    LabelDefinition("STUDENT_ID", "organisation_id", 3, "Student identifier"),
    LabelDefinition("HEALTH_RECORD_ID", "health_id", 5, "Health or patient record identifier"),
    LabelDefinition("BIOMETRIC_ID", "biometric", 5, "Biometric template or identifier"),
    # Australian Privacy Act sensitive-information classes and community-sector risks.
    LabelDefinition("HEALTH_CONDITION", "sensitive_health", 5, "Health or medical condition"),
    LabelDefinition("MEDICATION", "sensitive_health", 5, "Medication or treatment"),
    LabelDefinition("DISABILITY", "sensitive_health", 5, "Disability information"),
    LabelDefinition("MENTAL_HEALTH", "sensitive_health", 5, "Mental-health information"),
    LabelDefinition("GENETIC_INFO", "sensitive_health", 5, "Genetic information"),
    LabelDefinition("RACE_ETHNICITY", "sensitive_belief", 5, "Racial or ethnic origin"),
    LabelDefinition("RELIGION", "sensitive_belief", 5, "Religious or philosophical belief"),
    LabelDefinition("POLITICAL_AFFILIATION", "sensitive_belief", 5, "Political opinion or association"),
    LabelDefinition("TRADE_UNION", "sensitive_belief", 5, "Trade-union membership or association"),
    LabelDefinition("SEXUAL_ORIENTATION", "sensitive_personal", 5, "Sexual orientation or practices"),
    LabelDefinition("CRIMINAL_RECORD", "sensitive_legal", 5, "Criminal record or allegation"),
    LabelDefinition("VICTIM_SAFEGUARDING", "sensitive_safety", 5, "Victim, refuge, or safeguarding status"),
    LabelDefinition("FINANCIAL_HARDSHIP", "sensitive_financial", 4, "Financial hardship or debt status"),
    LabelDefinition("INCOME", "sensitive_financial", 4, "Salary, benefit, or income amount"),
    LabelDefinition("CHILD_STATUS", "sensitive_safety", 5, "Information identifying a child or minor"),
]

DEFINITIONS = {item.label: item for item in _DEFINITIONS}
LABELS = tuple(DEFINITIONS)
SHIPPED_LABELS = tuple(item.label for item in _DEFINITIONS if item.shipped)
SENSITIVE_FAMILIES = frozenset(item.family for item in _DEFINITIONS if item.family.startswith("sensitive_"))


ALIASES = {
    "EMAIL_ADDRESS": "EMAIL",
    "PRIVATE_EMAIL": "EMAIL",
    "TELEPHONENUM": "PHONE",
    "PHONE_NUMBER": "PHONE",
    "MOBILE_PHONE_NUMBER": "PHONE",
    "PRIVATE_PHONE": "PHONE",
    "TAXNUM": "TFN",
    "TAX_NUMBER": "TFN",
    "SOCIALNUM": "TFN",
    "GOVERNMENT_ID": "TFN",
    "IDCARDNUM": "TFN",
    "CREDITCARDNUMBER": "CREDIT_CARD",
    "ACCOUNTNUM": "BANK_ACCOUNT",
    "ACCOUNT_NUMBER": "BANK_ACCOUNT",
    "PASSPORTNUM": "PASSPORT",
    "PASSPORT_NUMBER": "PASSPORT",
    "DRIVERLICENSENUM": "DRIVER_LICENCE",
    "DRIVER_LICENSE": "DRIVER_LICENCE",
    "DRIVER_LICENSE_NUMBER": "DRIVER_LICENCE",
    "DOB": "DATE_OF_BIRTH",
    "DATEOFBIRTH": "DATE_OF_BIRTH",
    "DATE_OF_BIRTH": "DATE_OF_BIRTH",
    "PRIVATE_DATE": "DATE_OF_BIRTH",
    "ADDRESS": "STREET_ADDRESS",
    "PRIVATE_ADDRESS": "STREET_ADDRESS",
    "STREET": "STREET_ADDRESS",
    "STREET_NAME": "STREET_ADDRESS",
    "LOCATION": "STREET_ADDRESS",
    "BUILDINGNUM": "STREET_ADDRESS",
    "BUILDING_NUMBER": "STREET_ADDRESS",
    "ZIPCODE": "POSTCODE",
    "ZIP_CODE": "POSTCODE",
    "IPV4": "IP_ADDRESS",
    "IPV6": "IP_ADDRESS",
    "GIVENNAME": "PERSON",
    "GIVEN_NAME": "PERSON",
    "SURNAME": "PERSON",
    "PRIVATE_PERSON": "PERSON",
    "NAME": "PERSON",
    "USER_NAME": "USERNAME",
    "SOCIAL_MEDIA_HANDLE": "USERNAME",
    "SECRET": "PASSWORD",
    "ACCESS_TOKEN": "API_KEY",
    "TOKEN": "API_KEY",
    "LATITUDE_LONGITUDE": "COORDINATES",
    "COORDINATE": "COORDINATES",
    "LICENSE_PLATE": "VEHICLE_ID",
    "VIN": "VEHICLE_ID",
    "MEDICAL_RECORD_NUMBER": "HEALTH_RECORD_ID",
    "PATIENT_ID": "HEALTH_RECORD_ID",
    "MEDICAL_CONDITION": "HEALTH_CONDITION",
    "DIAGNOSIS": "HEALTH_CONDITION",
    "DRUG": "MEDICATION",
    "ETHNICITY": "RACE_ETHNICITY",
    "POLITICAL_OPINION": "POLITICAL_AFFILIATION",
    "UNION_MEMBERSHIP": "TRADE_UNION",
}

EXTENSION_LABELS = {
    "email": "EMAIL",
    "phone_au": "PHONE",
    "phone_intl": "PHONE",
    "tfn": "TFN",
    "abn": "ABN",
    "acn": "ACN",
    "medicare": "MEDICARE",
    "credit_card": "CREDIT_CARD",
    "bsb": "BSB",
    "bank_account": "BANK_ACCOUNT",
    "passport": "PASSPORT",
    "drivers_licence": "DRIVER_LICENCE",
    "dob": "DATE_OF_BIRTH",
    "street_address": "STREET_ADDRESS",
    "postcode_au": "POSTCODE",
    "ip_address": "IP_ADDRESS",
    "ipv6_address": "IP_ADDRESS",
    "name_vector": "PERSON",
}


def canonical_label(raw_label: str, explicit_map: dict[str, str] | None = None) -> str:
    """Convert common BIO/BIOES and vendor labels to the benchmark taxonomy."""
    label = str(raw_label or "").strip().upper().replace("-", "_").replace(" ", "_")
    label = re.sub(r"^(?:B|I|E|S|U|L)_", "", label)
    if explicit_map:
        mapped = explicit_map.get(label) or explicit_map.get(raw_label)
        if mapped:
            label = mapped
    label = ALIASES.get(label, label)
    return label if label in DEFINITIONS else "OTHER_PII"


def risk_for(label: str) -> int:
    return DEFINITIONS.get(label, LabelDefinition(label, "unknown", 3, "Unknown label")).risk


def family_for(label: str) -> str:
    return DEFINITIONS.get(label, LabelDefinition(label, "unknown", 3, "Unknown label")).family
