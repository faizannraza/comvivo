#!/usr/bin/env python3
"""Traceability checker and generator for the implementation plan in `docs/plan/`.

Role
----
`docs/plan/14-milestones.md` is normative for task numbering and order
(`01` §14 A20). Its §2 milestone tables define the canonical task IDs
(`M<n>-T<k>`), and each row's *Src* cell says which subsystem-spec tasks
(`02`–`13` §10) that canonical task carries. Two artefacts are *derived* from
those tables and must never drift from them:

1. `14` §4 — the traceability matrix (`<doc>:M<n>-T<k>` → canonical ID).
2. `docs/plan/STATUS.md` → `## Milestones` — the per-milestone checklists and
   their `Status: … · Tasks: X/Y · Gate: …` counters.

This script is the single tool that validates and regenerates both, so a plan
edit can never silently lose a spec task, invent a dependency on work that has
not happened yet, or leave STATUS out of step with the plan. It is the CI arm
of `14` §4.4 and of task `M0-T23`.

What `--check` enforces
-----------------------
* Canonical IDs are well formed, live in the milestone section they claim, and
  are unique inside that milestone. Numbering gaps are warnings, not errors,
  because `14` §0.5 rule 3 forbids renumbering and rule 4 keeps tombstone rows.
* Every `Deps` entry is `—`, a canonical ID that exists, or a milestone-level
  reference. A dependency on a later milestone, or on a later row of the same
  milestone, is an error: the table order *is* the execution order (§0.1).
* Every `Src` reference resolves: the doc file exists and the spec-local task
  ID really appears in that doc's §10. Every spec task defined in `02`–`13`
  §10 is claimed by exactly one or more `14` rows — an unclaimed spec task is
  an error ("fails on unmapped spec tasks or unknown references", `M0-T23` AC).
* `STATUS.md` has one checklist line per canonical task, with a matching
  title, no unknown tasks, and truthful `Tasks: X/Y` counters.
* The `‖` column is `‖` or `—`, and no `‖` row touches the serial-only areas
  of `14` §0.4 / `CLAUDE.md` §1.5 (`packages/core/src/{policy,ifc,
  constitution,declassify,governance,consent}`, or a database-migration path:
  a `migrations/` directory, or `packages/storage/src/{migrate,migrations}/`).
  Those are reported as `SERIAL-VIOLATION`.

Safety
------
No network access. The only files this script may write are
`docs/plan/STATUS.md` (with `--regen-status`) and `docs/plan/14-milestones.md`
(with `--regen-matrix`, and only between the `<!-- BEGIN:TRACE-MATRIX -->` /
`<!-- END:TRACE-MATRIX -->` markers). Writes are atomic (temp file + replace)
and `--dry-run` turns any write into a printed diff.
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import sys
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Final, Iterator, Literal, Sequence

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

SPEC_DOCS: Final[tuple[str, ...]] = (
    "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13",
)

MILESTONES_DOC: Final[str] = "14-milestones.md"
STATUS_DOC: Final[str] = "STATUS.md"

#: Canonical task IDs, per `14` §0.1.
CANONICAL_ID_RE: Final[re.Pattern[str]] = re.compile(r"^M(\d{1,2})-T(\d{1,3})$")

#: Spec-local IDs are looser: `02:M3-T-S1`, `09:M3-T901`, `07:M10-T-C3`.
SPEC_LOCAL_ID_RE: Final[re.Pattern[str]] = re.compile(
    r"^M(\d{1,2})-T(-?[A-Z]{0,2}\d{1,3})$"
)

#: A doc-prefixed spec reference as it appears in a `Src` cell.
SRC_REF_RE: Final[re.Pattern[str]] = re.compile(
    r"\b(\d{2}):(M\d{1,2}-T-?[A-Z]{0,2}\d{1,3})\b"
)

#: The literal that marks spine work no spec §10 owns (`14` §0.1, §4.1).
SRC_NEW_LITERAL: Final[str] = "14 (new)"

MILESTONE_HEADING_RE: Final[re.Pattern[str]] = re.compile(r"^### M(\d{1,2}) — (.+?)\s*$")
STATUS_LINE_RE: Final[re.Pattern[str]] = re.compile(
    r"^Status:\s*(?P<state>.*?)\s*·\s*Tasks:\s*(?P<done>\d+)/(?P<total>\d+)\s*·\s*Gate:\s*(?P<gate>.*?)\s*$"
)
CHECKLIST_RE: Final[re.Pattern[str]] = re.compile(
    r"^- \[(?P<mark>[ xX])\]\s+(?P<id>M\d{1,2}-T\d{1,3})(?:\s+(?P<rest>.*))?$"
)

TASK_TABLE_HEADER: Final[tuple[str, ...]] = (
    "ID", "Task", "Src", "Read", "Files", "AC", "Deps", "‖",
)

#: `packages/core/src/<dir>` areas that must stay serial (`14` §0.4).
SERIAL_CORE_DIRS: Final[tuple[str, ...]] = (
    "policy", "ifc", "constitution", "declassify", "governance", "consent",
)

MATRIX_BEGIN: Final[str] = "<!-- BEGIN:TRACE-MATRIX -->"
MATRIX_END: Final[str] = "<!-- END:TRACE-MATRIX -->"

#: Titles of the `02`–`13` docs, for the generated matrix headings.
DOC_TITLES: Final[dict[str, str]] = {
    "02": "Domain model & storage",
    "03": "Group intelligence",
    "04": "Memory system",
    "05": "Agent runtime",
    "06": "Channels",
    "07": "Coordination features",
    "08": "Security & privacy",
    "09": "Dashboard, API & CLI",
    "10": "Extensibility",
    "11": "Quality, evals & observability",
    "12": "Packaging, release & ops",
    "13": "Docs, launch & community",
}

Level = Literal["ERROR", "WARN", "INFO"]
LEVEL_ORDER: Final[dict[str, int]] = {"ERROR": 0, "WARN": 1, "INFO": 2}


# --------------------------------------------------------------------------- #
# Findings
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, order=True)
class Finding:
    """One problem (or note) about the plan, sortable for deterministic output."""

    sort_key: tuple[int, str, str] = field(init=False, repr=False)
    level: Level
    code: str
    where: str
    message: str

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "sort_key", (LEVEL_ORDER[self.level], self.code, self.where)
        )

    def render(self) -> str:
        return f"{self.level:<5} {self.code:<24} {self.where:<28} {self.message}"

    def to_dict(self) -> dict[str, str]:
        return {
            "level": self.level,
            "code": self.code,
            "where": self.where,
            "message": self.message,
        }


# --------------------------------------------------------------------------- #
# Markdown table parsing (explicit state machine, line by line)
# --------------------------------------------------------------------------- #


def split_table_row(line: str) -> list[str]:
    """Split one markdown table row into trimmed cells.

    Handles the three things a regex over the whole file gets wrong:

    * escaped pipes (``\\|``) inside a cell become a literal ``|``;
    * pipes inside an inline code span (any backtick run length) are literal;
    * leading/trailing row pipes are optional.

    >>> split_table_row(r"| a\\|b | `x|y` | c |")
    ['a|b', '`x|y`', 'c']
    """
    body = line.strip()
    if body.startswith("|"):
        body = body[1:]
    if body.endswith("|") and not body.endswith("\\|"):
        body = body[:-1]

    cells: list[str] = []
    current: list[str] = []
    open_run = 0  # length of the backtick run that opened the current code span
    i = 0
    n = len(body)
    while i < n:
        ch = body[i]
        if ch == "\\" and i + 1 < n and body[i + 1] == "|":
            current.append("|")
            i += 2
            continue
        if ch == "`":
            j = i
            while j < n and body[j] == "`":
                j += 1
            run = j - i
            if open_run == 0:
                open_run = run
            elif open_run == run:
                open_run = 0
            current.append(body[i:j])
            i = j
            continue
        if ch == "|" and open_run == 0:
            cells.append("".join(current))
            current = []
            i += 1
            continue
        current.append(ch)
        i += 1
    cells.append("".join(current))
    return [c.strip() for c in cells]


def is_delimiter_row(cells: Sequence[str]) -> bool:
    """True when every cell looks like `---`, `:--`, `--:` or `:-:`."""
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", c) for c in cells)


@dataclass(frozen=True)
class TableRow:
    lineno: int
    cells: tuple[str, ...]


@dataclass(frozen=True)
class Table:
    header: tuple[str, ...]
    rows: tuple[TableRow, ...]
    start_lineno: int


def iter_tables(lines: Sequence[str], first_lineno: int = 1) -> Iterator[Table]:
    """Yield every markdown table in `lines` using an explicit state machine.

    States: ``out`` → ``saw_header`` (needs a delimiter row next) → ``body``.
    A table ends on the first line that does not start with ``|``.
    """
    state = "out"
    header: tuple[str, ...] = ()
    header_lineno = 0
    rows: list[TableRow] = []

    def flush() -> Iterator[Table]:
        if state == "body" and header:
            yield Table(header=header, rows=tuple(rows), start_lineno=header_lineno)

    for offset, raw in enumerate(lines):
        lineno = first_lineno + offset
        stripped = raw.strip()
        is_row = stripped.startswith("|")

        if state == "out":
            if is_row:
                header = tuple(split_table_row(raw))
                header_lineno = lineno
                state = "saw_header"
            continue

        if state == "saw_header":
            if is_row and is_delimiter_row(split_table_row(raw)):
                rows = []
                state = "body"
            elif is_row:
                # Two consecutive pipe lines without a delimiter: not a table;
                # treat this line as a possible new header instead.
                header = tuple(split_table_row(raw))
                header_lineno = lineno
            else:
                state = "out"
            continue

        # state == "body"
        if is_row:
            cells = split_table_row(raw)
            if not is_delimiter_row(cells):
                rows.append(TableRow(lineno=lineno, cells=tuple(cells)))
            continue
        yield from flush()
        state = "out"
        header = ()
        rows = []

    yield from flush()


def strip_markdown(text: str) -> str:
    """Normalise a cell for comparison: drop `<br/>`, collapse whitespace."""
    out = re.sub(r"<br\s*/?>", " ", text)
    return re.sub(r"\s+", " ", out).strip()


# --------------------------------------------------------------------------- #
# Model
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class SrcRef:
    doc: str
    local_id: str

    def __str__(self) -> str:
        return f"{self.doc}:{self.local_id}"


@dataclass
class Task:
    task_id: str
    milestone: int
    number: int
    title: str
    order: int  # position inside its milestone table (execution order)
    src_raw: str
    src_refs: list[SrcRef]
    src_is_new: bool
    files_raw: str
    deps_raw: str
    parallel_raw: str
    lineno: int
    tombstone: bool

    @property
    def parallel(self) -> bool:
        return self.parallel_raw == "‖"

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.task_id,
            "milestone": self.milestone,
            "number": self.number,
            "title": self.title,
            "order": self.order,
            "line": self.lineno,
            "src": {
                "raw": self.src_raw,
                "refs": [str(r) for r in self.src_refs],
                "is_new": self.src_is_new,
            },
            "files": self.files_raw,
            "deps": {"raw": self.deps_raw, "resolved": sorted(parse_deps(self)[0])},
            "parallel": self.parallel,
            "tombstone": self.tombstone,
        }


@dataclass
class Milestone:
    number: int
    title: str
    lineno: int
    tasks: list[Task] = field(default_factory=list)


@dataclass
class SpecTask:
    doc: str
    local_id: str
    milestone: int
    lineno: int
    expanded_from: str | None = None

    @property
    def ref(self) -> str:
        return f"{self.doc}:{self.local_id}"


@dataclass
class StatusEntry:
    task_id: str
    done: bool
    rest: str
    lineno: int


@dataclass
class StatusMilestone:
    number: int
    title: str
    heading_lineno: int
    status_lineno: int | None = None
    status_state: str = ""
    status_gate: str = ""
    declared_done: int | None = None
    declared_total: int | None = None
    entries: list[StatusEntry] = field(default_factory=list)
    block_start: int | None = None  # 1-based lineno of first checklist line
    block_end: int | None = None  # 1-based lineno of last checklist line


@dataclass
class PlanModel:
    plan_dir: Path
    milestones: list[Milestone]
    tasks: dict[str, Task]
    spec_tasks: dict[str, SpecTask]  # keyed by "doc:local_id"
    status: list[StatusMilestone]
    matrix_pairs: dict[str, list[str]]  # "doc:local_id" -> canonical IDs, from §4
    matrix_counts: dict[str, int]  # per-doc counts declared in §4's summary table
    has_matrix_markers: bool
    findings: list[Finding] = field(default_factory=list)

    @property
    def claims(self) -> dict[str, list[str]]:
        """"doc:local_id" -> canonical task IDs that claim it, in plan order."""
        out: dict[str, list[str]] = {}
        for task in self.ordered_tasks():
            for ref in task.src_refs:
                out.setdefault(str(ref), []).append(task.task_id)
        return out

    def ordered_tasks(self) -> list[Task]:
        return sorted(self.tasks.values(), key=lambda t: (t.milestone, t.number))


# --------------------------------------------------------------------------- #
# Parsing: 14-milestones.md
# --------------------------------------------------------------------------- #


def read_lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").split("\n")


def find_section(lines: Sequence[str], pattern: str, level: int = 2) -> tuple[int, int]:
    """Return the 0-based [start, end) line span of a heading section.

    `pattern` is matched against the whole heading line. The section ends at the
    next heading of the same or a shallower level, or at EOF.
    """
    rx = re.compile(pattern)
    start = -1
    for i, line in enumerate(lines):
        if rx.match(line):
            start = i
            break
    if start < 0:
        return (-1, -1)
    prefixes = tuple("#" * lv + " " for lv in range(1, level + 1))
    for j in range(start + 1, len(lines)):
        if lines[j].startswith(prefixes):
            return (start, j)
    return (start, len(lines))


def extract_title(task_cell: str) -> str:
    """The bold lead-in of a Task cell, minus its trailing period.

    `14` §2 writes every task as ``**Title.** description…``. Titles may
    themselves contain periods (``**SP-9: transformers.js Whisper fallback.**``),
    so the bold run — not the first period — delimits the title.
    """
    cell = strip_markdown(task_cell)
    m = re.match(r"^\*\*(.+?)\*\*", cell)
    if m:
        return m.group(1).strip().rstrip(".").strip()
    # Fallback for rows written without a bold lead-in.
    head = re.split(r"\.\s|\.$", cell, maxsplit=1)[0]
    return head.strip().rstrip(".").strip()


def parse_src_cell(cell: str) -> tuple[list[SrcRef], bool]:
    """Spec references and the `14 (new)` flag from a `Src` cell.

    Doc-prefixed references are extracted positionally, so parenthetical
    annotations (``02:M1-T4 (keyring)``) and commas inside them are harmless.
    """
    refs: list[SrcRef] = []
    seen: set[tuple[str, str]] = set()
    for doc, local in SRC_REF_RE.findall(cell):
        if (doc, local) not in seen:
            seen.add((doc, local))
            refs.append(SrcRef(doc=doc, local_id=local))
    return refs, SRC_NEW_LITERAL in cell


def parse_milestones_doc(
    path: Path, findings: list[Finding]
) -> tuple[list[Milestone], dict[str, Task], dict[str, list[str]], dict[str, int], bool]:
    lines = read_lines(path)
    sec_start, sec_end = find_section(lines, r"^## 2\. Milestones\b")
    if sec_start < 0:
        findings.append(
            Finding("ERROR", "E-NO-SECTION-2", MILESTONES_DOC, "no `## 2. Milestones` heading found")
        )
        return [], {}, {}, {}, False

    milestones: list[Milestone] = []
    tasks: dict[str, Task] = {}
    current: Milestone | None = None
    by_milestone_seen: dict[int, set[int]] = {}

    # Walk §2 line by line so each table is attributed to the heading above it.
    segment = lines[sec_start:sec_end]
    heading_at: dict[int, Milestone] = {}
    for offset, line in enumerate(segment):
        m = MILESTONE_HEADING_RE.match(line)
        if m:
            current = Milestone(
                number=int(m.group(1)),
                title=strip_markdown(m.group(2)),
                lineno=sec_start + offset + 1,
            )
            milestones.append(current)
            heading_at[sec_start + offset + 1] = current

    for table in iter_tables(segment, first_lineno=sec_start + 1):
        if tuple(strip_markdown(h) for h in table.header) != TASK_TABLE_HEADER:
            continue
        owner = _owning_milestone(milestones, table.start_lineno)
        if owner is None:
            findings.append(
                Finding(
                    "ERROR",
                    "E-TABLE-ORPHAN",
                    f"{MILESTONES_DOC}:{table.start_lineno}",
                    "task table appears before any `### M<n> — …` heading",
                )
            )
            continue
        for row in table.rows:
            task = _build_task(row, owner, len(owner.tasks), findings)
            if task is None:
                continue
            seen = by_milestone_seen.setdefault(owner.number, set())
            if task.number in seen:
                findings.append(
                    Finding(
                        "ERROR",
                        "E-ID-DUPLICATE",
                        f"{MILESTONES_DOC}:{task.lineno}",
                        f"{task.task_id} is numbered twice inside M{owner.number}",
                    )
                )
                continue
            seen.add(task.number)
            if task.task_id in tasks:
                findings.append(
                    Finding(
                        "ERROR",
                        "E-ID-DUPLICATE",
                        f"{MILESTONES_DOC}:{task.lineno}",
                        f"{task.task_id} is defined twice in the plan",
                    )
                )
                continue
            owner.tasks.append(task)
            tasks[task.task_id] = task

    matrix_pairs, matrix_counts = _parse_matrix_section(lines, findings)
    has_markers = any(MATRIX_BEGIN in line for line in lines) and any(
        MATRIX_END in line for line in lines
    )
    return milestones, tasks, matrix_pairs, matrix_counts, has_markers


def _owning_milestone(milestones: Sequence[Milestone], lineno: int) -> Milestone | None:
    owner: Milestone | None = None
    for ms in milestones:
        if ms.lineno < lineno:
            owner = ms
        else:
            break
    return owner


def _build_task(
    row: TableRow, owner: Milestone, order: int, findings: list[Finding]
) -> Task | None:
    cells = list(row.cells)
    where = f"{MILESTONES_DOC}:{row.lineno}"
    if len(cells) != len(TASK_TABLE_HEADER):
        findings.append(
            Finding(
                "ERROR",
                "E-ROW-SHAPE",
                where,
                f"row has {len(cells)} cells, expected {len(TASK_TABLE_HEADER)} "
                f"(first cell {cells[0][:40]!r}); check for an unescaped `|`",
            )
        )
        return None

    raw_id = strip_markdown(cells[0]).strip("`").strip()
    m = CANONICAL_ID_RE.match(raw_id)
    if not m:
        findings.append(
            Finding(
                "ERROR",
                "E-ID-FORMAT",
                where,
                f"{raw_id!r} is not a canonical task ID (`M<n>-T<k>`, `14` §0.1)",
            )
        )
        return None
    milestone, number = int(m.group(1)), int(m.group(2))
    if milestone != owner.number:
        findings.append(
            Finding(
                "ERROR",
                "E-ID-MILESTONE",
                where,
                f"{raw_id} appears in the M{owner.number} section",
            )
        )

    src_raw = strip_markdown(cells[2])
    refs, is_new = parse_src_cell(src_raw)
    title = extract_title(cells[1])
    tombstone = bool(re.search(r"\bmoved to M\d{1,2}-T\d{1,3}\b", strip_markdown(cells[1]), re.I))

    return Task(
        task_id=raw_id,
        milestone=milestone,
        number=number,
        title=title,
        order=order,
        src_raw=src_raw,
        src_refs=refs,
        src_is_new=is_new,
        files_raw=strip_markdown(cells[4]),
        deps_raw=strip_markdown(cells[6]),
        parallel_raw=strip_markdown(cells[7]),
        lineno=row.lineno,
        tombstone=tombstone,
    )


def _parse_matrix_section(
    lines: Sequence[str], findings: list[Finding]
) -> tuple[dict[str, list[str]], dict[str, int]]:
    """Read §4's existing per-doc mapping tables and its count summary."""
    start, end = find_section(lines, r"^## 4\. Traceability matrix\b")
    if start < 0:
        return {}, {}
    # §4's own body ends where §4.1 begins.
    for j in range(start + 1, end):
        if lines[j].startswith("### 4.1"):
            end = j
            break

    pairs: dict[str, list[str]] = {}
    counts: dict[str, int] = {}
    segment = lines[start:end]
    doc_at: list[tuple[int, str]] = []
    for offset, line in enumerate(segment):
        m = re.match(r"^#### `(\d{2})`", line)
        if m:
            doc_at.append((start + offset + 1, m.group(1)))

    spec_cell_re = re.compile(r"^(\d{2}):(M\d{1,2}-T-?[A-Z]{0,2}\d{1,3})$")
    for table in iter_tables(segment, first_lineno=start + 1):
        header = tuple(strip_markdown(h) for h in table.header)
        if not header:
            continue
        if header[0] == "Doc":
            # Per-doc count summary. The spec-task count lives in a column named
            # "Count" (hand-written layout) or "Spec tasks" (generated layout);
            # "Count" wins when both are present, because in the hand-written
            # layout "Spec tasks" holds a first…last ID range, not a number.
            idx = next((i for i, h in enumerate(header) if h == "Count"), None)
            if idx is None:
                idx = next((i for i, h in enumerate(header) if h == "Spec tasks"), None)
            if idx is None:
                continue
            for row in table.rows:
                m = re.search(r"`(\d{2})`", row.cells[0])
                if m is None or idx >= len(row.cells):
                    continue
                value = strip_markdown(row.cells[idx]).strip("* ")
                if value.isdigit():
                    counts[m.group(1)] = int(value)
            continue
        if header[0] != "Spec":
            continue
        doc = ""
        for lineno, d in doc_at:
            if lineno < table.start_lineno:
                doc = d
        if not doc:
            continue
        # Layout-agnostic: a cell that parses as `<doc>:<id>` is a spec task, and
        # its canonical IDs are the next cell that is not an arrow or empty. This
        # reads both the hand-written 3-pairs-per-row layout and the generated
        # one-pair-per-row layout.
        for row in table.rows:
            k = 0
            while k < len(row.cells):
                spec_cell = strip_markdown(row.cells[k]).strip("`").strip()
                if not spec_cell or spec_cell in ("→", "+", "⇢"):
                    k += 1
                    continue
                m = spec_cell_re.match(spec_cell)
                if not m:
                    findings.append(
                        Finding(
                            "WARN",
                            "W-MATRIX-CELL",
                            f"{MILESTONES_DOC}:{row.lineno}",
                            f"unparsable §4 spec cell {spec_cell!r}",
                        )
                    )
                    k += 1
                    continue
                target = ""
                j = k + 1
                while j < len(row.cells):
                    candidate = strip_markdown(row.cells[j]).strip()
                    if candidate and candidate != "→":
                        target = candidate
                        break
                    j += 1
                cleaned = target.replace("⇢", " ").replace("+", " ")
                pairs[f"{m.group(1)}:{m.group(2)}"] = [
                    t.strip() for t in cleaned.split(",") if t.strip()
                ]
                k = j + 1
    return pairs, counts


