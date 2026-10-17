"""Deterministic synthetic Australian PII/PSI corpus generation and validation."""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
import hashlib
import json
from pathlib import Path
import random
import re
from typing import Callable, Iterable, Iterator

from . import GENERATOR_VERSION
from .taxonomy import DEFINITIONS, LABELS, family_for, risk_for


ACMA_FICTION_MOBILES = (
    "0491 570 006", "0491 570 156", "0491 570 313", "0491 571 804",
    "0491 572 665", "0491 573 087", "0491 574 632", "0491 575 789",
    "0491 576 801", "0491 577 644", "0491 578 888", "0491 579 455",
)
ACMA_FICTION_LANDLINES = (
    "(02) 5550 0182", "(03) 7010 2841", "(07) 5550 9910", "(08) 7010 1473",
)
NAMES = (
    "Aaliyah Khan", "Anh Nguyen", "Arjun Balakrishnan", "Chloë O'Connor",
    "Deng Manyang", "Eleni Papadopoulos", "Fatima al-Zahra", "Haruto Sato",
    "Isabella Rossi", "Jack Thompson", "Jamal Hussein", "Ji-woo Park",
    "José da Silva", "Kwame Mensah", "Lachlan Williams", "Linh Trần",
    "Mereana Raukawa", "Mei-Ling Chen", "Nadia Petrović", "Noah Taylor",
    "Priya Iyer", "Saanvi Rao", "Sione Tu'ipulotu", "Sofia García",
    "Tahlia Johnson", "Wei Zhang", "Yara Haddad", "Zoe McKenzie",
    "王小明", "فاطمة الزهراء", "김지우", "अर्जुन शर्मा", "Марія Коваленко",
)
ADDRESSES = (
    ("12 Example Street", "Sydney", "NSW 2000"),
    ("4/87 Sample Road", "Melbourne", "VIC 3000"),
    ("91 Fiction Avenue", "Brisbane", "QLD 4000"),
    ("7 Testing Circuit", "Canberra", "ACT 2600"),
    ("35 Placeholder Parade", "Adelaide", "SA 5000"),
    ("2 Demo Terrace", "Perth", "WA 6000"),
    ("18 Mockingbird Lane", "Hobart", "TAS 7000"),
    ("63 Sandbox Drive", "Darwin", "NT 0800"),
)
CONDITIONS = ("type 1 diabetes", "epilepsy", "Crohn's disease", "HIV", "endometriosis")
MEDICATIONS = ("sertraline 50 mg", "insulin glargine", "levetiracetam", "adalimumab")
MENTAL_HEALTH = ("post-traumatic stress disorder", "bipolar disorder", "severe anxiety")
DISABILITIES = ("a vision impairment", "an acquired brain injury", "a mobility disability")
ETHNICITIES = ("Wiradjuri", "Māori", "Hazara", "Tamil", "South Sudanese")
RELIGIONS = ("Muslim", "Jewish", "Hindu", "Buddhist", "Christian")
POLITICS = ("a Greens branch volunteer", "a Labor Party member", "a Liberal Party donor")
UNIONS = ("the Australian Services Union", "the Nurses and Midwives' Association", "the CPSU")
ORIENTATIONS = ("bisexual", "gay", "lesbian", "transgender")
CRIMINAL = ("a spent shoplifting conviction", "a pending assault charge", "a juvenile caution")
SAFEGUARDING = ("a family-violence refuge resident", "a protected witness", "under a safety plan")

EVALUATION_PARTITIONS = ("all", "calibration", "test")
PARTITION_SCHEME = "sha256-normalized-text-v2"
LEGACY_PARTITION_SCHEME = "sha256-record-id-v1"
PARTITION_SEED = "llss-pii-psi-2026-10-17"


