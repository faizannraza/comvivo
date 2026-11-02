#!/usr/bin/env python3
"""Unit tests for `scripts/plan/trace.py`.

Run with:

    python3 scripts/plan/trace.test.py

Each test builds a tiny self-contained plan directory from the inline fixture
strings below, so the suite never reads or writes the real `docs/plan/` files.
"""

from __future__ import annotations

import importlib.util
import io
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from typing import Iterable, Sequence

# `trace` is a stdlib module name, so load the script by path under a distinct
# name instead of relying on sys.path ordering.
_SCRIPT = Path(__file__).resolve().parent / "trace.py"
_spec = importlib.util.spec_from_file_location("village_plan_trace", _SCRIPT)
assert _spec is not None and _spec.loader is not None
pt = importlib.util.module_from_spec(_spec)
sys.modules["village_plan_trace"] = pt
_spec.loader.exec_module(pt)


# --------------------------------------------------------------------------- #
# Fixture helpers
# --------------------------------------------------------------------------- #

TASK_HEADER = "| ID | Task | Src | Read | Files | AC | Deps | ‖ |\n|---|---|---|---|---|---|---|---|"

#: A minimal but well-formed M0 table: two tasks, one serial, one parallel.
WELL_FORMED_TABLE = f"""\
## 2. Milestones

### M0 — Foundations

{TASK_HEADER}
| M0-T1 | **Monorepo scaffold.** pnpm workspaces and TS references | 14 (new) | 01 §3 | root `package.json` | `pnpm verify` is green | — | — |
| M0-T2 | **Vitest workspace.** Projects, tags, network guard | 11:M0-T1 | 11 §3.1.2 | `vitest.config.ts` | Projects run | M0-T1 | ‖ |
"""

WELL_FORMED_STATUS = """\
# STATUS

## Decisions log

Nothing yet.

## Milestones

### M0 — Foundations

Status: not started · Tasks: 0/2 · Gate: —

- [ ] M0-T1 Monorepo scaffold
- [ ] M0-T2 Vitest workspace

#### Execution note

_Not written yet._
"""


def write_spec(plan_dir: Path, doc: str, task_ids: Sequence[str], style: str = "table") -> None:
    """Write a minimal `<doc>-*.md` whose §10 defines exactly `task_ids`."""
    lines = ["# spec", "", "## 9. Tests", "", "Nothing.", "", "## 10. Implementation tasks", ""]
    if style == "table":
        lines += ["| ID | Task | Files | Acceptance criteria | Deps |", "|---|---|---|---|---|"]
        lines += [f"| {t} | Do {t} | `src/{t}.ts` | green | — |" for t in task_ids]
    elif style == "bold-bullet":
        lines += [f"- **{t} — Do {t}.** `src/{t}.ts`. *green.* Deps: —." for t in task_ids]
    elif style == "bold-line":
        for t in task_ids:
            lines += [f"**{t} — Do {t}**", f"- Files: `src/{t}.ts`", "- AC: green", ""]
    else:  # pragma: no cover - guard against typos in tests
        raise ValueError(style)
    lines += ["", "## 11. Open questions", "", "None.", ""]
    (plan_dir / f"{doc}-fixture.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def make_plan(
    milestones_md: str,
    status_md: str | None = WELL_FORMED_STATUS,
    specs: dict[str, Sequence[str]] | None = None,
    spec_style: str = "table",
    omit_docs: Sequence[str] = (),
) -> Path:
    """Materialise a throwaway plan directory and return its path.

    All twelve spec docs are written (with an empty §10 unless `specs` names
    tasks for them) because the checker requires every `02`–`13` file to exist.
    `omit_docs` deliberately leaves one out.
    """
    tmp = Path(tempfile.mkdtemp(prefix="trace-test-"))
    (tmp / pt.MILESTONES_DOC).write_text(milestones_md, encoding="utf-8")
    if status_md is not None:
        (tmp / pt.STATUS_DOC).write_text(status_md, encoding="utf-8")
    wanted = dict(specs) if specs is not None else {"11": ["M0-T1"]}
    for doc in pt.SPEC_DOCS:
        if doc in omit_docs:
            continue
        write_spec(tmp, doc, wanted.get(doc, []), style=spec_style)
    return tmp


def codes(findings: Iterable[pt.Finding], level: str | None = None) -> list[str]:
    return [f.code for f in findings if level is None or f.level == level]