# --------------------------------------------------------------------------- #
# Parsing: spec docs 02–13 §10
# --------------------------------------------------------------------------- #

#: `05` §10 collapses five tasks into one entry: `M13-T1–T5 — Hardening`.
RANGE_ENTRY_RE: Final[re.Pattern[str]] = re.compile(
    r"^M(\d{1,2})-T(\d{1,3})\s*[–—]\s*(?:M\d{1,2}-)?T?(\d{1,3})$"
)


def spec_doc_path(plan_dir: Path, doc: str) -> Path | None:
    matches = sorted(plan_dir.glob(f"{doc}-*.md"))
    return matches[0] if matches else None


def parse_spec_tasks(
    plan_dir: Path, doc: str, findings: list[Finding]
) -> list[SpecTask]:
    """Task IDs a spec defines in its own §10, in document order.

    `14` §4.4 describes the shapes to look for: table rows and bold bullets or
    bold stand-alone lines starting with a task ID, with `05`'s single
    "M13-T1–T5" entry expanded. Each of `02`–`13` writes §10 in its own style,
    so all three shapes are accepted.
    """
    path = spec_doc_path(plan_dir, doc)
    if path is None:
        findings.append(
            Finding("ERROR", "E-SPEC-MISSING", f"docs/plan/{doc}-*.md", "spec file not found")
        )
        return []

    lines = read_lines(path)
    start, end = find_section(lines, r"^## 10\.")
    if start < 0:
        findings.append(
            Finding("ERROR", "E-SPEC-NO-S10", path.name, "no `## 10.` implementation-tasks section")
        )
        return []

    out: list[SpecTask] = []
    seen: set[str] = set()

    def add(raw: str, lineno: int) -> None:
        rng = RANGE_ENTRY_RE.match(raw)
        candidates: list[tuple[str, str | None]]
        if rng and int(rng.group(3)) > int(rng.group(2)):
            candidates = [
                (f"M{rng.group(1)}-T{k}", raw)
                for k in range(int(rng.group(2)), int(rng.group(3)) + 1)
            ]
        else:
            candidates = [(raw, None)]
        for ident, origin in candidates:
            m = SPEC_LOCAL_ID_RE.match(ident)
            if not m or ident in seen:
                continue
            seen.add(ident)
            out.append(
                SpecTask(
                    doc=doc,
                    local_id=ident,
                    milestone=int(m.group(1)),
                    lineno=lineno,
                    expanded_from=origin,
                )
            )

    segment = lines[start + 1 : end]

    # Shape 1: table rows whose first cell is (optionally bold) a task ID.
    for table in iter_tables(segment, first_lineno=start + 2):
        for row in table.rows:
            first = strip_markdown(row.cells[0]).strip("*").strip("`").strip()
            if SPEC_LOCAL_ID_RE.match(first) or RANGE_ENTRY_RE.match(first):
                add(first, row.lineno)

    # Shape 2/3: bold bullets (`- **M4-T1 …**`) and bold stand-alone lines
    # (`**M3-T1 — …**`). Separators between the ID and the title vary by doc:
    # `03` and `11` use a space, `04`/`05`/`06` an em dash. The en dash must stay
    # *inside* the capture so `05`'s collapsed `M13-T1–T5` entry still expands.
    bold_re = re.compile(r"^(?:[-*]\s+)?\*\*(M\d{1,2}-T[^\s*—]*)")
    for offset, line in enumerate(segment):
        m = bold_re.match(line.strip())
        if m:
            add(m.group(1).rstrip(".:,"), start + 2 + offset)

    out.sort(key=lambda s: s.lineno)
    return out