def evaluation_partition(record_id: str, text: str | None = None,
                         scheme: str = PARTITION_SCHEME) -> str:
    """Assign identical normalised texts together; preserve explicit legacy replay."""
    if scheme == LEGACY_PARTITION_SCHEME:
        key = record_id
    elif scheme == PARTITION_SCHEME:
        if text is None:
            raise ValueError("Text is required for content-grouped evaluation partitions")
        key = " ".join(text.casefold().split())
    else:
        raise ValueError(f"Unknown partition scheme: {scheme}")
    digest = hashlib.sha256(f"{PARTITION_SEED}:{key}".encode("utf-8")).digest()
    return "calibration" if int.from_bytes(digest[:8], "big") % 5 == 0 else "test"


def _digits(rng: random.Random, count: int) -> str:
    return "".join(str(rng.randrange(10)) for _ in range(count))


def _pick(rng: random.Random, values: tuple[str, ...]) -> str:
    return values[rng.randrange(len(values))]


def _email(name: str, rng: random.Random) -> str:
    stem = re.sub(r"[^a-z]+", ".", name.lower()).strip(".")
    return f"{stem}.{rng.randrange(10, 999)}@example.com"


def _distort(value: str, rng: random.Random, noise: str) -> str:
    """Apply annotation-safe messiness to an entity value before insertion."""
    if noise == "case":
        return value.upper() if rng.random() < 0.5 else value.lower()
    if noise == "spacing":
        separator = rng.choice((" ", "  ", "\t"))
        if re.fullmatch(r"[\d ()+./:-]+", value):
            return re.sub(r"[ -]", separator, value)
        return value
    if noise == "zero_width" and len(value) > 4:
        at = rng.randrange(1, len(value) - 1)
        return value[:at] + "\u200b" + value[at:]
    if noise == "ocr":
        swaps = {"0": "O", "1": "l", "5": "S", "8": "B"}
        positions = [i for i, char in enumerate(value) if char in swaps]
        if positions:
            at = rng.choice(positions)
            return value[:at] + swaps[value[at]] + value[at + 1 :]
    if noise == "confusable":
        swaps = {"a": "а", "A": "Α", "e": "е", "E": "Ε", "o": "ο", "O": "Ο", "p": "р", "c": "с"}
        positions = [i for i, char in enumerate(value) if char in swaps]
        if positions:
            at = rng.choice(positions)
            return value[:at] + swaps[value[at]] + value[at + 1 :]
    if noise == "linebreak" and len(value) > 6:
        positions = [i for i, char in enumerate(value) if char in " -"]
        if positions:
            at = rng.choice(positions)
            return value[:at] + "\n" + value[at + 1 :]
    return value


@dataclass
class RecordBuilder:
    noise: str = "clean"
    rng: random.Random | None = None
    parts: list[str] = field(default_factory=list)
    entities: list[dict] = field(default_factory=list)
    length: int = 0

    def literal(self, text: str) -> "RecordBuilder":
        self.parts.append(text)
        self.length += len(text)
        return self

    def entity(self, label: str, value: str) -> "RecordBuilder":
        if label not in DEFINITIONS:
            raise ValueError(f"Unknown benchmark label: {label}")
        rendered = _distort(value, self.rng or random.Random(0), self.noise)
        start = self.length
        self.parts.append(rendered)
        self.length += len(rendered)
        self.entities.append(
            {
                "start": start,
                "end": self.length,
                "label": label,
                "family": family_for(label),
                "risk": risk_for(label),
            }
        )
        return self

    def finish(self) -> tuple[str, list[dict]]:
        return "".join(self.parts), self.entities


Template = Callable[[random.Random, str], tuple[str, list[dict], str, list[str]]]


def _contact(rng: random.Random, noise: str):
    name = _pick(rng, NAMES)
    b = RecordBuilder(noise, rng)
    b.literal(rng.choice(("Please contact ", "Client: ", "Callback requested by ")))
    b.entity("PERSON", name).literal(" at ").entity("EMAIL", _email(name, rng))
    b.literal(" or ").entity("PHONE", _pick(rng, ACMA_FICTION_MOBILES)).literal(".")
    return (*b.finish(), "community_services", ["identity", "contact", noise])