def analyse(plan_dir: Path) -> tuple[pt.PlanModel, list[pt.Finding]]:
    model = pt.load_plan(plan_dir)
    return model, pt.check_plan(model)


# --------------------------------------------------------------------------- #
# Tests
# --------------------------------------------------------------------------- #


class TestRowSplitting(unittest.TestCase):
    def test_plain_row(self) -> None:
        self.assertEqual(pt.split_table_row("| a | b | c |"), ["a", "b", "c"])

    def test_escaped_pipes_inside_a_cell(self) -> None:
        row = r"| M9-T1 | **CLI.** `village mcp token list\|revoke <id>` | 09:M9-T1 | — |"
        cells = pt.split_table_row(row)
        self.assertEqual(len(cells), 4)
        self.assertEqual(cells[1], "**CLI.** `village mcp token list|revoke <id>`")

    def test_pipes_inside_a_code_span_are_literal(self) -> None:
        cells = pt.split_table_row("| a | `x | y` | c |")
        self.assertEqual(cells, ["a", "`x | y`", "c"])

    def test_multi_backtick_code_span(self) -> None:
        cells = pt.split_table_row("| a | ``x | ` | y`` | c |")
        self.assertEqual(cells, ["a", "``x | ` | y``", "c"])

    def test_delimiter_detection(self) -> None:
        self.assertTrue(pt.is_delimiter_row(["---", ":---", "---:", ":---:"]))
        self.assertFalse(pt.is_delimiter_row(["---", "x"]))


class TestEscapedPipesEndToEnd(unittest.TestCase):
    """An escaped pipe must not shift the Src / Deps / ‖ columns."""

    MD = f"""\
## 2. Milestones

### M0 — Foundations

{TASK_HEADER}
| M0-T1 | **Monorepo scaffold.** base | 14 (new) | 01 §3 | root `package.json` | green | — | — |
| M0-T2 | **CLI tokens.** `village mcp token list\\|revoke <id>`; also `a \\| b` | 11:M0-T1 | 11 §3 | `apps/cli/src/mcp.ts`, `keys rotate-*\\|verify` | `list\\|revoke` work | M0-T1 | ‖ |
"""

    def test_columns_are_not_shifted(self) -> None:
        plan = make_plan(self.MD)
        model, findings = analyse(plan)
        self.assertNotIn("E-ROW-SHAPE", codes(findings))
        task = model.tasks["M0-T2"]
        self.assertEqual(task.src_raw, "11:M0-T1")
        self.assertEqual(task.deps_raw, "M0-T1")
        self.assertTrue(task.parallel)
        self.assertEqual(task.title, "CLI tokens")
        self.assertIn("keys rotate-*|verify", task.files_raw)

    def test_unescaped_pipe_is_reported_not_silently_eaten(self) -> None:
        broken = self.MD.replace("`village mcp token list\\|revoke <id>`", "list|revoke")
        model, findings = analyse(make_plan(broken))
        self.assertIn("E-ROW-SHAPE", codes(findings, "ERROR"))
        self.assertNotIn("M0-T2", model.tasks)


class TestWellFormedTable(unittest.TestCase):
    def test_parses_tasks_titles_and_tags(self) -> None:
        plan = make_plan(WELL_FORMED_TABLE)
        model, findings = analyse(plan)
        self.assertEqual(sorted(model.tasks), ["M0-T1", "M0-T2"])
        self.assertEqual(model.tasks["M0-T1"].title, "Monorepo scaffold")
        self.assertEqual(model.tasks["M0-T1"].milestone, 0)
        self.assertEqual(model.tasks["M0-T1"].number, 1)
        self.assertTrue(model.tasks["M0-T1"].src_is_new)
        self.assertFalse(model.tasks["M0-T1"].parallel)
        self.assertTrue(model.tasks["M0-T2"].parallel)
        self.assertEqual([str(r) for r in model.tasks["M0-T2"].src_refs], ["11:M0-T1"])
        self.assertEqual(codes(findings, "ERROR"), [])
        self.assertEqual(codes(findings, "WARN"), [])

    def test_check_mode_exits_zero(self) -> None:
        plan = make_plan(WELL_FORMED_TABLE)
        out = io.StringIO()
        rc = pt.run(["--check", "--plan-dir", str(plan)], stdout=out, stderr=out)
        self.assertEqual(rc, 0, out.getvalue())
        self.assertIn("trace: 2 tasks across 1 milestones", out.getvalue())

    def test_title_keeps_internal_periods(self) -> None:
        self.assertEqual(
            pt.extract_title("**SP-9: transformers.js Whisper fallback.** WER and latency"),
            "SP-9: transformers.js Whisper fallback",
        )
        self.assertEqual(
            pt.extract_title("**Telegram native polls & `poll.close`.** Native polls"),
            "Telegram native polls & `poll.close`",
        )

    def test_br_tags_are_normalised(self) -> None:
        self.assertEqual(pt.extract_title("**A<br/>B.** rest"), "A B")

    def test_src_cell_ignores_parenthetical_annotations(self) -> None:
        refs, is_new = pt.parse_src_cell(
            "14 (new), 08:M1-T83 (library, CLI wiring in `M3-T13`), 11:M3-T3 (`Crashpoints` port)"
        )
        self.assertTrue(is_new)
        self.assertEqual([str(r) for r in refs], ["08:M1-T83", "11:M3-T3"])


