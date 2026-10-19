"""Parse only fully specified dates; never apply a machine locale or assumed timezone."""

import re
from datetime import UTC, datetime, timedelta, timezone

MONTHS = {
    name: i
    for i, name in enumerate(
        ("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), 1
    )
}
ZONE = r"(?:Z|(?:UTC|GMT)(?:\s*[+-]\d{1,2}(?::?\d{2})?)?|[+-]\d{2}:?\d{2})"
TIME = r"(?P<hour>\d{1,2})(?::(?P<minute>\d{2}))?(?::(?P<second>\d{2}))?\s*(?P<ampm>AM|PM)?"
TAIL = r"(?:\s+at|\s*,)?[T\s]+" + TIME + r"\s*\(?(?P<zone>" + ZONE + r")(?![\w:+-])\)?"
ISO = re.compile(
    r"(?<!\d)(?P<year>\d{4})(?P<sep>[-/.])(?P<month>\d{1,2})(?P=sep)(?P<day>\d{1,2})" + TAIL,
    re.I,
)
MONTH_NAME = r"January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec"
ENGLISH = re.compile(
    r"(?P<month_name>" + MONTH_NAME + r")\s+(?P<day>\d{1,2})(?:st|nd|rd|th)?[,]?\s+(?P<year>\d{4})" + TAIL,
    re.I,
)
DAY_FIRST_ENGLISH = re.compile(
    r"(?<!\d)(?P<day>\d{1,2})(?:st|nd|rd|th)?\s+(?P<month_name>"
    + MONTH_NAME
    + r")[,]?\s+(?P<year>\d{4})"
    + TAIL,
    re.I,
)
NUMERIC_DATE = r"(?<![\d/.-])(?P<first>\d{1,2})(?P<sep>[/.-])(?P<last>\d{1,2})(?P=sep)(?P<year>\d{4})(?!\d)"
NUMERIC = re.compile(NUMERIC_DATE + TAIL, re.I)

TIME_LABELS = {
    "starts_at": r"starts?|opens?|begins?|開始",
    "deadline_at": r"ends?|ending|deadline|closes?|until|截止|結束|结束",
    "announcement_at": r"winners?\s+(?:will\s+be\s+)?(?:announced|announcement|drawn|picked|selected)|announcement|公布",
}


def labelled_times(text: str) -> dict[str, list[tuple[str, str]]]:
    result = {}
    next_label = r"(?<![A-Za-z])(?:" + "|".join(TIME_LABELS.values()) + r")(?![A-Za-z])"
    for key, label in TIME_LABELS.items():
        matches = re.finditer(
            r"(?<![A-Za-z])(?:"
            + label
            + r")(?![A-Za-z])(?:\s+(?:on|at|by))?\s*[:：]?\s*([^\n]+?)(?="
            + next_label
            + r"|\n|$)",
            text,
            re.I,
        )
        result[key] = [(m[0], m[1].strip(" \t⋆˙⟡★☆✦─")) for m in matches]
    return result


def date_orders(text: str) -> set[str]:
    return {
        order
        for order, pattern in [
            ("mdy", r"\bMM\s*[/.-]\s*DD\s*[/.-]\s*YYYY\b"),
            ("dmy", r"\bDD\s*[/.-]\s*MM\s*[/.-]\s*YYYY\b"),
        ]
        if re.search(pattern, text, re.I)
    }


def unresolved_time_reason(text: str, context: str = "") -> str:
    match = re.search(NUMERIC_DATE, text)
    if match and not (date_orders(text) or date_orders(context)):
        a, b = int(match["first"]), int(match["last"])
        if 1 <= a <= 12 and 1 <= b <= 12 and a != b:
            return "MM/DD or DD/MM unclear; UTC unavailable"
    missing = []
    if not re.search(r"\b\d{4}\b", text):
        missing.append("year")
    if not re.search(r"\d{1,2}:\d{2}|\d{1,2}\s*(?:AM|PM)\b", text, re.I):
        missing.append("time")
    if not re.search(r"\b(?:UTC|GMT)\b|\dZ\b|[+-]\d{2}:?\d{2}\b", text, re.I):
        missing.append("timezone")
    return (
        ("/".join(missing) + " missing; UTC unavailable")
        if missing
        else "date/time unresolved; UTC unavailable"
    )


def numeric_pairs(values: dict, text: str) -> set[tuple[int, int]]:
    a, b = int(values["first"]), int(values["last"])
    hints = date_orders(text)
    if len(hints) > 1:
        return set()
    return {(a, b)} if hints == {"mdy"} else {(b, a)} if hints == {"dmy"} else {(a, b), (b, a)}


def explicit_times(text: str, context: str = "") -> list[tuple[str, datetime]]:
    results = []
    for pattern in (ISO, ENGLISH, DAY_FIRST_ENGLISH, NUMERIC):
        for match in pattern.finditer(text):
            values = match.groupdict()
            try:
                zone = values["zone"].upper().replace(" ", "").removeprefix("UTC").removeprefix("GMT")
                offset = timedelta()
                if zone not in ("", "Z"):
                    sign = -1 if zone[0] == "-" else 1
                    digits = zone[1:].replace(":", "")
                    hours, minutes = (
                        (int(digits), 0) if len(digits) <= 2 else (int(digits[:-2]), int(digits[-2:]))
                    )
                    if hours > 23 or minutes > 59:
                        continue
                    offset = sign * timedelta(hours=hours, minutes=minutes)
                hour = int(values["hour"])
                if values["ampm"]:
                    if not 1 <= hour <= 12:
                        continue
                    hour = hour % 12 + (12 if values["ampm"].upper() == "PM" else 0)
                elif values["minute"] is None:
                    continue  # A bare hour is only accepted with AM/PM.
                month = (
                    MONTHS[values["month_name"][:3].lower()]
                    if values.get("month_name")
                    else int(values.get("month", 1))
                )
                pairs = (
                    numeric_pairs(values, text if date_orders(text) else context)
                    if "first" in values
                    else {(month, int(values["day"]))}
                )
                dates = set()
                for month, day in pairs:
                    try:
                        dates.add(
                            datetime(
                                int(values["year"]),
                                month,
                                day,
                                hour,
                                int(values["minute"] or 0),
                                int(values["second"] or 0),
                                tzinfo=timezone(offset),
                            ).astimezone(UTC)
                        )
                    except ValueError:
                        continue
                if len(dates) == 1:
                    results.append((match[0], dates.pop()))
            except (ValueError, KeyError):
                continue
    return results