def _address(rng: random.Random, noise: str):
    name = _pick(rng, NAMES)
    street, city, postcode = rng.choice(ADDRESSES)
    b = RecordBuilder(noise, rng)
    b.literal("Send the replacement card for ").entity("PERSON", name).literal(" to ")
    b.entity("STREET_ADDRESS", street).literal(", ").literal(city).literal(" ")
    b.entity("POSTCODE", postcode).literal(" before Friday.")
    return (*b.finish(), "customer_support", ["address", "contextual", noise])


def _australian_ids(rng: random.Random, noise: str):
    b = RecordBuilder(noise, rng)
    b.literal("TEST RECORD — TFN ").entity("TFN", f"000 {_digits(rng,3)} {_digits(rng,3)}")
    b.literal("; Medicare ").entity("MEDICARE", f"0000 {_digits(rng,5)} 0 0")
    b.literal("; passport: ").entity("PASSPORT", f"ZZ0{_digits(rng,6)}")
    b.literal("; licence #").entity("DRIVER_LICENCE", f"00000{_digits(rng,3)}").literal(".")
    return (*b.finish(), "government_form", ["structured", "government_id", noise])


def _business_finance(rng: random.Random, noise: str):
    b = RecordBuilder(noise, rng)
    b.literal("Synthetic vendor ABN ").entity("ABN", f"00 {_digits(rng,3)} {_digits(rng,3)} {_digits(rng,3)}")
    b.literal(", ACN ").entity("ACN", f"000 {_digits(rng,3)} {_digits(rng,3)}")
    b.literal(", BSB ").entity("BSB", f"000-{_digits(rng,3)}")
    b.literal(", account ").entity("BANK_ACCOUNT", _digits(rng, rng.randrange(6, 10))).literal(".")
    return (*b.finish(), "finance", ["structured", "financial", noise])


def _payment(rng: random.Random, noise: str):
    b = RecordBuilder(noise, rng)
    b.literal("Use payment test card ").entity("CREDIT_CARD", rng.choice(("4111 1111 1111 1111", "5555-5555-5555-4444", "3782 822463 10005")))
    b.literal(" for the sandbox only; customer ref ").entity("CUSTOMER_ID", f"CUST-{_digits(rng,8)}").literal(".")
    return (*b.finish(), "finance", ["structured", "payment", noise])


def _birth(rng: random.Random, noise: str):
    b = RecordBuilder(noise, rng)
    b.entity("PERSON", _pick(rng, NAMES)).literal(" (age ").entity("AGE", str(rng.randrange(15, 93)))
    b.literal(") has DOB: ").entity("DATE_OF_BIRTH", f"{rng.randrange(1,29):02d}/{rng.randrange(1,13):02d}/{rng.randrange(1940,2012)}").literal(".")
    return (*b.finish(), "intake", ["identity", "contextual", noise])


def _digital(rng: random.Random, noise: str):
    b = RecordBuilder(noise, rng)
    b.literal("Incident note\nuser=").entity("USERNAME", f"caseworker_{rng.randrange(100,999)}")
    b.literal(" password=").entity("PASSWORD", f"Demo!Pass-{_digits(rng,6)}")
    b.literal(" token=").entity("API_KEY", f"sk_test_{_digits(rng,24)}")
    b.literal("\nip=").entity("IP_ADDRESS", f"192.0.2.{rng.randrange(1,255)}")
    b.literal(" ipv6=").entity("IP_ADDRESS", f"2001:db8::{rng.randrange(1,999):x}")
    b.literal(" mac=").entity("MAC_ADDRESS", "02:00:5e:10:00:00")
    return (*b.finish(), "cybersecurity", ["structured", "secrets", "log", noise])


def _device_location(rng: random.Random, noise: str):
    b = RecordBuilder(noise, rng)
    b.literal("Safety app device ").entity("DEVICE_ID", f"DEV-{_digits(rng,4)}-{_digits(rng,8)}")
    b.literal(" last reported coordinates ").entity("COORDINATES", rng.choice(("-33.8688, 151.2093", "-37.8136, 144.9631", "-27.4698, 153.0251")))
    b.literal(" and vehicle ").entity("VEHICLE_ID", rng.choice(("TEST-42A", "1ZZ-9ZZ", "VIN TEST000000000001"))).literal(".")
    return (*b.finish(), "safeguarding", ["location", "digital", noise])