# --------------------------------------------------------------------------- #
# Parsing: STATUS.md
# --------------------------------------------------------------------------- #


def parse_status_doc(path: Path, findings: list[Finding]) -> list[StatusMilestone]:
    if not path.exists():
        findings.append(Finding("ERROR", "E-STATUS-MISSING-FILE", STATUS_DOC, "file not found"))
        return []
    lines = read_lines(path)
    start, end = find_section(lines, r"^## Milestones\b")
    if start < 0:
        findings.append(
            Finding("ERROR", "E-STATUS-NO-SECTION", STATUS_DOC, "no `## Milestones` heading found")
        )
        return []

    out: list[StatusMilestone] = []
    current: StatusMilestone | None = None
    for offset in range(start + 1, end):
        line = lines[offset]
        lineno = offset + 1
        m = MILESTONE_HEADING_RE.match(line)
        if m:
            current = StatusMilestone(
                number=int(m.group(1)),
                title=strip_markdown(m.group(2)),
                heading_lineno=lineno,
            )
            out.append(current)
            continue
        if current is None:
            continue
        ms = STATUS_LINE_RE.match(line)
        if ms:
            current.status_lineno = lineno
            current.status_state = ms.group("state")
            current.status_gate = ms.group("gate")
            current.declared_done = int(ms.group("done"))
            current.declared_total = int(ms.group("total"))
            continue
        mc = CHECKLIST_RE.match(line)
        if mc:
            current.entries.append(
                StatusEntry(
                    task_id=mc.group("id"),
                    done=mc.group("mark").lower() == "x",
                    rest=(mc.group("rest") or "").strip(),
                    lineno=lineno,
                )
            )
            if current.block_start is None:
                current.block_start = lineno
            current.block_end = lineno
    return out