class TestForwardDependency(unittest.TestCase):
    SAME_MILESTONE = f"""\
## 2. Milestones

### M0 — Foundations

{TASK_HEADER}
| M0-T1 | **Monorepo scaffold.** base | 14 (new) | 01 §3 | root `package.json` | green | M0-T2 | — |
| M0-T2 | **Vitest workspace.** tests | 11:M0-T1 | 11 §3 | `vitest.config.ts` | green | — | ‖ |
"""

    LATER_MILESTONE = f"""\
## 2. Milestones

### M0 — Foundations

{TASK_HEADER}
| M0-T1 | **Monorepo scaffold.** base | 14 (new) | 01 §3 | root `package.json` | green | M1-T1 | — |
| M0-T2 | **Vitest workspace.** tests | 11:M0-T1 | 11 §3 | `vitest.config.ts` | green | — | ‖ |

### M1 — Storage

{TASK_HEADER}
| M1-T1 | **Storage scaffold.** base | 11:M1-T1 | 02 §3 | `packages/storage/src/index.ts` | green | — | — |
"""

    def test_dependency_on_a_later_row_of_the_same_milestone_is_an_error(self) -> None:
        plan = make_plan(self.SAME_MILESTONE)
        _, findings = analyse(plan)
        forward = [f for f in findings if f.code == "E-DEP-FORWARD"]
        self.assertEqual(len(forward), 1, [f.render() for f in findings])
        self.assertIn("later in the same table", forward[0].message)
        self.assertEqual(forward[0].level, "ERROR")

    def test_dependency_on_a_later_milestone_is_an_error(self) -> None:
        status = WELL_FORMED_STATUS + textwrap.dedent(
            """\

            ### M1 — Storage

            Status: not started · Tasks: 0/1 · Gate: —

            - [ ] M1-T1 Storage scaffold
            """
        )
        plan = make_plan(
            self.LATER_MILESTONE, status, specs={"11": ["M0-T1", "M1-T1"]}
        )
        _, findings = analyse(plan)
        forward = [f for f in findings if f.code == "E-DEP-FORWARD"]
        self.assertEqual(len(forward), 1, [f.render() for f in findings])
        self.assertIn("later M1", forward[0].message)

    def test_check_mode_exits_one(self) -> None:
        plan = make_plan(self.SAME_MILESTONE)
        out = io.StringIO()
        self.assertEqual(pt.run(["--check", "--plan-dir", str(plan)], stdout=out, stderr=out), 1)

    def test_backward_and_milestone_level_deps_are_fine(self) -> None:
        md = WELL_FORMED_TABLE.replace(
            "| Projects run | M0-T1 |", "| Projects run | M0-T1, M0 gate |"
        )
        self.assertNotEqual(md, WELL_FORMED_TABLE)
        _, findings = analyse(make_plan(md))
        self.assertEqual([f for f in findings if f.code.startswith("E-DEP")], [])

    def test_dependency_ranges_expand(self) -> None:
        task = pt.Task(
            task_id="M1-T9",
            milestone=1,
            number=9,
            title="t",
            order=8,
            src_raw="",
            src_refs=[],
            src_is_new=True,
            files_raw="",
            deps_raw="M1-T2–M1-T5, M1-T7, M0 gate, M6-T6 (v0 subset)",
            parallel_raw="—",
            lineno=1,
            tombstone=False,
        )
        task_ids, milestones, unparsed = pt.parse_deps(task)
        self.assertEqual(task_ids, ["M1-T2", "M1-T3", "M1-T4", "M1-T5", "M1-T7", "M6-T6"])
        self.assertEqual(milestones, [0])
        self.assertEqual(unparsed, [])

    def test_unknown_dependency_is_an_error(self) -> None:
        md = WELL_FORMED_TABLE.replace("| Projects run | M0-T1 |", "| Projects run | M0-T9 |")
        _, findings = analyse(make_plan(md))
        self.assertIn("E-DEP-UNKNOWN", codes(findings, "ERROR"))


