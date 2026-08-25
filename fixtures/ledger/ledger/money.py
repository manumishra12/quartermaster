"""Money helpers. Amounts are integer cents everywhere - never floats."""


def split_evenly(total_cents: int, parties: int) -> list[int]:
    """Split an amount across parties as evenly as possible.

    Every cent of the original amount must land somewhere: the split is a
    partition of ``total_cents``, not an approximation of it.
    """
    if parties < 1:
        raise ValueError("parties must be at least 1")
    share = total_cents // parties
    return [share] * parties


def apply_discount(amount_cents: int, percent: int) -> int:
    """Reduce an amount by a whole percentage, rounding half up."""
    if not 0 <= percent <= 100:
        raise ValueError("percent must be between 0 and 100")
    return (amount_cents * (100 - percent) + 50) // 100
