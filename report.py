"""Build the voice booking report from analyzed conversations."""

from collections import Counter

from analyzer import (
    CATEGORIES,
    FAILURE_POINT_CATEGORIES,
    FAILURE_REASONS,
    canonical_failure_reason,
)
from welcome_course import UNKNOWN_COURSE


_QA_LABELS = (
    ("conversation_summary", "Conversation Summary"),
    ("failure_point_category", "Failure Point Category"),
    ("failure_point", "Failure Point"),
    ("what_happened", "What Happened"),
    ("confirmed_failure_reason", "Confirmed Failure Reason"),
    ("why_booking_did_not_happen", "Why Booking Did Not Happen"),
    ("possible_cause", "Possible Cause"),
    ("evidence", "Evidence"),
    ("final_root_cause", "Final Root Cause"),
)


def _qa_lines(item: dict) -> list[str]:
    lines = []
    for key, label in _QA_LABELS:
        value = str(item.get(key) or "").strip() or "Not stated"
        lines.append(f"    {label}: {value}")
    return lines


def _calls_for(analyses: list[dict], category: str) -> list[dict]:
    return [
        item
        for item in analyses
        if item["category"] == category and not item["booking_successful"]
    ]


def build_report(
    analyses: list[dict],
    *,
    course_name: str,
    report_date: str,
    ai_summary: str,
) -> str:
    total = len(analyses)
    successful = sum(1 for item in analyses if item["booking_successful"])
    rounds = sum(item.get("rounds") or 0 for item in analyses)
    not_completed = total - successful
    abandoned = sum(1 for item in analyses if item["category"] == "Customer Abandoned")

    failure_counts = Counter(
        item["category"] for item in analyses if not item["booking_successful"]
    )
    stage_counts = Counter(
        item["drop_off_stage"]
        for item in analyses
        if not item["booking_successful"] and item.get("drop_off_stage")
    )
    major_stage = stage_counts.most_common(1)[0][0] if stage_counts else "Unclear"

    lines = [
        "AI VOICE BOOKING REPORT",
        "",
        f"Course: {course_name}",
        f"Date: {report_date}",
        "",
        f"Total Conversations: {total}",
        f"Successful Bookings: {successful}",
        f"Rounds: {rounds}",
        f"Not Completed: {not_completed}",
        f"Abandoned Conversations: {abandoned}",
        "",
        "FAILURE REASONS",
        "",
    ]

    ordered = [category for category in CATEGORIES if category != "Booking Successful"]
    printed = False
    for category in ordered:
        count = failure_counts.get(category, 0)
        if count:
            lines.append(f"{category}: {count}")
            printed = True
    if not printed:
        lines.append("None")

    lines.extend(
        [
            "",
            "MAJOR DROP-OFF STAGE",
            "",
            major_stage,
            "",
            "AI SUMMARY",
            "",
            ai_summary.strip() or "No summary was produced.",
            "",
            "REPEATED FAILURE POINTS",
            "",
        ]
    )

    point_counts = Counter(
        item.get("failure_point_category") or "Root cause cannot be confirmed"
        for item in analyses
        if not item["booking_successful"]
    )
    point_order = [name for name in FAILURE_POINT_CATEGORIES if point_counts.get(name)]
    point_order.sort(key=lambda name: point_counts[name], reverse=True)
    if point_order:
        for name in point_order:
            lines.append(f"{name}: {point_counts[name]}")
    else:
        lines.append("None")

    lines.extend(
        [
            "",
            "CALL IDS BY FAILURE REASON",
            "",
        ]
    )

    examples_printed = False
    for category, count in failure_counts.most_common():
        if count <= 0:
            continue
        calls = _calls_for(analyses, category)
        if not calls:
            continue
        lines.append(f"{category}: {len(calls)}")
        for item in calls:
            lines.append(
                f"  conversation {item.get('conversation_id')} | call_id {item.get('call_id')}"
            )
            lines.extend(_qa_lines(item))
        lines.append("")
        examples_printed = True
    if not examples_printed:
        lines.append("None")

    lines.append("")
    return "\n".join(lines)


def _call_word(count: int) -> str:
    return "call" if count == 1 else "calls"


def build_coursewise_report(analyses: list[dict], *, report_date: str) -> str:
    """One report per course: totals, then each failure reason with its calls."""
    grouped: dict[str, list[dict]] = {}
    for item in analyses:
        name = item.get("course_name") or UNKNOWN_COURSE
        grouped.setdefault(name, []).append(item)

    def sort_key(name: str) -> tuple:
        return (name == UNKNOWN_COURSE, -len(grouped[name]), name.lower())

    day_counts = Counter(
        canonical_failure_reason(item.get("failure_reason"))
        for item in analyses
        if item.get("booking_status") == "Booking Not Completed"
    )
    lines = [
        "COURSE-WISE BOOKING ANALYSIS",
        "",
        f"Date: {report_date}",
        "",
        "FAILURE REASONS",
        "",
    ]
    for reason in FAILURE_REASONS:
        lines.append(f"{reason}: {day_counts.get(reason, 0)}")
    lines.append("")
    for course_name in sorted(grouped, key=sort_key):
        calls = grouped[course_name]
        successful = sum(1 for item in calls if item.get("booking_status") == "Booking Successful")
        unclear = sum(1 for item in calls if item.get("booking_status") == "Unclear")
        not_completed = [
            item for item in calls if item.get("booking_status") == "Booking Not Completed"
        ]
        by_reason: dict[str, list[dict]] = {}
        for item in not_completed:
            reason = canonical_failure_reason(item.get("failure_reason"))
            by_reason.setdefault(reason, []).append(item)
        ranked = [reason for reason in FAILURE_REASONS if by_reason.get(reason)]
        conversion = (100.0 * successful / len(calls)) if calls else 0.0
        lines.extend(
            [
                f"Course: {course_name}",
                "",
                f"Total Calls: {len(calls)}",
                f"Successful Bookings: {successful}",
                f"Booking Not Completed: {len(not_completed)}",
                f"Unclear Calls: {unclear}",
                f"Conversion: {conversion:.1f}%",
                "",
                "Why bookings were not completed:",
                "",
            ]
        )
        if not ranked:
            lines.append("None")
            lines.append("")
        for index, reason in enumerate(ranked, start=1):
            group = sorted(by_reason[reason], key=lambda item: str(item.get("created_at") or ""))
            lines.append(f"{index}. {reason} – {len(group)}")
            for item in group:
                happened = item.get("what_happened") or "Not stated"
                why = item.get("why_not_completed") or "Not stated"
                lines.append(f"   - Call ID: {item.get('call_id')}")
                lines.append(f"     What happened: {happened}")
                lines.append(f"     Why not completed: {why}")
            lines.append("")
        repeated = [reason for reason in ranked if len(by_reason[reason]) >= 2]
        lines.append("Repeated Issues:")
        if not repeated:
            lines.append("- None")
        else:
            for reason in repeated:
                count = len(by_reason[reason])
                lines.append(f"- {reason} – {count} {_call_word(count)}")
        lines.append("")
    return "\n".join(lines)