class TestSrcReferences(unittest.TestCase):
    UNKNOWN_DOC = f"""\
## 2. Milestones

### M0 — Foundations

{TASK_HEADER}
| M0-T1 | **Monorepo scaffold.** base | 14 (new) | 01 §3 | root `package.json` | green | — | — |
| M0-T2 | **Vitest workspace.** tests | 99:M0-T1 | 11 §3 | `vitest.config.ts` | green | M0-T1 | ‖ |
"""

    UNKNOWN_TASK = f"""\
## 2. Milestones

### M0 — Foundations

{TASK_HEADER}
| M0-T1 | **Monorepo scaffold.** base | 14 (new) | 01 §3 | root `package.json` | green | — | — |
| M0-T2 | **Vitest workspace.** tests | 11:M0-T77 | 11 §3 | `vitest.config.ts` | green | M0-T1 | ‖ |
"""

    def test_unknown_src_doc_is_an_error(self) -> None:
        plan = make_plan(self.UNKNOWN_DOC, specs={"11": []})
        _, findings = analyse(plan)
        bad = [f for f in findings if f.code == "E-SRC-UNKNOWN-DOC"]
        self.assertEqual(len(bad), 1, [f.render() for f in findings])
        self.assertEqual(bad[0].level, "ERROR")
        self.assertIn("99", bad[0].message)

    def test_missing_src_doc_file_is_an_error(self) -> None:
        # `11` is a legitimate doc number, but no `11-*.md` file exists here.
        plan = make_plan(WELL_FORMED_TABLE, omit_docs=("11",))
        _, findings = analyse(plan)
        self.assertIn("E-SPEC-MISSING", codes(findings, "ERROR"))
        self.assertIn("E-SRC-UNKNOWN-DOC", codes(findings, "ERROR"))

    def test_unknown_spec_task_is_an_error(self) -> None:
        plan = make_plan(self.UNKNOWN_TASK, specs={"11": ["M0-T1"]})
        _, findings = analyse(plan)
        self.assertIn("E-SRC-UNKNOWN-TASK", codes(findings, "ERROR"))
        # ...and M0-T1 of `11` is now claimed by nobody.
        self.assertIn("E-SRC-UNMAPPED", codes(findings, "ERROR"))

    def test_unmapped_spec_task_is_an_error(self) -> None:
        plan = make_plan(WELL_FORMED_TABLE, specs={"11": ["M0-T1", "M0-T9"]})
        _, findings = analyse(plan)
        unmapped = [f for f in findings if f.code == "E-SRC-UNMAPPED"]
        self.assertEqual(len(unmapped), 1, [f.render() for f in findings])
        self.assertIn("11:M0-T9", unmapped[0].message)

    def test_src_cell_with_no_reference_at_all_is_an_error(self) -> None:
        md = WELL_FORMED_TABLE.replace("| 11:M0-T1 |", "| see 11 |")
        _, findings = analyse(make_plan(md, specs={"11": []}))
        self.assertIn("E-SRC-EMPTY", codes(findings, "ERROR"))

    def test_spec_task_shapes_are_all_recognised(self) -> None:
        for style in ("table", "bold-bullet", "bold-line"):
            with self.subTest(style=style):
                plan = make_plan(WELL_FORMED_TABLE, specs={"11": ["M0-T1"]}, spec_style=style)
                model, findings = analyse(plan)
                self.assertEqual(list(model.spec_tasks), ["11:M0-T1"])
                self.assertEqual(codes(findings, "ERROR"), [])

    def test_collapsed_range_entry_expands(self) -> None:
        """`05` §10 writes five tasks as one `M13-T1–T5` bullet."""
        tmp = Path(tempfile.mkdtemp(prefix="trace-test-"))
        (tmp / "05-fixture.md").write_text(
            "# spec\n\n## 10. Implementation tasks\n\n"
            "- **M13-T1–T5 — Hardening:** final TTL and effort strategy.\n\n"
            "## 11. Refs\n",
            encoding="utf-8",
        )
        found = pt.parse_spec_tasks(tmp, "05", [])
        self.assertEqual([s.local_id for s in found], [f"M13-T{k}" for k in range(1, 6)])
        self.assertTrue(all(s.expanded_from == "M13-T1–T5" for s in found))

    def test_suffixed_spec_ids_are_recognised(self) -> None:
        """`02:M3-T-S1`, `09:M3-T901` and `07:M10-T-C3` must all parse."""
        plan = make_plan(
            WELL_FORMED_TABLE.replace("| 11:M0-T1 |", "| 02:M3-T-S1, 09:M3-T901, 07:M10-T-C3 |"),
            specs={"02": ["M3-T-S1"], "09": ["M3-T901"], "07": ["M10-T-C3"], "11": []},
        )
        model, findings = analyse(plan)
        self.assertEqual(
            sorted(model.spec_tasks), ["02:M3-T-S1", "07:M10-T-C3", "09:M3-T901"]
        )
        self.assertEqual(codes(findings, "ERROR"), [])