def _organisation_ids(rng: random.Random, noise: str):
    b = RecordBuilder(noise, rng)
    b.literal("Employee ").entity("PERSON", _pick(rng, NAMES)).literal(" [ID ").entity("EMPLOYEE_ID", f"EMP-{_digits(rng,6)}")
    b.literal("] supports student ").entity("STUDENT_ID", f"STU-{_digits(rng,7)}")
    b.literal(" under patient record ").entity("HEALTH_RECORD_ID", f"MRN-{_digits(rng,8)}").literal(".")
    return (*b.finish(), "case_management", ["organisation_id", "mixed_entities", noise])


def _health(rng: random.Random, noise: str):
    b = RecordBuilder(noise, rng)
    b.literal("Clinical handover: ").entity("PERSON", _pick(rng, NAMES)).literal(" is being treated for ")
    b.entity("HEALTH_CONDITION", _pick(rng, CONDITIONS)).literal(" with ").entity("MEDICATION", _pick(rng, MEDICATIONS)).literal(".")
    return (*b.finish(), "health", ["psi", "health", noise])


def _mental_disability(rng: random.Random, noise: str):
    b = RecordBuilder(noise, rng)
    b.literal("Accessibility note for ").entity("PERSON", _pick(rng, NAMES)).literal(": lives with ")
    b.entity("DISABILITY", _pick(rng, DISABILITIES)).literal(" and disclosed ").entity("MENTAL_HEALTH", _pick(rng, MENTAL_HEALTH)).literal(".")
    return (*b.finish(), "disability_services", ["psi", "health", noise])


def _genetic_biometric(rng: random.Random, noise: str):
    b = RecordBuilder(noise, rng)
    b.literal("Restricted result: ").entity("PERSON", _pick(rng, NAMES)).literal(" carries ")
    b.entity("GENETIC_INFO", rng.choice(("a pathogenic BRCA2 variant", "the HLA-B*57:01 allele", "a Lynch syndrome marker")))
    b.literal("; voice template ").entity("BIOMETRIC_ID", f"VOICE-{_digits(rng,12)}").literal(".")
    return (*b.finish(), "health_research", ["psi", "biometric", noise])


def _beliefs(rng: random.Random, noise: str):
    b = RecordBuilder(noise, rng)
    b.entity("PERSON", _pick(rng, NAMES)).literal(" identifies as ").entity("RACE_ETHNICITY", _pick(rng, ETHNICITIES))
    b.literal(" and requested a ").entity("RELIGION", _pick(rng, RELIGIONS)).literal(" pastoral-care worker.")
    return (*b.finish(), "community_services", ["psi", "belief", noise])


def _politics_union(rng: random.Random, noise: str):
    b = RecordBuilder(noise, rng)
    b.literal("Confidential HR note: ").entity("PERSON", _pick(rng, NAMES)).literal(" is ")
    b.entity("POLITICAL_AFFILIATION", _pick(rng, POLITICS)).literal(" and belongs to ").entity("TRADE_UNION", _pick(rng, UNIONS)).literal(".")
    return (*b.finish(), "human_resources", ["psi", "association", noise])


def _legal_personal(rng: random.Random, noise: str):
    b = RecordBuilder(noise, rng)
    b.literal("Private case note: ").entity("PERSON", _pick(rng, NAMES)).literal(" described themself as ")
    b.entity("SEXUAL_ORIENTATION", _pick(rng, ORIENTATIONS)).literal(" and reported ").entity("CRIMINAL_RECORD", _pick(rng, CRIMINAL)).literal(".")
    return (*b.finish(), "legal_aid", ["psi", "legal", noise])


