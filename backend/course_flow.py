"""Table-wise call, booking, and saved-reason flow.

Classification comes from the conversation itself. A Golf Course ID is SCO even
when an Organization ID is also set. An Organization ID alone is MCO. A call
with neither stays unclassified. Phone numbers from voice_channel_configurations
and voice_numbers group and check calls; they never classify a call.

A call is booked only when a bookings row has booking_session_id equal to the
conversation call_id, booking_channel voice, and status completed, confirmed,
or booked. A call without such a row is not called a failure unless a saved
failure reason exists for its Call ID in reports/courses-*.txt. Saved reasons
are read exactly as written and the report files are never changed.
"""

from __future__ import annotations

import json
import re
import shutil
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

import psycopg

from database import assert_select_only

FIRST_DAY = date(2024, 4, 24)
BOOKED_STATUSES = ("completed", "confirmed", "booked")
REASON_NOT_AVAILABLE = "Reason not available"
UNCLASSIFIED = "UNCLASSIFIED"
OUTCOME_BOOKED, OUTCOME_SAVED, OUTCOME_UNKNOWN = 0, 1, 2

ROOT = Path(__file__).resolve().parent.parent
REPORTS_DIR = ROOT / "reports"
CACHE_DIR = ROOT / ".flow-cache"
VALIDATION_PATH = ROOT / "flow-validation.txt"

_QUALIFYING = (
    "lower(btrim(b.booking_channel)) = 'voice' "
    "AND lower(btrim(b.status)) IN ('completed', 'confirmed', 'booked')"
)
_RANGE = (
    "c.created_at >= (%(first)s::timestamp AT TIME ZONE %(tz)s) "
    "AND c.created_at < ((%(through)s::timestamp + interval '1 day') AT TIME ZONE %(tz)s)"
)

CALLS_SQL = f"""
    SELECT
        c.id,
        c.call_id,
        to_char(c.created_at AT TIME ZONE %(tz)s, 'YYYY-MM-DD') AS day,
        c.golf_course_id,
        c.organization_id,
        regexp_replace(COALESCE(c.vapi_golf_course_phone_no, ''), '\\D', '', 'g') AS phone,
        (c.transcript IS NOT NULL AND btrim(c.transcript) <> '') AS has_transcript,
        COALESCE(s.session_rows, 0) AS session_rows,
        COALESCE(s.booked_rows, 0) AS booked_rows,
        COALESCE(s.test_rows, 0) AS test_rows,
        (lb.id IS NOT NULL) AS linked_booking
    FROM public.conversations AS c
    LEFT JOIN (
        SELECT
            b.booking_session_id,
            COUNT(*) AS session_rows,
            COUNT(*) FILTER (WHERE {_QUALIFYING}) AS booked_rows,
            COUNT(*) FILTER (WHERE {_QUALIFYING} AND b.is_test_booking) AS test_rows
        FROM public.bookings AS b
        WHERE btrim(COALESCE(b.booking_session_id, '')) <> ''
        GROUP BY b.booking_session_id
    ) AS s ON s.booking_session_id = c.call_id
    LEFT JOIN public.bookings AS lb
      ON lb.id = c.booking_id
     AND lower(btrim(lb.booking_channel)) = 'voice'
     AND lower(btrim(lb.status)) IN ('completed', 'confirmed', 'booked')
    WHERE {_RANGE}
"""

CONFIG_SQL = """
    SELECT
        v.id AS config_id,
        v.golf_course_id,
        v.organization_id,
        v.course_name,
        n.phone_number
    FROM public.voice_channel_configurations AS v
    LEFT JOIN public.voice_numbers AS n ON n.voice_channel_config_id = v.id
    ORDER BY v.id
"""

ORPHAN_NUMBERS_SQL = """
    SELECT n.voice_channel_config_id, n.phone_number
    FROM public.voice_numbers AS n
    LEFT JOIN public.voice_channel_configurations AS v ON v.id = n.voice_channel_config_id
    WHERE v.id IS NULL
"""

GOLF_NAMES_SQL = "SELECT id, golf_course_name FROM public.golf_courses"
ORG_NAMES_SQL = "SELECT id, org_name FROM public.organizations"

SESSION_VALUES_SQL = f"""
    SELECT b.booking_channel, b.status, COUNT(*) AS booking_rows,
           COUNT(DISTINCT b.booking_session_id) AS sessions
    FROM public.bookings AS b
    JOIN (SELECT c.call_id FROM public.conversations AS c WHERE {_RANGE}) AS r
      ON r.call_id = b.booking_session_id
    GROUP BY b.booking_channel, b.status
    ORDER BY b.booking_channel, b.status
"""

