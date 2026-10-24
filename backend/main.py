"""Analyze AI voice booking conversations.

    python3 backend/main.py --date 2026-09-30
    python3 backend/main.py --course 17044862984 --date 2026-09-30
    python3 backend/main.py --fetch-courses --date 2026-09-30
    python3 backend/main.py --history
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta
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
    DatabaseConnectionError,
    call_with_connection,
    connect,
    fetch_conversations,
    fetch_coursewise_conversations,
    fetch_daily_conversation_counts,
    fetch_first_report_day,
    fetch_golf_course_names,
    fetch_mco_history,
    fetch_organization_names,
    fetch_sco_history,
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
            "(vapi_golf_course_phone_no). Omit this to group every call by its "
            "golf course id or organization id."
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
    parser.add_argument(
        "--history",
        action="store_true",
        help=(
            "Write one course report for every day from the first recorded call "
            "through yesterday. A saved day whose call total already matches "
            "the database is left unchanged."
        ),
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
    analysis["course_kind"] = conversation.get("course_kind") or analysis.get("course_kind") or ""
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


def _announce_database_retry(attempt: int, attempts: int, error: BaseException, delay_seconds: float) -> None:
    print(
        f"Database connection failed (attempt {attempt} of {attempts}): {error}. "
        f"Retrying in {int(delay_seconds)} seconds.",
        file=sys.stderr,
    )


def _run_coursewise(args: argparse.Namespace, *, echo: bool = True) -> int:
    if args.date is None:
        print("Pass --date YYYY-MM-DD.", file=sys.stderr)
        return 1
    print("Connecting to the production database (read only)...", file=sys.stderr)

    def load_day(connection):
        conversations = fetch_coursewise_conversations(
            connection,
            on_date=args.date,
            customer_phone=args.phone,
            timezone_name=args.timezone,
        )
        golf_names = fetch_golf_course_names(connection)
        organization_names = fetch_organization_names(connection)
        return conversations, golf_names, organization_names

    conversations, golf_names, organization_names = call_with_connection(
        load_day,
        description=f"Loading {args.date.isoformat()}",
        on_retry=_announce_database_retry,
    )
    official_names = sorted(
        set(golf_names + organization_names),
        key=lambda name: (-len(name), name),
    )
    print(
        f"Fetched {len(conversations)} conversation(s) for {args.date.isoformat()}.",
        file=sys.stderr,
    )
    if not conversations:
        print("No conversations matched the date.", file=sys.stderr)
        return 0

    assign_courses(conversations, official_names, golf_names, organization_names)
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
    if echo:
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


def _reports_dir() -> Path:
    return Path(__file__).resolve().parent.parent / "reports"


def _course_report_path(on_date: date) -> Path:
    return _reports_dir() / f"courses-{on_date.isoformat()}.txt"


def _saved_call_total(path: Path) -> int | None:
    if not path.is_file():
        return None
    total = 0
    found = False
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("Total Calls:"):
            total += int(line.split(":", 1)[1].strip())
            found = True
    return total if found else None


def _yesterday(timezone_name: str) -> date:
    return datetime.now(ZoneInfo(timezone_name)).date() - timedelta(days=1)


def _history_validation_text(
    *,
    timezone_name: str,
    first_day: date | None,
    through: date,
    sco_rows: list[dict],
    mco_rows: list[dict],
    day_rows: list[dict],
) -> str:
    overall = sum(int(row["call_count"]) for row in sco_rows) + sum(int(row["call_count"]) for row in mco_rows)
    # Day totals count every conversation, including V1. Course totals do not.
    day_total = sum(int(row["database_count"]) for row in day_rows)
    missing = [
        row["day"] for row in day_rows
        if row["status"] != "pending"
        and int(row["database_count"]) > 0
        and (row["report_count"] is None or int(row["report_count"]) < int(row["database_count"]))
    ]
    duplicated = [
        row["day"] for row in day_rows
        if row["report_count"] is not None and int(row["report_count"]) > int(row["database_count"])
    ]
    lines = [
        "HISTORICAL COURSE REPORTS",
        "",
        f"Timezone: {timezone_name}",
        f"First day: {first_day.isoformat() if first_day else 'none'}",
        f"Through: {through.isoformat()}",
        f"Conversation total: {day_total}",
        f"SCO and MCO calls: {overall}",
        "",
        "SCO COURSES",
        "",
    ]
    if not sco_rows:
        lines.append("None")
        lines.append("")
    for row in sco_rows:
        lines.extend(_entity_lines(
            "Golf Course ID",
            row["golf_course_id"],
            row["name"],
            row["first_day"],
            through,
            row["call_count"],
        ))
    lines.extend(["MCO ORGANIZATIONS", ""])
    if not mco_rows:
        lines.append("None")
        lines.append("")
    for row in mco_rows:
        lines.extend(_entity_lines(
            "Organization ID",
            row["organization_id"],
            row["name"],
            row["first_day"],
            through,
            row["call_count"],
        ))
    lines.extend(["DAYS", ""])
    if not day_rows:
        lines.append("None")
    for row in day_rows:
        report_count = "none" if row["report_count"] is None else str(row["report_count"])
        lines.append(
            f"{row['day'].isoformat()}  database {row['database_count']}  "
            f"report {report_count}  {row['status']}"
        )
    lines.extend(["", f"Missing days: {len(missing)}", f"Duplicated days: {len(duplicated)}"])
    if missing:
        lines.append("Missing: " + ", ".join(day.isoformat() for day in missing))
    if duplicated:
        lines.append("Duplicated: " + ", ".join(day.isoformat() for day in duplicated))
    lines.append("")
    return "\n".join(lines)


def _entity_lines(label: str, entity_id, name: str, first_day: date, through: date, call_count) -> list[str]:
    display = name or "Unknown Course"
    return [
        f"{label}: {entity_id}",
        f"Name: {display}",
        f"First call: {first_day.isoformat()}",
        f"Through: {through.isoformat()}",
        f"Calls: {call_count}",
        "",
    ]


def _write_history_validation(
    *,
    timezone_name: str,
    first_day: date | None,
    through: date,
    sco_rows: list[dict],
    mco_rows: list[dict],
    day_rows: list[dict],
) -> Path:
    folder = _reports_dir()
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "history-validation.txt"
    text = _history_validation_text(
        timezone_name=timezone_name,
        first_day=first_day,
        through=through,
        sco_rows=sco_rows,
        mco_rows=mco_rows,
        day_rows=day_rows,
    )
    path.write_text(text if text.endswith("\n") else text + "\n", encoding="utf-8")
    return path


def _run_history(args: argparse.Namespace) -> int:
    timezone_name = args.timezone
    through = _yesterday(timezone_name)
    print(
        f"Historical reports through {through.isoformat()} ({timezone_name}).",
        file=sys.stderr,
    )

    def load_history(connection):
        first_day = fetch_first_report_day(
            connection,
            timezone_name=timezone_name,
            through=through,
        )
        sco_rows = fetch_sco_history(connection, timezone_name=timezone_name, through=through)
        mco_rows = fetch_mco_history(connection, timezone_name=timezone_name, through=through)
        daily = {}
        if first_day is not None and first_day <= through:
            daily = fetch_daily_conversation_counts(
                connection,
                timezone_name=timezone_name,
                first_day=first_day,
                through=through,
            )
        return first_day, sco_rows, mco_rows, daily

    try:
        first_day, sco_rows, mco_rows, daily = call_with_connection(
            load_history,
            description="Preparing historical reports",
            on_retry=_announce_database_retry,
        )
    except DatabaseConnectionError as error:
        print(
            f"Historical reports stopped before any date was processed. {error}",
            file=sys.stderr,
        )
        print("Existing reports were not changed.", file=sys.stderr)
        return 1
    day_rows: list[dict] = []
    if first_day is not None and first_day <= through:
        day = first_day
        while day <= through:
            day_rows.append({
                "day": day,
                "database_count": int(daily.get(day, 0)),
                "report_count": _saved_call_total(_course_report_path(day)),
                "status": "pending",
            })
            day += timedelta(days=1)
    saved = _write_history_validation(
        timezone_name=timezone_name,
        first_day=first_day,
        through=through,
        sco_rows=sco_rows,
        mco_rows=mco_rows,
        day_rows=day_rows,
    )
    print(f"Saved validation: {saved}", file=sys.stderr)
    if not day_rows:
        print(f"No calls on or before {through.isoformat()}.", file=sys.stderr)
        return 0

    for row in day_rows:
        day = row["day"]
        database_count = int(row["database_count"])
        path = _course_report_path(day)
        report_count = row["report_count"]
        if database_count == 0:
            status = "empty" if report_count in (None, 0) else "mismatched"
        elif report_count == database_count:
            status = "skipped"
            print(f"{day.isoformat()} skipped {database_count}", file=sys.stderr)
        else:
            print(
                f"{day.isoformat()} generating {database_count} conversation(s).",
                file=sys.stderr,
            )
            day_args = argparse.Namespace(**vars(args))
            day_args.date = day
            day_args.course = None
            day_args.history = False
            day_args.fetch_courses = False
            try:
                _run_coursewise(day_args, echo=False)
            except DatabaseConnectionError as error:
                print(
                    f"{day.isoformat()} stopped. This date was not saved because the "
                    f"database connection failed. {error}",
                    file=sys.stderr,
                )
                print(
                    "Reports that already match the database were kept. "
                    "Run the same --history command to resume this date.",
                    file=sys.stderr,
                )
                return 1
            report_count = _saved_call_total(path)
            status = "generated" if report_count == database_count else "mismatched"
            print(
                f"{day.isoformat()} {status} database {database_count} report {report_count}",
                file=sys.stderr,
            )
        row["report_count"] = report_count
        row["status"] = status
        saved = _write_history_validation(
            timezone_name=timezone_name,
            first_day=first_day,
            through=through,
            sco_rows=sco_rows,
            mco_rows=mco_rows,
            day_rows=day_rows,
        )

    print(f"Saved validation: {saved}", file=sys.stderr)
    mismatched = [row for row in day_rows if row["status"] == "mismatched"]
    return 1 if mismatched else 0


def main() -> int:
    load_dotenv()
    args = parse_args()
    if args.history:
        return _run_history(args)
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