# --------------------------------------------------------------------------- #
# Dependency parsing
# --------------------------------------------------------------------------- #

DEP_RANGE_RE: Final[re.Pattern[str]] = re.compile(
    r"^M(\d{1,2})-T(\d{1,3})\s*[–—]\s*(?:M(\d{1,2})-)?T?(\d{1,3})$"
)
DEP_MILESTONE_RE: Final[re.Pattern[str]] = re.compile(
    r"^M(\d{1,2})(?:\s+(?:gate|entry|exit))?$"
)


def parse_deps(task: Task) -> tuple[list[str], list[int], list[str]]:
    """Split a `Deps` cell into task IDs, milestone-level refs and leftovers.

    Grammar seen in `14` §2:
    ``—`` · ``M3-T4`` · ``M1-T18–M1-T25`` (inclusive range) · ``M9 gate`` ·
    ``M13 entry`` · bare ``M0`` · any of those with a trailing ``(note)``.
    """
    raw = task.deps_raw
    if not raw or raw == "—":
        return [], [], []

    task_ids: list[str] = []
    milestones: list[int] = []
    unparsed: list[str] = []
    for token in re.split(r"[,;]", raw):
        token = token.strip()
        token = re.sub(r"\s*\([^)]*\)\s*$", "", token).strip()
        token = token.strip("`").strip()
        if not token or token == "—":
            continue
        rng = DEP_RANGE_RE.match(token)
        if rng:
            lo, hi = int(rng.group(2)), int(rng.group(4))
            if rng.group(3) and rng.group(3) != rng.group(1):
                unparsed.append(token)
                continue
            if hi < lo:
                unparsed.append(token)
                continue
            task_ids.extend(f"M{rng.group(1)}-T{k}" for k in range(lo, hi + 1))
            continue
        if CANONICAL_ID_RE.match(token):
            task_ids.append(token)
            continue
        ms = DEP_MILESTONE_RE.match(token)
        if ms:
            milestones.append(int(ms.group(1)))
            continue
        unparsed.append(token)
    return task_ids, milestones, unparsed


# --------------------------------------------------------------------------- #
# Serial-area detection (`14` §0.4, CLAUDE.md §1.5)
# --------------------------------------------------------------------------- #

_CORE_DIRECT_RE: Final[re.Pattern[str]] = re.compile(
    r"(?:packages/)?core/src/(" + "|".join(SERIAL_CORE_DIRS) + r")\b"
)
_CORE_BRACE_RE: Final[re.Pattern[str]] = re.compile(r"(?:packages/)?core/src/\{([^}]*)\}")
# "Database migration" is scoped BY NAME (`14` §0.4, narrowed 2026-11-01). The signal is a
# directory named `migrations/` or `migrate/` — not a bare file called `migration.ts`. That is
# the line between real schema migrations (`packages/storage/{migrations/,src/migrate/}`) and
# `M3-T34`'s `packages/channels/telegram/src/{membership,migration,probe,webhook}.ts`, which
# handles Telegram's group->supergroup chat-id change and is correctly parallel-ok.
_MIGRATION_RE: Final[re.Pattern[str]] = re.compile(
    r"(?:^|[\s,{(/])(?:migrate|migrations)\b"   # a `migrate`/`migrations` path segment
    r"|\bmigrations?/",                          # or any `migration(s)/` directory
    re.I,
)


def serial_area_hits(files_cell: str) -> list[str]:
    """Serial-only areas a `Files` cell touches; empty when the row may run `‖`."""
    hits: list[str] = []
    text = files_cell.replace("`", "")
    for m in _CORE_DIRECT_RE.finditer(text):
        hits.append(f"core/src/{m.group(1)}")
    for m in _CORE_BRACE_RE.finditer(text):
        for member in m.group(1).split(","):
            head = member.strip().strip("/").split("/")[0]
            if head in SERIAL_CORE_DIRS:
                hits.append(f"core/src/{head}")
    for m in _MIGRATION_RE.finditer(text):
        hits.append(f"migration path {_enclosing_token(text, m.start(), m.end())!r}")
    # Deterministic, de-duplicated.
    return sorted(dict.fromkeys(hits))


