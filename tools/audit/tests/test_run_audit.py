import json

from . import helpers
from .helpers import TempDirTestCase
from .package_helpers import CAPTURE_NAME, build_package, make_git_repo, rewrite_package

from auditlib.toolset import toolset_commit


def visible_solid_fills(node):
    """The visible SOLID fills of the visible nodes, counted from the golden file without the toolset."""
    styles = node.get('styles', {})
    if styles.get('visible') is False:
        return 0
    own = sum(1 for p in styles.get('fills', []) if isinstance(p, dict) and p.get('type') == 'SOLID' and p.get('visible') is not False)
    return own + sum(visible_solid_fills(child) for child in node.get('children', []))


class RunAuditTest(TempDirTestCase):
    def setUp(self):
        super().setUp()
        self.package = build_package(self.tmp)
        self.outputs = self.tmp / 'out'

    def run_audit(self, *extra):
        return helpers.run_script('run_audit.py', self.package, '--outputs', self.outputs, *extra)

    def lines(self):
        return (self.outputs / 'run_audit.txt').read_text(encoding='utf-8').splitlines()

    def package_data(self):
        return json.loads((self.package / 'audit-package.json').read_text(encoding='utf-8'))

    def test_the_recorded_figure_is_not_taken_on_trust(self):
        # The nine of the package is the count of the golden file, worked out here by another route.
        self.assertEqual(visible_solid_fills(helpers.golden('screen')), 9)

    def test_a_package_that_matches(self):
        done = self.run_audit()
        self.assertEqual(done.returncode, 0, done.stderr)
        lines = self.lines()
        self.assertEqual(lines[-1], 'RERUN MATCH figures=13 mismatched=0 verdict=PASS')
        self.assertIn('MATCH census-screen unbound_paints.count observed=9 expected=9', lines)
        self.assertIn('MATCH tiles tile_count observed=6 expected=6', lines)
        self.assertIn('MATCH acceptance checks.C-1.observed observed=2 expected=2', lines)
        self.assertIn('MATCH report verdict observed="PASS" expected="PASS"', lines)
        self.assertEqual(done.stdout.splitlines(), lines)

    def test_it_writes_only_under_the_outputs_folder(self):
        before = {p: p.read_bytes() for p in self.package.rglob('*') if p.is_file()}
        self.assertEqual(self.run_audit().returncode, 0)
        after = {p: p.read_bytes() for p in self.package.rglob('*') if p.is_file()}
        self.assertEqual(before, after)
        names = {p.relative_to(self.outputs).as_posix() for p in self.outputs.rglob('*') if p.is_file()}
        self.assertIn('report.md', names)
        self.assertIn('run_audit.json', names)
        self.assertIn('scripts/census-screen/census-screen.census.json', names)
        self.assertIn('scripts/acceptance/acceptance.assert.json', names)
        self.assertIn('scripts/tiles/tiles.r00c00.png', names)

    def test_the_report_is_rendered_from_the_package(self):
        # The package has no tile declaration check problem: the surfaces name tiles that tile.py wrote.
        self.assertEqual(self.run_audit().returncode, 0)
        report = (self.outputs / 'report.md').read_text(encoding='utf-8')
        self.assertIn('Verdict: **PASS**', report)
        self.assertIn('dumps/run1/manifest.json', report)
        self.assertIn(f'captures/{CAPTURE_NAME}', report)
        self.assertIn(f'Toolset commit: `{toolset_commit()}`', report)

    def test_a_second_run_gives_the_same_report(self):
        self.assertEqual(self.run_audit().returncode, 0)
        first = (self.outputs / 'report.md').read_bytes()
        again = self.tmp / 'again'
        done = helpers.run_script('run_audit.py', self.package, '--outputs', again)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual((again / 'report.md').read_bytes(), first)

    def test_a_changed_figure_is_a_mismatch(self):
        data = self.package_data()
        data['runs'][1]['figures']['unbound_paints.count'] = 8
        rewrite_package(self.package, runs=data['runs'])
        done = self.run_audit()
        self.assertEqual(done.returncode, 1, done.stderr)
        lines = self.lines()
        self.assertIn('MISMATCH census-screen unbound_paints.count observed=9 expected=8', lines)
        self.assertIn('RERUN MISMATCH figures=13 mismatched=1 verdict=PASS', lines)
        # The other figures were still compared and still match.
        self.assertIn('MATCH tiles tile_count observed=6 expected=6', lines)

    def test_a_figure_that_no_script_gives_is_a_mismatch(self):
        data = self.package_data()
        data['runs'][0]['figures'] = {'nothing.here': 1}
        rewrite_package(self.package, runs=data['runs'])
        done = self.run_audit()
        self.assertEqual(done.returncode, 1)
        self.assertIn('MISMATCH completeness-set nothing.here observed="(no such figure)" expected=1', self.lines())

    def test_a_changed_verdict_and_a_changed_acceptance_figure_are_mismatches(self):
        data = self.package_data()
        data['acceptance']['figures']['summary.checks'] = 4
        rewrite_package(self.package, acceptance=data['acceptance'], recorded={'verdict': 'FAIL'})
        done = self.run_audit()
        self.assertEqual(done.returncode, 1)
        lines = self.lines()
        self.assertIn('MISMATCH acceptance summary.checks observed=3 expected=4', lines)
        self.assertIn('MISMATCH report verdict observed="PASS" expected="FAIL"', lines)

    def test_a_package_that_recorded_nothing_compares_nothing(self):
        data = self.package_data()
        for run in data['runs']:
            del run['figures']
        del data['acceptance']['figures']
        rewrite_package(self.package, runs=data['runs'], acceptance=data['acceptance'], recorded={})
        done = self.run_audit()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.lines()[-2:], ['NOTE the package recorded no figure, so nothing was compared', 'RERUN MATCH figures=0 mismatched=0 verdict=PASS'])

    # ── Step 1: the SHA-256 of each file ──

    def test_a_file_with_a_wrong_sha256_stops_the_run(self):
        with open(self.package / 'dumps' / 'run1' / 'N9.json', 'ab') as f:
            f.write(b' ')
        done = self.run_audit()
        self.assertEqual(done.returncode, 2)
        self.assertIn('N9.json', done.stderr)
        self.assertIn('manifest', done.stderr)
        self.assertFalse(self.outputs.exists())

    def test_a_capture_that_changed_stops_the_run(self):
        capture = self.package / 'captures' / 'frame.png'
        capture.write_bytes(capture.read_bytes()[:-1] + b'\x00')
        done = self.run_audit()
        self.assertEqual(done.returncode, 2)
        self.assertIn('frame.png', done.stderr)

    def test_a_manifest_of_the_wrong_tool_is_refused(self):
        rewrite_package(
            self.package,
            dump_calls=[{'name': 'wrong', 'manifest': f'captures/{CAPTURE_NAME}'}],
        )
        done = self.run_audit()
        self.assertEqual(done.returncode, 2)
        self.assertIn('manifest of save_screenshots', done.stderr)

    # ── Step 2: the toolset commit ──

    def test_a_toolset_commit_that_differs_is_refused(self):
        rewrite_package(self.package, toolset_commit='a' * 40)
        done = self.run_audit()
        self.assertEqual(done.returncode, 2)
        self.assertIn('the package recorded ' + 'a' * 40, done.stderr)
        self.assertIn('--allow-other-commit', done.stderr)
        self.assertFalse(self.outputs.exists())

    def test_allow_other_commit_runs_and_says_so(self):
        rewrite_package(self.package, toolset_commit='a' * 40)
        done = self.run_audit('--allow-other-commit')
        self.assertEqual(done.returncode, 0, done.stderr)
        lines = self.lines()
        self.assertTrue(lines[0].startswith('WARNING the toolset is at '))
        self.assertIn('not at the recorded ' + 'a' * 40, lines[0])
        record = json.loads((self.outputs / 'run_audit.json').read_text(encoding='utf-8'))
        self.assertEqual(record['toolset']['same'], False)
        report = (self.outputs / 'report.md').read_text(encoding='utf-8')
        self.assertIn(f'Toolset commit: `{toolset_commit()}`', report)

    def test_a_clean_checkout_at_the_recorded_commit_and_a_dirty_one(self):
        repo = self.tmp / 'toolset'
        commit = make_git_repo(repo)
        rewrite_package(self.package, toolset_commit=commit)
        self.assertEqual(self.run_audit('--toolset-dir', repo).returncode, 0)
        (repo / 'file.txt').write_text('changed\n', encoding='utf-8')
        done = self.run_audit('--toolset-dir', repo)
        self.assertEqual(done.returncode, 2)
        self.assertIn(f'the toolset is at {commit}-dirty', done.stderr)

    # ── The layout of the package ──

    def test_every_problem_of_the_layout_is_listed(self):
        rewrite_package(
            self.package,
            schema=2,
            toolset_commit='abc',
            runs=[
                {'id': 'a', 'script': 'unknown', 'inputs': {}},
                {'id': 'a b', 'script': 'census', 'inputs': {'dump': 'dumps/run1', 'extra': 1}},
            ],
            surprise=True,
        )
        done = self.run_audit()
        self.assertEqual(done.returncode, 2)
        for fragment in (
            'unknown keys surprise',
            'schema: must be 1',
            'toolset_commit: must be the full commit',
            'runs[0].script: "unknown"',
            'runs[1].id',
            'runs[1].inputs: unknown keys extra',
            'runs[1].inputs.variables: is required',
        ):
            self.assertIn(fragment, done.stderr)

    def test_a_path_that_leaves_the_package_is_refused(self):
        data = self.package_data()
        data['runs'][1]['inputs']['exemptions'] = '../outside.json'
        rewrite_package(self.package, runs=data['runs'])
        done = self.run_audit()
        self.assertEqual(done.returncode, 2)
        self.assertIn('runs[1].inputs.exemptions', done.stderr)
        self.assertIn('no ".."', done.stderr)
        data['runs'][1]['inputs']['exemptions'] = str((self.tmp / 'x.json').resolve())
        rewrite_package(self.package, runs=data['runs'])
        self.assertEqual(self.run_audit().returncode, 2)

    def test_a_missing_file_of_the_package_is_refused(self):
        (self.package / 'inputs' / 'defects.json').unlink()
        done = self.run_audit()
        self.assertEqual(done.returncode, 2)
        self.assertIn('inputs.defects: "inputs/defects.json" is missing from the package', done.stderr)

    def test_the_package_folder_and_its_file_must_exist(self):
        done = helpers.run_script('run_audit.py', self.tmp / 'nowhere', '--outputs', self.outputs)
        self.assertEqual(done.returncode, 2)
        (self.tmp / 'empty').mkdir()
        done = helpers.run_script('run_audit.py', self.tmp / 'empty', '--outputs', self.outputs)
        self.assertEqual(done.returncode, 2)
        self.assertIn('audit-package.json', done.stderr)

    def test_the_outputs_may_not_go_into_the_package_or_an_evidence_folder(self):
        for target in (self.package / 'out', self.package / 'dumps' / 'run1' / 'out'):
            done = helpers.run_script('run_audit.py', self.package, '--outputs', target)
            self.assertEqual(done.returncode, 2, target)
            self.assertIn('outputs may not go into', done.stderr)

    def test_a_script_of_the_package_never_runs(self):
        # A planted script with a toolset name is ignored: the run uses the script of the toolset.
        (self.package / 'census.py').write_text('raise SystemExit(99)\n', encoding='utf-8')
        (self.package / 'auditlib').mkdir()
        (self.package / 'auditlib' / '__init__.py').write_text('raise SystemExit(98)\n', encoding='utf-8')
        self.assertEqual(self.run_audit().returncode, 0)

    def test_a_script_that_stops_on_its_input_stops_the_run(self):
        data = self.package_data()
        data['runs'][1]['inputs']['root'] = 'N999'
        rewrite_package(self.package, runs=data['runs'])
        done = self.run_audit()
        self.assertEqual(done.returncode, 2)
        self.assertIn('N999', done.stderr)
