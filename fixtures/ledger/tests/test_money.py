import unittest

from ledger.money import apply_discount, split_evenly


class SplitEvenlyTests(unittest.TestCase):
    def test_split_is_a_partition_of_the_total(self):
        # 1000 cents across 3 parties: 334 + 333 + 333. No cent may be lost.
        shares = split_evenly(1000, 3)
        self.assertEqual(sum(shares), 1000)

    def test_shares_differ_by_at_most_one_cent(self):
        shares = split_evenly(1000, 3)
        self.assertLessEqual(max(shares) - min(shares), 1)

    def test_exact_division_is_unchanged(self):
        self.assertEqual(split_evenly(900, 3), [300, 300, 300])


class ApplyDiscountTests(unittest.TestCase):
    def test_whole_percentage(self):
        self.assertEqual(apply_discount(1000, 10), 900)

    def test_rounds_half_up(self):
        self.assertEqual(apply_discount(1005, 50), 503)


if __name__ == "__main__":
    unittest.main()