def _safeguarding(rng: random.Random, noise: str):
    b = RecordBuilder(noise, rng)
    b.literal("Do not disclose: ").entity("PERSON", _pick(rng, NAMES)).literal(" is ").entity("VICTIM_SAFEGUARDING", _pick(rng, SAFEGUARDING))
    b.literal(". The case concerns ").entity("CHILD_STATUS", f"their {rng.randrange(5,17)}-year-old child").literal(".")
    return (*b.finish(), "safeguarding", ["psi", "high_risk", noise])


def _hardship(rng: random.Random, noise: str):
    b = RecordBuilder(noise, rng)
    b.entity("PERSON", _pick(rng, NAMES)).literal(" earns ").entity("INCOME", f"${rng.randrange(38,121)},000 per year")
    b.literal(" and is ").entity("FINANCIAL_HARDSHIP", rng.choice(("three months behind on rent", "in mortgage hardship", "receiving emergency relief"))).literal(".")
    return (*b.finish(), "financial_counselling", ["psi", "financial", noise])


def _code_switch(rng: random.Random, noise: str):
    introductions = (
        "客户姓名：", "اسم العميل: ", "고객 이름: ", "ग्राहक का नाम: ", "Ім’я клієнта: ",
    )
    b = RecordBuilder(noise, rng)
    b.literal(rng.choice(introductions)).entity("PERSON", _pick(rng, NAMES[-5:]))
    b.literal(" | email: ").entity("EMAIL", f"client.{rng.randrange(100,999)}@example.com")
    b.literal(" | phone: ").entity("PHONE", _pick(rng, ACMA_FICTION_MOBILES)).literal(".")
    return (*b.finish(), "multicultural_support", ["code_switch", "multilingual", noise])


def _long_case(rng: random.Random, noise: str):
    padding = (
        "This is synthetic non-identifying case narrative used to test long-document windowing. "
        "No operational decision should rely on this placeholder paragraph. "
    )
    b = RecordBuilder(noise, rng)
    b.literal("Subject ").entity("PERSON", _pick(rng, NAMES)).literal(". ")
    b.literal(padding * 12)
    b.literal("Private contact ").entity("EMAIL", f"long.case.{rng.randrange(100,999)}@example.com").literal(". ")
    b.literal(padding * 12)
    b.literal("Restricted condition ").entity("HEALTH_CONDITION", _pick(rng, CONDITIONS)).literal(". ")
    b.literal(padding * 12)
    b.literal("Emergency phone ").entity("PHONE", _pick(rng, ACMA_FICTION_LANDLINES)).literal(".")
    return (*b.finish(), "long_form_casework", ["long_document", "window_boundary", "psi", noise])


POSITIVE_TEMPLATES: tuple[Template, ...] = (
    _contact, _address, _australian_ids, _business_finance, _payment, _birth,
    _digital, _device_location, _organisation_ids, _health, _mental_disability,
    _genetic_biometric, _beliefs, _politics_union, _legal_personal, _safeguarding,
    _hardship, _code_switch, _long_case,
)

HARD_NEGATIVES = (
    ("The release target is version 4.6.0 and build 123456789.", "software_release"),
    ("The RFC documentation block is 192.0.2.0/24; it identifies no user.", "documentation"),
    ("Use 2001:db8::/32 in examples rather than a production network.", "documentation"),
    ("The meeting is on 17/10/2026, not a date of birth.", "calendar"),
    ("Order 123-456-789 has shipped with item 4111111111111112.", "commerce"),
    ("The paper discusses bipolar disorder at a population level, not a patient.", "public_health"),
    ("The union published a general guide to workplace leave.", "policy"),
    ("Sydney and Melbourne are Australian cities.", "geography"),
    ("Example Street is a placeholder used in documentation.", "documentation"),
    ("Contact the team through the help centre; no personal contact is included.", "customer_support"),
    ("The variable is named patient_id but contains no identifier.", "source_code"),
    ("The string EMAIL_ADDRESS is a schema field, not an email address.", "source_code"),
    ("A salary band of $80,000–$95,000 applies to the role, not a person.", "recruitment"),
    ("The museum exhibition explores religious and political history.", "culture"),
    ("Model TEST-42A is a product SKU, not a vehicle registration.", "catalogue"),
    ("There were 4,000 survey responses from adults aged 18 to 65.", "statistics"),
)