QUALIFYING_TABLE_SQL = f"""
    SELECT
        COUNT(*) AS booking_rows,
        COUNT(*) FILTER (WHERE btrim(COALESCE(b.booking_session_id, '')) = '') AS blank_session,
        COUNT(r.call_id) AS session_in_range,
        COUNT(*) FILTER (WHERE b.is_test_booking) AS test_rows,
        COUNT(*) FILTER (WHERE b.deleted_at IS NOT NULL) AS deleted_rows
    FROM public.bookings AS b
    LEFT JOIN (
        SELECT DISTINCT c.call_id FROM public.conversations AS c WHERE {_RANGE}
    ) AS r ON r.call_id = b.booking_session_id
    WHERE {_QUALIFYING}
"""

TRANSCRIPT_SQL = """
    SELECT c.id, c.call_id, c.transcript, c.created_at
    FROM public.conversations AS c
    WHERE c.call_id = %s
"""

REASON_LINE = re.compile(r"^(\d+)\.\s+(.+?)\s+[–—-]\s+(\d+)\s*$")
CALL_LINE = re.compile(r"^\s*-\s+Call ID:\s*(.+?)\s*$")
WHAT_LINE = re.compile(r"^\s*What happened:\s*(.*)$")
WHY_LINE = re.compile(r"^\s*Why not completed:\s*(.*)$")
HEADER_LINES = {
    "total": re.compile(r"^(?:Total Calls|Unclassified calls):\s*(\d+)\s*$", re.MULTILINE),
    "successful": re.compile(r"^Successful Bookings:\s*(\d+)\s*$", re.MULTILINE),
    "notCompleted": re.compile(r"^Booking Not Completed:\s*(\d+)\s*$", re.MULTILINE),
    "unclear": re.compile(r"^Unclear Calls:\s*(\d+)\s*$", re.MULTILINE),
}
SECTION_BREAKS = ("Repeated Issues:", "Course:", "UNCLASSIFIED CALLS", "FAILURE REASONS")


def _clean(value) -> str:
    return " ".join(str(value or "").split())


def _digits(value) -> str:
    return re.sub(r"\D", "", str(value or ""))


def _select(connection: psycopg.Connection, sql: str, params=None) -> list[tuple]:
    assert_select_only(sql)
    with connection.cursor() as cursor:
        cursor.execute(sql, params)
        return cursor.fetchall()


def parse_saved_reasons(text: str, day: str) -> list[dict]:
    """Failure blocks in one report, in file order, with text exactly as saved."""
    entries: list[dict] = []
    category = None
    current = None
    for line in text.splitlines():
        if line.startswith(SECTION_BREAKS):
            category = None
            current = None
            continue
        reason = REASON_LINE.match(line)
        if reason:
            category = reason.group(2).strip()
            current = None
            continue
        if category is None:
            continue
        call = CALL_LINE.match(line)
        if call:
            current = {
                "callId": call.group(1),
                "category": category,
                "whatHappened": "",
                "whyNotCompleted": "",
                "day": day,
            }
            entries.append(current)
            continue
        if current is None:
            continue
        what = WHAT_LINE.match(line)
        if what:
            current["whatHappened"] = what.group(1).strip()
            continue
        why = WHY_LINE.match(line)
        if why:
            current["whyNotCompleted"] = why.group(1).strip()
    return entries


def load_saved_reasons(folder: Path = REPORTS_DIR) -> tuple[dict[str, dict], dict]:
    """Saved failure reasons by Call ID, plus parse and header statistics."""
    by_call: dict[str, list[dict]] = defaultdict(list)
    header = Counter()
    files = 0
    for path in sorted(folder.glob("courses-*.txt")):
        match = re.search(r"(\d{4}-\d{2}-\d{2})", path.name)
        if not match:
            continue
        files += 1
        text = path.read_text(encoding="utf-8")
        for key, pattern in HEADER_LINES.items():
            header[key] += sum(int(value) for value in pattern.findall(text))
        for entry in parse_saved_reasons(text, match.group(1)):
            by_call[entry["callId"]].append(entry)

    reasons: dict[str, dict] = {}
    duplicate_ids = 0
    conflicts: list[dict] = []
    blocks = 0
    for call_id, entries in by_call.items():
        blocks += len(entries)
        reasons[call_id] = entries[0]
        if len(entries) == 1:
            continue
        duplicate_ids += 1
        texts = {(item["category"], item["whatHappened"], item["whyNotCompleted"]) for item in entries}
        if len(texts) > 1:
            conflicts.append(
                {
                    "callId": call_id,
                    "days": sorted({item["day"] for item in entries}),
                    "categories": sorted({item["category"] for item in entries}),
                }
            )
    stats = {
        "files": files,
        "blocks": blocks,
        "uniqueCallIds": len(reasons),
        "duplicateCallIds": duplicate_ids,
        "conflictingCallIds": conflicts,
        "missingWhy": sum(1 for item in reasons.values() if not item["whyNotCompleted"]),
        "header": dict(header),
    }
    return reasons, stats