def _enclosing_token(text: str, start: int, end: int) -> str:
    """Grow a match out to the whole path-ish token around it, for the message."""
    breaks = " \t,;()<>"
    left = start
    while left > 0 and text[left - 1] not in breaks:
        left -= 1
    right = end
    while right < len(text) and text[right] not in breaks:
        right += 1
    return text[left:right] or text[start:end]


# --------------------------------------------------------------------------- #
# Loading + checking
# --------------------------------------------------------------------------- #


def load_plan(plan_dir: Path) -> PlanModel:
    findings: list[Finding] = []
    milestones_path = plan_dir / MILESTONES_DOC
    if not milestones_path.exists():
        findings.append(
            Finding("ERROR", "E-PLAN-MISSING", str(milestones_path), "milestones file not found")
        )
        return PlanModel(
            plan_dir=plan_dir,
            milestones=[],
            tasks={},
            spec_tasks={},
            status=[],
            matrix_pairs={},
            matrix_counts={},
            has_matrix_markers=False,
            findings=findings,
        )

    milestones, tasks, matrix_pairs, matrix_counts, has_markers = parse_milestones_doc(
        milestones_path, findings
    )
    spec_tasks: dict[str, SpecTask] = {}
    for doc in SPEC_DOCS:
        for st in parse_spec_tasks(plan_dir, doc, findings):
            spec_tasks[st.ref] = st
    status = parse_status_doc(plan_dir / STATUS_DOC, findings)
    return PlanModel(
        plan_dir=plan_dir,
        milestones=milestones,
        tasks=tasks,
        spec_tasks=spec_tasks,
        status=status,
        matrix_pairs=matrix_pairs,
        matrix_counts=matrix_counts,
        has_matrix_markers=has_markers,
        findings=findings,
    )


def check_plan(model: PlanModel) -> list[Finding]:
    """Run every validation. Returns `model.findings` (parse findings included)."""
    out = model.findings
    out.extend(_check_numbering(model))
    out.extend(_check_deps(model))
    out.extend(_check_src(model))
    out.extend(_check_status(model))
    out.extend(_check_parallel(model))
    out.extend(_check_matrix(model))
    out.extend(_check_table_shape(model))
    out.sort()
    return out


def _check_table_shape(model: PlanModel) -> list[Finding]:
    """Flag a markdown table row whose column count does not match its header.

    This exists because two rows were appended to `STATUS.md`'s *Plan changes*
    table without a newline between them, producing one line with twice the
    columns. Nothing caught it: the checker reads the rows it cares about by
    name, Vale reads prose, and the rendered table merely looks odd. A
    corrupted row in the decision record is the one kind of damage this
    project cannot afford to make quietly, because the record *is* the
    evidence.

    A doubled row is the signal here, so the check is on the count rather than
    on the content. `<br/>`-heavy cells and inline pipes inside code spans are
    already handled by `split_table_row`.
    """
    out: list[Finding] = []
    for doc in (MILESTONES_DOC, STATUS_DOC):
        path = model.plan_dir / doc
        if not path.exists():
            continue
        for table in iter_tables(read_lines(path)):
            width = len(table.header)
            for row in table.rows:
                if len(row.cells) != width:
                    out.append(
                        Finding(
                            "ERROR",
                            "E-TABLE-SHAPE",
                            f"{doc}:{row.lineno}",
                            f"row has {len(row.cells)} columns; the header at "
                            f"line {table.start_lineno} has {width}",
                        )
                    )
    return out


def _check_numbering(model: PlanModel) -> list[Finding]:
    out: list[Finding] = []
    seen_numbers = sorted({ms.number for ms in model.milestones})
    if len(seen_numbers) != len(model.milestones):
        out.append(
            Finding(
                "ERROR",
                "E-MILESTONE-DUP",
                MILESTONES_DOC,
                "a milestone number has more than one `### M<n> — …` section",
            )
        )
    for ms in model.milestones:
        if not ms.tasks:
            out.append(
                Finding(
                    "WARN",
                    "W-MILESTONE-EMPTY",
                    f"{MILESTONES_DOC}:{ms.lineno}",
                    f"M{ms.number} has no task table rows",
                )
            )
            continue
        numbers = sorted(t.number for t in ms.tasks)
        gaps = [n for n in range(1, numbers[-1] + 1) if n not in set(numbers)]
        if gaps:
            out.append(
                Finding(
                    "WARN",
                    "W-ID-GAP",
                    f"{MILESTONES_DOC}:{ms.lineno}",
                    f"M{ms.number} numbering has gaps {gaps} "
                    f"(allowed by §0.5 rule 3 'never renumber' / tombstones; "
                    f"{len(numbers)} rows, highest T{numbers[-1]})",
                )
            )
    return out


def _check_deps(model: PlanModel) -> list[Finding]:
    out: list[Finding] = []
    for task in model.ordered_tasks():
        where = f"{MILESTONES_DOC}:{task.lineno}"
        dep_ids, dep_ms, unparsed = parse_deps(task)
        for token in unparsed:
            out.append(
                Finding(
                    "WARN",
                    "W-DEP-UNPARSED",
                    where,
                    f"{task.task_id}: cannot read dependency {token!r}",
                )
            )
        for number in dep_ms:
            if number > task.milestone:
                out.append(
                    Finding(
                        "ERROR",
                        "E-DEP-FORWARD",
                        where,
                        f"{task.task_id} depends on milestone M{number}, which is later than M{task.milestone}",
                    )
                )
        for dep in dep_ids:
            other = model.tasks.get(dep)
            if other is None:
                out.append(
                    Finding(
                        "ERROR",
                        "E-DEP-UNKNOWN",
                        where,
                        f"{task.task_id} depends on {dep}, which does not exist in the plan",
                    )
                )
                continue
            if other.milestone > task.milestone:
                out.append(
                    Finding(
                        "ERROR",
                        "E-DEP-FORWARD",
                        where,
                        f"{task.task_id} (M{task.milestone}) depends on {dep} in the later M{other.milestone}",
                    )
                )
            elif other.milestone == task.milestone and other.order > task.order:
                out.append(
                    Finding(
                        "ERROR",
                        "E-DEP-FORWARD",
                        where,
                        f"{task.task_id} depends on {dep}, which is later in the same table "
                        f"(table order is execution order, §0.1)",
                    )
                )
            elif dep == task.task_id:
                out.append(
                    Finding("ERROR", "E-DEP-SELF", where, f"{task.task_id} depends on itself")
                )
    return out


def _check_src(model: PlanModel) -> list[Finding]:
    out: list[Finding] = []
    for task in model.ordered_tasks():
        where = f"{MILESTONES_DOC}:{task.lineno}"
        if not task.src_refs and not task.src_is_new:
            out.append(
                Finding(
                    "ERROR",
                    "E-SRC-EMPTY",
                    where,
                    f"{task.task_id}: Src cell {task.src_raw!r} names no `<doc>:M<n>-T<k>` "
                    f"reference and is not `{SRC_NEW_LITERAL}`",
                )
            )
            continue
        for ref in task.src_refs:
            if ref.doc not in SPEC_DOCS:
                out.append(
                    Finding(
                        "ERROR",
                        "E-SRC-UNKNOWN-DOC",
                        where,
                        f"{task.task_id}: Src references doc `{ref.doc}`, which is not one of "
                        f"{SPEC_DOCS[0]}–{SPEC_DOCS[-1]}",
                    )
                )
                continue
            if spec_doc_path(model.plan_dir, ref.doc) is None:
                out.append(
                    Finding(
                        "ERROR",
                        "E-SRC-UNKNOWN-DOC",
                        where,
                        f"{task.task_id}: no file matches docs/plan/{ref.doc}-*.md",
                    )
                )
                continue
            if str(ref) not in model.spec_tasks:
                out.append(
                    Finding(
                        "ERROR",
                        "E-SRC-UNKNOWN-TASK",
                        where,
                        f"{task.task_id}: Src references {ref}, which is not defined in that doc's §10",
                    )
                )

    claims = model.claims
    for ref, spec in sorted(model.spec_tasks.items(), key=_spec_sort_key):
        if ref not in claims:
            path = spec_doc_path(model.plan_dir, spec.doc)
            name = path.name if path else f"{spec.doc}-*.md"
            out.append(
                Finding(
                    "ERROR",
                    "E-SRC-UNMAPPED",
                    f"{name}:{spec.lineno}",
                    f"spec task {ref} is claimed by no `14` row's Src cell",
                )
            )
    return out