class TestSerialViolation(unittest.TestCase):
    POLICY = f"""\
## 2. Milestones

### M0 — Foundations

{TASK_HEADER}
| M0-T1 | **Monorepo scaffold.** base | 14 (new) | 01 §3 | root `package.json` | green | — | — |
| M0-T2 | **authorize().** policy decisions | 11:M0-T1 | 03 §3.3.3 | `packages/core/src/policy/{{authorize,contest}}.ts` | green | M0-T1 | ‖ |
"""

    def test_parallel_row_touching_core_policy_is_a_serial_violation(self) -> None:
        plan = make_plan(self.POLICY)
        _, findings = analyse(plan)
        hits = [f for f in findings if f.code == "SERIAL-VIOLATION"]
        self.assertEqual(len(hits), 1, [f.render() for f in findings])
        self.assertEqual(hits[0].level, "ERROR")
        self.assertIn("M0-T2", hits[0].message)
        self.assertIn("core/src/policy", hits[0].message)

    def test_serial_row_touching_core_policy_is_fine(self) -> None:
        plan = make_plan(self.POLICY.replace("| M0-T1 | ‖ |", "| M0-T1 | — |"))
        _, findings = analyse(plan)
        self.assertEqual([f for f in findings if f.code == "SERIAL-VIOLATION"], [])

    def test_every_sensitive_core_dir_and_migrations_are_detected(self) -> None:
        for directory in pt.SERIAL_CORE_DIRS:
            with self.subTest(directory=directory):
                self.assertEqual(
                    pt.serial_area_hits(f"`packages/core/src/{directory}/x.ts`"),
                    [f"core/src/{directory}"],
                )
                self.assertEqual(
                    pt.serial_area_hits(f"`core/src/{{{directory},other}}.ts`"),
                    [f"core/src/{directory}"],
                )
        self.assertEqual(
            pt.serial_area_hits("`packages/storage/migrations/0001_init/`"),
            ["migration path 'packages/storage/migrations/0001_init/'"],
        )
        self.assertEqual(
            pt.serial_area_hits("`src/migrate/data-migration.ts`"),
            ["migration path 'src/migrate/data-migration.ts'"],
        )
        self.assertEqual(
            pt.serial_area_hits("`MIGRATIONS.md`, `docs/architecture/storage.md`"),
            ["migration path 'MIGRATIONS.md'"],
        )

    def test_unrelated_core_dirs_are_not_flagged(self) -> None:
        self.assertEqual(pt.serial_area_hits("`packages/core/src/time/when.ts`"), [])
        self.assertEqual(pt.serial_area_hits("`packages/channels/telegram/src/probe.ts`"), [])

    def test_bad_parallel_column_value(self) -> None:
        md = WELL_FORMED_TABLE.replace("| M0-T1 | ‖ |", "| M0-T1 | yes |")
        _, findings = analyse(make_plan(md))
        self.assertIn("E-PARALLEL-VALUE", codes(findings, "ERROR"))


