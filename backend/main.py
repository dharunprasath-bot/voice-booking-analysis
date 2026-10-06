"""Analyze AI voice booking conversations.

    python3 backend/main.py --date 2026-09-30
    python3 backend/main.py --course 17044862984 --date 2026-09-30
    python3 backend/main.py --fetch-courses --date 2026-09-30
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv

from analyzer import (
    analyze_conversation,
    analyze_course_conversation,
    course_evidence,
    summarize_results,
)
from courses import FETCH_COURSES
from database import (
    connect,
    fetch_conversations,
    fetch_coursewise_conversations,
    fetch_golf_course_names,
    fetch_ten_course_counts,
)
from report import build_coursewise_report, build_report
from welcome_course import assign_courses


def _parse_date(value: str) -> date:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except ValueError as error:
        raise argparse.ArgumentTypeError("Use YYYY-MM-DD.") from error


def _report_date(on_date: date | None, conversations: list[dict]) -> str:
    if on_date is not None:
        return on_date.isoformat()
    dates = []
    for conversation in conversations:
        created_date = conversation.get("created_date") or ""
        if len(created_date) >= 10:
            dates.append(created_date[:10])
    if not dates:
        return "n/a"
    first, last = min(dates), max(dates)
    if first == last:
        return first
    return f"{first} to {last}"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Analyze AI voice booking conversations course by course."
    )
    parser.add_argument(
        "--course",
        default=None,
        help=(
            "Limit the older single-course report to this voice line "
            "(vapi_golf_course_phone_no). Omit this to group every call by welcome name."
        ),
    )
    parser.add_argument(
        "--course-name",
        default=os.environ.get("COURSE_NAME") or "Highland Creek",
        help="Name printed on the single-course report. Defaults to COURSE_NAME.",
    )
    parser.add_argument(
        "--fetch-courses",
        action="store_true",
        help="Count conversations for the 10 fetch courses. Does not run AI analysis.",
    )
    parser.add_argument(
        "--date",
        type=_parse_date,
        default=None,
        help="Calendar date taken from created_at, YYYY-MM-DD.",
    )
    parser.add_argument(
        "--phone",
        default=None,
        help="Customer phone number (customer_phone_no).",
    )
    parser.add_argument(
        "--timezone",
        default=os.environ.get("REPORT_TIMEZONE", "America/New_York"),
        help="Timezone used when --date is set.",
    )
    return parser.parse_args()


def _save_report(report: str, course_name: str, report_date: str) -> Path:
    slug = re.sub(r"[^a-z0-9]+", "-", course_name.lower()).strip("-") or "course"
    date_slug = re.sub(
        r"[^a-z0-9-]+",
        "-",
        report_date.lower().replace(" to ", "-to-"),
    ).strip("-") or "undated"
    folder = Path(__file__).resolve().parent.parent / "reports"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{slug}-{date_slug}.txt"
    text = report if report.endswith("\n") else report + "\n"
    path.write_text(text, encoding="utf-8")
    return path


def _apply_booking_record(conversation: dict, analysis: dict) -> dict:
    """Count a booking only when public.bookings.status is booked."""
    status = conversation.get("booking_record_status")
    players = conversation.get("total_players") or 0
    analysis["booking_record_status"] = status
    analysis["rounds"] = players if status == "booked" else 0
    if status == "booked":
        analysis["booking_successful"] = True
        analysis["category"] = "Booking Successful"
        analysis["drop_off_stage"] = "Completed"
        analysis["failure_reason"] = ""
    elif status == "cancelled" and analysis["booking_successful"]:
        analysis["booking_successful"] = False
        analysis["category"] = "Other"
        analysis["failure_reason"] = "The booking was cancelled."
        analysis["confirmed_failure_reason"] = "The booking record status is cancelled."
        analysis["why_booking_did_not_happen"] = "The booking was cancelled."
        analysis["final_root_cause"] = "The booking was cancelled."
        analysis["possible_cause"] = ""
    return analysis


def _display_time(value, timezone_name: str) -> str:
    if not value:
        return ""
    if isinstance(value, datetime):
        moment = value
    else:
        text = str(value).replace("Z", "+00:00")
        moment = datetime.fromisoformat(text)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=ZoneInfo("UTC"))
    return moment.astimezone(ZoneInfo(timezone_name)).strftime("%Y-%m-%d %H:%M")


def _apply_course_booking(conversation: dict, analysis: dict) -> dict:
    """A booked row is successful. A cancelled row is not a completed booking."""
    status = conversation.get("booking_record_status")
    analysis["course_name"] = conversation.get("course_name") or analysis.get("course_name")
    if status == "booked":
        analysis["booking_status"] = "Booking Successful"
        analysis["failure_reason"] = ""
        analysis["drop_off_stage"] = "Completed"
        analysis["why_not_completed"] = ""
        if not analysis.get("what_happened"):
            analysis["what_happened"] = "The booking record status is booked."
    elif status == "cancelled" and analysis.get("booking_status") == "Booking Successful":
        analysis["booking_status"] = "Booking Not Completed"
        analysis["failure_reason"] = "Other"
        analysis["why_not_completed"] = "The booking was cancelled."
        analysis["what_happened"] = (
            analysis.get("what_happened") or "The booking record status is cancelled."
        )
    return analysis


def _failed_analysis(conversation: dict) -> dict:
    return {
        "conversation_id": conversation.get("id"),
        "call_id": conversation.get("call_id"),
        "course_name": conversation.get("course_name"),
        "created_at": conversation.get("created_at"),
        "booking_status": "Unclear",
        "failure_reason": "Unclear",
        "drop_off_stage": "Unclear",
        "what_happened": "The analysis did not finish.",
        "why_not_completed": "The analysis did not finish.",
    }


def _analyze_failure(conversation: dict) -> dict:
    """Read each transcript once. Transport retries stay inside the API call."""
    try:
        return analyze_course_conversation(conversation)
    except Exception as error:
        print(
            f"Analysis failed for {conversation['id']}: {error}",
            file=sys.stderr,
        )
        return _failed_analysis(conversation)


def _copy_analysis(analysis: dict, conversation: dict) -> dict:
    copied = dict(analysis)
    copied["conversation_id"] = conversation.get("id")
    copied["call_id"] = conversation.get("call_id")
    copied["course_name"] = conversation.get("course_name")
    copied["created_at"] = conversation.get("created_at")
    return _apply_course_booking(conversation, copied)


def _run_coursewise(args: argparse.Namespace) -> int:
    if args.date is None:
        print("Pass --date YYYY-MM-DD.", file=sys.stderr)
        return 1
    print("Connecting to the production database (read only)...", file=sys.stderr)
    with connect() as connection:
        conversations = fetch_coursewise_conversations(
            connection,
            on_date=args.date,
            customer_phone=args.phone,
            timezone_name=args.timezone,
        )
        official_names = fetch_golf_course_names(connection)
    print(
        f"Fetched {len(conversations)} conversation(s) for {args.date.isoformat()}.",
        file=sys.stderr,
    )
    if not conversations:
        print("No conversations matched the date.", file=sys.stderr)
        return 0

    assign_courses(conversations, official_names)
    analyses = [None] * len(conversations)
    pending = []
    for index, conversation in enumerate(conversations):
        if conversation.get("booking_record_status") == "booked":
            analyses[index] = _apply_course_booking(
                conversation,
                {
                    "conversation_id": conversation.get("id"),
                    "call_id": conversation.get("call_id"),
                    "course_name": conversation.get("course_name"),
                    "created_at": conversation.get("created_at"),
                    "booking_status": "Booking Successful",
                    "failure_reason": "",
                    "drop_off_stage": "Completed",
                    "what_happened": "",
                    "why_not_completed": "",
                },
            )
            analyses[index]["created_display"] = _display_time(
                conversation.get("created_at"),
                args.timezone,
            )
        else:
            pending.append(index)

    grouped: dict[str, list[int]] = {}
    unique_keys: list[str] = []
    for index in pending:
        evidence = course_evidence(conversations[index])
        key = hashlib.sha256(evidence.encode("utf-8")).hexdigest()
        bucket = grouped.get(key)
        if bucket is None:
            grouped[key] = [index]
            unique_keys.append(key)
        else:
            bucket.append(index)

    print(
        f"Analyzing {len(pending)} conversation(s) that need a failure reason "
        f"({len(unique_keys)} unique transcripts). "
        f"{len(conversations) - len(pending)} already booked.",
        file=sys.stderr,
    )
    completed = 0
    workers = min(32, max(1, len(unique_keys)))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(_analyze_failure, conversations[grouped[key][0]]): key
            for key in unique_keys
        }
        for future in as_completed(futures):
            key = futures[future]
            analysis = future.result()
            for index in grouped[key]:
                conversation = conversations[index]
                copied = _copy_analysis(analysis, conversation)
                copied["created_display"] = _display_time(
                    conversation.get("created_at"),
                    args.timezone,
                )
                analyses[index] = copied
                completed += 1
            sample = conversations[grouped[key][0]]
            print(
                f"Analyzing {completed}/{len(pending)}: "
                f"conversation {sample['id']} ({sample['course_name']})",
                file=sys.stderr,
            )

    report_date = args.date.isoformat()
    report = build_coursewise_report(analyses, report_date=report_date)
    print(report)
    saved = _save_report(report, "courses", report_date)
    print(f"Saved report: {saved}", file=sys.stderr)
    return 0


def _ten_course_report(result: dict) -> str:
    lines = [
        "TEN-COURSE CONVERSATION FETCH",
        "",
        f"Date (America/New_York): {result['report_date']}",
        "",
    ]
    total = 0
    not_fetched = set(result["not_fetched"])
    for course in FETCH_COURSES:
        course_id = course["id"]
        if course_id in not_fetched:
            count_text = "not fetched"
        else:
            count = result["counts"].get(course_id, 0)
            total += count
            count_text = str(count)
        lines.append(f"{course_id:>3}  {course['name']:<40}  {count_text}")
    lines.extend(["", f"Total conversations: {total}", ""])
    if not_fetched:
        lines.append(
            "voice_numbers could not be read. Only Highland Creek was counted by its voice line."
        )
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    load_dotenv()
    args = parse_args()
    if args.fetch_courses:
        if args.date is None:
            print("Pass --date YYYY-MM-DD for the 10-course fetch.", file=sys.stderr)
            return 1
        print("Connecting to the production database (read only)...", file=sys.stderr)
        with connect() as connection:
            result = fetch_ten_course_counts(connection, list(FETCH_COURSES), args.date)
        report = _ten_course_report(result)
        print(report)
        saved = _save_report(report, "ten-courses", result["report_date"])
        print(f"Saved report: {saved}", file=sys.stderr)
        return 0

    if not args.course:
        return _run_coursewise(args)

    print("Connecting to the production database (read only)...", file=sys.stderr)
    with connect() as connection:
        conversations = fetch_conversations(
            connection,
            course_phone=args.course,
            customer_phone=args.phone,
            on_date=args.date,
            timezone_name=args.timezone,
        )

    print(
        f"Fetched {len(conversations)} conversation(s) for {args.course_name}.",
        file=sys.stderr,
    )
    if not conversations:
        print("No conversations matched the filters.", file=sys.stderr)
        return 0

    analyses = []
    for index, conversation in enumerate(conversations, start=1):
        print(
            f"Analyzing {index}/{len(conversations)}: conversation {conversation['id']}",
            file=sys.stderr,
        )
        analyses.append(
            _apply_booking_record(conversation, analyze_conversation(conversation))
        )

    print("Writing the report summary...", file=sys.stderr)
    summary = summarize_results(analyses, args.course_name)
    report_date = _report_date(args.date, conversations)
    report = build_report(
        analyses,
        course_name=args.course_name,
        report_date=report_date,
        ai_summary=summary,
    )
    print(report)
    saved = _save_report(report, args.course_name, report_date)
    print(f"Saved report: {saved}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"Error: {error}", file=sys.stderr)
        raise SystemExit(1)