def _spec_sort_key(item: tuple[str, SpecTask]) -> tuple[str, int, str]:
    ref, spec = item
    return (spec.doc, spec.milestone, spec.local_id)


def _check_status(model: PlanModel) -> list[Finding]:
    out: list[Finding] = []
    if not model.status:
        return out
    by_number: dict[int, StatusMilestone] = {}
    for sm in model.status:
        if sm.number in by_number:
            out.append(
                Finding(
                    "ERROR",
                    "E-STATUS-DUP-SECTION",
                    f"{STATUS_DOC}:{sm.heading_lineno}",
                    f"M{sm.number} has more than one section under `## Milestones`",
                )
            )
            continue
        by_number[sm.number] = sm

    plan_numbers = [ms.number for ms in model.milestones]
    for number in plan_numbers:
        if number not in by_number:
            out.append(
                Finding(
                    "ERROR",
                    "E-STATUS-NO-MILESTONE",
                    STATUS_DOC,
                    f"no `### M{number} — …` section under `## Milestones`",
                )
            )
    for number, sm in sorted(by_number.items()):
        if number not in plan_numbers:
            out.append(
                Finding(
                    "ERROR",
                    "E-STATUS-UNKNOWN-MILESTONE",
                    f"{STATUS_DOC}:{sm.heading_lineno}",
                    f"M{number} is not a milestone in `14` §2",
                )
            )

    for ms in model.milestones:
        sm = by_number.get(ms.number)
        if sm is None:
            continue
        plan_ids = [t.task_id for t in ms.tasks]
        status_ids = [e.task_id for e in sm.entries]
        counted: dict[str, int] = {}
        for tid in status_ids:
            counted[tid] = counted.get(tid, 0) + 1

        for tid in plan_ids:
            if counted.get(tid, 0) == 0:
                out.append(
                    Finding(
                        "ERROR",
                        "E-STATUS-MISSING-TASK",
                        f"{STATUS_DOC}:{sm.heading_lineno}",
                        f"{tid} is in `14` M{ms.number} but has no checklist line",
                    )
                )
            elif counted[tid] > 1:
                out.append(
                    Finding(
                        "ERROR",
                        "E-STATUS-DUPLICATE-TASK",
                        f"{STATUS_DOC}:{sm.heading_lineno}",
                        f"{tid} has {counted[tid]} checklist lines",
                    )
                )
        for entry in sm.entries:
            task = model.tasks.get(entry.task_id)
            if task is None or task.milestone != ms.number:
                out.append(
                    Finding(
                        "ERROR",
                        "E-STATUS-UNKNOWN-TASK",
                        f"{STATUS_DOC}:{entry.lineno}",
                        f"{entry.task_id} is not a task of `14` M{ms.number}",
                    )
                )
                continue
            if not entry.rest.startswith(task.title):
                out.append(
                    Finding(
                        "ERROR",
                        "E-STATUS-TITLE",
                        f"{STATUS_DOC}:{entry.lineno}",
                        f"{entry.task_id} title is {entry.rest!r}, plan says {task.title!r}",
                    )
                )
        if status_ids and [t for t in status_ids if t in plan_ids] != [
            t for t in plan_ids if t in status_ids
        ]:
            out.append(
                Finding(
                    "WARN",
                    "W-STATUS-ORDER",
                    f"{STATUS_DOC}:{sm.heading_lineno}",
                    f"M{ms.number} checklist order differs from the `14` table order",
                )
            )

        real_done = sum(1 for e in sm.entries if e.done)
        real_total = len(sm.entries)
        if sm.status_lineno is None:
            out.append(
                Finding(
                    "ERROR",
                    "E-STATUS-NO-COUNTER",
                    f"{STATUS_DOC}:{sm.heading_lineno}",
                    f"M{ms.number} has no `Status: … · Tasks: X/Y · Gate: …` line",
                )
            )
        else:
            if (sm.declared_done, sm.declared_total) != (real_done, real_total):
                out.append(
                    Finding(
                        "ERROR",
                        "E-STATUS-COUNT",
                        f"{STATUS_DOC}:{sm.status_lineno}",
                        f"M{ms.number} declares Tasks: {sm.declared_done}/{sm.declared_total} "
                        f"but the checklist has {real_done}/{real_total}",
                    )
                )
            if sm.declared_total != len(plan_ids):
                out.append(
                    Finding(
                        "ERROR",
                        "E-STATUS-COUNT",
                        f"{STATUS_DOC}:{sm.status_lineno}",
                        f"M{ms.number} declares {sm.declared_total} tasks but `14` §2 has "
                        f"{len(plan_ids)}",
                    )
                )
    return out


def _check_parallel(model: PlanModel) -> list[Finding]:
    out: list[Finding] = []
    for task in model.ordered_tasks():
        where = f"{MILESTONES_DOC}:{task.lineno}"
        if task.parallel_raw not in ("‖", "—"):
            out.append(
                Finding(
                    "ERROR",
                    "E-PARALLEL-VALUE",
                    where,
                    f"{task.task_id}: `‖` column is {task.parallel_raw!r}, expected `‖` or `—`",
                )
            )
            continue
        if not task.parallel:
            continue
        hits = serial_area_hits(task.files_raw)
        if hits:
            out.append(
                Finding(
                    "ERROR",
                    "SERIAL-VIOLATION",
                    where,
                    f"{task.task_id} is marked `‖` but its Files touch serial-only "
                    f"{', '.join(hits)} (`14` §0.4, CLAUDE.md §1.5)",
                )
            )
    return out


def _check_matrix(model: PlanModel) -> list[Finding]:
    """Compare §4's stored matrix and counts with what the Src columns imply."""
    out: list[Finding] = []
    if not model.has_matrix_markers:
        out.append(
            Finding(
                "INFO",
                "I-MATRIX-MARKERS",
                MILESTONES_DOC,
                f"§4 has no `{MATRIX_BEGIN}` / `{MATRIX_END}` markers, so "
                f"--regen-matrix prints the table instead of writing it",
            )
        )
    generated = generate_matrix_pairs(model)
    if model.matrix_pairs:
        for ref in sorted(set(generated) | set(model.matrix_pairs), key=_ref_sort_key):
            want = generated.get(ref)
            have = model.matrix_pairs.get(ref)
            if want is None:
                out.append(
                    Finding(
                        "WARN",
                        "W-MATRIX-DRIFT",
                        MILESTONES_DOC,
                        f"§4 maps {ref}, but no Src cell claims it; run --regen-matrix",
                    )
                )
            elif have is None:
                out.append(
                    Finding(
                        "WARN",
                        "W-MATRIX-DRIFT",
                        MILESTONES_DOC,
                        f"§4 does not list {ref} (claimed by {', '.join(want)}); run --regen-matrix",
                    )
                )
            elif have != want:
                out.append(
                    Finding(
                        "WARN",
                        "W-MATRIX-DRIFT",
                        MILESTONES_DOC,
                        f"§4 maps {ref} → {', '.join(have)} but Src says {', '.join(want)}",
                    )
                )
    for doc in SPEC_DOCS:
        real = sum(1 for st in model.spec_tasks.values() if st.doc == doc)
        declared = model.matrix_counts.get(doc)
        if declared is not None and declared != real:
            out.append(
                Finding(
                    "WARN",
                    "W-MATRIX-COUNT",
                    MILESTONES_DOC,
                    f"§4 declares {declared} tasks for `{doc}` but its §10 defines {real}",
                )
            )
    return out


def _ref_sort_key(ref: str) -> tuple[str, int, int, str]:
    doc, _, local = ref.partition(":")
    m = re.match(r"^M(\d{1,2})-T-?[A-Z]{0,2}(\d{1,3})$", local)
    if m:
        return (doc, int(m.group(1)), int(m.group(2)), local)
    return (doc, 99, 999, local)


# --------------------------------------------------------------------------- #
# Generation: STATUS checklists
# --------------------------------------------------------------------------- #

_NOTE_SEPARATORS: Final[tuple[str, ...]] = (" — ", " · ", " (", " [", " – ")