class TestStatusConsistency(unittest.TestCase):
    def test_count_mismatch_is_an_error(self) -> None:
        status = WELL_FORMED_STATUS.replace("Tasks: 0/2", "Tasks: 1/3")
        plan = make_plan(WELL_FORMED_TABLE, status)
        _, findings = analyse(plan)
        counts = [f for f in findings if f.code == "E-STATUS-COUNT"]
        self.assertEqual(len(counts), 2, [f.render() for f in findings])
        self.assertTrue(any("checklist has 0/2" in f.message for f in counts))
        self.assertTrue(any("`14` §2 has 2" in f.message for f in counts))

    def test_ticked_box_must_be_counted(self) -> None:
        status = WELL_FORMED_STATUS.replace("- [ ] M0-T1", "- [x] M0-T1")
        _, findings = analyse(make_plan(WELL_FORMED_TABLE, status))
        counts = [f for f in findings if f.code == "E-STATUS-COUNT"]
        self.assertEqual(len(counts), 1)
        self.assertIn("declares Tasks: 0/2 but the checklist has 1/2", counts[0].message)

    def test_missing_unknown_and_mistitled_lines(self) -> None:
        status = WELL_FORMED_STATUS.replace(
            "- [ ] M0-T2 Vitest workspace",
            "- [ ] M0-T2 Vitest workbench\n- [ ] M0-T7 Ghost task",
        ).replace("Tasks: 0/2", "Tasks: 0/3")
        _, findings = analyse(make_plan(WELL_FORMED_TABLE, status))
        found = codes(findings, "ERROR")
        self.assertIn("E-STATUS-TITLE", found)
        self.assertIn("E-STATUS-UNKNOWN-TASK", found)
        self.assertIn("E-STATUS-COUNT", found)

    def test_trailing_note_after_the_title_is_allowed(self) -> None:
        status = WELL_FORMED_STATUS.replace(
            "- [ ] M0-T1 Monorepo scaffold", "- [x] M0-T1 Monorepo scaffold (abc1234)"
        ).replace("Tasks: 0/2", "Tasks: 1/2")
        _, findings = analyse(make_plan(WELL_FORMED_TABLE, status))
        self.assertEqual(codes(findings, "ERROR"), [])

    def test_missing_milestone_section(self) -> None:
        status = WELL_FORMED_STATUS.replace("### M0 — Foundations", "### M4 — Policy")
        _, findings = analyse(make_plan(WELL_FORMED_TABLE, status))
        found = codes(findings, "ERROR")
        self.assertIn("E-STATUS-NO-MILESTONE", found)
        self.assertIn("E-STATUS-UNKNOWN-MILESTONE", found)


class TestRegenStatus(unittest.TestCase):
    def test_rewrites_counts_and_restores_lines_while_preserving_marks(self) -> None:
        status = """\
# STATUS

## Decisions log

Keep me exactly as I am.

## Milestones

### M0 — Foundations

Status: in progress · Tasks: 0/9 · Gate: —

- [x] M0-T1 Monorepo scaffold (abc1234)

#### Execution note

_Keep me too._
"""
        plan = make_plan(WELL_FORMED_TABLE, status)
        out = io.StringIO()
        rc = pt.run(["--regen-status", "--plan-dir", str(plan)], stdout=out, stderr=out)
        self.assertEqual(rc, 0, out.getvalue())
        text = (plan / pt.STATUS_DOC).read_text(encoding="utf-8")
        self.assertIn("Status: in progress · Tasks: 1/2 · Gate: —", text)
        self.assertIn("- [x] M0-T1 Monorepo scaffold (abc1234)", text)
        self.assertIn("- [ ] M0-T2 Vitest workspace", text)
        self.assertIn("Keep me exactly as I am.", text)
        self.assertIn("_Keep me too._", text)
        # And the result now checks clean.
        _, findings = analyse(plan)
        self.assertEqual([f for f in findings if f.code.startswith("E-STATUS")], [])

    def test_dry_run_writes_nothing_but_prints_a_diff(self) -> None:
        status = WELL_FORMED_STATUS.replace("Tasks: 0/2", "Tasks: 0/5")
        plan = make_plan(WELL_FORMED_TABLE, status)
        before = (plan / pt.STATUS_DOC).read_text(encoding="utf-8")
        out = io.StringIO()
        pt.run(["--regen-status", "--dry-run", "--plan-dir", str(plan)], stdout=out, stderr=out)
        self.assertEqual((plan / pt.STATUS_DOC).read_text(encoding="utf-8"), before)
        self.assertIn("-Status: not started · Tasks: 0/5", out.getvalue())
        self.assertIn("+Status: not started · Tasks: 0/2", out.getvalue())
        self.assertIn("--dry-run, nothing written", out.getvalue())

    def test_inserts_a_checklist_where_a_milestone_has_none(self) -> None:
        status = """\
# STATUS

## Milestones

### M0 — Foundations

Status: not started · Tasks: 0/0 · Gate: —

#### Execution note

_Not written yet._
"""
        plan = make_plan(WELL_FORMED_TABLE, status)
        out = io.StringIO()
        pt.run(["--regen-status", "--plan-dir", str(plan)], stdout=out, stderr=out)
        text = (plan / pt.STATUS_DOC).read_text(encoding="utf-8")
        self.assertIn("Status: not started · Tasks: 0/2 · Gate: —", text)
        self.assertIn("- [ ] M0-T1 Monorepo scaffold\n- [ ] M0-T2 Vitest workspace", text)
        self.assertIn("#### Execution note", text)
        _, findings = analyse(plan)
        self.assertEqual([f for f in findings if f.code.startswith("E-STATUS")], [])

    def test_is_idempotent(self) -> None:
        plan = make_plan(WELL_FORMED_TABLE)
        out = io.StringIO()
        pt.run(["--regen-status", "--plan-dir", str(plan)], stdout=out, stderr=out)
        self.assertIn("already up to date", out.getvalue())

    def test_a_line_for_a_vanished_task_is_kept_not_deleted(self) -> None:
        status = WELL_FORMED_STATUS.replace(
            "- [ ] M0-T2 Vitest workspace",
            "- [ ] M0-T2 Vitest workspace\n- [x] M0-T8 Removed task (deadbeef)",
        ).replace("Tasks: 0/2", "Tasks: 1/3")
        plan = make_plan(WELL_FORMED_TABLE, status)
        out = io.StringIO()
        pt.run(["--regen-status", "--plan-dir", str(plan)], stdout=out, stderr=out)
        text = (plan / pt.STATUS_DOC).read_text(encoding="utf-8")
        self.assertIn("- [x] M0-T8 Removed task (deadbeef)", text)
        self.assertIn("W-REGEN-ORPHAN", out.getvalue())

    def test_preserved_suffix_rules(self) -> None:
        self.assertEqual(pt._preserved_suffix("Monorepo scaffold (abc1234)", "Monorepo scaffold"), " (abc1234)")
        self.assertEqual(pt._preserved_suffix("Old title — see note", "New title"), " — see note")
        self.assertEqual(pt._preserved_suffix("Old title", "New title"), "")