def _best_config_name(names: list[str]) -> str:
    counts = Counter(name for name in names if name)
    if not counts:
        return ""
    return sorted(counts.items(), key=lambda item: (-item[1], -len(item[0]), item[0]))[0][0]


def _load_mapping(connection: psycopg.Connection) -> dict:
    configs = _select(connection, CONFIG_SQL)
    orphans = _select(connection, ORPHAN_NUMBERS_SQL)
    golf_names = {int(row[0]): _clean(row[1]) for row in _select(connection, GOLF_NAMES_SQL)}
    org_names = {int(row[0]): _clean(row[1]) for row in _select(connection, ORG_NAMES_SQL)}

    phone_configs: dict[str, list[dict]] = defaultdict(list)
    config_names: dict[str, list[str]] = defaultdict(list)
    owners: dict[str, dict] = {}
    configs_without_phone = []
    config_ids = set()
    for config_id, golf_id, org_id, course_name, phone_number in configs:
        config_ids.add(int(config_id))
        if golf_id is not None:
            owner = f"SCO:{int(golf_id)}"
        elif org_id is not None:
            owner = f"MCO:{int(org_id)}"
        else:
            owner = ""
        config = {
            "configId": int(config_id),
            "golfCourseId": int(golf_id) if golf_id is not None else None,
            "organizationId": int(org_id) if org_id is not None else None,
            "owner": owner,
            "courseName": _clean(course_name),
        }
        if owner:
            config_names[owner].append(config["courseName"])
            group = owners.setdefault(owner, {"phones": set(), "configIds": set()})
            group["configIds"].add(config["configId"])
        phone = _digits(phone_number)
        if not phone:
            configs_without_phone.append(config)
            continue
        phone_configs[phone].append(config)
        if owner:
            owners[owner]["phones"].add(phone)

    def name_for(key: str) -> tuple[str, str]:
        kind, raw_id = key.split(":")
        number = int(raw_id)
        official = golf_names.get(number) if kind == "SCO" else org_names.get(number)
        if official:
            return official, "golf_courses" if kind == "SCO" else "organizations"
        configured = _best_config_name(config_names.get(key, []))
        if configured:
            return configured, "voice_channel_configurations"
        label = "Golf Course" if kind == "SCO" else "Organization"
        return f"{label} {number}", "id only"

    return {
        "phoneConfigs": phone_configs,
        "owners": owners,
        "configNames": config_names,
        "configsWithoutPhone": configs_without_phone,
        "orphanNumbers": [(row[0], _digits(row[1])) for row in orphans],
        "configCount": len(config_ids),
        "nameFor": name_for,
    }


def _configured_owners(phone: str, phone_configs: dict) -> list[str]:
    if not phone:
        return []
    return sorted({item["owner"] for item in phone_configs.get(phone, []) if item.get("owner")})


def _assign_call(golf_id, org_id, phone: str, phone_configs: dict) -> tuple[str, str]:
    """Return the course key and how the call was assigned.

    A configured phone with one owner wins when the conversation IDs are empty
    or name that same owner. A disagreeing ID or a phone shared by two owners
    is not assigned. A conversation ID is kept only when its phone is not configured.
    """
    owners = _configured_owners(phone, phone_configs)
    conversation_key = ""
    if golf_id is not None:
        conversation_key = f"SCO:{int(golf_id)}"
    elif org_id is not None:
        conversation_key = f"MCO:{int(org_id)}"
    if len(owners) > 1:
        return UNCLASSIFIED, "conflict_shared_phone"
    if len(owners) == 1:
        owner = owners[0]
        if not conversation_key:
            return owner, "phone_filled"
        if conversation_key == owner:
            return owner, "id_agrees"
        return UNCLASSIFIED, "conflict_id"
    if conversation_key:
        return conversation_key, "id_only"
    if not phone:
        return UNCLASSIFIED, "blank_phone"
    return UNCLASSIFIED, "unmatched_phone"


def _phone_status(kind: str, number: int | None, phone: str, phone_configs: dict) -> str:
    if not phone:
        return "blank"
    configs = phone_configs.get(phone)
    if not configs:
        return "unmapped"
    if kind == "SCO" and any(item["golfCourseId"] == number for item in configs):
        return "match"
    if kind == "MCO" and any(
        item["golfCourseId"] is None and item["organizationId"] == number for item in configs
    ):
        return "match"
    return "other"


