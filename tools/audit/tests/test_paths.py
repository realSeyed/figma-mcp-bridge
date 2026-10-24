import unittest

from . import helpers  # noqa: F401  (puts the toolset on the import path)

from auditlib.paths import ABSENT, PathError, changed_paths, format_path, parse_path, resolve, values_equal


class PathTest(unittest.TestCase):
    def test_parse_and_format_round_trip(self):
        for text, steps in [
            ('styles.fills[0].color', ['styles', 'fills', 0, 'color']),
            ('id', ['id']),
            ('a[1][2]', ['a', 1, 2]),
            ('componentProperties.Label#1:2.value', ['componentProperties', 'Label#1:2', 'value']),
            ('x["a.b"]', ['x', 'a.b']),
        ]:
            self.assertEqual(parse_path(text), steps, text)
            self.assertEqual(format_path(steps), text)

    def test_a_quoted_key_may_hold_what_a_bare_key_cannot(self):
        self.assertEqual(parse_path('componentProperties["Label#1:2"].value'), ['componentProperties', 'Label#1:2', 'value'])
        self.assertEqual(parse_path('x["a\\"b"]'), ['x', 'a"b'])
        self.assertEqual(format_path(['x', 'a"b', '']), 'x["a\\"b"][""]')

    def test_bad_paths(self):
        for text in ['', '.a', 'a.', 'a..b', 'a[', 'a[x]', 'a[-1]', 'a[0]b', 'a"b"', '[0', 'a["b]']:
            with self.assertRaises(PathError, msg=text):
                parse_path(text)

    def test_resolve(self):
        node = {'styles': {'fills': [{'color': '#fff'}]}, 'x': 0}
        self.assertEqual(resolve(node, parse_path('styles.fills[0].color')), '#fff')
        self.assertEqual(resolve(node, parse_path('x')), 0)
        for text in ['styles.fills[1]', 'styles.nope', 'x.y', 'styles[0]', 'styles.fills.color']:
            self.assertIs(resolve(node, parse_path(text)), ABSENT, text)

    def test_values_equal_keeps_bool_apart_from_numbers(self):
        self.assertTrue(values_equal(1, 1.0))
        self.assertFalse(values_equal(True, 1))
        self.assertFalse(values_equal(0, False))
        self.assertTrue(values_equal({'a': [1, {'b': None}]}, {'a': [1.0, {'b': None}]}))
        self.assertFalse(values_equal([1], {'0': 1}))

    def test_changed_paths(self):
        a = {'k': 1, 'styles': {'fills': [{'c': 'x'}, {'c': 'y'}], 'gone': 1}, 'same': [1, 2]}
        b = {'k': 2, 'styles': {'fills': [{'c': 'x'}, {'c': 'z'}, {'c': 'w'}], 'new': 1}, 'same': [1, 2]}
        self.assertEqual(
            changed_paths(a, b), ['k', 'styles.fills[1].c', 'styles.fills[2]', 'styles.gone', 'styles.new']
        )
        self.assertEqual(changed_paths({'a': 1, 'b': 2}, {'b': 2.0, 'a': 1}), [])