NOISE_LEVELS = ("clean", "clean", "clean", "case", "spacing", "zero_width", "ocr", "confusable", "linebreak")
WRAPPERS = ("plain", "plain", "plain", "json", "csv", "markdown", "log")


def _wrap(text: str, entities: list[dict], wrapper: str) -> tuple[str, list[dict]]:
    if wrapper == "plain":
        return text, entities
    if wrapper == "json":
        prefix, suffix = '{"synthetic_note":"', '"}'
        # Recompute offsets through a deterministic per-character escape map.
        starts: dict[int, int] = {}
        ends: dict[int, int] = {}
        escaped_parts: list[str] = []
        cursor = len(prefix)
        for i, char in enumerate(text):
            starts[i] = cursor
            rendered = json.dumps(char, ensure_ascii=False)[1:-1]
            escaped_parts.append(rendered)
            cursor += len(rendered)
            ends[i + 1] = cursor
        shifted = [{**e, "start": starts[e["start"]], "end": ends[e["end"]]} for e in entities]
        return prefix + "".join(escaped_parts) + suffix, shifted
    if wrapper == "csv":
        prefix, suffix = 'case_id,note\nSYNTH-001,"', '"'
    elif wrapper == "markdown":
        prefix, suffix = "## Synthetic case note\n\n", "\n"
    else:
        prefix, suffix = "2026-10-17T10:00:00Z INFO synthetic_case=", " status=test"
    shifted = [{**e, "start": e["start"] + len(prefix), "end": e["end"] + len(prefix)} for e in entities]
    return prefix + text + suffix, shifted