class TestRegenMatrix(unittest.TestCase):
    def test_without_markers_nothing_is_written_and_a_note_is_printed(self) -> None:
        plan = make_plan(WELL_FORMED_TABLE)
        before = (plan / pt.MILESTONES_DOC).read_text(encoding="utf-8")
        out = io.StringIO()
        rc = pt.run(["--regen-matrix", "--plan-dir", str(plan)], stdout=out, stderr=out)
        self.assertEqual(rc, 0)
        self.assertEqual((plan / pt.MILESTONES_DOC).read_text(encoding="utf-8"), before)
        printed = out.getvalue()
        self.assertIn("| `11:M0-T1` | → | M0-T2 |", printed)
        self.assertIn("has no <!-- BEGIN:TRACE-MATRIX -->", printed)
        self.assertIn("nothing was written", printed)

    def test_with_markers_the_body_is_spliced_in_place(self) -> None:
        md = WELL_FORMED_TABLE + textwrap.dedent(
            f"""\

            ## 4. Traceability matrix

            {pt.MATRIX_BEGIN}
            stale content
            {pt.MATRIX_END}

            ### 4.1 Later

            end
            """
        )
        plan = make_plan(md)
        out = io.StringIO()
        pt.run(["--regen-matrix", "--plan-dir", str(plan)], stdout=out, stderr=out)
        text = (plan / pt.MILESTONES_DOC).read_text(encoding="utf-8")
        self.assertNotIn("stale content", text)
        self.assertIn("| `11:M0-T1` | → | M0-T2 |", text)
        self.assertIn("### 4.1 Later", text)
        self.assertTrue(text.rstrip().endswith("end"))

    def test_split_and_moved_markers(self) -> None:
        md = f"""\
## 2. Milestones

### M0 — Foundations

{TASK_HEADER}
| M0-T1 | **Part one.** a | 11:M1-T1 | 11 §3 | `a.ts` | green | — | — |

### M1 — Storage

{TASK_HEADER}
| M1-T1 | **Part two.** b | 11:M1-T1 | 11 §3 | `b.ts` | green | — | — |
"""
        status = """\
# STATUS

## Milestones

### M0 — Foundations

Status: not started · Tasks: 0/1 · Gate: —

- [ ] M0-T1 Part one

### M1 — Storage

Status: not started · Tasks: 0/1 · Gate: —

- [ ] M1-T1 Part two
"""
        plan = make_plan(md, status, specs={"11": ["M1-T1"]})
        model, _ = analyse(plan)
        rendered = "\n".join(pt.render_matrix(model))
        # Two canonical tasks carry it ("+"), and M0-T1 is not in M1 ("⇢").
        self.assertIn("| `11:M1-T1` | → | M0-T1, M1-T1 + ⇢ |", rendered)

    def test_existing_matrix_drift_is_a_warning(self) -> None:
        md = WELL_FORMED_TABLE + textwrap.dedent(
            """\

            ## 4. Traceability matrix

            | Doc | Spec tasks | Count |
            |---|---|---|
            | `11` Quality | `11:M0-T1` | 7 |

            #### `11` — Quality

            | Spec | → | Spec | → | Spec | → |
            |---|---|---|---|---|---|
            | `11:M0-T1` | M0-T1 | | | | |

            ### 4.1 Later

            end
            """
        )
        _, findings = analyse(make_plan(md))
        self.assertIn("W-MATRIX-DRIFT", codes(findings, "WARN"))
        self.assertIn("W-MATRIX-COUNT", codes(findings, "WARN"))