def _preserved_suffix(rest: str, title: str) -> str:
    """The trailing commit hash / note on a STATUS line, without its title."""
    if rest.startswith(title):
        return rest[len(title) :]
    best = len(rest)
    for sep in _NOTE_SEPARATORS:
        idx = rest.find(sep)
        if idx != -1:
            best = min(best, idx)
    if best < len(rest):
        return rest[best:]
    m = re.search(r"\s[0-9a-f]{7,40}\b", rest)
    if m:
        return rest[m.start() :]
    return ""


def regenerate_status_lines(model: PlanModel) -> tuple[list[str], list[Finding]]:
    """Return the full new STATUS.md line list and any notes about the rewrite."""
    path = model.plan_dir / STATUS_DOC
    lines = read_lines(path)
    findings: list[Finding] = []
    by_number = {sm.number: sm for sm in model.status}

    # Build replacements keyed by the 0-based span they overwrite, then apply
    # them from the bottom up so earlier line numbers stay valid.
    edits: list[tuple[int, int, list[str]]] = []
    for ms in model.milestones:
        sm = by_number.get(ms.number)
        if sm is None:
            findings.append(
                Finding(
                    "WARN",
                    "W-REGEN-SKIP",
                    STATUS_DOC,
                    f"M{ms.number} has no section in STATUS.md; add it by hand "
                    f"(this tool never reorders or creates milestone sections)",
                )
            )
            continue
        existing = {e.task_id: e for e in sm.entries}
        block: list[str] = []
        for task in ms.tasks:
            entry = existing.get(task.task_id)
            mark = "x" if entry and entry.done else " "
            suffix = _preserved_suffix(entry.rest, task.title) if entry else ""
            if entry and entry.rest and not entry.rest.startswith(task.title) and not suffix:
                findings.append(
                    Finding(
                        "WARN",
                        "W-REGEN-TEXT",
                        f"{STATUS_DOC}:{entry.lineno}",
                        f"{task.task_id}: replaced stale text {entry.rest!r} with the plan title",
                    )
                )
            block.append(f"- [{mark}] {task.task_id} {task.title}{suffix}".rstrip())
        # Never drop a checklist line for a task we cannot account for.
        for entry in sm.entries:
            if entry.task_id not in {t.task_id for t in ms.tasks}:
                block.append(
                    f"- [{'x' if entry.done else ' '}] {entry.task_id} {entry.rest}".rstrip()
                )
                findings.append(
                    Finding(
                        "WARN",
                        "W-REGEN-ORPHAN",
                        f"{STATUS_DOC}:{entry.lineno}",
                        f"{entry.task_id} is not in `14` M{ms.number}; line kept, please resolve",
                    )
                )

        done = sum(1 for line in block if line.startswith("- [x]"))
        total = len(block)
        if sm.status_lineno is not None:
            old = lines[sm.status_lineno - 1]
            new = STATUS_LINE_RE.sub(
                lambda m: f"Status: {m.group('state')} · Tasks: {done}/{total} · Gate: {m.group('gate')}",
                old,
            )
            if new != old:
                edits.append((sm.status_lineno - 1, sm.status_lineno, [new]))
        else:
            findings.append(
                Finding(
                    "WARN",
                    "W-REGEN-NO-COUNTER",
                    f"{STATUS_DOC}:{sm.heading_lineno}",
                    f"M{ms.number} has no `Status:` line, so its counter was not fixed",
                )
            )

        if sm.block_start is not None and sm.block_end is not None:
            edits.append((sm.block_start - 1, sm.block_end, block))
        elif sm.status_lineno is not None:
            insert_at = sm.status_lineno  # 0-based index just after the Status: line
            edits.append((insert_at, insert_at, [""] + block))
        else:
            insert_at = sm.heading_lineno
            edits.append((insert_at, insert_at, [""] + block))

    out = list(lines)
    for start, end, block in sorted(edits, key=lambda e: e[0], reverse=True):
        out[start:end] = block
    return out, findings


# --------------------------------------------------------------------------- #
# Generation: §4 traceability matrix
# --------------------------------------------------------------------------- #


def generate_matrix_pairs(model: PlanModel) -> dict[str, list[str]]:
    """"doc:local_id" -> canonical IDs, from the Src columns, in plan order."""
    pairs: dict[str, list[str]] = {}
    for task in model.ordered_tasks():
        for ref in task.src_refs:
            pairs.setdefault(str(ref), []).append(task.task_id)
    return pairs


def render_matrix(model: PlanModel) -> list[str]:
    """The generated body of `14` §4: a count summary plus one row per spec task."""
    pairs = generate_matrix_pairs(model)
    lines: list[str] = []
    lines.append("")
    lines.append(
        "_Generated by `scripts/plan/trace.py --regen-matrix` from the §2 *Src* columns. "
        'Do not edit by hand. "⇢" marks a spec task whose canonical task runs in a '
        'different milestone than the spec proposed; "+" marks a spec task split across '
        "several canonical tasks._"
    )
    lines.append("")
    lines.append("| Doc | Spec tasks | Mapped | Canonical tasks |")
    lines.append("|---|---|---|---|")
    total_spec = 0
    for doc in SPEC_DOCS:
        refs = [r for r in pairs if r.startswith(f"{doc}:")]
        defined = [st for st in model.spec_tasks.values() if st.doc == doc]
        canonical = {cid for r in refs for cid in pairs[r]}
        total_spec += len(defined)
        lines.append(
            f"| `{doc}` {DOC_TITLES.get(doc, '')} | {len(defined)} | {len(refs)} | "
            f"{len(canonical)} |"
        )
    new_rows = [t.task_id for t in model.ordered_tasks() if t.src_is_new]
    lines.append(
        f"| **Total** | **{total_spec}** | **{len(pairs)}** | "
        f"**{len(model.tasks)}** (of which {len(new_rows)} have a "
        f"`{SRC_NEW_LITERAL}` component, §4.1) |"
    )
    lines.append("")

    for doc in SPEC_DOCS:
        refs = sorted(
            (r for r in pairs if r.startswith(f"{doc}:")), key=_ref_sort_key
        )
        if not refs:
            continue
        lines.append(f"#### `{doc}` — {DOC_TITLES.get(doc, '')}")
        lines.append("")
        lines.append("| Spec | → | Canonical |")
        lines.append("|---|---|---|")
        for ref in refs:
            canonical = pairs[ref]
            spec = model.spec_tasks.get(ref)
            marks = ""
            if len(canonical) > 1:
                marks += " +"
            if spec is not None:
                moved = any(
                    model.tasks[c].milestone != spec.milestone
                    for c in canonical
                    if c in model.tasks
                )
                if moved:
                    marks += " ⇢"
            lines.append(f"| `{ref}` | → | {', '.join(canonical)}{marks} |")
        lines.append("")
    return lines


def splice_matrix(lines: Sequence[str], body: Sequence[str]) -> list[str]:
    """Replace everything between the matrix markers with `body`."""
    begin = next(i for i, l in enumerate(lines) if MATRIX_BEGIN in l)
    end = next(i for i, l in enumerate(lines) if MATRIX_END in l)
    if end < begin:
        raise ValueError(f"{MATRIX_END} appears before {MATRIX_BEGIN}")
    return list(lines[: begin + 1]) + list(body) + list(lines[end:])


# --------------------------------------------------------------------------- #
# Output helpers
# --------------------------------------------------------------------------- #


def atomic_write(path: Path, text: str) -> None:
    """Write `text` to `path` via a temp file in the same directory + replace."""
    directory = path.parent
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def print_diff(path: Path, old: Sequence[str], new: Sequence[str], stream) -> bool:
    diff = list(
        difflib.unified_diff(
            list(old), list(new), fromfile=f"a/{path.name}", tofile=f"b/{path.name}", lineterm=""
        )
    )
    if not diff:
        print(f"trace: {path.name} is already up to date", file=stream)
        return False
    for line in diff:
        print(line, file=stream)
    return True