def build_flow(
    connection: psycopg.Connection,
    *,
    timezone_name: str,
    through: date,
    first_day: date = FIRST_DAY,
    reports_dir: Path = REPORTS_DIR,
) -> dict:
    """Read every table once and return the flow data and its validation."""
    params = {"tz": timezone_name, "first": first_day.isoformat(), "through": through.isoformat()}
    mapping = _load_mapping(connection)
    phone_configs = mapping["phoneConfigs"]
    calls = _select(connection, CALLS_SQL, params)
    session_values = _select(connection, SESSION_VALUES_SQL, params)
    qualifying = _select(connection, QUALIFYING_TABLE_SQL, params)[0]
    reasons, reason_stats = load_saved_reasons(reports_dir)

    days: list[str] = []
    day_index: dict[str, int] = {}
    phones: list[str] = []
    phone_index: dict[str, int] = {}
    groups: list[dict] = []
    group_index: dict[str, int] = {}
    categories: list[str] = []
    category_index: dict[str, int] = {}

    def index_of(value, items, lookup):
        found = lookup.get(value)
        if found is None:
            found = len(items)
            lookup[value] = found
            items.append(value)
        return found

    def group_of(key: str) -> int:
        found = group_index.get(key)
        if found is not None:
            return found
        if key == UNCLASSIFIED:
            group = {"key": key, "kind": "", "id": None, "name": "Unclassified calls", "nameSource": ""}
        else:
            kind, raw_id = key.split(":")
            name, source = mapping["nameFor"](key)
            group = {"key": key, "kind": kind, "id": int(raw_id), "name": name, "nameSource": source}
        owner = mapping["owners"].get(key, {"phones": set(), "configIds": set()})
        group["configIds"] = sorted(owner["configIds"])
        group["phones"] = sorted(index_of(phone, phones, phone_index) for phone in owner["phones"])
        group["configNames"] = sorted({name for name in mapping["configNames"].get(key, []) if name})
        group_index[key] = len(groups)
        groups.append(group)
        return group_index[key]

    for key in sorted(mapping["owners"], key=lambda item: (item.split(":")[0], int(item.split(":")[1]))):
        group_of(key)
    for phone in sorted(phone_configs):
        index_of(phone, phones, phone_index)

    columns = {name: [] for name in ("ids", "callIds", "day", "group", "phone", "transcript", "outcome", "category", "linked")}
    rows: dict[tuple, list[int]] = {}
    reason_rows: Counter = Counter()
    shards: dict[str, dict] = defaultdict(dict)

    totals = Counter()
    kind_totals: dict[str, Counter] = defaultdict(Counter)
    phone_check: dict[str, Counter] = defaultdict(Counter)
    phone_mismatches: Counter = Counter()
    unclassified_on_configured: Counter = Counter()
    assignment_counts: Counter = Counter()
    conflict_samples: list[dict] = []
    phone_calls: Counter = Counter()
    seen_ids: set = set()
    seen_call_ids: set = set()
    duplicate_ids = 0
    duplicate_call_ids = 0
    blank_call_ids = 0
    in_range_call_ids: set = set()

    for (conversation_id, call_id, day, golf_id, org_id, phone, has_transcript,
         session_rows, booked_rows, test_rows, linked_booking) in calls:
        if conversation_id in seen_ids:
            duplicate_ids += 1
            continue
        seen_ids.add(conversation_id)
        call_id = str(call_id or "")
        if not call_id:
            blank_call_ids += 1
        elif call_id in seen_call_ids:
            duplicate_call_ids += 1
        seen_call_ids.add(call_id)
        in_range_call_ids.add(call_id)

        key, assignment = _assign_call(golf_id, org_id, phone, phone_configs)
        assignment_counts[assignment] += 1
        if assignment in ("conflict_id", "conflict_shared_phone") and len(conflict_samples) < 50:
            conflict_samples.append(
                {
                    "callId": call_id,
                    "phone": phone,
                    "golfCourseId": int(golf_id) if golf_id is not None else None,
                    "organizationId": int(org_id) if org_id is not None else None,
                    "phoneOwners": _configured_owners(phone, phone_configs),
                    "reason": assignment,
                }
            )
        if key == UNCLASSIFIED:
            kind, number = "", None
        else:
            kind, raw_id = key.split(":")
            number = int(raw_id)
        label = kind or "Unclassified"
        group = group_of(key)
        day_at = index_of(day, days, day_index)
        phone_at = index_of(phone, phones, phone_index)
        phone_calls[phone] += 1

        booked = int(booked_rows or 0) > 0
        saved = None if booked or not call_id else reasons.get(call_id)
        if booked:
            outcome = OUTCOME_BOOKED
        elif saved:
            outcome = OUTCOME_SAVED
        else:
            outcome = OUTCOME_UNKNOWN
        category = index_of(saved["category"], categories, category_index) if saved else -1

        bucket = rows.setdefault((day_at, group, phone_at), [0, 0, 0, 0, 0])
        bucket[0] += 1
        bucket[1] += 1 if has_transcript else 0
        bucket[2 + outcome] += 1
        if outcome != OUTCOME_BOOKED:
            reason_rows[(day_at, group, category)] += 1
        if saved:
            shard = (call_id[:2].lower() if re.match(r"^[0-9a-z]{2}", call_id.lower()) else "_")
            shards[shard][call_id] = [saved["whatHappened"], saved["whyNotCompleted"]]

        columns["ids"].append(int(conversation_id))
        columns["callIds"].append(call_id)
        columns["day"].append(day_at)
        columns["group"].append(group)
        columns["phone"].append(phone_at)
        columns["transcript"].append(1 if has_transcript else 0)
        columns["outcome"].append(outcome)
        columns["category"].append(category)
        columns["linked"].append(1 if linked_booking else 0)

        for counter in (totals, kind_totals[label]):
            counter["calls"] += 1
            counter["withTranscript"] += 1 if has_transcript else 0
            counter["booked"] += 1 if booked else 0
            counter["saved"] += 1 if outcome == OUTCOME_SAVED else 0
            counter["unknown"] += 1 if outcome == OUTCOME_UNKNOWN else 0
            counter["sessionMatched"] += 1 if int(session_rows or 0) > 0 else 0
            counter["sessionNotQualifying"] += 1 if int(session_rows or 0) > 0 and not booked else 0
            counter["multiQualifyingRows"] += 1 if int(booked_rows or 0) > 1 else 0
            counter["qualifyingRows"] += int(booked_rows or 0)
            counter["testBooked"] += 1 if int(test_rows or 0) > 0 else 0
            counter["linkedNotSession"] += 1 if linked_booking and not booked else 0
            counter["linkedNotSessionSaved"] += 1 if linked_booking and outcome == OUTCOME_SAVED else 0
            counter["savedOnBooked"] += 1 if booked and call_id in reasons else 0

        if kind:
            status = _phone_status(kind, number, phone, phone_configs)
            phone_check[kind][status] += 1
            if status in ("other", "unmapped"):
                phone_mismatches[(key, phone, status)] += 1

    saved_in_range = sum(1 for call_id in reasons if call_id in in_range_call_ids)
    unmatched_saved = sorted(call_id for call_id in reasons if call_id not in in_range_call_ids)

    configured_without_calls = []
    for phone, configs in sorted(phone_configs.items()):
        if phone_calls.get(phone):
            continue
        for config in configs:
            configured_without_calls.append({"phone": phone, **config})
    unconfigured_phones = sorted(
        ((phone, count) for phone, count in phone_calls.items() if phone and phone not in phone_configs),
        key=lambda item: (-item[1], item[0]),
    )
    multi_phone_owners = []
    for key, owner in mapping["owners"].items():
        if len(owner["phones"]) > 1:
            group = groups[group_of(key)]
            multi_phone_owners.append(
                {
                    "key": key,
                    "name": group["name"],
                    "phones": [[phone, phone_calls.get(phone, 0)] for phone in sorted(owner["phones"])],
                }
            )
    shared_phones = [
        {"phone": phone, "configs": [item["configId"] for item in configs], "owners": sorted({item["owner"] for item in configs})}
        for phone, configs in sorted(phone_configs.items())
        if len(configs) > 1
    ]

    group_totals = defaultdict(lambda: [0, 0, 0, 0, 0])
    for (_, group, _), values in rows.items():
        for position, value in enumerate(values):
            group_totals[group][position] += value
    sum_groups = [sum(values[position] for values in group_totals.values()) for position in range(5)]
    courses_with_calls = {"SCO": 0, "MCO": 0}
    courses_without_calls = []
    for index, group in enumerate(groups):
        if group["kind"] not in ("SCO", "MCO"):
            continue
        if group_totals[index][0]:
            courses_with_calls[group["kind"]] += 1
        else:
            courses_without_calls.append({"key": group["key"], "kind": group["kind"], "name": group["name"]})

    validation = {
        "range": {"firstDay": first_day.isoformat(), "through": through.isoformat(), "timezone": timezone_name},
        "conversations": {
            "rows": len(calls),
            "distinctIds": len(seen_ids),
            "duplicateIds": duplicate_ids,
            "distinctCallIds": len(seen_call_ids),
            "duplicateCallIds": duplicate_call_ids,
            "blankCallIds": blank_call_ids,
        },
        "totals": dict(totals),
        "byKind": {kind: dict(counter) for kind, counter in kind_totals.items()},
        "phoneCheck": {kind: dict(counter) for kind, counter in phone_check.items()},
        "phoneMismatches": [
            {"group": key, "name": groups[group_index[key]]["name"], "phone": phone, "status": status,
             "phoneOwners": sorted({item["owner"] for item in phone_configs.get(phone, [])}), "calls": count}
            for (key, phone, status), count in sorted(phone_mismatches.items(), key=lambda item: -item[1])
        ],
        "unclassifiedOnConfiguredPhones": dict(unclassified_on_configured),
        "assignment": {
            "phoneFilled": assignment_counts["phone_filled"],
            "idAgrees": assignment_counts["id_agrees"],
            "idOnly": assignment_counts["id_only"],
            "conflictId": assignment_counts["conflict_id"],
            "conflictSharedPhone": assignment_counts["conflict_shared_phone"],
            "blankPhone": assignment_counts["blank_phone"],
            "unmatchedPhone": assignment_counts["unmatched_phone"],
            "conflicts": conflict_samples,
        },
        "coursesWithCalls": courses_with_calls,
        "coursesWithoutCalls": courses_without_calls,
        "mapping": {
            "configs": mapping["configCount"],
            "configsWithoutPhone": mapping["configsWithoutPhone"],
            "orphanNumbers": mapping["orphanNumbers"],
            "sharedPhones": shared_phones,
            "multiPhoneOwners": sorted(multi_phone_owners, key=lambda item: item["key"]),
            "configuredPhonesWithoutCalls": configured_without_calls,
            "unconfiguredPhones": [[phone, count] for phone, count in unconfigured_phones],
            "blankPhoneCalls": phone_calls.get("", 0),
        },
        "bookings": {
            "sessionValues": [
                {"channel": row[0], "status": row[1], "rows": int(row[2]), "sessions": int(row[3])}
                for row in session_values
            ],
            "qualifyingTable": {
                "rows": int(qualifying[0]),
                "blankSession": int(qualifying[1]),
                "sessionInRange": int(qualifying[2]),
                "testRows": int(qualifying[3]),
                "deletedRows": int(qualifying[4]),
            },
        },
        "savedReasons": {
            **{key: value for key, value in reason_stats.items() if key != "conflictingCallIds"},
            "conflictingCallIds": reason_stats["conflictingCallIds"][:50],
            "conflictCount": len(reason_stats["conflictingCallIds"]),
            "inRange": saved_in_range,
            "unmatchedCount": len(unmatched_saved),
            "unmatchedSample": unmatched_saved[:50],
        },
        "checks": {
            "groupTotalsMatchOverall": sum_groups == [
                totals["calls"], totals["withTranscript"], totals["booked"], totals["saved"], totals["unknown"]
            ],
            "outcomesAddUp": totals["booked"] + totals["saved"] + totals["unknown"] == totals["calls"],
            "kindsAddUp": sum(counter["calls"] for counter in kind_totals.values()) == totals["calls"],
            "assignmentAddsUp": sum(assignment_counts.values()) == totals["calls"],
            "uniqueConversations": duplicate_ids == 0 and len(seen_ids) == totals["calls"],
            "uniqueCallIds": duplicate_call_ids == 0 and blank_call_ids == 0,
            "noSharedPhones": not shared_phones,
        },
    }

    flow = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "timezone": timezone_name,
        "firstDay": first_day.isoformat(),
        "through": through.isoformat(),
        "reasonNotAvailable": REASON_NOT_AVAILABLE,
        "days": days,
        "phones": phones,
        "categories": categories,
        "groups": groups,
        "phoneOwners": {
            str(phone_index[phone]): sorted({item["owner"] for item in configs if item["owner"]})
            for phone, configs in phone_configs.items()
        },
        "rows": [[day, group, phone, *values] for (day, group, phone), values in sorted(rows.items())],
        "reasons": [[day, group, category, count] for (day, group, category), count in sorted(reason_rows.items())],
        "validation": validation,
    }
    return {"flow": flow, "calls": columns, "shards": shards}