class TestIdAndNumbering(unittest.TestCase):
    def test_bad_id_format(self) -> None:
        md = WELL_FORMED_TABLE.replace("| M0-T2 |", "| M0-Tx |")
        _, findings = analyse(make_plan(md))
        self.assertIn("E-ID-FORMAT", codes(findings, "ERROR"))

    def test_id_in_the_wrong_milestone_section(self) -> None:
        md = WELL_FORMED_TABLE.replace("| M0-T2 |", "| M4-T2 |")
        _, findings = analyse(make_plan(md))
        self.assertIn("E-ID-MILESTONE", codes(findings, "ERROR"))

    def test_duplicate_number(self) -> None:
        md = WELL_FORMED_TABLE.replace("| M0-T2 |", "| M0-T1 |")
        _, findings = analyse(make_plan(md))
        self.assertIn("E-ID-DUPLICATE", codes(findings, "ERROR"))

    def test_numbering_gap_is_only_a_warning(self) -> None:
        md = WELL_FORMED_TABLE.replace("| M0-T2 |", "| M0-T5 |")
        status = WELL_FORMED_STATUS.replace("M0-T2 Vitest workspace", "M0-T5 Vitest workspace")
        _, findings = analyse(make_plan(md, status))
        self.assertEqual(codes(findings, "ERROR"), [])
        gaps = [f for f in findings if f.code == "W-ID-GAP"]
        self.assertEqual(len(gaps), 1)
        self.assertIn("never renumber", gaps[0].message)


class TestCli(unittest.TestCase):
    def test_no_mode_prints_help_and_exits_two(self) -> None:
        out, err = io.StringIO(), io.StringIO()
        rc = pt.run(["--plan-dir", "."], stdout=out, stderr=err)
        self.assertEqual(rc, 2)
        self.assertIn("--regen-status", out.getvalue())
        self.assertIn("pick a mode", err.getvalue())

    def test_missing_plan_dir_exits_two(self) -> None:
        out, err = io.StringIO(), io.StringIO()
        rc = pt.run(["--check", "--plan-dir", "/nonexistent/plan/dir"], stdout=out, stderr=err)
        self.assertEqual(rc, 2)
        self.assertIn("plan directory not found", err.getvalue())

    def test_json_mode_emits_the_parsed_model(self) -> None:
        import json

        plan = make_plan(WELL_FORMED_TABLE)
        out = io.StringIO()
        rc = pt.run(["--json", "--plan-dir", str(plan)], stdout=out, stderr=out)
        self.assertEqual(rc, 0)
        payload = json.loads(out.getvalue())
        self.assertEqual(payload["summary"]["taskCount"], 2)
        self.assertEqual(payload["summary"]["specTaskCount"], 1)
        self.assertEqual(payload["srcMappings"], {"11:M0-T1": ["M0-T2"]})
        self.assertEqual(payload["unmappedSpecTasks"], [])
        self.assertEqual([t["id"] for t in payload["tasks"]], ["M0-T1", "M0-T2"])

    def test_output_order_is_deterministic(self) -> None:
        plan = make_plan(TestSerialViolation.POLICY)
        runs = []
        for _ in range(3):
            out = io.StringIO()
            pt.run(["--check", "--plan-dir", str(plan)], stdout=out, stderr=out)
            runs.append(out.getvalue())
        self.assertEqual(len(set(runs)), 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