def print_report(model: PlanModel, findings: Sequence[Finding], stream) -> None:
    for level in ("ERROR", "WARN", "INFO"):
        group = [f for f in findings if f.level == level]
        if not group:
            continue
        print(f"\n== {level} ({len(group)}) ==", file=stream)
        for finding in group:
            print(f"  {finding.render()}", file=stream)
    errors = sum(1 for f in findings if f.level == "ERROR")
    warnings = sum(1 for f in findings if f.level == "WARN")
    print(
        f"\ntrace: {len(model.tasks)} tasks across {len(model.milestones)} milestones; "
        f"{len(model.spec_tasks)} spec tasks in `02`–`13` §10; "
        f"{errors} error{'' if errors == 1 else 's'}, "
        f"{warnings} warning{'' if warnings == 1 else 's'}",
        file=stream,
    )


def model_to_json(model: PlanModel, findings: Sequence[Finding]) -> dict[str, object]:
    pairs = generate_matrix_pairs(model)
    return {
        "planDir": str(model.plan_dir),
        "milestones": [
            {
                "number": ms.number,
                "title": ms.title,
                "line": ms.lineno,
                "taskCount": len(ms.tasks),
                "tasks": [t.task_id for t in ms.tasks],
            }
            for ms in model.milestones
        ],
        "tasks": [t.to_dict() for t in model.ordered_tasks()],
        "specTasks": [
            {
                "ref": st.ref,
                "doc": st.doc,
                "localId": st.local_id,
                "milestone": st.milestone,
                "line": st.lineno,
                "expandedFrom": st.expanded_from,
            }
            for _, st in sorted(model.spec_tasks.items(), key=_spec_sort_key)
        ],
        "srcMappings": {ref: pairs[ref] for ref in sorted(pairs, key=_ref_sort_key)},
        "unmappedSpecTasks": sorted(
            (ref for ref in model.spec_tasks if ref not in pairs), key=_ref_sort_key
        ),
        "status": [
            {
                "milestone": sm.number,
                "title": sm.title,
                "declaredDone": sm.declared_done,
                "declaredTotal": sm.declared_total,
                "entries": [
                    {"id": e.task_id, "done": e.done, "rest": e.rest, "line": e.lineno}
                    for e in sm.entries
                ],
            }
            for sm in model.status
        ],
        "hasMatrixMarkers": model.has_matrix_markers,
        "findings": [f.to_dict() for f in findings],
        "summary": {
            "taskCount": len(model.tasks),
            "milestoneCount": len(model.milestones),
            "specTaskCount": len(model.spec_tasks),
            "errors": sum(1 for f in findings if f.level == "ERROR"),
            "warnings": sum(1 for f in findings if f.level == "WARN"),
        },
    }


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def default_plan_dir() -> Path:
    """`docs/plan` relative to the repo root, derived from this file's location."""
    return (Path(__file__).resolve().parent.parent.parent / "docs" / "plan").resolve()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="trace.py",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description=(
            "Keep docs/plan/14-milestones.md, the subsystem specs' §10 task lists and\n"
            "docs/plan/STATUS.md in agreement (14 §4.4, task M0-T23).\n"
        ),
        epilog=(
            "Typical use\n"
            "-----------\n"
            "  python3 scripts/plan/trace.py --check\n"
            "        Validate everything and exit 1 on any ERROR. This is the CI mode;\n"
            "        run it after every plan edit.\n"
            "  python3 scripts/plan/trace.py --regen-status --dry-run\n"
            "        Show the STATUS.md checklist/counter rewrite without touching the file.\n"
            "  python3 scripts/plan/trace.py --regen-status\n"
            "        Apply it. Existing [x] marks and trailing commit hashes or notes are\n"
            "        preserved, milestones are never reordered, and nothing outside each\n"
            "        milestone's checklist block and Status: counter is touched.\n"
            "  python3 scripts/plan/trace.py --regen-matrix\n"
            "        Regenerate 14 §4's traceability table. It is written in place only if\n"
            f"        {MATRIX_BEGIN} / {MATRIX_END} are present;\n"
            "        otherwise the table is printed for you to paste in.\n"
            "  python3 scripts/plan/trace.py --json > plan.json\n"
            "        Emit the parsed model (tasks, deps, Src mappings, findings) for other tools.\n"
            "\n"
            "Fixing the common failures\n"
            "--------------------------\n"
            "  E-SRC-UNMAPPED       A spec §10 task no 14 row claims. Add it to some row's Src\n"
            "                       cell, or add a new row per 14 §0.5 rule 3 (next free number).\n"
            "  E-SRC-UNKNOWN-TASK   A Src cell names a spec task that doc's §10 does not define.\n"
            "                       Fix the reference, or add the task to the spec.\n"
            "  E-DEP-FORWARD        A Deps entry points at later work. Reorder the rows or\n"
            "                       correct the dependency; table order is execution order.\n"
            "  E-STATUS-*           STATUS.md drifted. Run --regen-status.\n"
            "  SERIAL-VIOLATION     A row marked ‖ touches packages/core/src/{policy,ifc,\n"
            "                       constitution,declassify,governance,consent}, a migrations/\n"
            "                       directory, or packages/storage/src/{migrate,migrations}/\n"
            "                       path. Change its ‖ to —; that work stays on the main thread.\n"
            "  W-ID-GAP             Informational: 14 §0.5 rule 3 forbids renumbering, so gaps\n"
            "                       from moved or tombstoned tasks are expected.\n"
        ),
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="validate the plan and exit 1 if any ERROR is found (CI mode)",
    )
    parser.add_argument(
        "--regen-status",
        action="store_true",
        help="rewrite each milestone's checklist and Tasks: X/Y counter in STATUS.md",
    )
    parser.add_argument(
        "--regen-matrix",
        action="store_true",
        help="regenerate 14 §4's traceability table between the TRACE-MATRIX markers",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="print the full parsed model as JSON on stdout",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="with --regen-*: print the unified diff but write nothing",
    )
    parser.add_argument(
        "--plan-dir",
        type=Path,
        default=None,
        metavar="DIR",
        help="plan directory to read (default: the repo's docs/plan)",
    )
    return parser


def run(argv: Sequence[str] | None = None, stdout=None, stderr=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    out = stdout if stdout is not None else sys.stdout
    err = stderr if stderr is not None else sys.stderr

    if not (args.check or args.regen_status or args.regen_matrix or args.json):
        parser.print_help(out)
        print("\ntrace: pick a mode (--check, --regen-status, --regen-matrix, --json)", file=err)
        return 2

    plan_dir = (args.plan_dir or default_plan_dir()).resolve()
    if not plan_dir.is_dir():
        print(f"trace: plan directory not found: {plan_dir}", file=err)
        return 2

    model = load_plan(plan_dir)
    findings = check_plan(model)
    errors = sum(1 for f in findings if f.level == "ERROR")
    exit_code = 0

    if args.json:
        json.dump(model_to_json(model, findings), out, indent=2, ensure_ascii=False, sort_keys=False)
        print(file=out)

    if args.check:
        print_report(model, findings, out)
        if errors:
            exit_code = 1

    if args.regen_status:
        path = plan_dir / STATUS_DOC
        if not path.exists():
            print(f"trace: {path} not found; nothing to regenerate", file=err)
            return 2
        old = read_lines(path)
        new, notes = regenerate_status_lines(model)
        for note in sorted(notes):
            print(f"  {note.render()}", file=out)
        changed = print_diff(path, old, new, out)
        if changed and not args.dry_run:
            atomic_write(path, "\n".join(new))
            print(f"trace: wrote {path}", file=out)
        elif changed:
            print("trace: --dry-run, nothing written", file=out)

    if args.regen_matrix:
        path = plan_dir / MILESTONES_DOC
        body = render_matrix(model)
        if not model.has_matrix_markers:
            print("\n".join(body), file=out)
            print(
                f"\ntrace: NOTE — {MILESTONES_DOC} has no {MATRIX_BEGIN} / {MATRIX_END} "
                f"markers, so nothing was written.\n"
                f"       Add the two markers around the body of §4 "
                f"(between the section heading and `### 4.1`), then re-run "
                f"`--regen-matrix`. This tool will not restructure the plan text itself.",
                file=out,
            )
        else:
            old = read_lines(path)
            new = splice_matrix(old, body)
            changed = print_diff(path, old, new, out)
            if changed and not args.dry_run:
                atomic_write(path, "\n".join(new))
                print(f"trace: wrote {path}", file=out)
            elif changed:
                print("trace: --dry-run, nothing written", file=out)

    return exit_code


def main() -> int:
    return run()


if __name__ == "__main__":
    sys.exit(main())