def generate_records(count: int, seed: int) -> Iterator[dict]:
    if count < len(POSITIVE_TEMPLATES) + len(HARD_NEGATIVES):
        raise ValueError(f"count must be at least {len(POSITIVE_TEMPLATES) + len(HARD_NEGATIVES)}")
    rng = random.Random(seed)
    positive_count = max(len(POSITIVE_TEMPLATES), round(count * 0.84))
    for index in range(count):
        if index < positive_count:
            template = POSITIVE_TEMPLATES[index % len(POSITIVE_TEMPLATES)]
            noise = NOISE_LEVELS[(index // len(POSITIVE_TEMPLATES)) % len(NOISE_LEVELS)]
            text, entities, domain, slices = template(rng, noise)
            wrapper = WRAPPERS[(index * 5 + seed) % len(WRAPPERS)]
            text, entities = _wrap(text, entities, wrapper)
            slices = sorted(set(slices + [wrapper, "positive"]))
            template_id = template.__name__.removeprefix("_")
        else:
            text, domain = HARD_NEGATIVES[(index - positive_count) % len(HARD_NEGATIVES)]
            entities = []
            slices = ["hard_negative", "negative"]
            template_id = f"hard_negative_{(index - positive_count) % len(HARD_NEGATIVES):02d}"
        yield {
            "id": f"llss-au-v1-{index:07d}",
            "text": text,
            "language": "en-AU",
            "domain": domain,
            "slices": slices,
            "entities": entities,
            "metadata": {
                "synthetic": True,
                "template_id": template_id,
                "generator_version": GENERATOR_VERSION,
                "seed": seed,
            },
        }


def write_dataset(path: Path, count: int, seed: int) -> dict:
    path.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    labels: Counter[str] = Counter()
    slices: Counter[str] = Counter()
    domains: Counter[str] = Counter()
    entity_count = 0
    with path.open("wb") as handle:
        for record in generate_records(count, seed):
            validate_record(record)
            encoded = (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
            handle.write(encoded)
            digest.update(encoded)
            entity_count += len(record["entities"])
            labels.update(entity["label"] for entity in record["entities"])
            slices.update(record["slices"])
            domains.update([record["domain"]])
    return {
        "schema_version": 1,
        "generator_version": GENERATOR_VERSION,
        "seed": seed,
        "records": count,
        "entities": entity_count,
        "sha256": digest.hexdigest(),
        "labels": dict(sorted(labels.items())),
        "slices": dict(sorted(slices.items())),
        "domains": dict(sorted(domains.items())),
    }


def iter_jsonl(path: Path) -> Iterator[dict]:
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if line.strip():
                try:
                    yield json.loads(line)
                except json.JSONDecodeError as exc:
                    raise ValueError(f"Invalid JSON on {path}:{line_number}: {exc}") from exc


def audit_dataset(path: Path) -> dict:
    """Expose repetition and partition leakage before interpreting any score."""
    groups: dict[str, dict[str, set[str]]] = {}
    partition_counts: dict[str, Counter] = {
        scheme: Counter() for scheme in (LEGACY_PARTITION_SCHEME, PARTITION_SCHEME)
    }
    count = 0
    for record in iter_jsonl(path):
        count += 1
        normalized = " ".join(record["text"].casefold().split())
        key = hashlib.sha256(normalized.encode()).hexdigest()
        group = groups.setdefault(key, {scheme: set() for scheme in partition_counts})
        for scheme, counts in partition_counts.items():
            partition = evaluation_partition(record["id"], record["text"], scheme)
            counts[partition] += 1
            group[scheme].add(partition)
    return {
        "records": count,
        "unique_normalized_texts": len(groups),
        "repeated_records": count - len(groups),
        "partition_schemes": {
            scheme: {"records": dict(counts), "cross_partition_text_groups": sum(
                len(group[scheme]) > 1 for group in groups.values())}
            for scheme, counts in partition_counts.items()
        },
    }


def validate_record(record: dict) -> None:
    text = record.get("text")
    if not isinstance(text, str) or not text:
        raise ValueError(f"{record.get('id', '<unknown>')}: text must be non-empty")
    last_end = -1
    for entity in sorted(record.get("entities", []), key=lambda item: (item["start"], item["end"])):
        start, end, label = entity.get("start"), entity.get("end"), entity.get("label")
        if not isinstance(start, int) or not isinstance(end, int) or not (0 <= start < end <= len(text)):
            raise ValueError(f"{record.get('id')}: invalid entity offsets {start}:{end}")
        if start < last_end:
            raise ValueError(f"{record.get('id')}: overlapping gold entities are not allowed")
        if label not in LABELS:
            raise ValueError(f"{record.get('id')}: unknown label {label}")
        if entity.get("risk") != risk_for(label) or entity.get("family") != family_for(label):
            raise ValueError(f"{record.get('id')}: stale taxonomy metadata for {label}")
        last_end = end


def validate_dataset(path: Path, expected_sha256: str | None = None) -> dict:
    digest = hashlib.sha256()
    seen: set[str] = set()
    labels: Counter[str] = Counter()
    records = entities = negative_records = 0
    with path.open("rb") as handle:
        for line_number, line in enumerate(handle, 1):
            digest.update(line)
            if not line.strip():
                continue
            record = json.loads(line)
            validate_record(record)
            record_id = record.get("id")
            if not record_id or record_id in seen:
                raise ValueError(f"{path}:{line_number}: missing or duplicate record ID")
            seen.add(record_id)
            records += 1
            entities += len(record["entities"])
            negative_records += not record["entities"]
            labels.update(entity["label"] for entity in record["entities"])
    actual_sha256 = digest.hexdigest()
    if expected_sha256 and actual_sha256 != expected_sha256:
        raise ValueError(f"SHA-256 mismatch: expected {expected_sha256}, got {actual_sha256}")
    missing = sorted(set(LABELS) - set(labels))
    if missing:
        raise ValueError(f"Dataset does not cover labels: {', '.join(missing)}")
    return {
        "records": records,
        "entities": entities,
        "negative_records": negative_records,
        "sha256": actual_sha256,
        "labels": dict(sorted(labels.items())),
    }