def write_cache(result: dict, cache_dir: Path = CACHE_DIR) -> Path:
    """Write the flow, the per-call columns, and the saved-reason shards."""
    staging = cache_dir.with_name(cache_dir.name + ".tmp")
    if staging.exists():
        shutil.rmtree(staging)
    (staging / "reasons").mkdir(parents=True)
    (staging / "flow.json").write_text(json.dumps(result["flow"], separators=(",", ":")), encoding="utf-8")
    (staging / "calls.json").write_text(json.dumps(result["calls"], separators=(",", ":")), encoding="utf-8")
    for shard, entries in result["shards"].items():
        (staging / "reasons" / f"{shard}.json").write_text(
            json.dumps(entries, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
    if cache_dir.exists():
        shutil.rmtree(cache_dir)
    staging.rename(cache_dir)
    return cache_dir


def fetch_transcript(connection: psycopg.Connection, call_id: str) -> dict | None:
    rows = _select(connection, TRANSCRIPT_SQL, (call_id,))
    if not rows:
        return None
    conversation_id, found_call_id, transcript, created_at = rows[0]
    return {
        "conversationId": int(conversation_id),
        "callId": found_call_id,
        "transcript": transcript or "",
        "createdAt": created_at.isoformat() if isinstance(created_at, datetime) else created_at,
    }


def _line(label: str, value) -> str:
    return f"{label}: {value:,}" if isinstance(value, int) else f"{label}: {value}"


def validation_text(flow: dict) -> str:
    """Plain-text reconciliation report for the flow."""
    v = flow["validation"]
    t = v["totals"]
    groups = flow["groups"]
    lines = [
        "TABLE-WISE FLOW VALIDATION",
        "",
        f"Generated: {flow['generatedAt']}",
        f"Range: {v['range']['firstDay']} through {v['range']['through']} ({v['range']['timezone']} calendar days)",
        "",
        "CONVERSATIONS",
        _line("Rows read", v["conversations"]["rows"]),
        _line("Distinct conversation IDs", v["conversations"]["distinctIds"]),
        _line("Duplicate conversation IDs", v["conversations"]["duplicateIds"]),
        _line("Distinct call IDs", v["conversations"]["distinctCallIds"]),
        _line("Duplicate call IDs", v["conversations"]["duplicateCallIds"]),
        _line("Blank call IDs", v["conversations"]["blankCallIds"]),
        "",
        "CLASSIFICATION (configured phone, then a conversation ID only when that phone is not configured)",
        "A phone with one configured course is used when the conversation ID is empty or names that same course.",
        "A disagreeing ID, or a phone configured for more than one course, is reported and not assigned.",
    ]
    for kind in ("SCO", "MCO", "Unclassified"):
        counter = v["byKind"].get(kind, {})
        lines.append(
            f"{kind}: {counter.get('calls', 0):,} calls | booked {counter.get('booked', 0):,} | "
            f"saved reason {counter.get('saved', 0):,} | reason not available {counter.get('unknown', 0):,} | "
            f"with transcript {counter.get('withTranscript', 0):,}"
        )
    lines += [
        "",
        "OUTCOMES",
        _line("Total calls", t.get("calls", 0)),
        _line("Calls with transcript", t.get("withTranscript", 0)),
        _line("Calls without transcript", t.get("calls", 0) - t.get("withTranscript", 0)),
        _line("Booked (Voice session, completed/confirmed/booked)", t.get("booked", 0)),
        _line("Qualifying booking rows behind those calls", t.get("qualifyingRows", 0)),
        _line("Booked calls with more than one qualifying row (counted once)", t.get("multiQualifyingRows", 0)),
        _line("Booked calls whose booking is marked is_test_booking", t.get("testBooked", 0)),
        _line("Not booked, saved failure reason", t.get("saved", 0)),
        _line("Not booked or not verified, reason not available", t.get("unknown", 0)),
        _line("Calls with any session row", t.get("sessionMatched", 0)),
        _line("Calls with a session row that does not qualify", t.get("sessionNotQualifying", 0)),
        "",
        "BOOKING TABLE",
        "Session-matched booking rows by channel and status:",
    ]
    for row in v["bookings"]["sessionValues"]:
        lines.append(f"  {row['channel']!s:8} {row['status']!s:10} rows {row['rows']:,} sessions {row['sessions']:,}")
    q = v["bookings"]["qualifyingTable"]
    lines += [
        _line("Qualifying Voice rows in bookings (all dates)", q["rows"]),
        _line("  with a blank booking_session_id", q["blankSession"]),
        _line("  whose session matches a call in range", q["sessionInRange"]),
        _line("  marked is_test_booking", q["testRows"]),
        _line("  with deleted_at set", q["deletedRows"]),
        _line("Calls linked by conversations.booking_id to a qualifying Voice booking but with no qualifying session", t.get("linkedNotSession", 0)),
        _line("  of those, with a saved failure reason", t.get("linkedNotSessionSaved", 0)),
        _line("Saved failure reasons on calls that are booked by session (not shown as reasons)", t.get("savedOnBooked", 0)),
        "",
        "SAVED FAILURE REASONS (reports/courses-*.txt, read only)",
    ]
    s = v["savedReasons"]
    lines += [
        _line("Report files", s["files"]),
        _line("Call ID blocks", s["blocks"]),
        _line("Unique Call IDs", s["uniqueCallIds"]),
        _line("Call IDs saved more than once", s["duplicateCallIds"]),
        _line("Call IDs saved with different text", s["conflictCount"]),
        _line("Saved blocks with no Why not completed text", s["missingWhy"]),
        _line("Saved Call IDs found in range", s["inRange"]),
        _line("Saved Call IDs with no conversation in range", s["unmatchedCount"]),
    ]
    if s["unmatchedSample"]:
        lines.append("  Sample: " + ", ".join(s["unmatchedSample"][:20]))
    for item in s["conflictingCallIds"][:20]:
        lines.append(f"  Conflict {item['callId']}: days {', '.join(item['days'])}; categories {', '.join(item['categories'])}")
    h = s["header"]
    lines += [
        "",
        "OLD REPORT HEADERS COMPARED WITH THIS FLOW",
        f"Saved headers: total {h.get('total', 0):,} | successful {h.get('successful', 0):,} | "
        f"not completed {h.get('notCompleted', 0):,} | unclear {h.get('unclear', 0):,}",
        f"This flow: total {t.get('calls', 0):,} | booked {t.get('booked', 0):,} | "
        f"saved reason {t.get('saved', 0):,} | reason not available {t.get('unknown', 0):,}",
        "Saved successes came from the AI transcript reading and from conversations.booking_id rows with",
        "status booked. This flow counts only Voice bookings matched by booking_session_id = call_id.",
        "",
        "ASSIGNMENT",
    ]
    a = v["assignment"]
    lines += [
        _line("Calls filled in from the configured phone (no conversation ID)", a["phoneFilled"]),
        _line("Calls whose conversation ID agrees with the configured phone", a["idAgrees"]),
        _line("Calls kept on their conversation ID because the phone is not configured", a["idOnly"]),
        _line("Calls not assigned because the conversation ID disagrees with the phone", a["conflictId"]),
        _line("Calls not assigned because the phone belongs to more than one course", a["conflictSharedPhone"]),
        _line("Calls not assigned because the phone is blank", a["blankPhone"]),
        _line("Calls not assigned because the phone is not in voice_numbers", a["unmatchedPhone"]),
        _line("SCO courses with calls", v["coursesWithCalls"].get("SCO", 0)),
        _line("MCO organizations with calls", v["coursesWithCalls"].get("MCO", 0)),
        _line("Configured courses with no calls in range", len(v["coursesWithoutCalls"])),
    ]
    for item in v["coursesWithoutCalls"]:
        lines.append(f"  {item['key']} {item['name']}")
    if a["conflicts"]:
        lines.append("Conflicts (not assigned):")
        for item in a["conflicts"]:
            owners = ", ".join(item["phoneOwners"]) or "none"
            lines.append(
                f"  {item['callId']} | phone {item['phone'] or '(blank)'} | golf {item['golfCourseId']} | "
                f"organization {item['organizationId']} | phone owner {owners} | {item['reason']}"
            )
    lines += [
        "",
        "PHONE MAPPING (voice_channel_configurations.id -> voice_numbers.voice_channel_config_id -> conversations)",
    ]
    m = v["mapping"]
    lines += [
        _line("Configurations", m["configs"]),
        _line("Configurations without a phone", len(m["configsWithoutPhone"])),
        _line("voice_numbers rows whose configuration is missing", len(m["orphanNumbers"])),
        _line("Phones shared by more than one configuration", len(m["sharedPhones"])),
        _line("Configured phones with no calls in range", len({item["phone"] for item in m["configuredPhonesWithoutCalls"]})),
        _line("Conversation phones not in voice_numbers", len(m["unconfiguredPhones"])),
        _line("  calls on those phones", sum(count for _, count in m["unconfiguredPhones"])),
        _line("Calls with a blank phone", m["blankPhoneCalls"]),
    ]
    for kind, counter in sorted(v["phoneCheck"].items()):
        lines.append(
            f"{kind} calls by phone check: match {counter.get('match', 0):,} | phone of another course {counter.get('other', 0):,} | "
            f"unconfigured phone {counter.get('unmapped', 0):,} | blank {counter.get('blank', 0):,}"
        )
    for owner, count in sorted(v["unclassifiedOnConfiguredPhones"].items()):
        lines.append(f"Unclassified calls on phones configured for {owner}: {count:,} (left unclassified)")
    lines += ["", "Courses and organizations with more than one phone:"]
    for item in m["multiPhoneOwners"]:
        phones = ", ".join(f"{phone} ({count:,})" for phone, count in item["phones"])
        lines.append(f"  {item['key']} {item['name']}: {phones}")
    lines += ["", "Configurations without a phone:"]
    for item in m["configsWithoutPhone"]:
        lines.append(f"  config {item['configId']} {item['owner'] or 'no owner'} {item['courseName']}")
    lines += ["", "Configured phones with no calls in range:"]
    for item in m["configuredPhonesWithoutCalls"]:
        lines.append(f"  {item['phone']} config {item['configId']} {item['owner'] or 'no owner'} {item['courseName']}")
    lines += ["", "Conversation phones not in voice_numbers (phone, calls):"]
    for phone, count in m["unconfiguredPhones"]:
        lines.append(f"  {phone} {count:,}")
    lines += ["", "SCO/MCO calls whose phone is not that course's configured phone:"]
    for item in v["phoneMismatches"]:
        owners = ", ".join(item["phoneOwners"]) or "none"
        lines.append(f"  {item['group']} {item['name']} | phone {item['phone'] or '(blank)'} | {item['status']} | phone owner {owners} | {item['calls']:,} calls")
    lines += ["", "COURSES"]
    lines.append(f"SCO entries: {sum(1 for group in groups if group['kind'] == 'SCO'):,}")
    lines.append(f"MCO entries: {sum(1 for group in groups if group['kind'] == 'MCO'):,}")
    keys = [group["key"] for group in groups]
    lines.append(f"Duplicate course keys: {len(keys) - len(set(keys))}")
    lines += ["", "CHECKS"]
    for name, passed in v["checks"].items():
        lines.append(f"{name}: {'PASS' if passed else 'FAIL'}")
    return "\n".join(lines) + "\n"
